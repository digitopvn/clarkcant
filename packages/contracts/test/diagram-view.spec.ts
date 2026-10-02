import { describe, expect, it } from "vitest";

import {
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_NODES,
  SEMANTIC_LIMITS,
  diagramNeighbours,
  diagramProblems,
  diagramSelectionProblems,
  diagramSemantic,
  diagramText,
  readDiagram,
  readDiagramState,
} from "../src/index.ts";

const VALID = {
  title: "Release",
  nodes: [
    { id: "plan", label: "Plan", shape: "round" },
    { id: "build", label: "Build", group: "CI" },
    { id: "test", label: "Tests pass?", shape: "diamond", group: "CI" },
    { id: "ship", label: "Ship", shape: "circle" },
    { id: "docs", label: "Docs" },
  ],
  edges: [
    { from: "plan", to: "build" },
    { from: "build", to: "test" },
    { from: "test", to: "ship", label: "yes" },
    { from: "test", to: "build", label: "no" },
    { from: "ship", to: "docs", direction: "none" },
    { from: "plan", to: "docs", direction: "both" },
  ],
};

function chain(count: number): { nodes: { id: string; label: string }[]; edges: { from: string; to: string }[] } {
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `n${String(index)}`, label: `Node ${String(index)}` }));
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ from: `n${String(index)}`, to: node.id })) };
}

describe("the bounded diagram contract", () => {
  it("accepts nodes in four shapes with groups, and edges with labels and directions", () => {
    expect(diagramProblems(VALID)).toEqual([]);
    const diagram = readDiagram(VALID);
    expect(diagram).toMatchObject({ title: "Release", layout: "layered", direction: "TB" });
    expect(diagram?.nodes.map((node) => node.shape)).toEqual(["round", "box", "diamond", "circle", "box"]);
    expect(diagram?.edges.map((edge) => edge.direction)).toEqual(["forward", "forward", "forward", "forward", "none", "both"]);
  });

  it("refuses an unknown shape, a missing node, repeated ids, loops and repeated edges", () => {
    expect(diagramProblems({ nodes: [{ id: "a", label: "A", shape: "hexagon" }] }).join(" ")).toMatch(/shape/u);
    expect(diagramProblems({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] })).toEqual([
      'edge 1 names "ghost", which is not a node',
    ]);
    expect(diagramProblems({ nodes: [{ id: "a", label: "A" }, { id: "a", label: "Again" }] }).join(" ")).toMatch(/node ids repeat: a/u);
    expect(diagramProblems({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "a" }] }).join(" ")).toMatch(/from a node to itself/u);
    expect(
      diagramProblems({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }] }).join(" "),
    ).toMatch(/edges repeat/u);
  });

  it("refuses an oversized graph by its count, before reading any node", () => {
    const nodes = Array.from({ length: MAX_DIAGRAM_NODES + 1 }, () => "not even a node");
    expect(diagramProblems({ nodes })).toEqual([`the diagram has ${String(MAX_DIAGRAM_NODES + 1)} nodes; at most 60 are drawn`]);
    const edges = Array.from({ length: MAX_DIAGRAM_EDGES + 1 }, () => ({}));
    expect(diagramProblems({ nodes: [], edges })[0]).toMatch(/121 edges; at most 120/u);
  });

  it("refuses hidden characters, markup-shaped ids and extra fields", () => {
    expect(diagramProblems({ nodes: [{ id: "a", label: "A‮B" }] }).join(" ")).toMatch(/U\+202E/u);
    expect(diagramProblems({ nodes: [{ id: "a", label: "line\nbreak" }] }).join(" ")).toMatch(/U\+000A/u);
    expect(diagramProblems({ nodes: [{ id: "<script>", label: "A" }] }).join(" ")).toMatch(/is not an id/u);
    expect(diagramProblems({ nodes: [{ id: "a", label: "A", href: "https://example.com" }] }).join(" ")).toMatch(/href/u);
    expect(diagramProblems({ nodes: [], svg: "<svg/>" }).join(" ")).toMatch(/svg/u);
  });

  it("holds the tree layout to one parent per node and no cycle", () => {
    const twoParents = { layout: "tree", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }] };
    expect(diagramProblems(twoParents).join(" ")).toMatch(/c has more than one/u);
    const cycle = { layout: "tree", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    expect(diagramProblems(cycle).join(" ")).toMatch(/cycle/u);
    expect(diagramProblems({ ...cycle, layout: "layered" })).toEqual([]);
  });

  it("names each node's neighbours by direction", () => {
    const diagram = readDiagram(VALID);
    if (diagram === undefined) throw new Error("valid");
    const test = diagramNeighbours(diagram, "test");
    expect(test.previous.map((node) => node.id)).toEqual(["build"]);
    expect(test.next.map((node) => node.id)).toEqual(["ship", "build"]);
    const docs = diagramNeighbours(diagram, "docs");
    expect(docs.linked.map((node) => node.id)).toEqual(["ship"]);
    expect(docs.next.map((node) => node.id)).toEqual(["plan"]);
    expect(docs.previous.map((node) => node.id)).toEqual(["plan"]);
  });

  it("checks a selection against the nodes, and reads only one that still names a node", () => {
    const diagram = readDiagram(VALID);
    if (diagram === undefined) throw new Error("valid");
    expect(diagramSelectionProblems(diagram, { selectedId: "ship" })).toEqual([]);
    expect(diagramSelectionProblems(diagram, { selectedId: "" })).toEqual([]);
    expect(diagramSelectionProblems(diagram, { selectedId: "ghost" })[0]).toMatch(/not a node/u);
    expect(diagramSelectionProblems(diagram, { selectedId: "ship", extra: 1 })[0]).toMatch(/only selectedId/u);
    expect(readDiagramState({ selectedId: "ship" }, diagram)).toEqual({ selectedId: "ship" });
    expect(readDiagramState({ selectedId: "ghost" }, diagram)).toEqual({});
  });

  it("writes an adjacency list that names every node and edge", () => {
    const diagram = readDiagram(VALID);
    if (diagram === undefined) throw new Error("valid");
    expect(diagramText(diagram)).toBe(
      [
        "Release: 5 nodes, 6 edges",
        "- Plan: → Build, ↔ Docs",
        "- Build [CI]: → Tests pass?",
        "- Tests pass? [CI]: → Ship (yes), → Build (no)",
        "- Ship: — Docs",
        "- Docs",
      ].join("\n"),
    );
    expect(diagramText(diagram, 40)).toMatch(/… \(shortened\)$/u);
  });

  it("reads the selected node and its neighbours within the semantic limits", () => {
    const diagram = readDiagram(VALID);
    if (diagram === undefined) throw new Error("valid");
    const semantic = diagramSemantic(diagram, { selectedId: "test" });
    expect(semantic.summary).toBe("Diagram: 5 nodes, 6 edges, layered top to bottom; selected Tests pass? (1 in, 2 out, 0 linked)");
    expect(semantic.values).toMatchObject({ selectedLabel: "Tests pass?", selectedGroup: "CI", previous: ["Build"], next: ["Ship (yes)", "Build (no)"] });
    expect(semantic.selectedIds).toEqual(["test"]);
    const big = readDiagram(chain(MAX_DIAGRAM_NODES));
    if (big === undefined) throw new Error("valid");
    const wide = readDiagram({
      nodes: big.nodes.map(({ id, label }) => ({ id, label })),
      edges: big.nodes.slice(1).map((node) => ({ from: "n0", to: node.id })),
    });
    if (wide === undefined) throw new Error("valid");
    const hub = diagramSemantic(wide, { selectedId: "n0" });
    expect((hub.values.next as string[]).length).toBe(SEMANTIC_LIMITS.list);
    expect(hub.summary.length).toBeLessThanOrEqual(SEMANTIC_LIMITS.summary);
  });
});
