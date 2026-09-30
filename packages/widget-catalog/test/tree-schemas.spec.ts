import { describe, expect, it } from "vitest";

import { MAX_TREE_DEPTH, MAX_TREE_NODES, TREE_ID, treeProblems } from "@clarkcant/contracts";
import { TREE } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";
import { validateProps } from "../src/validate-props.ts";

const GOOD = {
  title: "Project",
  initiallyExpanded: ["root"],
  nodes: [{ id: "root", label: "ClarkCant", icon: "project", children: [{ id: "app", label: "App", icon: "folder" }] }],
};

function deepTree(level: number): Record<string, unknown>[] {
  let node: Record<string, unknown> = { id: `n${String(level)}`, label: `Node ${String(level)}` };
  for (let current = level - 1; current >= 1; current -= 1) node = { id: `n${String(current)}`, label: `Node ${String(current)}`, children: [node] };
  return [node];
}

describe("tree catalog descriptor and fixtures", () => {
  it("registers the host-rendered definition with a fixture that passes both validators", () => {
    expect(TREE.id).toBe(TREE_ID);
    for (const fixture of fixturesFor(TREE_ID)) {
      expect(validateProps(TREE, fixture.props), fixture.id).toMatchObject({ ok: true });
      expect(treeProblems(fixture.props), fixture.id).toEqual([]);
    }
  });

  it("keeps the model schema and runtime semantic checks aligned for valid and malformed trees", () => {
    const bad = [
      { nodes: [{ id: "a", label: "A", icon: "alien" }] },
      { nodes: [{ id: "a", label: "A" }, { id: "a", label: "Again" }] },
      { nodes: deepTree(MAX_TREE_DEPTH + 1) },
      { nodes: Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) => ({ id: `n${String(index)}`, label: "Node" })) },
      { nodes: [{ id: "a", label: "A" }], initiallyExpanded: ["missing"] },
    ];
    expect(validateProps(TREE, GOOD)).toMatchObject({ ok: true });
    expect(treeProblems(GOOD)).toEqual([]);
    expect(bad.every((props) => treeProblems(props).length > 0)).toBe(true);
    expect(validateProps(TREE, bad[0] as Record<string, unknown>)).toMatchObject({ ok: false });
    expect(validateProps(TREE, bad[2] as Record<string, unknown>)).toMatchObject({ ok: false });
    // Uniqueness and references are graph properties, so they are checked after structural schema validation.
    expect(validateProps(TREE, bad[1] as Record<string, unknown>)).toMatchObject({ ok: true });
    expect(treeProblems(bad[1] as Record<string, unknown>)).not.toEqual([]);
  });
});
