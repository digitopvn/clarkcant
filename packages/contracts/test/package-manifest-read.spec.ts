import { describe, expect, it } from "vitest";

import { MAX_PACKAGE_FACETS, describeSkippedFacet, manifestProblems, packageManifestSchema, readPackageManifest } from "../src/index.ts";

/**
 * How a host reads a package manifest: a facet kind it does not know is skipped and reported, never refused, while
 * everything it does know stays as strict as the schema.
 */

const UI = { kind: "ui", id: "com.example.board.main@1", entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" };
const NEWER = { kind: "agents", id: "com.example.board.agents", entry: "agents/index.json", isolation: "declarative", runs: { every: "1h" } };

function manifest(facets: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "com.example.board",
    version: "1.0.0",
    displayName: "Board",
    description: "A board.",
    hostApi: { min: 1, max: 1 },
    facets,
    requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["linux-x64"],
    ...extra,
  };
}

describe("readPackageManifest", () => {
  it("accepts a package with a facet kind it does not know, leaving the facet out and reporting it", () => {
    const read = readPackageManifest(manifest([UI, NEWER]));
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data.facets).toEqual([UI]);
    expect(read.skippedFacets).toEqual([{ index: 1, kind: "agents", id: "com.example.board.agents", isolation: "declarative" }]);
    expect(describeSkippedFacet(read.skippedFacets[0]!)).toBe(
      'facet com.example.board.agents: kind "agents" is declared but not understood by this version of ClarkCant, so it is skipped',
    );
    expect(manifestProblems(read.data)).toEqual([]);
  });

  it("reports only what it can show as written: a position for an id that is not one, and no unknown lane", () => {
    const read = readPackageManifest(manifest([{ kind: "agents", id: "../x", isolation: "kernel" }, UI]));
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.skippedFacets).toEqual([{ index: 0, kind: "agents" }]);
    expect(describeSkippedFacet(read.skippedFacets[0]!)).toContain('facet #0: kind "agents"');
  });

  it("still refuses a known kind with a bad body", () => {
    for (const broken of [
      { ...UI, isolation: "service" },
      { ...UI, extra: true },
      { kind: "skills", id: "com.example.board.skills", isolation: "declarative" },
    ]) {
      expect(readPackageManifest(manifest([broken, NEWER])).success, JSON.stringify(broken)).toBe(false);
    }
    // A problem names the facet by its place in the file, not in the list left after skipping.
    const read = readPackageManifest(manifest([NEWER, { ...UI, isolation: "service" }]));
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.error.issues[0]?.path.slice(0, 2)).toEqual(["facets", 1]);
  });

  it("refuses a facet whose kind is not a plain name, since that is a broken facet rather than a newer one", () => {
    for (const kind of ["", "has space", "x".repeat(65), 7, null]) {
      expect(readPackageManifest(manifest([UI, { ...NEWER, kind }])).success, JSON.stringify(kind)).toBe(false);
    }
  });

  it("refuses a manifest whose facets are all skipped, because nothing of it could run here", () => {
    const read = readPackageManifest(manifest([NEWER]));
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.error.issues[0]?.message).toBe("declares no facet kind this version of ClarkCant understands (agents); update ClarkCant");
  });

  it("keeps the rest of the manifest strict: an unknown top-level field and an unread version still refuse it", () => {
    expect(readPackageManifest(manifest([UI, NEWER], { trust: "full" })).success).toBe(false);
    expect(readPackageManifest(manifest([UI, NEWER], { schemaVersion: 4 })).success).toBe(false);
  });

  it("counts skipped facets toward the facet limit", () => {
    const many = Array.from({ length: MAX_PACKAGE_FACETS }, (_, index) => ({ ...NEWER, id: `agents-${String(index)}` }));
    expect(readPackageManifest(manifest([UI, ...many])).success).toBe(false);
    expect(readPackageManifest(manifest([UI, ...many.slice(1)])).success).toBe(true);
  });

  it("leaves the writer's schema strict: an unknown kind is still refused there", () => {
    expect(packageManifestSchema.safeParse(manifest([UI, NEWER])).success).toBe(false);
  });
});
