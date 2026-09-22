import { FAMILY_BY_DEFINITION, WIDGETS } from "@clarkcant/data-canvas";
import { describe, expect, it } from "vitest";

import {
  CATALOG_DEFINITIONS,
  CATALOG_ENTRIES,
  catalogEntry,
  catalogFamilies,
  catalogMetaIds,
  isContainerDefinition,
  libraryEntries,
} from "../src/registry.ts";

/**
 * The catalog, checked as a whole.
 *
 * The point of these checks is that a definition cannot be added without also being describable: an
 * entry with no metadata, a family that names nothing, or a container that quietly appears as a
 * browsable widget all fail here rather than in front of somebody.
 */

describe("catalog registry", () => {
  it("covers every definition the pack ships, plus the sample-only note", () => {
    const listed = new Set(CATALOG_ENTRIES.map((entry) => entry.definition.id));
    const missing = WIDGETS.map((definition) => definition.id).filter((id) => !listed.has(id));
    expect(missing).toEqual([]);
    // The note is deliberately outside `WIDGETS`: that list is the model's callable view vocabulary,
    // so adding a widget to it is a model-surface change rather than a metadata refactor.
    expect(listed.has("canvas.note@1")).toBe(true);
    expect(WIDGETS.map((definition) => definition.id)).not.toContain("canvas.note@1");
  });

  it("has explicit metadata for every definition, so nothing falls back to a raw id", () => {
    expect(catalogMetaIds()).toEqual(
      CATALOG_DEFINITIONS.map((definition) => definition.id).sort((a, b) => a.localeCompare(b)),
    );
  });

  it("gives every entry a non-empty display name and description", () => {
    const empty = CATALOG_ENTRIES.filter(
      (entry) => entry.displayName.trim() === "" || entry.description.trim() === "",
    ).map((entry) => entry.definition.id);
    expect(empty).toEqual([]);
  });

  it("matches the family map wherever the family map claims the definition", () => {
    const mismatched = CATALOG_ENTRIES.filter((entry) => {
      const mapped = FAMILY_BY_DEFINITION[entry.definition.id];
      return mapped !== undefined && entry.family !== mapped;
    }).map((entry) => entry.definition.id);
    expect(mismatched).toEqual([]);
  });

  it("marks built-ins as builtin with a real status", () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.source).toBe("builtin");
      expect(["stable", "experimental"]).toContain(entry.status);
    }
  });

  it("keeps the composition container out of the library-visible set", () => {
    expect(isContainerDefinition("canvas.overview@1")).toBe(true);
    expect(libraryEntries().map((entry) => entry.definition.id)).not.toContain("canvas.overview@1");
  });

  it("exposes only catalog-renderer leaves to the library", () => {
    for (const entry of libraryEntries()) {
      expect(entry.definition.renderer).toBe("catalog");
      expect(isContainerDefinition(entry.definition.id)).toBe(false);
    }
  });

  it("resolves an entry by definition id and reports an unknown id honestly", () => {
    expect(catalogEntry("canvas.calendar@1")?.displayName).toBe("Lịch");
    expect(catalogEntry("canvas.not-a-widget@9")).toBeUndefined();
  });

  it("lists families from the visible entries only", () => {
    expect(catalogFamilies()).toContain("trend");
    expect(catalogFamilies()).not.toContain("layout");
  });
});
