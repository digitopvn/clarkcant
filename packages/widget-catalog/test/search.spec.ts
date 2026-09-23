import { describe, expect, it } from "vitest";

import { CATALOG_ENTRIES, libraryEntries } from "../src/registry.ts";
import { normaliseQuery, searchCatalog } from "../src/search.ts";

/**
 * Search, from a person's point of view.
 *
 * The accent-insensitivity is the part worth testing: speech transcription and hurried typing both
 * drop tone marks, so `lich` and `lịch` have to find the same widget or the search looks broken half
 * the time.
 */

const entries = libraryEntries();
const ids = (query: string): readonly string[] =>
  searchCatalog(entries, query).map((entry) => entry.definition.id);

describe("catalog search", () => {
  it("finds the calendar by its accented Vietnamese name", () => {
    expect(ids("lịch")).toContain("canvas.calendar@1");
  });

  it("finds the calendar by the unaccented spelling a transcriber may produce", () => {
    expect(ids("lich")).toContain("canvas.calendar@1");
  });

  it("finds charts by an unaccented Vietnamese phrase", () => {
    expect(ids("bieu do")).toContain("canvas.line@1");
  });

  it("finds a widget by its definition id", () => {
    expect(ids("canvas.table@1")[0]).toBe("canvas.table@1");
  });

  it("finds widgets by family", () => {
    expect(ids("media")).toContain("canvas.gallery@1");
  });

  it("finds a widget by tag", () => {
    expect(ids("trend")).toContain("canvas.line@1");
  });

  it("returns everything for an empty query, because an empty library reads as broken", () => {
    expect(searchCatalog(entries, "").length).toBe(entries.length);
    expect(searchCatalog(entries, "   ").length).toBe(entries.length);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchCatalog(entries, "zzzz-not-a-widget")).toEqual([]);
  });

  it("folds Vietnamese đ as well as tone marks", () => {
    expect(normaliseQuery("Đồ thị")).toBe("do thi");
  });

  it("keeps the composition container out of what the library searches", () => {
    // The container is still a catalog entry - it has metadata and a family - so the exclusion is a
    // property of the library view rather than of the registry. Both directions are asserted here so
    // neither can be "fixed" by hiding the entry outright.
    expect(CATALOG_ENTRIES.map((entry) => entry.definition.id)).toContain("canvas.overview@1");
    expect(ids("tổng quan")).not.toContain("canvas.overview@1");
  });
});
