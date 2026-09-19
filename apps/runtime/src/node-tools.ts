import { join } from "node:path";

import { ATTACHMENT_LIMITS, attachmentIdSchema, memoryKindSchema, memoryScopeSchema } from "@clarkcant/contracts";
import { getAttachment } from "@clarkcant/storage";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import { requestApproval, type CoordinationDeps } from "@clarkcant/core";

import { blobsDir, readBlob } from "./blobs.ts";
import { describeSearch, machineRoots, searchFileSystem } from "./fs-search.ts";
import { commandDigest, guardCommand } from "./run-command.ts";
import type { ProjectFinderDeps } from "./project-finder.ts";
import { createFindProjectTool } from "./project-finder.ts";
import { createFindRuntimeTool } from "./runtime-candidates.ts";
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
   * Where an approval request is recorded, when this node may run commands at all.
   *
   * Absent means `run_command` is not registered: a node with no way to record a decision has no way to
   * ask for one, and a tool that could only refuse is worse than no tool.
   */
  approvals?: () => CoordinationDeps;
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
}): ToolDefinition[] {
  const roots = input.roots ?? machineRoots;
  return [
    createSearchHistoryTool(input.search),
    createSearchFilesTool(roots),
    ...(input.approvals === undefined
      ? []
      : [
          createRunCommandTool({
            approvals: input.approvals,
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
 * Running a command, as the model may ask for it.
 *
 * The tool does not run anything. It records a request and hands back the card that asks the user, and
 * the command runs only when that card is approved — which is why the description says so in the first
 * sentence. A model that believed it had already run something would tell the user it was done.
 *
 * The description also sends it looking for a place first, because the operator's decision was that the
 * agent may work anywhere it can justify: `where` is an intent ("somewhere beside my other projects") and
 * it is resolved by the project finder, which is where Jev decides when several folders could be meant.
 * Naming no place at all is not an option the model has — it either finds one or asks.
 */
export function createRunCommandTool(input: {
  approvals: () => CoordinationDeps;
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
}): ToolDefinition {
  return {
    name: "run_command",
    label: "Chạy một lệnh, sau khi bạn duyệt",
    description:
      "Ask to run one shell command. Nothing runs until the user approves the exact command and folder in " +
      "the card this creates, so say that you are asking rather than that you did it. Pass `where` with the " +
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
      },
    },
    promptSnippet: "run_command — propose a shell command; the user must approve it before it runs",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const command = typeof params.command === "string" ? params.command.trim() : "";
      if (command === "") return { text: "Cần một lệnh để chạy." };

      let cwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd.trim() : undefined;
      let because: string | undefined;

      const where = typeof params.where === "string" ? params.where.trim() : "";
      if (cwd === undefined && where !== "" && input.resolveFolder !== undefined) {
        const found = await input.resolveFolder(where);
        if (found.status === "ask") {
          // Several folders could be meant, so the question goes back through the model: it is the one
          // holding the conversation, and the user's answer then names the folder it wanted.
          const options = found.options.length === 0 ? "" : ` Có thể là: ${found.options.join(", ")}.`;
          return { text: `${found.message}${options} Hãy chọn một thư mục rồi đề xuất lại.` };
        }
        cwd = found.cwd;
        because = `được tìm thấy từ “${where}” (${found.relPath})`;
      }

      const guard = guardCommand({ command, cwd });
      if (!guard.ok || guard.cwd === undefined) {
        // Refused here, in the same turn, so the model can correct itself rather than the user finding out
        // that a command cannot run where it asked.
        return { text: guard.message ?? "Không xin được quyền chạy lệnh đó." };
      }

      const resolvedCwd = guard.cwd;
      const why = typeof params.why === "string" && params.why.trim() !== "" ? params.why.trim() : "";
      const reason = because ?? guard.because ?? "";
      const digest = commandDigest(command, resolvedCwd);
      const approval = requestApproval(input.approvals(), {
        operationDigest: digest,
        operationDescription:
          `Chạy một lệnh trong ${resolvedCwd}` + (reason === "" ? "" : ` (${reason})`) + (why === "" ? "" : `: ${why}`),
        effectCategory: "local-write",
        // A quarter of an hour: long enough to read the command and decide, short enough that a card left
        // on screen overnight cannot be approved the next morning for a stale reason.
        ttlMs: 15 * 60_000,
      });

      return {
        text:
          `Đã gửi yêu cầu duyệt để chạy \`${command}\` trong ${resolvedCwd}. Chưa có gì chạy cả — người dùng ` +
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
          payload: JSON.stringify({ command, cwd: resolvedCwd }),
        },
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
