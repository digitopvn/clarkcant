import { describe, expect, it } from "vitest";

import { libraryEntries } from "@clarkcant/widget-catalog";

import {
  CLOSED_LIBRARY,
  applyLibraryAction,
  familyFacets,
  selectedEntry,
  visibleEntries,
  type WidgetLibraryState,
} from "../src/widget-library/widget-library-state.ts";

/**
 * The library's state machine.
 *
 * These assertions are pure on purpose: the repo runs Vitest in Node with no DOM, and the parts of
 * the surface that are easy to get wrong - filtering, selection, and what closing restores - are
 * exactly the parts that do not need a DOM to check. Anything about rendered focus or layout belongs
 * in the Playwright journeys.
 */

const entries = libraryEntries();

function opened(mode: "browse" | "develop" = "browse"): WidgetLibraryState {
  return applyLibraryAction(CLOSED_LIBRARY, { kind: "open", mode });
}

const ids = (state: WidgetLibraryState): readonly string[] =>
  visibleEntries(entries, state).map((entry) => entry.definition.id);

describe("widget library state", () => {
  it("opens in browse mode with nothing filtered", () => {
    const state = opened();
    expect(state).toEqual({ open: true, mode: "browse", query: "", family: "all", selectedId: undefined });
  });

  it("opens in develop mode when the lab asked for it", () => {
    expect(opened("develop").mode).toBe("develop");
  });

  it("closes back to exactly the closed state", () => {
    const open = applyLibraryAction(opened(), { kind: "query", value: "lich" });
    expect(applyLibraryAction(open, { kind: "close" })).toEqual(CLOSED_LIBRARY);
  });

  it("filters by an unaccented Vietnamese query", () => {
    const state = applyLibraryAction(opened(), { kind: "query", value: "lich" });
    expect(ids(state)).toContain("canvas.calendar@1");
  });

  it("filters by family", () => {
    const state = applyLibraryAction(opened(), { kind: "family", value: "media" });
    const families = visibleEntries(entries, state).map((entry) => entry.family);
    expect(new Set(families)).toEqual(new Set(["media"]));
  });

  it("shows an empty result rather than an error for a query that matches nothing", () => {
    const state = applyLibraryAction(opened(), { kind: "query", value: "zzzz" });
    expect(ids(state)).toEqual([]);
  });

  it("keeps the query and family when stepping back out of a widget", () => {
    let state = applyLibraryAction(opened(), { kind: "family", value: "media" });
    state = applyLibraryAction(state, { kind: "select", cardId: "canvas.gallery@1" });
    const back = applyLibraryAction(state, { kind: "back" });
    expect(back.selectedId).toBeUndefined();
    expect(back.family).toBe("media");
  });

  it("drops a stale selection when the filter changes", () => {
    let state = applyLibraryAction(opened(), { kind: "select", cardId: "canvas.calendar@1" });
    state = applyLibraryAction(state, { kind: "query", value: "table" });
    expect(state.selectedId).toBeUndefined();
  });

  it("resolves a selected entry only while the id still exists", () => {
    const state = applyLibraryAction(opened(), { kind: "select", cardId: "canvas.calendar@1" });
    expect(selectedEntry(entries, state)?.definition.id).toBe("canvas.calendar@1");
    expect(selectedEntry([], state)).toBeUndefined();
  });

  it("lands on the widget a spoken command named instead of on the grid", () => {
    const state = applyLibraryAction(CLOSED_LIBRARY, {
      kind: "open",
      target: { definitionId: "canvas.calendar@1" },
    });
    expect(state.selectedId).toBe("canvas.calendar@1");
    expect(state.family).toBe("all");
  });

  it("filters to a family a spoken command named", () => {
    const state = applyLibraryAction(CLOSED_LIBRARY, { kind: "open", target: { family: "media" } });
    expect(state.family).toBe("media");
    expect(state.selectedId).toBeUndefined();
  });

  it("offers every family in the catalog plus an unfiltered option", () => {
    const facets = familyFacets(entries);
    expect(facets[0]).toBe("all");
    expect(facets).toContain("trend");
    expect(facets).toContain("media");
  });

  it("never offers the composition container", () => {
    expect(ids(opened())).not.toContain("canvas.overview@1");
  });
});
