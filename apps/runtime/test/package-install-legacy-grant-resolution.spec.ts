import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveGenerationGrantedCapabilities,
  type LegacyPackageGeneration,
  type PackageInstallDeps,
} from "../src/application/package-install.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * N4: a generation activated before `grantedCapabilities` existed on the schema is marked `null` by migration 22
 * (`packages/storage/src/migrate.ts`) rather than guessed at, and resolved lazily — once — the first time it is
 * actually read, from the package's own manifest. This is that resolution, isolated from the frame route that
 * consumes it (`apps/runtime/src/routes/conversations.ts`), so the resolve-once contract is provable without
 * standing up a widget instance.
 */

const PACKAGE_ID = "com.example.legacy-grant";
const VERSION = "1.0.0";
const DIGEST = "sha256:legacy-grant-digest";
const REQUESTED = ["project.code.read@1", "project.code.write@1"];

let dir: string;
let packageRoot: string;
let indexPath: string;
let services: NodeServices;
let deps: PackageInstallDeps;
let previousIndex: string | undefined;

function writeManifest(): void {
  writeFileSync(
    join(packageRoot, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE_ID,
      version: VERSION,
      displayName: "Legacy grant fixture",
      description: "A package whose generation predates grantedCapabilities.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "widget", id: `${PACKAGE_ID}.tool`, entry: "tool.js", definition: "tool.json", isolation: "isolated-ui" }],
      requestedCapabilities: REQUESTED,
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
}

function writeIndex(): void {
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        packageId: PACKAGE_ID,
        version: VERSION,
        displayName: "Legacy grant fixture",
        description: "A package whose generation predates grantedCapabilities.",
        source: { kind: "local", path: packageRoot },
        publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
        preview: {},
        facets: ["ui"],
        isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
        platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
        hostApi: { min: 1, max: 1 },
        permissionsSummary: [],
        riskTier: "isolated-ui",
        sizeBytes: 512,
        digest: DIGEST,
      },
    ]),
  );
}

/** A generation row exactly as migration 22 leaves one it cannot guess a value for: `grantedCapabilities: null`. */
function insertLegacyGeneration(): LegacyPackageGeneration {
  const generation: LegacyPackageGeneration = {
    generationId: `${PACKAGE_ID}@${VERSION}:legacy`,
    packageId: PACKAGE_ID,
    version: VERSION,
    digest: DIGEST,
    nodeId: services.runtime.identity.nodeId,
    codeGeneration: "codegen-legacy",
    activatedAt: "2026-01-01T00:00:00.000Z" as never,
    uiOnlyFacets: [],
    grantedCapabilities: null,
  };
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      generation.generationId,
      generation.packageId,
      generation.version,
      generation.digest,
      generation.nodeId,
      generation.codeGeneration,
      generation.activatedAt,
      JSON.stringify(generation),
    );
  return generation;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-legacy-grant-"));
  packageRoot = join(dir, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeManifest();
  indexPath = join(dir, "directory.json");
  writeIndex();
  services = bootNodeServices({ dataDir: dir, label: "legacy grant resolution test node" });
  deps = { runtime: services.runtime, conductor: services.conductor };
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("N4: resolving a legacy generation's null grantedCapabilities", () => {
  it("resolves null to the package's own manifest-requested capabilities, and persists the result", () => {
    const generation = insertLegacyGeneration();

    const resolved = resolveGenerationGrantedCapabilities(deps, generation);
    expect(resolved).toEqual(REQUESTED);

    const row = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generation.generationId) as { document: string };
    const persisted = JSON.parse(row.document) as { grantedCapabilities: unknown };
    expect(persisted.grantedCapabilities).toEqual(REQUESTED);
  });

  it("resolves once: a second read returns the persisted array without re-reading the manifest", () => {
    const generation = insertLegacyGeneration();
    resolveGenerationGrantedCapabilities(deps, generation);

    // The manifest is gone; if this resolved again by reading it, it would find nothing rather than the answer
    // it already persisted.
    unlinkSync(join(packageRoot, "clarkcant.json"));

    const row = services.runtime.db
      .prepare("SELECT document FROM package_generations WHERE generation_id = ?")
      .get(generation.generationId) as { document: string };
    const persistedGeneration = JSON.parse(row.document) as LegacyPackageGeneration;
    const resolvedAgain = resolveGenerationGrantedCapabilities(deps, persistedGeneration);
    expect(resolvedAgain).toEqual(REQUESTED);
  });

  it("does not touch a generation that already carries a real grantedCapabilities array", () => {
    const generation: LegacyPackageGeneration = {
      ...insertLegacyGeneration(),
      grantedCapabilities: ["already.granted@1"],
    };

    const resolved = resolveGenerationGrantedCapabilities(deps, generation);
    expect(resolved).toEqual(["already.granted@1"]);
  });

  it("[fails on the old behaviour] there was no lazy resolution, so a legacy null generation crashed a reader that assumed an array", () => {
    // Before N4, the frame-broker route read `generation?.grantedCapabilities` directly off `activeGeneration`'s
    // result, with no allowance for the migration's `null` marker: `brokeredCapabilities` would have been handed
    // `null` where it expects an array, and the shape this test now proves — a resolved array, persisted — did
    // not exist at all. Kept as its own case so a future regression that removes the lazy resolution fails here.
    const generation = insertLegacyGeneration();
    const resolved = resolveGenerationGrantedCapabilities(deps, generation);
    expect(Array.isArray(resolved)).toBe(true);
  });
});
