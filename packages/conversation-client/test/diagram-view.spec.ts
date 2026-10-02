import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DIAGRAM_ID, layoutDiagram, readDiagram, type Diagram } from "@clarkcant/contracts";

import { diagramKeyTarget } from "../src/diagram-navigation.ts";
import { CATALOG, type RendererProps } from "../src/renderers.tsx";

const PROPS = {
  title: "Release",
  nodes: [
    { id: "plan", label: "Plan", shape: "round" },
    { id: "build", label: "Build", group: "CI" },
    { id: "lint", label: "Lint", group: "CI" },
    { id: "test", label: "Tests pass?", shape: "diamond" },
    { id: "ship", label: "Ship", shape: "circle" },
    { id: "notes", label: "Notes" },
  ],
  edges: [
    { from: "plan", to: "build" },
    { from: "plan", to: "lint" },
    { from: "build", to: "test" },
    { from: "lint", to: "test" },
    { from: "test", to: "ship", label: "yes" },
    { from: "ship", to: "notes", direction: "none" },
  ],
};

function diagramOf(props: unknown): Diagram {
  const diagram = readDiagram(props);
  if (diagram === undefined) throw new Error("expected a diagram");
  return diagram;
}

function render(props: Record<string, unknown>, state?: Record<string, unknown>): string {
  const renderer = CATALOG[DIAGRAM_ID];
  if (renderer === undefined) throw new Error("the diagram has no renderer");
  const input: RendererProps = { definitionId: DIAGRAM_ID, props, dataset: undefined, state };
  return renderToStaticMarkup(createElement(renderer, input));
}

describe("moving through a diagram by keyboard", () => {
  const diagram = diagramOf(PROPS);
  const layout = layoutDiagram(diagram);

  it("follows edges along the flow and back, to the nearest target first", () => {
    expect(diagramKeyTarget("ArrowDown", diagram, layout, "build")).toBe("test");
    expect(diagramKeyTarget("ArrowUp", diagram, layout, "test")).toMatch(/^(build|lint)$/u);
    expect(diagramKeyTarget("ArrowDown", diagram, layout, "plan")).toMatch(/^(build|lint)$/u);
    // An undirected edge counts both ways.
    expect(diagramKeyTarget("ArrowDown", diagram, layout, "ship")).toBe("notes");
    expect(diagramKeyTarget("ArrowUp", diagram, layout, "notes")).toBe("ship");
    expect(diagramKeyTarget("ArrowDown", diagram, layout, "notes")).toBe("ship");
    expect(diagramKeyTarget("ArrowUp", diagram, layout, "plan")).toBeUndefined();
  });

  it("steps across a layer, and Home and End go to the first and last node", () => {
    const layer = layout.layers.find((ids) => ids.includes("build")) ?? [];
    expect(layer).toHaveLength(2);
    expect(diagramKeyTarget("ArrowRight", diagram, layout, layer[0] ?? "")).toBe(layer[1]);
    expect(diagramKeyTarget("ArrowLeft", diagram, layout, layer[1] ?? "")).toBe(layer[0]);
    expect(diagramKeyTarget("ArrowLeft", diagram, layout, layer[0] ?? "")).toBeUndefined();
    expect(diagramKeyTarget("Home", diagram, layout, "ship")).toBe("plan");
    expect(diagramKeyTarget("End", diagram, layout, "plan")).toBe("notes");
    expect(diagramKeyTarget("Enter", diagram, layout, "plan")).toBeUndefined();
  });

  it("turns the keys with the direction: Right follows the flow left to right", () => {
    const sideways = diagramOf({ ...PROPS, direction: "LR" });
    const sidewaysLayout = layoutDiagram(sideways);
    expect(diagramKeyTarget("ArrowRight", sideways, sidewaysLayout, "build")).toBe("test");
    expect(diagramKeyTarget("ArrowLeft", sideways, sidewaysLayout, "test")).toMatch(/^(build|lint)$/u);
    const column = sidewaysLayout.layers.find((ids) => ids.includes("build")) ?? [];
    expect(diagramKeyTarget("ArrowDown", sideways, sidewaysLayout, column[0] ?? "")).toBe(column[1]);
  });
});

describe("the diagram renderer", () => {
  it("draws each node as a button named with its shape, group and neighbours, and one tab stop", () => {
    const html = render(PROPS);
    expect(html.match(/role="button"/gu)).toHaveLength(6);
    expect(html.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="Build, hộp, thuộc nhóm CI, dẫn tới Tests pass?, đến từ Plan"');
    expect(html).toContain('aria-label="Notes, hộp, nối với Ship"');
    expect(html).toContain('aria-label="Tests pass?, hình thoi, dẫn tới Ship, đến từ Build, Lint"');
    expect(html).toContain("Nút: 6 · Cạnh: 6");
  });

  it("highlights the held selection's edges and neighbours, and ignores a selection of a node it does not hold", () => {
    const html = render(PROPS, { selectedId: "test" });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-diagram-node="test"/u);
    expect(html.match(/data-neighbour="true"/gu)).toHaveLength(3);
    expect(html.match(/data-lit="true"/gu)).toHaveLength(3);
    expect(html).toContain('data-diagram-selected-node="test"');
    const stale = render(PROPS, { selectedId: "ghost" });
    expect(stale).not.toContain('aria-pressed="true"');
    expect(stale).toContain('data-diagram-selected=""');
  });

  it("draws labels shaped like markup as text, with no script, foreignObject, handler or link", () => {
    const html = render({
      nodes: [
        { id: "a", label: "<img src=x onerror=alert(1)>" },
        { id: "b", label: "<script>alert(1)</script>" },
        { id: "c", label: "javascript:alert(1)" },
      ],
      edges: [{ from: "a", to: "b", label: "<b>x</b>" }, { from: "b", to: "c" }],
    });
    expect(html).not.toMatch(/<(script|img|foreignObject|a|iframe|image|use)\b/iu);
    // An attribute named on…, as opposed to the same letters inside a label's text or an aria-label's value.
    expect(html).not.toMatch(/\son[a-z]+="/iu);
    expect(html).not.toMatch(/href=/iu);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("keeps marker ids to characters every url() reads", () => {
    const ids = [...render(PROPS).matchAll(/marker-end="url\(#([^)]*)\)"/gu)].map((match) => match[1] ?? "");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("says when there is nothing to draw, or when the props are not a diagram", () => {
    expect(render({ title: "Empty", nodes: [] })).toContain('data-diagram-empty="true"');
    expect(render({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "missing" }] })).toContain('data-widget-unavailable="true"');
  });

  it("lists every node and edge as text", () => {
    const html = render(PROPS);
    expect(html).toContain('data-diagram-text-node="test"');
    expect(html).toContain("Tests pass?: → Ship (yes)");
    expect(html).toContain("Ship: — Notes");
  });
});
