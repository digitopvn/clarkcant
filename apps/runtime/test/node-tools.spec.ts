import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeTools } from "../src/node-tools.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The tools a turn may call.
 *
 * This list is asserted rather than described because of how one entry went missing: `find_project`
 * was defined, unit-tested and required by the plan's phase 11, and the entry point never put it in
 * the list the model is given. A tool that exists and is never offered is a tool nobody has.
 */

let dir: string;
let services: NodeServices;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-tools-"));
  services = bootNodeServices({ dataDir: dir, label: "tools node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the node's tools", () => {
  it("offers the model every read-only report, including the project finder", () => {
    const tools = createNodeTools({ search: services.search, projects: services.projects });
    expect(tools.map((tool) => tool.name)).toEqual(["search_history", "search_files", "find_runtime", "find_project"]);

    for (const tool of tools) {
      // A tool with no description is a tool the model cannot decide to use.
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("answers find_project without opening anything", async () => {
    const tool = createNodeTools({ search: services.search, projects: services.projects }).find(
      (candidate) => candidate.name === "find_project",
    );
    const result = await tool?.execute({ query: "nothing matches this on a fresh node" });
    // A report, not a side effect: no session is started and no directory is opened.
    expect(typeof result?.text).toBe("string");
    expect(result?.text).not.toContain("/Users/");
  });
});
