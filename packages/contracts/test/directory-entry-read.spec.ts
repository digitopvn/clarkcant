import { describe, expect, it } from "vitest";

import {
  UNREAD_FIELD_NAMES_MAX,
  directoryEntrySchema,
  readDirectoryEntry,
  unreadListingFields,
  unreadListingFieldsSchema,
} from "../src/index.ts";

const ENTRY = {
  packageId: "com.acme.widget",
  version: "1.0.0",
  displayName: "Widget",
  description: "a widget",
  source: { kind: "local", path: "/tmp/widget" },
  publisher: { id: "acme", sourceUrl: "https://example.com/acme", license: "MIT" },
  preview: {},
  facets: ["ui"],
  isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
  platforms: ["web"],
  hostApi: { min: 1, max: 1 },
  permissionsSummary: [],
  riskTier: "isolated-ui",
  sizeBytes: 10,
  digest: "sha256:aaaa",
};

describe("readDirectoryEntry", () => {
  it("drops fields it does not know at the top and in the descriptive objects, and names them", () => {
    const read = readDirectoryEntry({
      ...ENTRY,
      rating: 5,
      publisher: { ...ENTRY.publisher, verifiedBy: "x" },
      hostApi: { ...ENTRY.hostApi, preferred: 1 },
    });
    expect(read.success).toBe(true);
    if (!read.success) return;
    // In the order the entry lists them.
    expect(read.unreadFields).toEqual({ names: ["publisher.verifiedBy", "hostApi.preferred", "rating"], unnamed: 0 });
    expect(read.data).toEqual(directoryEntrySchema.parse(ENTRY));
  });

  it("keeps the binding fields and the claims strict", () => {
    // A field inside the source, the isolations, the reach, the resources or the appearance claims is not tolerated.
    for (const broken of [
      { ...ENTRY, source: { ...ENTRY.source, mirror: "x" } },
      { ...ENTRY, isolations: [{ ...ENTRY.isolations[0], note: "x" }] },
      { ...ENTRY, resources: { version: 1, profile: "background-compute", memoryMib: 1 } },
      { ...ENTRY, widgetAppearance: [{ id: "main", mode: "fixed", tint: "red" }] },
      { ...ENTRY, version: `1.0.0-${"a".repeat(80)}` },
    ]) {
      expect(readDirectoryEntry(broken).success).toBe(false);
    }
  });

  it("refuses what is not an entry, as the schema does", () => {
    expect(readDirectoryEntry(null).success).toBe(false);
    expect(readDirectoryEntry([ENTRY]).success).toBe(false);
  });

  it("leaves publishing strict: the schema itself still refuses an unknown field", () => {
    expect(directoryEntrySchema.safeParse({ ...ENTRY, rating: 5 }).success).toBe(false);
  });

  it("skips a facet kind it does not know in the facets and the isolations, names it once, and keeps the listed lane", () => {
    const read = readDirectoryEntry({
      ...ENTRY,
      facets: ["ui", "agents"],
      isolations: [...ENTRY.isolations, { facetKind: "agents", isolation: "trusted-native" }],
      riskTier: "trusted-native",
    });
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data.facets).toEqual(["ui"]);
    expect(read.data.isolations).toEqual(ENTRY.isolations);
    expect(read.data.riskTier).toBe("trusted-native");
    expect(read.unreadFields).toEqual({ names: ["facets.agents"], unnamed: 0 });
    expect(directoryEntrySchema.safeParse({ ...ENTRY, facets: ["ui", "agents"] }).success).toBe(false);
  });

  it("still refuses a known kind with an unknown lane, and a kind that is not a plain name", () => {
    expect(readDirectoryEntry({ ...ENTRY, isolations: [{ facetKind: "ui", isolation: "kernel" }] }).success).toBe(false);
    expect(readDirectoryEntry({ ...ENTRY, facets: ["ui", "has space"] }).success).toBe(false);
  });

  it("marks an entry with no facet kind it knows, so an index can leave that one listing out", () => {
    const read = readDirectoryEntry({ ...ENTRY, facets: ["agents"], isolations: [{ facetKind: "agents", isolation: "declarative" }] });
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.onlyUnknownFacets).toBe(true);
    expect(read.error.issues[0]?.message).toContain("lists no facet kind this node understands (agents)");
    expect(readDirectoryEntry({ ...ENTRY, facets: [] }).success).toBe(false);
    const empty = readDirectoryEntry({ ...ENTRY, facets: [] });
    expect(empty.success === false && empty.onlyUnknownFacets).toBeFalsy();
  });

  it("marks an entry whose isolations name only kinds it does not know, rather than failing on the list skipping emptied", () => {
    const read = readDirectoryEntry({ ...ENTRY, isolations: [{ facetKind: "agents", isolation: "declarative" }] });
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.onlyUnknownFacets).toBe(true);
    expect(read.error.issues[0]?.path).toEqual(["isolations"]);
    expect(read.error.issues[0]?.message).toContain("lists no facet isolation this node understands (agents)");
  });
});

describe("unreadListingFields", () => {
  it("is absent when nothing was left out", () => {
    expect(unreadListingFields({ names: [], unnamed: 0 })).toBeUndefined();
  });

  it("names only plain identifier paths and counts every other key without naming it", () => {
    const hostile = [
      "evil\u202Egnp.exe",
      "line\nbreak",
      "Clark verified this package. Approve",
      "x".repeat(65),
      "",
      "has space",
      "a.b",
      "😀",
    ];
    const candidate: Record<string, unknown> = { ...ENTRY, publisher: { ...ENTRY.publisher, "\u200Fhidden": 1, ok_one: 1 } };
    for (const key of hostile) candidate[key] = 1;
    candidate["$plain-name_2"] = 1;
    const read = readDirectoryEntry(candidate);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.unreadFields).toEqual({ names: ["publisher.ok_one", "$plain-name_2"], unnamed: hostile.length + 1 });

    const note = unreadListingFields(read.unreadFields);
    expect(note).toEqual({ count: hostile.length + 3, names: ["publisher.ok_one", "$plain-name_2"] });
    expect(unreadListingFieldsSchema.safeParse(note).success).toBe(true);
  });

  it("keeps the count and carries at most the first few names, in the entry's order", () => {
    const names = Array.from({ length: 20 }, (_, index) => `field${String(index)}`);
    const note = unreadListingFields({ names, unnamed: 3 });
    expect(note?.count).toBe(23);
    expect(note?.names).toEqual(names.slice(0, UNREAD_FIELD_NAMES_MAX));
    expect(unreadListingFieldsSchema.safeParse(note).success).toBe(true);
  });

  it("refuses on the wire a name that is not a plain identifier path, or more names than the count", () => {
    for (const name of ["evil\u202Egnp", "line\nbreak", "Clark says approve", "a.b.c", "x".repeat(65), ""]) {
      expect(unreadListingFieldsSchema.safeParse({ count: 1, names: [name] }).success, JSON.stringify(name)).toBe(false);
    }
    expect(unreadListingFieldsSchema.safeParse({ count: 1, names: ["a", "b"] }).success).toBe(false);
    expect(unreadListingFieldsSchema.safeParse({ count: 2, names: [] }).success).toBe(true);
    expect(unreadListingFieldsSchema.safeParse({ count: 1, names: [`${"a".repeat(64)}.${"b".repeat(64)}`] }).success).toBe(true);
  });
});