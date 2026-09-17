import type { ToolDefinition } from "@clarkcant/pi-adapter";

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
}): ToolDefinition[] {
  return [
    createSearchHistoryTool(input.search),
    createFindRuntimeTool({
      db: input.search.db,
      nodeId: input.search.nodeId,
      now: input.search.now,
    }),
    createFindProjectTool(input.projects),
  ];
}
