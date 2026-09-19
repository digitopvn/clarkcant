import { join } from "node:path";

import { ATTACHMENT_LIMITS, attachmentIdSchema, type AutonomySettings, type ExecutionPolicy, type GuardClass, type GuardrailConstraint, type Instant } from "@clarkcant/contracts";
import { getAttachment } from "@clarkcant/storage";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import { requestApproval, type CoordinationDeps } from "@clarkcant/core";

import { blobsDir, readBlob } from "./blobs.ts";
import { createAskUserQuestionTool } from "./ask-user-question.ts";
import { createRequestSecretTool, type RequestSecretDeps } from "./request-secret.ts";
import type { InteractionDeps } from "./interactions.ts";
import { describeSearch, machineRoots, searchFileSystem } from "./fs-search.ts";
import { applyGuardrailConstraints, preflightCommand, type CommandEnvelope, type OwnedResources } from "./preflight.ts";
import { createQuestion } from "./interactions.ts";
import type { SecretBroker } from "./secret-broker.ts";
import type { OperationGuardInput, OperationGuardOutcome } from "./jev-decider.ts";
import { commandDigest, runGuardedCommand, type CommandOutcome } from "./run-command.ts";
import type { ProjectFinderDeps } from "./project-finder.ts";
import { createFindProjectTool } from "./project-finder.ts";
import { createFindRuntimeTool } from "./runtime-candidates.ts";
import type { SessionSearchDeps } from "./session-search.ts";
import { createSearchHistoryTool } from "./session-search.ts";

/**
 * The tools a turn may call beyond the view and composition surface.
 *
 * Assembled here rather than inline in the entry point, and that is the point: the list was built
 * inside a lazy closure in `main.ts`, where nothing could assert it. A plan that says "expose
 * `find_project` to the main model" was therefore satisfied in the module that *defines* the tool and
 * not in the node that runs it, and no test could tell the difference. A list a test can read is a
 * list that cannot go missing quietly.
 *
 * All three are read-only reports. None of them starts work, dispatches a task, grants a capability or
 * opens a session: what a turn may *do* goes through the view surface and, for side effects, through
 * the approval route.
 */
export function createNodeTools(input: {
  search: SessionSearchDeps;
  projects: ProjectFinderDeps;
  /** Where a machine-wide search starts. Defaults to every drive, or the filesystem root. */
  roots?: () => readonly string[];
  /**
   * The interaction manager for the conversation this turn belongs to.
   *
   * Absent means `ask_user_question` is not registered: a turn with no conversation has no transcript to
   * record a question in, and a card nobody can answer is worse than no tool.
   */
  interactions?: InteractionDeps;
  /**
   * The secret broker's read side, when this node may ask for secrets at all.
   *
   * Absent means `request_secret` is not registered, and the instruction not to ask for a secret anywhere else is
   * the only thing left — which is why the refusal inside `ask_user_question` is deterministic rather than
   * dependent on this tool existing.
   */
  secrets?: RequestSecretDeps;
  /**
   * The command path, when this node may run commands at all.
   *
   * Absent means `run_command` is not registered. Note what is *not* required: an approval route. A node
   * whose policy is `guarded` runs commands without ever recording a decision, so tying this tool's
   * existence to the approval infrastructure — as it used to be — would leave the default policy with no
   * executor.
   */
  command?: CommandToolDeps;
  /** Resolve a folder from the model's words, through the finder and its decider. */
  resolveFolder?: (intent: string) => Promise<
    | { status: "resolved"; cwd: string; relPath: string }
    | { status: "ask"; message: string; options: readonly string[] }
  >;
  /**
   * The conversation this turn belongs to, when the node may read attachments at all.
   *
   * Absent means `read_attachment` is not registered, which is the honest state for a turn that belongs
   * to no conversation: the tool's whole check is that an attachment belongs to *this* conversation and
   * *this* principal, and a turn with no conversation has nothing to check against.
   */
  attachments?: { dataDir: string; conversationId: string };
}): ToolDefinition[] {
  const roots = input.roots ?? machineRoots;
  return [
    createSearchHistoryTool(input.search),
    createSearchFilesTool(roots),
    ...(input.interactions === undefined ? [] : [createAskUserQuestionTool(input.interactions)]),
    ...(input.secrets === undefined ? [] : [createRequestSecretTool(input.secrets)]),
    ...(input.command === undefined
      ? []
      : [
          createRunCommandTool({
            ...input.command,
            ...(input.interactions === undefined ? {} : { interactions: input.interactions }),
            ...(input.resolveFolder === undefined ? {} : { resolveFolder: input.resolveFolder }),
          }),
        ]),
    createFindRuntimeTool({
      db: input.search.db,
      nodeId: input.search.nodeId,
      now: input.search.now,
    }),
    createFindProjectTool(input.projects),
    ...(input.attachments === undefined
      ? []
      : [
          createReadAttachmentTool({
            db: input.search.db,
            principalId: input.search.principalId,
            conversationId: input.attachments.conversationId,
            dataDir: input.attachments.dataDir,
          }),
        ]),
  ];
}

/**
 * Reading a file a person attached, as the model may ask for it.
 *
 * This is the only reading path a prompt's attachment section points at, and it takes an attachment id
 * and nothing else. That is the whole design: there is no path parameter to escape from, and no relative
 * form to resolve against anything, so a file's content cannot be used to steer the model into reading a
 * different file. The two checks — the row belongs to this principal, and to this conversation — happen
 * against storage, not against the argument.
 *
 * A binary attachment is answered honestly rather than silently: this node has no extractor for images or
 * PDFs, and a tool that returned nothing for a picture would read as a file that was empty.
 */
export function createReadAttachmentTool(input: {
  db: SessionSearchDeps["db"];
  principalId: string;
  conversationId: string;
  dataDir: string;
}): ToolDefinition {
  return {
    name: "read_attachment",
    label: "Đọc một tệp đính kèm",
    description:
      "Read a file the user attached to this conversation, by the attachment id you were given in the " +
      "prompt. Use it when a text file's content was too long to include, or when you need to re-read it. " +
      "It only accepts an id from this conversation: it cannot open any other file, and it takes no path. " +
      "Images and PDFs have no reader on this node yet and say so.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["attachmentId"],
      properties: {
        attachmentId: { type: "string", description: "The attachment id from the prompt, e.g. att_abc123." },
      },
    },
    promptSnippet: "read_attachment — read the content of a file the user attached to this conversation",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const parsed = attachmentIdSchema.safeParse(params.attachmentId);
      if (!parsed.success) {
        // Refused in the same turn so the model can correct itself. Saying what an id looks like is not
        // saying which ids exist.
        return { text: "Cần một attachment id, dạng att_… như trong prompt. Công cụ này không nhận đường dẫn tệp." };
      }

      const record = getAttachment(input.db, parsed.data, input.principalId);
      // One answer for absent, someone else's, and another conversation's. Distinguishing them would turn
      // this tool into a way to ask which attachment ids exist on the node.
      if (record === undefined || record.conversationId !== input.conversationId) {
        return { text: "Không có tệp đính kèm nào với id đó trong cuộc hội thoại này." };
      }

      if (record.kind !== "text") {
        return {
          text:
            `Tệp “${record.filename}” là ${record.mime} (${record.sizeBytes} byte). Node này chưa có bộ trích ` +
            `nội dung cho ảnh và PDF, nên tui không đọc được nội dung của nó. Đừng đoán nội dung.`,
        };
      }

      const blob = readBlob({
        dataDir: input.dataDir,
        blobPath: join(blobsDir(input.dataDir), record.blobPath.split(/[/\\]/).at(-1) ?? ""),
      });
      if (!blob.ok) return { text: `${record.filename}: ${blob.message}` };

      // The same ceiling the prompt's attachment section uses, so a file read here cannot be larger than
      // one that would have been inlined there.
      const allowed = Math.min(blob.bytes.byteLength, ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes.subarray(0, allowed));
      const truncated =
        allowed < blob.bytes.byteLength
          ? `\n[đã lược bớt: tệp dài ${blob.bytes.byteLength} byte, chỉ đọc ${allowed} byte đầu]`
          : "";
      return { text: `Nội dung của “${record.filename}”:\n${text}${truncated}` };
    },
  };
}

/**
 * Everything the command tool needs, injected.
 *
 * Functions rather than values, so a settings change applies to the next command instead of the next
 * restart, and so this module stays testable without a database, a node or a provider.
 */
export interface CommandToolDeps {
  /**
   * Where an approval request is recorded. Only `confirm` needs it.
   *
   * Optional on purpose: the default policy does not ask anybody, and a tool that refused to exist
   * without a decision route would make the default unreachable.
   */
  approvals?: () => CoordinationDeps;
  /** The autonomy settings as they are now. */
  autonomy: () => AutonomySettings;
  /** The folders this node owns. Every effect has to resolve inside one of them. */
  resources: () => OwnedResources;
  /** The node's own working directory, used when the model named no folder and `cwd` was absent. */
  fallbackCwd: () => string;
  /** The policy layer. Absent means there is nothing to consult, and the fail-open setting decides. */
  guardrails?: (input: OperationGuardInput) => Promise<OperationGuardOutcome>;
  /**
   * The narrowing options this host is willing to apply, with the constraint each one means.
   *
   * The selector picks an id; this table turns it into a constraint. That indirection is the guarantee
   * that a guardrail cannot widen anything: it can only point at something the host already decided was a
   * narrowing.
   */
  narrowing?: readonly { id: string; description: string; constraint: GuardrailConstraint }[];
  /** Ids for the receipts this tool writes. */
  newId: () => string;
  /**
   * The interaction manager, when this node may ask the person something.
   *
   * Optional because a node can run commands without being able to ask: in that case a folder the finder cannot
   * choose between comes back as a question for the model to carry, which is worse but honest.
   */
  interactions?: InteractionDeps;
  now?: () => Instant;
  /** Injected so the whole path can be tested without spawning anything. */
  run?: (request: {
    command: string;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: Record<string, string>;
  }) => Promise<CommandOutcome>;
  /**
   * The secret broker, when a command may be given a secret it needs.
   *
   * Absent means `secretRef` is refused rather than ignored: a command that ran without the credential it asked
   * for would fail in a way that looks like the command's fault.
   */
  broker?: SecretBroker;
}

/**
 * Which policy applies to one effect.
 *
 * `guarded` is the interesting case: it means "do not ask a person, but do ask the policy layer", and the
 * policy layer is only asked for the classes the person left switched on. A class that is switched off is
 * not "denied" — it is simply not judged, and it runs. Reading it as a denial would make turning a class
 * off in settings stop work, which is the opposite of what the switch says.
 */
export function policyForEffect(settings: AutonomySettings, guardClass: GuardClass): ExecutionPolicy {
  if (settings.executionPolicy === "deny") return "deny";
  if (settings.executionPolicy === "confirm") return "confirm";
  if (settings.executionPolicy === "auto") return "auto";
  if (!settings.jevGuardrails) return "auto";
  return settings.guardedClasses.includes(guardClass) ? "guarded" : "auto";
}

export type GuardDecisionForCommand =
  | { kind: "proceed"; envelope: CommandEnvelope }
  | { kind: "refuse"; text: string };

/**
 * Consult the policy layer about one command, and turn its answer into something the turn can act on.
 *
 * The four outcomes are handled differently on purpose. `allow` proceeds. `deny` and `clarify` both stop
 * the command but say different things — a refusal is final, a clarification is a question the model can
 * carry back and re-propose against. `constrain` is applied through the host's own table and can still be
 * refused by `applyGuardrailConstraints` if it turns out to widen. `unavailable` is not a refusal: it is
 * the absence of a judgment, and what it means is the person's `whenJevUnavailable` setting rather than a
 * guess made here.
 */
export async function decideGuardrailForCommand(
  input: CommandToolDeps,
  request: { settings: AutonomySettings; envelope: CommandEnvelope; why: string },
): Promise<GuardDecisionForCommand> {
  const outcome: OperationGuardOutcome =
    input.guardrails === undefined
      ? { status: "unavailable", reason: "node này chưa nối guardrail nào" }
      : await input.guardrails({
          intent: request.why === "" ? request.envelope.command : request.why,
          operation: `Chạy lệnh trong ${request.envelope.cwd}`,
          state: {
            effect: request.envelope.effectCategory,
            commandClass: request.envelope.classification.commandClass,
            cwdScope: request.envelope.cwd,
            executable: request.envelope.command.split(/\s+/)[0] ?? "",
            recursive: String(request.envelope.classification.recursive),
            destructive: String(request.envelope.classification.destructive),
            estimatedTargets: String(request.envelope.classification.estimatedTargets),
          },
          instructions: request.settings.instructions,
          ...(input.narrowing === undefined
            ? {}
            : { constraints: input.narrowing.map((entry) => ({ id: entry.id, description: entry.description })) }),
          clarifyQuestion:
            "Lệnh này có thể nhắm vào nhiều đối tượng đều hợp lệ. Bạn muốn nói tới cái nào?",
        });

  if (outcome.status === "allow") return { kind: "proceed", envelope: request.envelope };
  if (outcome.status === "deny") {
    return { kind: "refuse", text: `Guardrail từ chối lệnh này (${outcome.reason}). Không có gì được chạy.` };
  }
  if (outcome.status === "clarify") {
    return { kind: "refuse", text: `${outcome.question} Hỏi người dùng rồi đề xuất lại.` };
  }
  if (outcome.status === "constrain") {
    const offered = (input.narrowing ?? []).find((entry) => entry.id === outcome.constraintId);
    if (offered === undefined) {
      return { kind: "refuse", text: "Guardrail yêu cầu thu hẹp nhưng không nêu cách nào host đã cho phép." };
    }
    const narrowed = applyGuardrailConstraints(request.envelope, [offered.constraint]);
    if (!narrowed.ok) return { kind: "refuse", text: `Guardrail yêu cầu nới phạm vi: ${narrowed.message}` };
    return { kind: "proceed", envelope: narrowed.envelope };
  }

  if (request.settings.whenJevUnavailable === "allow") return { kind: "proceed", envelope: request.envelope };
  return {
    kind: "refuse",
    text: `Guardrail không dùng được (${outcome.reason}) và node này đặt là từ chối khi Jev vắng. Không có gì được chạy.`,
  };
}

/**
 * Turn a finder's indecision into a question card.
 *
 * The options are the folders themselves, in the finder's own words, and the answer comes back as the label the
 * person saw — which is what the next turn needs to re-propose against. Returns nothing when the node cannot ask
 * or when the manager refuses the question, so the caller keeps its text fallback rather than inventing a card.
 */
function askWhichFolder(
  input: { interactions?: InteractionDeps },
  found: { message: string; options: readonly string[] },
): { text: string; hostBlocks: Record<string, unknown>[] } | undefined {
  if (input.interactions === undefined || found.options.length === 0) return undefined;
  const created = createQuestion(input.interactions, {
    question: found.message,
    kind: "single-choice",
    options: found.options.slice(0, 8).map((folder, index) => ({ id: `folder-${index + 1}`, label: folder })),
    allowOther: true,
  });
  if (!created.ok) return undefined;
  return {
    text: "Đã hỏi người dùng muốn dùng thư mục nào. Lượt này kết thúc ở đây; câu trả lời sẽ tới ở lượt sau.",
    // SAFETY: built against the message-block union by `createQuestion`; the adapter's shape is loose because it
    // must not depend on contracts, and the node validates every block before it reaches a transcript.
    hostBlocks: [created.block as unknown as Record<string, unknown>],
  };
}

/**
 * Running a command, as the model may ask for it.
 *
 * The tool used to do nothing but record a request and hand back a card. It now runs the command, and what
 * makes that acceptable is not the tool: it is `preflightCommand`, which decides ownership, existence and
 * budget before this code runs, and `decideGuardrailForCommand`, which may narrow or refuse afterwards.
 * The approval card is still here for `confirm`, whole and unchanged, because a policy mode that cannot be
 * exercised is a policy mode that has already rotted.
 */
export function createRunCommandTool(
  input: CommandToolDeps & {
    /**
     * Resolve a folder from the model's words, through the finder and its decider.
     *
     * Injected rather than imported so the tool stays independent of the finder's machinery, and so a test
     * can drive the ambiguous case without a project index.
     */
    resolveFolder?: (intent: string) => Promise<
      | { status: "resolved"; cwd: string; relPath: string }
      | { status: "ask"; message: string; options: readonly string[] }
    >;
  },
): ToolDefinition {
  return {
    name: "run_command",
    label: "Chạy một lệnh",
    description:
      "Run one shell command in a folder this node owns. Unless this node is set to ask first, the command " +
      "runs straight away and you get its output in this turn — so do not say you are only proposing it. Pass " +
      "`where` with the place you intend in your own words and look for it first with find_project or " +
      "search_files, because the folder must resolve inside a folder this node owns; a folder outside them, " +
      "or one that does not exist, is refused before anything runs. Pass `cwd` only when you already know the " +
      "exact directory. Use it for work that needs a shell: git clone, a build, a test run.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", description: "The exact command line to run, as the user will read it." },
        where: {
          type: "string",
          description:
            "Where to run it, in your own words, e.g. 'canh các dự án khác' or 'trong dự án vừa tìm thấy'. Sent to the project finder.",
        },
        cwd: { type: "string", description: "An exact directory, when you already know one." },
        why: { type: "string", description: "One sentence for the card: what this is for." },
        secretRef: {
          type: "string",
          description:
            "Name of a secret this command needs, e.g. github_token. It goes into this one child process's " +
            "environment and you never see the value. Ask for it with request_secret first if the node may not have it.",
        },
        secretEnvVar: {
          type: "string",
          description: "The environment variable to put it in. Defaults to the secret's name in upper case.",
        },
      },
    },
    promptSnippet: "run_command — propose a shell command; the user must approve it before it runs",
    execute: async (
      params: Record<string, unknown>,
    ): Promise<{ text: string; hostCard?: Record<string, unknown>; hostBlocks?: Record<string, unknown>[] }> => {
      const command = typeof params.command === "string" ? params.command.trim() : "";
      if (command === "") return { text: "Cần một lệnh để chạy." };

      let cwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd.trim() : undefined;
      let because: string | undefined;

      const where = typeof params.where === "string" ? params.where.trim() : "";
      if (cwd === undefined && where !== "" && input.resolveFolder !== undefined) {
        const found = await input.resolveFolder(where);
        if (found.status === "ask") {
          /*
           * The finder found several folders that could be meant, and this is the case the interaction manager
           * exists for: the question is structural (which of these), not a request for permission, and the person
           * can answer it by clicking or by saying the folder's name.
           *
           * Falling back to text is not a failure: a node with no way to ask leaves the model to carry the
           * question, which is what this did before there was a card.
           */
          const asked = askWhichFolder(input, found);
          if (asked !== undefined) return asked;
          const options = found.options.length === 0 ? "" : ` Có thể là: ${found.options.join(", ")}.`;
          return { text: `${found.message}${options} Hãy chọn một thư mục rồi đề xuất lại.` };
        }
        cwd = found.cwd;
        because = `được tìm thấy từ “${where}” (${found.relPath})`;
      }

      const settings = input.autonomy();
      const preflight = preflightCommand({
        command,
        cwd,
        resources: input.resources(),
        fallbackCwd: input.fallbackCwd(),
      });
      if (!preflight.ok) {
        // Refused here, in the same turn, so the model can correct itself rather than the user finding out
        // that a command cannot run where it asked. This is the host's own gate, not policy: a folder the
        // node does not own, or one that is not there, is not a question to put to a model.
        return { text: preflight.message };
      }
      if (preflight.envelope.kind !== "command") return { text: "Chỉ chạy được lệnh shell qua công cụ này." };

      const envelope = preflight.envelope;
      const why = typeof params.why === "string" && params.why.trim() !== "" ? params.why.trim() : "";
      const reason = because ?? "";
      const policy = policyForEffect(settings, envelope.guardClass);

      if (policy === "deny") {
        return {
          text:
            `Node này đang tắt lớp “${envelope.guardClass}”, nên lệnh này không chạy. ` +
            `Người dùng bật lại trong Settings → Autonomy nếu muốn.`,
        };
      }

      if (policy === "confirm") {
        if (input.approvals === undefined) {
          return {
            text:
              "Node này đang ở chế độ confirm nhưng không có nơi ghi quyết định, nên lệnh không chạy được. " +
              "Đổi sang chế độ khác trong Settings → Autonomy.",
          };
        }
        const digest = commandDigest(command, envelope.cwd);
        const approval = requestApproval(input.approvals(), {
          operationDigest: digest,
          operationDescription:
            `Chạy một lệnh trong ${envelope.cwd}` +
            (reason === "" ? "" : ` (${reason})`) +
            (why === "" ? "" : `: ${why}`),
          effectCategory: envelope.effectCategory,
          // A quarter of an hour: long enough to read the command and decide, short enough that a card left
          // on screen overnight cannot be approved the next morning for a stale reason.
          ttlMs: 15 * 60_000,
        });
        return {
          text:
            `Đã gửi yêu cầu duyệt để chạy \`${command}\` trong ${envelope.cwd}. Chưa có gì chạy cả — người dùng ` +
            `phải bấm duyệt, và tui không thể tự duyệt. Đừng nói là đã chạy xong.`,
          hostCard: {
            type: "approval-card",
            owner: "host",
            approvalId: approval.approvalId,
            operationDescription: approval.operationDescription,
            operationDigest: approval.operationDigest,
            effectCategory: approval.effectCategory,
            expiresAt: approval.expiresAt,
            decider: approval.decider,
            decision: approval.decision,
            // The payload is what runs on approval, and the digest above is what proves it is unchanged.
            payload: JSON.stringify({ command, cwd: envelope.cwd }),
          },
        };
      }

      // `guarded` and `auto` differ only in whether the policy layer is consulted. Neither asks a person,
      // which is the whole point of the default: the control is the host's gate plus a judgment that can
      // only narrow, not a dialog nobody reads.
      let guarded = envelope;
      if (policy === "guarded") {
        const decision = await decideGuardrailForCommand(input, { settings, envelope, why });
        if (decision.kind === "refuse") return { text: decision.text };
        guarded = decision.envelope;
      }

      /*
       * A secret this command needs, injected just in time.
       *
       * The consumer is derived from the command itself rather than taken from the model, so a secret allowed for
       * `command:git` cannot be handed to `curl` by asking nicely. The value goes into this one child process's
       * environment and exists nowhere else — not in the receipt, not in the tool result, not in the turn.
       */
      let env: Record<string, string> | undefined;
      const secretRef = typeof params.secretRef === "string" ? params.secretRef.trim() : "";
      if (secretRef !== "") {
        if (input.broker === undefined) {
          return { text: "Node này chưa nối secret broker, nên không inject được secret cho lệnh này." };
        }
        const executable = guarded.command.split(/\s+/)[0] ?? "";
        const variable =
          typeof params.secretEnvVar === "string" && params.secretEnvVar.trim() !== ""
            ? params.secretEnvVar.trim()
            : secretRef.toUpperCase();
        const built = input.broker.environmentFor({ name: secretRef, consumer: `command:${executable}` }, variable);
        if (!built.ok) return { text: `${built.message} Lệnh không chạy.` };
        env = built.env;
      }

      const ran = await runGuardedCommand({
        operationId: input.newId(),
        envelope: guarded,
        ...(reason === "" ? {} : { reason }),
        ...(why === "" ? {} : { why }),
        ...(env === undefined ? {} : { env }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.run === undefined ? {} : { run: input.run }),
      });

      return {
        // The output travels back with the result because the model is still holding this turn: there is no
        // second turn to hand it to, and a model told only that a command exited 0 would have to ask for the
        // output it already produced.
        text: `${ran.description}\n\n${ran.receipt}`,
        // SAFETY: these are the blocks `runGuardedCommand` built out of the message-block union, and the
        // adapter's shape is deliberately loose because that package must not depend on contracts. The node
        // validates every block against the schema before it reaches a transcript, and the seam cannot be
        // typed more tightly without inverting the dependency.
        hostBlocks: ran.blocks as unknown as Record<string, unknown>[],
      };
    },
  };
}

/**
 * The machine-wide search, as the model may call it.
 *
 * Its description states what it does and what that costs, because both matter to the decision: it
 * reads files from the whole machine, and the lines it finds are sent to the model provider as the
 * tool's result. A tool that quietly did that and described itself as "search" would be a privacy
 * decision made by a model on the user's behalf.
 */
export function createSearchFilesTool(roots: () => readonly string[]): ToolDefinition {
  return {
    name: "search_files",
    label: "Tìm tệp trên máy",
    description:
      "Search this machine's filesystem, read-only, for a name or a phrase. Use it for questions about " +
      "files on this computer, which the history search cannot answer. It walks the machine when it is " +
      "called and keeps no index, so it is bounded: it reports what it scanned and why it stopped. The " +
      "matching paths and lines are returned to you as this tool's result, which means they are sent to " +
      "the model provider.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Text to look for, matched without regard to case, in file names and contents.",
        },
        namesOnly: {
          type: "boolean",
          description: "Only match file names. Faster, and enough when the name is what is known.",
        },
      },
    },
    promptSnippet: "search_files — find a file or a phrase anywhere on this machine (read-only)",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (query === "") return { text: "Cần một chuỗi để tìm." };
      const outcome = await searchFileSystem(
        { query, ...(params.namesOnly === true ? { namesOnly: true } : {}) },
        { roots: roots() },
      );
      return { text: describeSearch(outcome, query) };
    },
  };
}
