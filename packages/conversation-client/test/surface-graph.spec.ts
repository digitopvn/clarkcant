import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI } from "../src/i18n/messages.ts";
import { STATE_EVENT_OPERATION, actionForIntent, composedImageRefs, surfaceGraph } from "../src/mini-app-surface.tsx";

/**
 * How a composed page routes what a leaf reports.
 *
 * A section can hold two bindings, one it acts through and one that reports to the surface's graph, and a press sent to
 * the wrong one is either refused by the node or, worse, performs the other. The rendering itself is asserted in the
 * browser journey.
 */

const ACTIONS = [
  { actionBindingId: "act_select", sectionId: "calendar-1", operation: "date.select" },
  { actionBindingId: "act_graph", sectionId: "calendar-1", operation: STATE_EVENT_OPERATION },
  { actionBindingId: "act_period", sectionId: "filter-1" },
];

const section = (sectionId: string, id: string, props: Record<string, unknown> = {}) => ({
  sectionId,
  definitionRef: { id, version: "1.0.0", digest: "sha256:x" },
  props,
});

describe("routing a leaf's report", () => {
  it("sends a graph event to the graph binding and anything else to the section's own", () => {
    expect(actionForIntent(ACTIONS, { sectionId: "calendar-1", action: STATE_EVENT_OPERATION })?.actionBindingId).toBe("act_graph");
    expect(actionForIntent(ACTIONS, { sectionId: "calendar-1", action: "date.select" })?.actionBindingId).toBe("act_select");
    expect(actionForIntent(ACTIONS, { sectionId: "filter-1", action: "period.change" })?.actionBindingId).toBe("act_period");
    // A section with no graph binding has nothing to send a graph event to.
    expect(actionForIntent(ACTIONS, { sectionId: "filter-1", action: STATE_EVENT_OPERATION })).toBeUndefined();
  });

  it("runs the graph a surface declares, or the one its search box implies on a surface stored before graphs", () => {
    const declared = { state: { metric: { type: "string" as const, initial: "completed" } }, on: [], feed: [] };
    expect(surfaceGraph({ graph: declared, sections: [] })).toBe(declared);
    const older = surfaceGraph({
      sections: [section("search-1", "canvas.search@1", { query: "acme" }), section("table-1", "canvas.table@1")] as never,
    });
    expect(older?.state.query?.initial).toBe("acme");
    expect(older?.feed).toEqual([{ sectionId: "table-1", op: "query", key: "query" }]);
    expect(surfaceGraph({ sections: [section("table-1", "canvas.table@1")] as never })).toBeUndefined();
  });

  it("fetches every picture a composed surface asks for, from an image leaf and from a gallery or carousel", () => {
    expect(
      composedImageRefs([
        { props: { imageRef: "image_one" } },
        { props: { imageRefs: ["image_two", "image_one", "", 7] } },
        { props: { title: "Bảng" } },
      ]),
    ).toEqual(["image_one", "image_two"]);
  });

  it("says which series a chart shows, and why it kept its own, in both languages", () => {
    for (const messages of [MESSAGES_EN, MESSAGES_VI]) {
      expect(messages["widgets.chart.showingSeries"]).toContain("{series}");
      expect(messages["widgets.chart.seriesMissing"]).toContain("{series}");
      expect(messages["widgets.list.noMatch"]).toBeTruthy();
    }
  });
});
