import { join } from "node:path";

import {
  ATTACHMENT_LIMITS,
  appIntentSchema,
  attachmentIdSchema,
  describeAppIntent,
  memoryKindSchema,
  memoryScopeSchema,
  settingsTabSchema,
  type AppIntentDecision,
  type ConversationId,
  type ExecutionPolicyConfig,
  type GuardrailConstraint,
  type Instant,
} from "@clarkcant/contracts";
import type { ModelTurnEvent } from "@clarkcant/core";
import { getAttachment } from "@clarkcant/storage";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import {
  decideExecution,
  guardrailCovers,
  recordAppIntentEvent,
  recordEffectExecution,
  requestApproval,
  type CoordinationDeps,
  type ExecutionAuditDeps,
  readDirectoryIndex,
  searchDirectory,
} from "@clarkcant/core";
import type { Database } from "@clarkcant/storage";

import { blobsDir, readBlob } from "./blobs.ts";
import { createAskUserQuestionTool } from "./ask-user-question.ts";
import { createRequestSecretTool, type RequestSecretDeps } from "./request-secret.ts";
import type { InteractionDeps } from "./interactions.ts";
import { describeSearch, machineRoots, searchFileSystem } from "./fs-search.ts";
import { applyGuardrailConstraints, preflightCommand, type CommandEnvelope, type OwnedResources } from "./preflight.ts";
import { createQuestion } from "./interactions.ts";
import type { SecretBroker } from "./secret-broker.ts";
import type { OperationGuardInput, OperationGuardOutcome } from "./jev-decider.ts";
import { extractPdfText } from "./pdf-text.ts";
import { commandDigest, runGuardedCommand, type CommandOutcome } from "./run-command.ts";
import type { ProjectFinderDeps } from "./project-finder.ts";
import { createFindProjectTool } from "./project-finder.ts";
import { createFindRuntimeTool } from "./runtime-candidates.ts";
import { createManagePackageTool, type ManagePackageToolDeps } from "./manage-package-tool.ts";
import { createTerminalTools } from "./terminal-tools.ts";
import type { TerminalRegistry } from "./terminal-sessions.ts";
import { rememberMemory, type MemoryDeps } from "./memory.ts";
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

  approvals?: () => CoordinationDeps;
  /**
   * Where an effect performed without an approval card leaves its record.
   *
   * Absent means this node does not perform such an effect at all: it asks instead. An effect nobody
   * approved and nobody can find afterwards is worse than a question.
   */
  /**
   * Where a command that ran without a card leaves its record in the effect ledger; see `audit` above for the trail.
   *
   * Two different records on purpose: this one follows how far an external effect got, which is a question about
   * recovery, and the trail above answers who asked for what and how it ended.
   */
  effectAudit?: () => { deps: ExecutionAuditDeps; principalId: string; conversationId?: string };
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
  /**
   * Where a remembered thing is written, when this turn may write one.
   *
   * Absent means `remember` is not registered. Remembering is always about a conversation and a
   * principal, so a turn that has neither has nothing to attach a record to.
   */
  memory?: { conversationId: string; newId: (prefix: string) => string };
  /**
   * Where a question's id comes from.
   *
   * Absent means `ask_user` is not registered. A question id has to be unique for as long as the transcript
   * that carries it, because the answerability rule is "the conversation has not moved past this id" — an id
   * that could repeat across a restart would make an old card answerable again.
   */
  questions?: { newId: (prefix: string) => string };
  /**
   * Where a directory index is, when this node may search one.
   *
   * Always present in the runtime, because "no directory configured" is a state the tool reports rather
   * than a reason not to register it: a user who has not configured one should be told that, not left
   * wondering why the agent never looks.
   */
  directory?: { indexPath: string | undefined; newId: (prefix: string) => string };
  /**
   * The app-control channel, when this turn has a foreground surface that could act on it.
   *
   * Absent means `control_app` is not registered: a turn with no conversation has no host-control
   * transport to deliver an event on, and offering the tool anyway would let the model believe an
   * action could reach a screen that this call has no way to reach.
   */
  appControl?: ControlAppDeps;
  /**
   * Uninstalling, restoring and rolling back packages, when this turn belongs to a node that holds them.
   *
   * Absent means `manage_package` is not registered. Present, it calls the same action the Settings buttons call.
   */
  packages?: ManagePackageToolDeps;
  /**
   * The node's terminals, when a turn may open or type into one.
   *
   * Registered only with `command`: typing into a shell is running a command, so it is gated by the same policy
   * deps, and a node that cannot run commands cannot type them either.
   */
  terminals?: { registry: TerminalRegistry; newId: (prefix: string) => string; conversationId?: string };
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
            // The effect ledger, kept from main: `audit` above is the trail (who asked for what, and how it ended),
            // and this is the record of how far an external effect got, which is the question recovery asks.
            ...(input.effectAudit === undefined ? {} : { effectAudit: input.effectAudit }),
            ...(input.resolveFolder === undefined ? {} : { resolveFolder: input.resolveFolder }),
          }),
        ]),
    ...(input.command === undefined || input.terminals === undefined
      ? []
      : createTerminalTools({
          ...input.command,
          ...(input.effectAudit === undefined ? {} : { effectAudit: input.effectAudit }),
          ...(input.resolveFolder === undefined ? {} : { resolveFolder: input.resolveFolder }),
          terminals: input.terminals.registry,
          newCardId: input.terminals.newId,
          ...(input.terminals.conversationId === undefined ? {} : { conversationId: input.terminals.conversationId }),
        })),
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
    ...(input.questions === undefined ? [] : [createAskUserTool(input.questions.newId)]),
    ...(input.directory === undefined ? [] : [createSearchDirectoryTool(input.directory)]),
    ...(input.memory === undefined
      ? []
      : [
          createRememberTool({
            db: input.search.db,
            principalId: input.search.principalId,
            conversationId: input.memory.conversationId,
            now: input.search.now,
            newId: input.memory.newId,
          }),
        ]),
    ...(input.appControl === undefined ? [] : [createControlAppTool(input.appControl)]),
    ...(input.packages === undefined ? [] : [createManagePackageTool(input.packages)]),
  ];
}

/**
 * The kinds `control_app` may ask for.
 *
 * A deliberate subset of the full app-intent vocabulary: `app.quit` stays confirmation-gated and is not
 * offered to a tool call at all, because this tool has no confirmation flow of its own and adding one
 * here would be a second, divergent quit path. The widget kinds are reached through `read_attachment`'s
 * sibling tools and the view surface instead, not through this generic channel.
 */
const CONTROL_APP_KINDS = [
  "settings.open",
  "settings.tab",
  "nav.home",
  "nav.conversation",
  "voice.open",
  "voice.end",
  "model.cycle",
  "model.select",
  "inbox.open",
] as const;

/** What a node answers a `control_app` call with — always an honest account, never a claim of success it did not verify. */
export type ControlAppResult =
  | { status: "delivered"; say: string }
  | { status: "refused"; reason: "unsupported" | "no-active-surface"; say: string };

export interface ControlAppDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  principalId: string;
  conversationId?: ConversationId;
  /** The live turn's event sink, read at call time; see `extraTools` in `model-turn.ts` for why this is a getter. */
  onEvent: () => ((event: ModelTurnEvent) => void) | undefined;
  /**
   * Which surface the message this call belongs to came in on, read at call time for the same reason
   * `onEvent` is a getter: the tool list is built once per session, and a session answers both typed
   * and spoken messages over its life. Drives the audit record's `source` — `"agent"` for a message
   * from the composer, `"voice"` for one the voice session's own conductor call answered — so a click,
   * a deterministic spoken command, and a model's own decision never collapse into one indistinguishable
   * record.
   */
  channel: () => "voice" | "chat";
}

const NO_ACTIVE_HOST_SURFACE_SAY =
  "Không có màn hình nào đang mở phiên trò chuyện này để tôi thực hiện lệnh, nên tôi chưa làm gì cả.";

/**
 * Let the agent do what a click or a spoken command already can, through the one shared app-intent
 * executor.
 *
 * This tool never claims success on its own: it validates the request against the same contract the
 * typed and spoken paths use, records who asked with `source: "agent"` or `"voice"` (see `channel`) so
 * the audit can tell a person's click from a model's own decision — and, among those, whether the
 * decision was made answering the composer or a spoken sentence — and then delivers an ephemeral
 * `host-control` event to whichever foreground stream is watching this turn. Whether the screen
 * actually changed is answered by the client's one executor (`runAppIntent`), not guessed here — this
 * call only reports that the event was delivered or, honestly, that there was nowhere to deliver it.
 */
export function createControlAppTool(deps: ControlAppDeps): ToolDefinition {
  return {
    name: "control_app",
    label: "Điều khiển ứng dụng",
    description:
      "Ask the app to carry out one of its own semantic actions on the person's behalf: open Settings " +
      "(optionally at a tab), open the inbox (what is waiting for the person and the notices from background " +
      "work), return to the current conversation, go to the home screen, start or end voice mode, or switch the configured model (cycle to the next one, or select a specific alias). " +
      "This is not a scripting surface — it accepts only these fixed kinds, never a URL, selector or " +
      "arbitrary command. Only call it when the user's own request implies the app itself should change, " +
      "not merely to narrate what you are about to say. The result tells you whether the request reached " +
      "a screen; it does not by itself prove the screen changed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: {
          type: "string",
          enum: [...CONTROL_APP_KINDS],
          description: "Which app-control action to perform.",
        },
        tab: {
          type: "string",
          description: "Required only for kind \"settings.tab\": which Settings tab to open.",
        },
        modelAlias: {
          type: "string",
          description: "Required only for kind \"model.select\": the configured profile's alias.",
        },
      },
    },
    promptSnippet: "control_app — open Settings or the inbox, navigate, or switch voice/model state for the user",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const outcome = decideControlApp(deps, params);
      return { text: outcome.say };
    },
  };
}

/**
 * The decision half of `control_app`, kept apart from `execute` so it can be asserted on its own: a
 * `ToolDefinition.execute` must answer `{ text }` for the model, and squeezing the structured outcome —
 * whether it was delivered, and why not when it was refused — through that one string would make the
 * two claims this tool exists to keep separate (delivered vs. refused, and why) untestable without
 * parsing prose.
 */
export function decideControlApp(deps: ControlAppDeps, params: Record<string, unknown>): ControlAppResult {
  const kind = typeof params.kind === "string" ? params.kind : "";
  if (!(CONTROL_APP_KINDS as readonly string[]).includes(kind)) {
    return {
      status: "refused",
      reason: "unsupported",
      say: `"${kind}" không phải một hành động control_app hợp lệ.`,
    };
  }

  const parsed = appIntentSchema.safeParse({
    kind,
    ...(kind === "settings.tab" && settingsTabSchema.safeParse(params.tab).success ? { tab: params.tab } : {}),
    ...(kind === "model.select" && typeof params.modelAlias === "string" && params.modelAlias.trim() !== ""
      ? { modelAlias: params.modelAlias.trim() }
      : {}),
  });
  if (!parsed.success) {
    return {
      status: "refused",
      reason: "unsupported",
      say:
        kind === "settings.tab"
          ? "settings.tab cần tên tab hợp lệ."
          : "model.select cần modelAlias của một profile đã cấu hình.",
    };
  }

  const intent = parsed.data;
  const readBack = describeAppIntent(intent);
  const onEvent = deps.onEvent();
  if (onEvent === undefined) {
    return { status: "refused", reason: "no-active-surface", say: NO_ACTIVE_HOST_SURFACE_SAY };
  }

  const decision: AppIntentDecision = { kind: "intent", intent, requiresConfirmation: false, readBack };
  onEvent({ type: "host-control", decision });
  recordAppIntentEvent(
    { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.newId },
    {
      intent,
      source: deps.channel() === "voice" ? "voice" : "agent",
      confirmed: false,
      ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }),
    },
  );
  return { status: "delivered", say: readBack };
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
 * A picture is handed over as a picture rather than described: the model gets the image itself, because a
 * file name answers nothing about what is in it. A PDF is read for its text, and what cannot be read comes
 * back with the reason instead of with nothing, since an empty answer reads as an empty file.
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
      "prompt. Use it when a text file's content was too long to include, when you need to re-read it, or " +
      "when the user asks about a picture they attached: an image comes back as the image itself, so answer " +
      "from what you see in it rather than from its file name. It only accepts an id from this conversation: " +
      "it cannot open any other file, and it takes no path.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["attachmentId"],
      properties: {
        attachmentId: { type: "string", description: "The attachment id from the prompt, e.g. att_abc123." },
      },
    },
    promptSnippet: "read_attachment — read the content of a file the user attached to this conversation",
    execute: async (
      params: Record<string, unknown>,
    ): Promise<{ text: string; image?: { mimeType: string; dataBase64: string } }> => {
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

      // An image is handed over as an image: the model receives the picture itself, so a question about what is
      // in it is answered from the picture rather than from its file name. The sentence beside it stays, because
      // a transcript that shows only an image loses which file it came from.
      if (record.kind === "image") {
        const picture = readBlob({
          dataDir: input.dataDir,
          blobPath: join(blobsDir(input.dataDir), record.blobPath.split(/[/\\]/).at(-1) ?? ""),
        });
        if (!picture.ok) return { text: `${record.filename}: ${picture.message}` };
        return {
          text: `Ảnh “${record.filename}” (${record.mime}, ${record.sizeBytes} byte) ở dưới.`,
          image: { mimeType: record.mime, dataBase64: Buffer.from(picture.bytes).toString("base64") },
        };
      }

      const blob = readBlob({
        dataDir: input.dataDir,
        blobPath: join(blobsDir(input.dataDir), record.blobPath.split(/[/\\]/).at(-1) ?? ""),
      });
      if (!blob.ok) return { text: `${record.filename}: ${blob.message}` };

      // A PDF is read here rather than named: the issue this tool exists for asks for a file's content, and a PDF's
      // text can be recovered without a provider. What cannot be read comes back with the reason.
      if (record.kind === "pdf") {
        const extracted = extractPdfText(blob.bytes);
        if (!extracted.ok) return { text: `“${record.filename}”: ${extracted.reason}.` };
        const allowed = Math.min(extracted.text.length, ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn);
        const truncated =
          allowed < extracted.text.length
            ? `\n[đã lược bớt: tệp dài ${extracted.text.length} ký tự, chỉ đọc ${allowed} ký tự đầu]`
            : "";
        return { text: `Nội dung của “${record.filename}”:\n${extracted.text.slice(0, allowed)}${truncated}` };
      }

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
  /** The execution policy in force, as it is now. One reader supplies it; this tool never opens a preference. */
  autonomy: () => ExecutionPolicyConfig;
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
   * Where a finished command is written down, when this node keeps a trail.
   *
   * Optional because the audit trail is a node's decision: a test, or an embedder, may run this tool without one.
   * What is *not* optional is what it may contain — a summary and an outcome, never the command's output and never a
   * secret that was injected into it.
   */
  audit?: (event: {
    summary: string;
    outcome: "done" | "failed" | "stopped" | "refused";
    ref?: string;
  }) => void;
  /**
   * The effect ledger, kept from main.
   *
   * Two records answer two different questions: `audit` says who asked for what and how it ended, and this one says
   * how far an external effect got — which is what a reader needs after a crash between a command starting and its
   * result arriving. The dependencies come from the caller because only the node knows its database and its clock.
   */
  effectAudit?: () => {
    deps: Parameters<typeof recordEffectExecution>[0];
    principalId: string;
    conversationId?: string;
  };
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

export type GuardDecisionForCommand =
  | { kind: "proceed"; envelope: CommandEnvelope }
  | { kind: "refuse"; text: string }
  /** The policy layer could not tell what the command is aimed at and said so. A question, not a verdict. */
  | { kind: "ask"; question: string };

/**
 * Consult the judgment layer about one command, and turn its answer into something the turn can act on.
 *
 * The four outcomes are handled differently on purpose. `allow` proceeds. `deny` and `clarify` both stop
 * the command but say different things — a refusal is final, a clarification is a question the model can
 * carry back and re-propose against. `constrain` is applied through the host's own table and can still be
 * refused by `applyGuardrailConstraints` if it turns out to widen. `unavailable` is not a refusal: it is
 * the absence of a judgment, and what it means is the person's `whenJevUnavailable` setting rather than a
 * guess made here.
 *
 * Reached only when `guardrailCovers` said the layer is consulted for this effect, which is a different
 * question from the mode: the mode says who is asked, the switches say who is judged.
 */
export async function decideGuardrailForCommand(
  input: CommandToolDeps,
  request: { policy: ExecutionPolicyConfig; envelope: CommandEnvelope; why: string },
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
          instructions: request.policy.guardrails.instructions,
          ...(input.narrowing === undefined
            ? {}
            : { constraints: input.narrowing.map((entry) => ({ id: entry.id, description: entry.description })) }),
          clarifyQuestion:
            "Lệnh này có thể nhắm vào nhiều đối tượng đều hợp lệ. Bạn muốn nói tới cái nào?",
        });

  if (outcome.status === "allow") return { kind: "proceed", envelope: request.envelope };
  if (outcome.status === "deny") {
    /*
     * The refusal says what was refused and what can be done about it.
     *
     * "Guardrail từ chối lệnh này" alone told nobody whether the effect, the scope or the target was the problem, and
     * left a person with nothing to do but give up. The guardrail returns a choice and no prose, so the reason is built
     * from the facts the decision carried rather than invented, and the way out names the surface that owns the switch.
     */
    return {
      kind: "refuse",
      text: `Guardrail từ chối lệnh này (${outcome.reason}). Không có gì được chạy. Xem Settings → Control nếu bạn muốn những lệnh như vậy chạy.`,
    };
  }
  if (outcome.status === "clarify") {
    /*
     * A question rather than a refusal.
     *
     * This used to be handed to the model as prose — "ask the user and propose again" — which made whether anybody
     * was actually asked depend on the model remembering to ask. It is the same judgement either way; what changes is
     * who holds the question. The interaction manager holds it, so the turn ends on it and the answer arrives as its
     * own turn, which is also what lets a click and a spoken sentence be the same answer.
     */
    return { kind: "ask", question: outcome.question };
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

  if (request.policy.guardrails.whenUnavailable === "allow") return { kind: "proceed", envelope: request.envelope };
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
 * Turn a guardrail's request to clarify into a question card.
 *
 * A `text` question rather than a choice, because what the policy layer could not tell apart is the intent itself —
 * offering it options would be pretending it had narrowed the possibilities down. Returns nothing when the node cannot
 * ask, so the caller keeps its text fallback rather than inventing a card nobody can answer.
 */
function askClarify(
  input: { interactions?: InteractionDeps },
  question: string,
): { text: string; hostBlocks: Record<string, unknown>[] } | undefined {
  if (input.interactions === undefined) return undefined;
  const created = createQuestion(input.interactions, { question, kind: "text", allowOther: true });
  if (!created.ok) return undefined;
  return {
    text:
      "Đã hỏi người dùng cho rõ trước khi chạy. Lượt này kết thúc ở đây; câu trả lời sẽ tới ở lượt sau, và không có gì " +
      "chạy trước khi có câu trả lời. Đừng nói là đã chạy.",
    // SAFETY: built against the message-block union by `createQuestion`; the adapter's shape is loose because it must
    // not depend on contracts, and the node validates every block before it reaches a transcript.
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
      "Run one shell command. Whether it runs immediately or waits for the user to approve the exact " +
      "command and folder depends on this node's execution policy, and the result of this call says which " +
      "happened — read it before telling the user anything ran. Pass `where` with the " +
      "place you intend in your own words — look for it first with find_project or search_files, because the " +
      "folder is decided from what you find and the user sees it in the card. Pass `cwd` only when you " +
      "already know the exact directory. Use it for work that needs a shell: git clone, a build, a test run.",
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
    promptSnippet:
      "run_command — run one shell command, immediately or once the user approves it, according to this node's execution policy",
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

      const policy = input.autonomy();
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
      const digest = commandDigest(command, envelope.cwd);

      /*
       * The command path goes through the canonical resolver, like the widget path and the install route.
       *
       * It used to answer this itself, from its own four-value policy plus a list of guarded classes, and the
       * difference is the declared behaviour change: the legacy `guarded` consulted the judgment layer and
       * never opened a card, while the canonical `guarded` asks wherever the effect category or a rule
       * requires it. That is the target recorded in DESIGN.md, not a translation of what was there before,
       * and it is why this is stated rather than described as equivalent.
       *
       * The preflight above is untouched and still first. It is the host's own gate — ownership, existence,
       * budget — and no policy runs before it, which is what keeps a folder this node does not own out of the
       * conversation entirely rather than a question to put to a model.
       */
      const decision = decideExecution({
        policy,
        action: { kind: "effect", category: envelope.effectCategory, operationDigest: digest },
        /*
         * True, and worth being exact about why. The model proposes this command inside a turn, and a turn
         * exists because the user acted — the same reading the widget path takes of a click and the install
         * route takes of "install this package". It is not a claim that the user named this command, and it
         * lifts nothing on its own: a node-wide prohibition, a rule the user wrote, and every hard consent
         * boundary are all read before the intent matters, and the preflight has already run.
         */
        explicitUserIntent: true,
      });

      if (decision.kind === "deny") {
        return {
          text:
            `Node này không chạy lệnh này: ${decision.reason}. Không có gì được chạy. ` +
            `Người dùng đổi lại trong Settings → Control nếu muốn.`,
        };
      }

      /*
       * The judgment layer, on every effect the host allowed and the switches cover — the ones it will execute and
       * the ones it will ask a person about.
       *
       * It runs before the card rather than after it, and that order is the point. A card is a stricter gate than a
       * judgment that can only narrow, but it is not a substitute for one: a guardrail consulted only on the execute
       * branch meant that in Ask every time — the most restrictive mode — the categories the user wrote instructions
       * about were the ones that ran un-narrowed and un-refused once somebody approved the card. So a refusal refuses
       * here, before any card exists, and the envelope the card displays is the same narrowed one the command will run
       * under if it is approved.
       *
       * The layer may refuse, ask for a clarification, or apply one of the host's own narrowings, and a widening is
       * refused rather than clamped.
       */
      let guarded = envelope;
      if (guardrailCovers(policy, envelope)) {
        const judgment = await decideGuardrailForCommand(input, { policy, envelope, why });
        if (judgment.kind === "refuse") {
          // A refusal is an effect too: it is the thing a person asks about later, when work they expected did not
          // happen and nobody can remember why.
          input.audit?.({ summary: judgment.text, outcome: "refused" });
          return { text: judgment.text };
        }
        if (judgment.kind === "ask") {
          const asked = askClarify(input, judgment.question);
          // No trail entry: the question and its answer are blocks in the transcript, which is the durable record of
          // this conversation. An audit kind here would be a second, shallower copy of the same fact.
          if (asked !== undefined) return asked;
          // A node that cannot ask leaves the question with the model. Worse, and said so.
          return { text: `${judgment.question} Hỏi người dùng rồi đề xuất lại.` };
        }
        guarded = judgment.envelope;
      }

      if (decision.kind === "ask") {
        if (input.approvals === undefined) {
          return {
            text:
              "Node này cần người dùng duyệt lệnh này nhưng không có nơi ghi quyết định, nên lệnh không chạy được. " +
              "Đổi mức tự chủ trong Settings → Control.",
          };
        }
        /*
         * The digest is taken from the envelope the command will run under, not from the one the preflight produced:
         * a guardrail may have narrowed the directory, and the approval has to be bound to what actually runs.
         */
        const approvedDigest = commandDigest(guarded.command, guarded.cwd);
        const approval = requestApproval(input.approvals(), {
          operationDigest: approvedDigest,
          operationDescription:
            `Chạy một lệnh trong ${guarded.cwd}` +
            (reason === "" ? "" : ` (${reason})`) +
            (why === "" ? "" : `: ${why}`),
          effectCategory: guarded.effectCategory,
          // A quarter of an hour: long enough to read the command and decide, short enough that a card left
          // on screen overnight cannot be approved the next morning for a stale reason.
          ttlMs: 15 * 60_000,
        });
        return {
          text:
            `Đã gửi yêu cầu duyệt để chạy \`${guarded.command}\` trong ${guarded.cwd}. Chưa có gì chạy cả — người dùng ` +
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
            /*
             * The payload is what runs on approval, and the digest above is what proves it is unchanged. It carries
             * the narrowed envelope whole — the directory and the budget — because a guardrail's narrowing is policy:
             * a card that displayed one envelope and ran another would be the same inversion this ordering fixed.
             */
            payload: JSON.stringify({
              command: guarded.command,
              cwd: guarded.cwd,
              timeoutMs: guarded.budget.timeoutMs,
              maxOutputBytes: guarded.budget.maxOutputBytes,
            }),
          },
        };
      }

      const operationId = input.newId();

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

      /*
       * The effect ledger, kept from main.
       *
       * Two records answer two different questions: the trail says who asked for what and how it ended, and this one
       * says how far an external effect got — which is what a reader needs after a crash between a command starting
       * and its result arriving. It is written before the command starts for exactly that reason.
       */
      const effectAudit = input.effectAudit?.();
      if (effectAudit !== undefined) {
        /*
         * The decision the resolver actually made, and the mode it made it in.
         *
         * Both used to be invented here — a literal `autonomous` and a hand-built execute decision — because the
         * command path had no resolver to quote. Quoting the real one is the point of the ledger: the record now
         * says what decided this, and a mode this build does not know cannot be written down as `autonomous`.
         */
        recordEffectExecution(effectAudit.deps, {
          principalId: effectAudit.principalId,
          mode: policy.mode,
          decision,
          category: guarded.effectCategory,
          operationDigest: commandDigest(guarded.command, guarded.cwd),
          ...(effectAudit.conversationId === undefined ? {} : { conversationId: effectAudit.conversationId }),
          description: `${guarded.command} — ${guarded.cwd}`,
        });
      }

      const ran = await runGuardedCommand({
        operationId,
        envelope: guarded,
        ...(reason === "" ? {} : { reason }),
        ...(why === "" ? {} : { why }),
        ...(env === undefined ? {} : { env }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.run === undefined ? {} : { run: input.run }),
      });

      /*
       * Written down, with what it produced.
       *
       * The summary is the verdict line rather than the command's output: a trail that held output would be a second
       * copy of everything the receipt exists to bound, and a stopped command is recorded as stopped rather than as a
       * failure, because those are the two things a reader needs to tell apart.
       */
      input.audit?.({
        summary: ran.description,
        outcome:
          ran.outcome.stopped === true ? "stopped" : ran.outcome.exitCode === 0 && !ran.outcome.timedOut ? "done" : "failed",
        ref: operationId,
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

/**
 * The tool that writes a memory down.
 *
 * The conversation and the principal come from the turn, never from the model's parameters. A model that
 * could name the conversation it writes into could write into somebody else's, and the whole point of a
 * memory is that it belongs to the person whose node it is.
 *
 * `sourceMessageId` is deliberately not filled: a turn does not reliably know its own message id, and a
 * pointer that might be wrong is worse than no pointer at all, because it would make the Memory tab's
 * "where this came from" a claim nobody can check.
 */
export function createRememberTool(input: {
  db: SessionSearchDeps["db"];
  principalId: string;
  conversationId: string;
  now: () => string;
  newId: (prefix: string) => string;
}): ToolDefinition {
  const deps: MemoryDeps = { db: input.db, now: input.now, newId: input.newId };
  return {
    name: "remember",
    label: "Ghi nhớ một điều",
    description:
      "Keep one thing for later turns: a preference, a fact about a project, or a decision taken here. " +
      "Use it when the user asks you to remember something, or when a choice will matter again. Secrets " +
      "are removed before it is stored. Everything stored is listed in the app's Memory tab, where the " +
      "user can read it and delete it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "scope", "text"],
      properties: {
        kind: {
          type: "string",
          enum: ["preference", "project-fact", "decision"],
          description: "preference about the person, project-fact about a project, or decision taken here.",
        },
        scope: {
          type: "string",
          enum: ["node", "conversation"],
          description: "node for something true everywhere, conversation for something settled in this one.",
        },
        text: { type: "string", description: "The thing to remember, as one sentence." },
      },
    },
    promptSnippet: "remember — keep one thing for later turns",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const kind = memoryKindSchema.safeParse(params.kind);
      const scope = memoryScopeSchema.safeParse(params.scope);
      if (!kind.success || !scope.success) {
        return {
          text: "kind must be preference, project-fact or decision; scope must be node or conversation.",
        };
      }
      if (typeof params.text !== "string") return { text: "text must be a string." };

      const outcome = rememberMemory(deps, {
        principalId: input.principalId,
        conversationId: input.conversationId,
        kind: kind.data,
        scope: scope.data,
        text: params.text,
      });
      if ("refused" in outcome) return { text: `Could not remember it: ${outcome.refused}` };
      return { text: `Remembered (${outcome.kind}): ${outcome.text}` };
    },
  };
}


/**
 * Searching the package directory.
 *
 * The producer for the marketplace-results card, and the reason that card is host-owned: a result asserts a digest
 * and a risk lane, and a model that could mint one could draw a listing that looks verified while pointing at bytes
 * nobody has hashed.
 *
 * The tool is a *finder*, never an installer. It hands back sources, and installing one goes through the same
 * resolver, digest check and generation swap as a path typed by hand. Search is how you find a source, not how you
 * authorise one.
 *
 * "No directory configured" and "nothing matched" are reported as the different things they are.
 */
export function createSearchDirectoryTool(input: {
  indexPath: string | undefined;
  newId: (prefix: string) => string;
}): ToolDefinition {
  return {
    name: "search_directory",
    label: "Tìm gói trong directory",
    description:
      "Search the configured package directory for a widget or package to install. Each result carries its source, " +
      "version, digest and risk lane. Installing one still goes through the normal install path. If no directory is " +
      "configured this says so, which is not the same as finding nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for. An empty string browses the directory." },
      },
    },
    promptSnippet: "search_directory — find a package in the directory, then install it by its source",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const state = readDirectoryIndex(input.indexPath);
      if (state.kind === "not-configured") return { text: state.reason };
      if (state.kind === "unreadable") return { text: `Không đọc được directory: ${state.reason}` };

      const results = searchDirectory({ entries: state.entries, query });
      return {
        text:
          results.length === 0
            ? `Không có gói nào trong ${state.directory} khớp “${query}”.`
            : `Tìm thấy ${results.length} gói trong ${state.directory}.`,
        hostCard: {
          type: "marketplace-results",
          owner: "host",
          cardId: input.newId("market"),
          query,
          directory: state.directory,
          results: results.map((entry) => ({
            packageId: entry.packageId,
            version: entry.version,
            displayName: entry.displayName,
            description: entry.description,
            source: entry.source,
            digest: entry.digest,
            riskTier: entry.riskTier,
            facets: entry.facets,
            platforms: entry.platforms,
          })),
        },
      };
    },
  };
}

/**
 * Asking the user a question, with the answers that will be accepted.
 *
 * The producer for the question card, and the reason that card exists: without it an agent that needs a
 * decision writes a paragraph and then guesses which sentence answered it. Here it names the answers, so a
 * click, a keystroke and a spoken reply all produce the same user message.
 *
 * The tool does not wait for the answer. The turn ends, the card stays in the transcript, and the answer arrives
 * as the user's next message — which is the only shape that works for a conversation that outlives this process.
 */
export function createAskUserTool(newId: (prefix: string) => string): ToolDefinition {
  return {
    name: "ask_user",
    label: "Hỏi người dùng một câu",
    description:
      "Ask the user one question and offer the answers you will accept. Use it when a decision is genuinely " +
      "needed and you cannot pick sensibly yourself — not for confirmation of something you were already asked " +
      "to do. The answer comes back as the user's next message, so end your turn after asking and do not answer " +
      "on their behalf.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", description: "The question, in the user's own language, as one sentence." },
        title: { type: "string", description: "For a form: what the form is for, as one sentence." },
        fields: {
          type: "array",
          maxItems: 12,
          description:
            "For a form instead of a question: the values you need. Each needs a label; `kind` is text, textarea or select, and a select needs `options`.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: {
              label: { type: "string" },
              kind: { type: "string", enum: ["text", "textarea", "select"] },
              options: { type: "array", items: { type: "string" } },
              required: { type: "boolean" },
              placeholder: { type: "string" },
            },
          },
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          description: "The answers the user may choose from. Two to six: fewer is not a choice, more is a list.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: {
              label: { type: "string", description: "What the user sees on the button, and what is sent as their reply." },
              detail: { type: "string", description: "One line clarifying what this choice means." },
            },
          },
        },
      },
    },
    promptSnippet: "ask_user — ask one question with the answers you will accept, then end your turn",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const question = typeof params.question === "string" ? params.question.trim() : "";
      const raw = Array.isArray(params.options) ? params.options : [];
      const options = raw
        .map((entry, index) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          const label = typeof record.label === "string" ? record.label.trim() : "";
          if (label === "") return undefined;
          return {
            id: `option-${index + 1}`,
            label,
            ...(typeof record.detail === "string" && record.detail.trim() !== ""
              ? { detail: record.detail.trim() }
              : {}),
          };
        })
        .filter((entry): entry is { id: string; label: string; detail?: string } => entry !== undefined);

      /*
       * Fields make it a form; options make it a question. One tool rather than two, because the agent's
       * decision is "I need something from the user" and which shape fits is a detail of that.
       */
      const rawFields = Array.isArray(params.fields) ? params.fields : [];
      const fields = rawFields
        .map((entry, index) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          const label = typeof record.label === "string" ? record.label.trim() : "";
          if (label === "") return undefined;
          const kind = record.kind === "textarea" || record.kind === "select" ? record.kind : ("text" as const);
          const choices = Array.isArray(record.options)
            ? record.options.filter((option): option is string => typeof option === "string" && option.trim() !== "")
            : [];
          // A select with nothing to choose from is a control the user cannot use, so it becomes text.
          const usable = kind === "select" && choices.length === 0 ? ("text" as const) : kind;
          return {
            id: `field-${index + 1}`,
            label,
            kind: usable,
            ...(usable === "select" ? { options: choices } : {}),
            ...(record.required === true ? { required: true } : {}),
            ...(typeof record.placeholder === "string" && record.placeholder.trim() !== ""
              ? { placeholder: record.placeholder.trim() }
              : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

      if (fields.length > 0) {
        const title = typeof params.title === "string" && params.title.trim() !== "" ? params.title.trim() : question;
        return {
          text: `Đã gửi một biểu mẫu để hỏi người dùng: “${title}”. Câu trả lời sẽ đến ở lượt kế tiếp — kết thúc lượt này.`,
          hostCard: { type: "form-card", owner: "host", formId: newId("form"), title, fields },
        };
      }

      if (question === "" || options.length < 2) {
        // Refused in the same turn, so the model corrects itself rather than the user seeing an empty card.
        return { text: "Cần một câu hỏi kèm ít nhất hai lựa chọn, hoặc một biểu mẫu có ít nhất một trường." };
      }

      return {
        text:
          `Đã hỏi người dùng: “${question}”. Câu trả lời sẽ đến ở lượt kế tiếp — kết thúc lượt này và đừng ` +
          `tự trả lời thay họ.`,
        hostCard: {
          type: "question-card",
          owner: "host",
          questionId: newId("q"),
          question,
          options,
        },
      };
    },
  };
}
