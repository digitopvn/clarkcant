import { FAMILY_BY_DEFINITION, WIDGETS } from "@clarkcant/data-canvas";
import { describe, expect, it } from "vitest";

import { resolveRenderer } from "../src/renderers.tsx";

/**
 * The catalog, checked as a whole.
 *
 * V11's caution was that the designed catalog's completeness must not be inferred from the families
 * that happen to have a browser journey. So this checks every definition instead of the ones that
 * were convenient: each has a family, a renderer the client can actually draw it with, and a text
 * description. A definition added without one of those fails here rather than in front of somebody.
 *
 * What this does not claim, and the conformance ledger says so in the row: not every family has a
 * browser journey. The families that do are the ones a suggestion chip can ask for.
 */

describe("every definition in the catalog", () => {
  it("is actually listed, so this is checking the list that ships", () => {
    // Without this, every assertion below would pass on an empty catalog.
    expect(WIDGETS.length).toBeGreaterThan(0);
  });

  it("has a family, so a candidate set can filter on it and the release gate has something to require", () => {
    const withoutFamily = WIDGETS.map((definition) => definition.id).filter((id) => {
      const family: string | undefined = FAMILY_BY_DEFINITION[id];
      return family === undefined || family === "unknown";
    });
    expect(withoutFamily).toEqual([]);
  });

  it("has a renderer, so the client draws it instead of falling back to the text alternative", () => {
    // `canvas.overview@1` is the composition container, not a leaf: the composition path in
    // `Conversation.tsx` checks it before the leaf lookup precisely because it has no entry here.
    // Every other definition has to resolve to a renderer.
    const CONTAINER = "canvas.overview@1";
    const withoutRenderer = WIDGETS.map((definition) => definition.id).filter(
      (id) => id !== CONTAINER && resolveRenderer(id) === undefined,
    );
    expect(withoutRenderer).toEqual([]);
  });

  it("carries a text description, which is what a reader gets when the picture does not help", () => {
    const withoutText = WIDGETS.filter((definition) => {
      const described = definition.semanticDescription;
      return typeof described !== "string" || described.trim() === "";
    }).map((definition) => definition.id);
    expect(withoutText).toEqual([]);
  });

  it("covers every id the family map names, so the map and the catalog cannot drift apart", () => {
    // The other direction matters as much: an entry left behind after a definition is renamed would
    // keep a family occupied that nothing can draw.
    const listed = new Set(WIDGETS.map((definition) => definition.id));
    const stale = Object.keys(FAMILY_BY_DEFINITION).filter((id) => !listed.has(id));
    expect(stale).toEqual([]);
  });
});
