import { describe, expect, it } from "vitest";

import { DIAGRAM_ID, MAX_DIAGRAM_NODES, diagramProblems, readDiagram, readDiagramState } from "@clarkcant/contracts";
import { DIAGRAM } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";
import { validateProps } from "../src/validate-props.ts";

describe("diagram catalog descriptor and fixtures", () => {
  it("registers the host-rendered definition with fixtures that pass both validators", () => {
    expect(DIAGRAM.id).toBe(DIAGRAM_ID);
    const fixtures = fixturesFor(DIAGRAM_ID);
    expect(fixtures.map((fixture) => fixture.id)).toEqual(["diagram.normal", "diagram.empty"]);
    for (const fixture of fixtures) {
      expect(validateProps(DIAGRAM, fixture.props), fixture.id).toMatchObject({ ok: true });
      expect(diagramProblems(fixture.props), fixture.id).toEqual([]);
      const diagram = readDiagram(fixture.props);
      if (diagram === undefined) throw new Error(fixture.id);
      // A fixture's state names a node it really holds, so the preview opens with that node selected.
      if (fixture.state !== undefined) expect(readDiagramState(fixture.state, diagram)).toEqual(fixture.state);
    }
  });

  it("keeps the JSON Schema and the diagram's checks aligned for malformed diagrams", () => {
    const schemaRefuses = [
      { nodes: [{ id: "a", label: "A", shape: "hexagon" }] },
      { nodes: [{ id: "<a>", label: "A" }] },
      { nodes: [{ id: "a", label: "A‮" }] },
      { nodes: [{ id: "a", label: "A", html: "<b>A</b>" }] },
      { nodes: Array.from({ length: MAX_DIAGRAM_NODES + 1 }, (_, index) => ({ id: `n${String(index)}`, label: "Node" })) },
      { nodes: [], mermaid: "flowchart TB" },
    ];
    for (const props of schemaRefuses) {
      expect(validateProps(DIAGRAM, props), JSON.stringify(props).slice(0, 60)).toMatchObject({ ok: false });
      expect(diagramProblems(props).length).toBeGreaterThan(0);
    }
    // Repeated ids and edges to missing nodes are properties of the graph, checked after the schema.
    const graphRefuses = [
      { nodes: [{ id: "a", label: "A" }, { id: "a", label: "Again" }] },
      { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] },
    ];
    for (const props of graphRefuses) {
      expect(validateProps(DIAGRAM, props)).toMatchObject({ ok: true });
      expect(diagramProblems(props).length).toBeGreaterThan(0);
    }
  });
});
