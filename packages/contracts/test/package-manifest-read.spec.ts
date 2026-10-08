import { describe, expect, it } from "vitest";

import {
  MAX_PACKAGE_FACETS,
  describeSkippedFacet,
  manifestProblems,
  packageGenerationSchema,
  packageManifestSchema,
  readPackageManifest,
  recordSkippedFacets,
  recordedSkippedFacetSchema,
  skippedFacetLane,
  withoutFacetsSkippedAtInstall,
} from "../src/index.ts";

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

  it("treats only a lowercase name as a possible newer kind, so a mistyped known kind is refused rather than skipped", () => {
    for (const kind of ["UI", "Tools", "Agents", "agents_v2"]) {
      const read = readPackageManifest(manifest([UI, { ...NEWER, kind }]));
      expect(read.success, kind).toBe(false);
    }
    expect(readPackageManifest(manifest([UI, { ...NEWER, kind: "agents-v2" }])).success).toBe(true);
  });

  it("refuses the schemaVersion 1 kind widget in a later manifest, saying what to write instead", () => {
    const read = readPackageManifest(manifest([UI, { ...NEWER, kind: "widget" }]));
    expect(read.success).toBe(false);
    if (read.success) return;
    expect(read.error.issues[0]?.path).toEqual(["facets", 1, "kind"]);
    expect(read.error.issues[0]?.message).toBe('kind "widget" is the schemaVersion 1 name of a ui facet; a schemaVersion 2 or 3 manifest names it "ui"');
    // Alone, too: an update would never make it readable, so it is not reported as a version gap.
    const alone = readPackageManifest(manifest([{ ...NEWER, kind: "widget" }]));
    expect(alone.success).toBe(false);
    if (alone.success) return;
    expect(alone.error.issues[0]?.message).toContain("schemaVersion 1 name");
  });

  it("refuses a skipped facet whose id repeats another facet's, which a host that understands both would refuse", () => {
    const clash = readPackageManifest(manifest([UI, { ...NEWER, id: UI.id }]));
    expect(clash.success).toBe(false);
    if (clash.success) return;
    expect(clash.error.issues[0]?.path).toEqual(["facets", 1, "id"]);
    expect(readPackageManifest(manifest([UI, NEWER, { ...NEWER, kind: "planners" }])).success).toBe(false);
  });
});

describe("facets skipped at install", () => {
  const TOOLS = { kind: "tools", id: "com.example.board.agents", isolation: "service" };
  const THEME = { kind: "themes", id: "com.example.board.dusk", isolation: "declarative" };

  it("records what a generation keeps of a skipped facet: everything but its position", () => {
    expect(recordSkippedFacets([{ index: 1, kind: "agents", id: "a", isolation: "service" }, { index: 3, kind: "planners" }])).toEqual([
      { kind: "agents", id: "a", isolation: "service" },
      { kind: "planners" },
    ]);
    expect(recordedSkippedFacetSchema.safeParse({ kind: "Agents" }).success).toBe(false);
  });

  it("keeps a facet skipped at install out of a later reading that understands it, by kind or by id", () => {
    const read = { facets: [UI, TOOLS, THEME] };
    // A newer host reads the same facet with a kind it knows: still left out, for the id it had.
    expect(withoutFacetsSkippedAtInstall(read, [{ kind: "agents", id: "com.example.board.agents" }]).facets).toEqual([UI, THEME]);
    // Every facet of a kind the installing host did not know was skipped, whatever its id.
    expect(withoutFacetsSkippedAtInstall(read, [{ kind: "themes" }]).facets).toEqual([UI, TOOLS]);
    expect(withoutFacetsSkippedAtInstall(read, undefined)).toBe(read);
  });

  it("counts a skipped facet in its declared lane, or the strongest when it declares none", () => {
    expect(skippedFacetLane({ isolation: "declarative" })).toBe("declarative");
    expect(skippedFacetLane({})).toBe("trusted-native");
  });

  it("is kept on a generation, and only in its recorded shape", () => {
    const generation = {
      generationId: "g",
      packageId: "com.example.board",
      version: "1.0.0",
      digest: "sha256:x",
      nodeId: "n",
      codeGeneration: "c",
      activatedAt: "2026-10-08T03:00:00.000Z",
      uiOnlyFacets: [],
      grantedCapabilities: [],
    };
    expect(packageGenerationSchema.safeParse({ ...generation, skippedFacets: [{ kind: "agents", isolation: "service" }] }).success).toBe(true);
    expect(packageGenerationSchema.safeParse({ ...generation, skippedFacets: [{ kind: "agents", index: 1 }] }).success).toBe(false);
  });
});
