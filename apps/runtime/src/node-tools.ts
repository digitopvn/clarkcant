import type { ToolDefinition } from "@clarkcant/pi-adapter";
import { requestApproval, type CoordinationDeps } from "@clarkcant/core";

import { describeSearch, machineRoots, searchFileSystem } from "./fs-search.ts";
import { commandDigest, guardCommand, type CommandPlacement } from "./run-command.ts";
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
   * Where an approval request is recorded, when this node may run commands at all.
   *
   * Absent means `run_command` is not registered: a node with no way to record a decision has no way to
   * ask for one, and a tool that could only refuse is worse than no tool.
   */
  approvals?: () => CoordinationDeps;
  /** Where a command may run, and why. */
  placement?: () => CommandPlacement;
  /** Resolve a folder from the model's words, through the finder and its decider. */
  resolveFolder?: (intent: string) => Promise<
    | { status: "resolved"; cwd: string; relPath: string }
    | { status: "ask"; message: string; options: readonly string[] }
  >;
}): ToolDefinition[] {
  const roots = input.roots ?? machineRoots;
  const placement = input.placement;
  return [
    createSearchHistoryTool(input.search),
    createSearchFilesTool(roots),
    ...(input.approvals === undefined || placement === undefined
      ? []
      : [
          createRunCommandTool({
            approvals: input.approvals,
            placement,
            ...(input.resolveFolder === undefined ? {} : { resolveFolder: input.resolveFolder }),
          }),
        ]),
    createFindRuntimeTool({
      db: input.search.db,
      nodeId: input.search.nodeId,
      now: input.search.now,
    }),
    createFindProjectTool(input.projects),
  ];
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
  placement: () => CommandPlacement;
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
    label: "Chạy lệnh trong thư mục đã duyệt",
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

      const guard = guardCommand({ command, cwd, placement: input.placement() });
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
