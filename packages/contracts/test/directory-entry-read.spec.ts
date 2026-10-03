import { describe, expect, it } from "vitest";

import {
  UNREAD_FIELD_NAME_MAX,
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
    expect(read.unreadFields).toEqual(["hostApi.preferred", "publisher.verifiedBy", "rating"]);
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
});

describe("unreadListingFields", () => {
  it("is absent when nothing was left out", () => {
    expect(unreadListingFields([])).toBeUndefined();
  });

  it("keeps the count and bounds the names it carries", () => {
    const many = Array.from({ length: 20 }, (_, index) => `field${String(index)}`);
    const long = "x".repeat(200);
    const note = unreadListingFields([long, "", ...many]);
    expect(note?.count).toBe(22);
    expect(note?.names).toHaveLength(UNREAD_FIELD_NAMES_MAX);
    expect(note?.names[0]?.length).toBe(UNREAD_FIELD_NAME_MAX);
    expect(note?.names[1]).toBe('""');
    expect(unreadListingFieldsSchema.safeParse(note).success).toBe(true);
  });

  it("never cuts a character in half", () => {
    const note = unreadListingFields(["😀".repeat(40)]);
    expect(unreadListingFieldsSchema.safeParse(note).success).toBe(true);
    expect(note?.names[0]?.endsWith("😀…")).toBe(true);
  });
});
