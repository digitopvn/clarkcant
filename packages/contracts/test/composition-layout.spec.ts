import { describe, expect, it } from "vitest";

import {
  type LayoutNode,
  LAYOUT_COMPOSITION_SCHEMA_VERSION,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
  SURFACE_COMPOSITION_SCHEMA_VERSION,
  checkLayout,
  checkSurfaceCompositionSpec,
  describeLayout,
  layoutNodeSchema,
  layoutSectionIds,
  measureLayout,
  surfaceCompositionSpecSchema,
} from "../src/index.ts";

/**
 * The layout tree of a composed surface.
 *
 * What is protected here is that a tree is only arrangement: it names sections by id and nothing else, it is bounded,
 * and every section is placed exactly once, so a region is never drawn twice or silently lost.
 */

const widget = (sectionId: string, label?: string): LayoutNode => ({
  kind: "widget",
  sectionId,
  ...(label === undefined ? {} : { label }),
});

const dashboard: LayoutNode = {
  kind: "grid",
  columns: 3,
  children: [widget("metrics-1"), widget("metrics-2"), { kind: "card", label: "Chi tiết", children: [widget("filter-1"), widget("table-1")] }],
};
const ids = new Set(["metrics-1", "metrics-2", "filter-1", "table-1"]);

function nest(depth: number): LayoutNode {
  let node: LayoutNode = widget("metrics-1");
  for (let level = 1; level < depth; level += 1) node = { kind: "stack", children: [node] };
  return node;
}

describe("a layout tree", () => {
  it("parses a grid of two tiles and a card, and places each section once", () => {
    expect(layoutNodeSchema.parse(dashboard)).toEqual(dashboard);
    expect(checkLayout(dashboard, ids)).toEqual([]);
    expect(layoutSectionIds(dashboard)).toEqual(["metrics-1", "metrics-2", "filter-1", "table-1"]);
  });

  it("refuses any field that is not arrangement", () => {
    for (const extra of [
      { kind: "widget", sectionId: "metrics-1", props: { datasetRef: "x" } },
      { kind: "widget", sectionId: "metrics-1", widget: "canvas.metrics@1" },
      { kind: "card", children: [widget("metrics-1")], script: "alert(1)" },
      { kind: "divider", label: "x" },
      { kind: "iframe", children: [widget("metrics-1")] },
    ]) {
      expect(layoutNodeSchema.safeParse(extra).success).toBe(false);
    }
  });

  it("is bounded in depth and node count, and says which bound it crossed", () => {
    expect(checkLayout(nest(MAX_LAYOUT_DEPTH), new Set(["metrics-1"]))).toEqual([]);
    expect(checkLayout(nest(MAX_LAYOUT_DEPTH + 1), new Set(["metrics-1"])).join(" ")).toContain("levels deep");

    const wide: LayoutNode = {
      kind: "stack",
      children: Array.from({ length: 4 }, () => ({ kind: "row", children: Array.from({ length: 12 }, () => ({ kind: "divider" })) }) as LayoutNode),
    };
    expect(checkLayout(wide, new Set()).join(" ")).toContain(`more than ${String(MAX_LAYOUT_NODES)} nodes`);
  });

  it("stops measuring a tree once it is already too big", () => {
    // A tree far past the bounds costs no more to measure than one just past them.
    const measured = measureLayout(nest(10_000));
    expect(measured.depth).toBe(MAX_LAYOUT_DEPTH + 1);
  });

  it("places every section exactly once and names only sections the composition has", () => {
    const twice: LayoutNode = { kind: "stack", children: [widget("metrics-1"), widget("metrics-1")] };
    expect(checkLayout(twice, new Set(["metrics-1"])).join(" ")).toContain("placed 2 times");
    expect(checkLayout(widget("metrics-1"), new Set(["metrics-1", "table-1"])).join(" ")).toContain('"table-1" is not placed');
    expect(checkLayout(widget("ghost"), new Set()).join(" ")).toContain('"ghost", which the composition does not have');
  });

  it("holds each container to its own rules", () => {
    const problems = (node: LayoutNode): string => checkLayout(node, ids).join(" ");
    const all = [widget("metrics-1"), widget("metrics-2"), widget("filter-1"), widget("table-1")];
    expect(problems({ kind: "split", children: all })).toContain("a split has two");
    expect(problems({ kind: "tabs", children: all })).toContain("tab 1 needs a label");
    expect(problems({ kind: "collapsible", children: all })).toContain("needs a label");
    expect(problems({ kind: "stack", columns: 2, children: all })).toContain("only a grid has");
    expect(problems({ kind: "stack", open: true, children: all })).toContain("only a collapsible has");
    expect(
      problems({ kind: "tabs", children: [{ kind: "stack", label: "A", children: all.slice(0, 2) }, { kind: "stack", label: "B", children: all.slice(2) }] }),
    ).toBe("");
  });

  it("reads as text, labels first, for a reader who cannot see it", () => {
    const text = describeLayout(dashboard, (sectionId) => `[${sectionId}]`);
    expect(text).toBe("[metrics-1] [metrics-2] Chi tiết: [filter-1] [table-1]");
  });
});

describe("a composition with a tree", () => {
  const spec = {
    schemaVersion: LAYOUT_COMPOSITION_SCHEMA_VERSION,
    compositionId: "comp_1",
    instanceId: "winst_1",
    templateId: "layout",
    templateVersion: "1",
    catalogDigest: "sha256:catalog",
    sections: [...ids].map((sectionId) => ({
      sectionId,
      slot: sectionId.split("-")[0],
      definitionRef: { id: `canvas.${sectionId.split("-")[0] ?? ""}@1`, version: "1.0.0", digest: "sha256:d" },
      props: {},
      dataRefs: [],
      textAlternative: sectionId,
    })),
    initialState: { period: "week", timezone: "UTC" },
    actions: [],
    provenance: {
      createdAt: "2026-09-29T00:00:00.000Z",
      templateId: "layout",
      templateVersion: "1",
      selector: { mode: "explicit", policyVersion: "1" },
      sourceRevisions: [],
    },
    layout: dashboard,
  };

  it("lets two sections share a kind of region, because the tree places them", () => {
    const parsed = surfaceCompositionSpecSchema.parse(spec);
    expect(checkSurfaceCompositionSpec(parsed)).toEqual({ ok: true });
  });

  it("keeps the version and the tree in agreement", () => {
    const withoutTree = surfaceCompositionSpecSchema.parse({ ...spec, layout: undefined });
    const check = checkSurfaceCompositionSpec(withoutTree);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(" ")).toContain("needs a layout");

    const oldWithTree = surfaceCompositionSpecSchema.parse({ ...spec, schemaVersion: SURFACE_COMPOSITION_SCHEMA_VERSION });
    const old = checkSurfaceCompositionSpec(oldWithTree);
    expect(old.ok).toBe(false);
  });

  it("checks the tree against the sections it holds", () => {
    const parsed = surfaceCompositionSpecSchema.parse({ ...spec, layout: { kind: "stack", children: [widget("metrics-1")] } });
    const check = checkSurfaceCompositionSpec(parsed);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join(" ")).toContain("is not placed anywhere");
  });
});
