import { describe, expect, it } from "vitest";

import { MAX_DIAGRAM_EDGES, MAX_DIAGRAM_NODES, diagramEdgeLabelWidth, layoutDiagram, readDiagram, wrapDiagramLabel, type Diagram } from "../src/index.ts";

function diagram(props: unknown): Diagram {
  const read = readDiagram(props);
  if (read === undefined) throw new Error("expected a valid diagram");
  return read;
}

const FLOW = {
  nodes: [
    { id: "a", label: "Start", shape: "round" },
    { id: "b", label: "Decide", shape: "diamond" },
    { id: "c", label: "Left" },
    { id: "d", label: "Right" },
    { id: "e", label: "End", shape: "circle" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "e" },
    { from: "d", to: "e" },
    { from: "a", to: "e", label: "skip" },
    { from: "e", to: "a", label: "again" },
  ],
};

/** The densest graph the limits allow: 60 nodes, 120 edges, long edges across many layers and cycles. */
function worstCase(layout: "layered" | "tree"): Diagram {
  const nodes = Array.from({ length: MAX_DIAGRAM_NODES }, (_, index) => ({ id: `n${String(index)}`, label: `Node number ${String(index)} with a long label` }));
  if (layout === "tree") {
    return diagram({ layout, nodes, edges: nodes.slice(1).map((node, index) => ({ from: `n${String(Math.floor(index / 2))}`, to: node.id })) });
  }
  const edges: { from: string; to: string }[] = [];
  for (let index = 0; index + 1 < MAX_DIAGRAM_NODES; index += 1) edges.push({ from: `n${String(index)}`, to: `n${String(index + 1)}` });
  // Jumps of 29 and more, wrapping round: long edges across many layers, and edges back up that close cycles.
  for (let step = 29; edges.length < MAX_DIAGRAM_EDGES; step += 1) {
    for (let index = 0; index < MAX_DIAGRAM_NODES && edges.length < MAX_DIAGRAM_EDGES; index += 3) {
      edges.push({ from: `n${String(index)}`, to: `n${String((index + step) % MAX_DIAGRAM_NODES)}` });
    }
  }
  return diagram({ nodes, edges });
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("the diagram layout", () => {
  it("is the same for the same diagram, every time", () => {
    const first = layoutDiagram(diagram(FLOW));
    for (let run = 0; run < 5; run += 1) expect(layoutDiagram(diagram(structuredClone(FLOW)))).toEqual(first);
    expect(layoutDiagram(worstCase("layered"))).toEqual(layoutDiagram(worstCase("layered")));
  });

  it("layers along the flow, breaking a cycle where the props close it", () => {
    const layout = layoutDiagram(diagram(FLOW));
    const layer = Object.fromEntries(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 2, d: 2, e: 3 });
    expect(layout.layers).toEqual([["a"], ["b"], ["c", "d"], ["e"]]);
    const back = layout.edges.find((edge) => edge.from === "e" && edge.to === "a");
    expect(back?.points[0]?.y).toBeGreaterThan(back?.points.at(-1)?.y ?? 0);
    // The long edge a → e bends through the two layers it crosses.
    expect(layout.edges.find((edge) => edge.from === "a" && edge.to === "e")?.points).toHaveLength(4);
    expect(layout.edges.find((edge) => edge.from === "a" && edge.to === "b")?.labelAt).toBeUndefined();
    expect(layout.edges.find((edge) => edge.from === "a" && edge.to === "e")?.labelAt).toBeDefined();
  });

  it("keeps every node inside the drawing and apart from the others, in both directions", () => {
    for (const direction of ["TB", "LR"]) {
      for (const source of [diagram({ ...FLOW, direction }), worstCase("layered"), worstCase("tree")]) {
        const layout = layoutDiagram({ ...source, direction: direction as "TB" | "LR" });
        for (const node of layout.nodes) {
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.y).toBeGreaterThanOrEqual(0);
          expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
          expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
          for (const other of layout.nodes) if (other !== node) expect(overlaps(node, other)).toBe(false);
        }
        for (const edge of layout.edges) for (const point of edge.points) expect(Number.isInteger(point.x) && Number.isInteger(point.y)).toBe(true);
      }
    }
  });

  it("widens the gap an edge label sits in, so no node covers it, in both directions", () => {
    const label = "a forty character label for the edge ok";
    for (const direction of ["TB", "LR"] as const) {
      const layout = layoutDiagram(diagram({ direction, nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], edges: [{ from: "a", to: "b", label }, { from: "a", to: "c" }] }));
      const edge = layout.edges.find((candidate) => candidate.to === "b");
      if (edge?.labelAt === undefined) throw new Error("the labelled edge has a label position");
      // The box the page draws behind a label: its character width across, 20 high.
      const half = { x: diagramEdgeLabelWidth(label) / 2, y: 10 };
      const box = { x: edge.labelAt.x - half.x, y: edge.labelAt.y - half.y, width: half.x * 2, height: half.y * 2 };
      for (const node of layout.nodes) expect(overlaps(box, node), `the label overlaps ${node.id} (${direction})`).toBe(false);
    }
  });

  it("draws two edges between the same nodes, one each way, on separate lines", () => {
    const layout = layoutDiagram(diagram({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "go" }, { from: "b", to: "a", label: "back" }] }));
    const [there, back] = layout.edges;
    expect(there?.points[0]?.x).not.toBe(back?.points.at(-1)?.x);
    expect(there?.labelAt).not.toEqual(back?.labelAt);
  });

  it("places a tree's children under their parent", () => {
    const layout = layoutDiagram(
      diagram({
        layout: "tree",
        nodes: [{ id: "r", label: "Root" }, { id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
        edges: [{ from: "r", to: "a" }, { from: "r", to: "b" }, { from: "a", to: "c" }],
      }),
    );
    const at = Object.fromEntries(layout.nodes.map((node) => [node.id, node]));
    const center = (id: string): number => (at[id]?.x ?? 0) + (at[id]?.width ?? 0) / 2;
    expect(center("c")).toBe(center("a"));
    expect(center("r")).toBe((center("a") + center("b")) / 2);
    expect(layout.layers).toEqual([["r"], ["a", "b"], ["c"]]);
  });

  it("wraps labels by character, a long word included", () => {
    expect(wrapDiagramLabel("Kiểm tra bản phát hành", 10)).toEqual(["Kiểm tra", "bản phát", "hành"]);
    expect(wrapDiagramLabel("abcdefghijklmnopqrstuvwxy", 10)).toEqual(["abcdefghij", "klmnopqrst", "uvwxy"]);
    expect(wrapDiagramLabel("", 10)).toEqual([""]);
  });

  it("lays out the largest diagram the limits allow within a bounded time", () => {
    const layered = worstCase("layered");
    const tree = worstCase("tree");
    const started = performance.now();
    for (let run = 0; run < 20; run += 1) {
      layoutDiagram(layered);
      layoutDiagram(tree);
    }
    // Twenty runs of each: a real regression to a super-quadratic step would take seconds, not this budget.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
