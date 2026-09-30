import { describe, expect, it } from "vitest";

import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  readTree,
  readTreeState,
  treeProblems,
  treeSemantic,
  treeStateProblems,
  treeText,
} from "../src/index.ts";

const VALID = {
  title: "Project",
  initiallyExpanded: ["root", "app"],
  nodes: [
    {
      id: "root",
      label: "ClarkCant",
      icon: "project",
      children: [
        { id: "app", label: "App", icon: "folder", children: [{ id: "composer", label: "Composer", secondary: "Ready", icon: "document" }] },
      ],
    },
  ],
};

function deepTree(level: number): Record<string, unknown>[] {
  let node: Record<string, unknown> = { id: `n${String(level)}`, label: `Node ${String(level)}` };
  for (let current = level - 1; current >= 1; current -= 1) node = { id: `n${String(current)}`, label: `Node ${String(current)}`, children: [node] };
  return [node];
}

describe("the bounded tree contract", () => {
  it("accepts a nested outline and reads its count and depth", () => {
    expect(treeProblems(VALID)).toEqual([]);
    expect(readTree(VALID)).toMatchObject({ title: "Project", nodeCount: 3, depth: 3, initiallyExpanded: ["root", "app"] });
  });

  it("refuses duplicate ids, cycles, excess depth, node count, unknown icons and hidden characters", () => {
    expect(treeProblems({ nodes: [{ id: "a", label: "A" }, { id: "a", label: "Again" }] }).join(" ")).toMatch(/ids repeat/u);
    const cyclic: { id: string; label: string; children?: unknown[] } = { id: "cycle", label: "Cycle" };
    cyclic.children = [cyclic];
    expect(treeProblems({ nodes: [cyclic] })).toContain("tree contains a cycle");
    expect(treeProblems({ nodes: deepTree(MAX_TREE_DEPTH + 1) })).toContain(`tree depth is greater than ${String(MAX_TREE_DEPTH)}`);
    expect(treeProblems({ nodes: Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) => ({ id: `n${String(index)}`, label: "Node" })) })).toContain(
      `tree has more than ${String(MAX_TREE_NODES)} nodes`,
    );
    expect(treeProblems({ nodes: [{ id: "a", label: "A", icon: "unknown" }] }).join(" ")).toMatch(/icon/u);
    expect(treeProblems({ nodes: [{ id: "a", label: "A‮B" }] }).join(" ")).toMatch(/U\+202E/u);
  });

  it("requires unique existing initially expanded branch ids", () => {
    expect(treeProblems({ nodes: [{ id: "root", label: "Root", children: [{ id: "child", label: "Child" }] }], initiallyExpanded: ["root", "root"] }).join(" ")).toMatch(/repeats/u);
    expect(treeProblems({ nodes: [{ id: "root", label: "Root" }], initiallyExpanded: ["missing"] }).join(" ")).toMatch(/missing nodes/u);
    expect(treeProblems({ nodes: [{ id: "root", label: "Root", children: [{ id: "child", label: "Child" }] }], initiallyExpanded: ["child"] }).join(" ")).toMatch(/leaf nodes/u);
  });

  it("ignores stale saved ids and exposes a bounded semantic path", () => {
    const tree = readTree(VALID);
    if (tree === undefined) throw new Error("valid tree did not read");
    const state = readTreeState({ selectedId: "composer", expandedIds: ["root", "missing", "app", "composer"] }, tree);
    expect(state).toEqual({ selectedId: "composer", expandedIds: ["root", "app"] });
    expect(treeStateProblems(tree, { selectedId: "missing" })).toMatchObject([expect.stringContaining("must name a node")]);
    expect(treeStateProblems(tree, { expandedIds: ["composer"] })).toContain("expandedIds must name at most 200 expandable branches on this tree");
    expect(treeSemantic(tree, state)).toMatchObject({
      summary: expect.stringContaining("selected ClarkCant / App / Composer"),
      values: { nodeCount: 3, depth: 3, expandedNodes: 2, selectedPath: "ClarkCant / App / Composer" },
      selectedIds: ["composer"],
    });
  });

  it("uses an indented text outline when the renderer is unavailable", () => {
    const tree = readTree(VALID);
    if (tree === undefined) throw new Error("valid tree did not read");
    expect(treeText(tree)).toContain("- ClarkCant\n  - App\n    - Composer — Ready");
  });
});
