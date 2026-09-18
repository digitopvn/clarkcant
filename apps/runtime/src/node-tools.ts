import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { describeSearch, machineRoots, searchFileSystem } from "./fs-search.ts";
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
}): ToolDefinition[] {
  return [
    createSearchHistoryTool(input.search),
    createSearchFilesTool(input.roots ?? machineRoots),
    createFindRuntimeTool({
      db: input.search.db,
      nodeId: input.search.nodeId,
      now: input.search.now,
    }),
    createFindProjectTool(input.projects),
  ];
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
