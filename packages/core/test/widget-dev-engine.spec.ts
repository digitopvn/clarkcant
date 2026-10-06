import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareDevReach, directoryEntrySchema, type PackageManifest, type WidgetDefinition } from "@clarkcant/contracts";

import { cachedLocalSnapshotPath, devConsentScopeOf, digestOfDirectory, startDevEngine, type DevEngine } from "../src/index.ts";

/**
 * The dev engine: a folder read as a package on every change, into immutable generations named by their digest, with
 * a failed build never replacing the last good one.
 */

const WIDGET_ID = "com.example.dev.main@1";

const DEFINITION: WidgetDefinition = {
  id: WIDGET_ID,
  version: "0.1.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "A dev widget.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A widget being developed",
  requestedCapabilities: [],
};

function manifest(overrides: Partial<PackageManifest> = {}): PackageManifest {
  return {
    schemaVersion: 2,
    id: "com.example.dev",
    version: "0.1.0",
    displayName: "Dev",
    description: "A widget being developed.",
    hostApi: { min: 1, max: 1 },
    facets: [{ kind: "ui", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" }],
    requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
    dependencies: [],
    ...overrides,
  };
}

const created: string[] = [];
const engines: DevEngine[] = [];

function writePackage(root: string, html: string, overrides: Partial<PackageManifest> = {}): void {
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), html);
  writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
  writeFileSync(join(root, "clarkcant.json"), JSON.stringify(manifest(overrides)));
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function engineFor(root: string, cacheRoot?: string): DevEngine {
  const engine = startDevEngine({ root, watch: false, ...(cacheRoot === undefined ? {} : { cacheRoot }), now: () => "2026-10-06T00:00:00.000Z" });
  engines.push(engine);
  return engine;
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.close();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the dev engine", () => {
  it("reads the folder into a first generation named by the same digest a node's snapshot carries", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root);
    const first = await engine.ready;

    expect(first.kind).toBe("generation");
    const latest = engine.latest();
    expect(latest?.generation).toMatchObject({ generation: 1, packageId: "com.example.dev", version: "0.1.0", trigger: "start", widgetIds: [WIDGET_ID] });
    expect(latest?.generation.delta.verdict).toBe("initial");
    const digest = digestOfDirectory(root, { exclude: [".git"], excludeAnyCase: true });
    expect(digest.ok && digest.digest).toBe(latest?.generation.digest);
    // The listing is a valid directory entry, naming the folder for a host that serves it directly.
    expect(directoryEntrySchema.parse(latest?.listing).source).toEqual({ kind: "local", path: engine.root });
    expect(latest?.listing.publisher.id).toBe("local-development");
    expect(Object.isFrozen(latest?.generation)).toBe(true);
  });

  it("produces nothing new for files that did not change, and a new generation for files that did", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root);
    await engine.ready;

    expect((await engine.rebuild()).kind).toBe("unchanged");
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>two</p>");
    const next = await engine.rebuild("change");

    expect(next.kind).toBe("generation");
    expect(engine.latest()?.generation.generation).toBe(2);
    // A UI-only edit reaches nothing new.
    expect(engine.latest()?.generation.delta.verdict).toBe("unchanged");
  });

  it("keeps the last good generation when a change does not read as a package, and says what is wrong", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root);
    await engine.ready;
    const good = engine.latest();

    writeFileSync(join(root, "widgets", "main", "widget.json"), "{ not json");
    const failed = await engine.rebuild("change");

    expect(failed.kind).toBe("failed");
    expect(engine.lastBuild()?.ok).toBe(false);
    expect(engine.lastBuild()?.diagnostics.length).toBeGreaterThan(0);
    expect(engine.latest()).toBe(good);

    // Fixing it builds again, as the next generation.
    writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>fixed</p>");
    expect((await engine.rebuild("change")).kind).toBe("generation");
    expect(engine.lastBuild()?.ok).toBe(true);
    expect(engine.latest()?.generation.generation).toBe(2);
  });

  it("says a change that asks for more is wider, whatever else it gives up", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root);
    await engine.ready;

    writePackage(root, "<p>one</p>", {
      permissions: { networkOrigins: ["https://api.example.com"], filesystem: [], microphone: true, camera: false, lifecycleScripts: [] },
    });
    await engine.rebuild("change");
    const delta = engine.latest()?.generation.delta;

    expect(delta?.verdict).toBe("wider");
    expect(delta?.frameOrigins.added).toEqual(["https://api.example.com"]);
    expect(delta?.permissions.added).toEqual(["microphone"]);
  });

  it("copies each generation into the package cache and lists the copy, so later edits never change it", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root, cacheRoot);
    await engine.ready;
    const first = engine.latest();
    const snapshot = first === undefined ? undefined : cachedLocalSnapshotPath(cacheRoot, first.generation.digest);

    expect(first?.listing.source).toEqual({ kind: "local", path: snapshot });
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>two</p>");
    await engine.rebuild("change");

    expect(snapshot !== undefined && existsSync(snapshot)).toBe(true);
    expect(readFileSync(join(snapshot ?? "", "widgets", "main", "index.html"), "utf8")).toBe("<p>one</p>");
    expect(engine.latest()?.listing.source).not.toEqual(first?.listing.source);
  });

  it("reports a missing folder as a failed build rather than throwing", async () => {
    const root = join(tempDir("dev-engine-"), "missing");
    const engine = engineFor(root);
    const first = await engine.ready;

    expect(first.kind).toBe("failed");
    expect(engine.latest()).toBeUndefined();
  });
});

describe("the dev consent scope", () => {
  it("is the same for generations that reach the same things, and changes when the reach does", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root);
    await engine.ready;
    const first = engine.latest();
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>two</p>");
    await engine.rebuild("change");
    const second = engine.latest();
    writePackage(root, "<p>two</p>", {
      permissions: { networkOrigins: ["https://api.example.com"], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    });
    await engine.rebuild("change");
    const third = engine.latest();

    if (first === undefined || second === undefined || third === undefined) throw new Error("expected three generations");
    expect(devConsentScopeOf(second.listing)).toBe(devConsentScopeOf(first.listing));
    expect(devConsentScopeOf(third.listing)).not.toBe(devConsentScopeOf(first.listing));
    expect(devConsentScopeOf(first.listing)).toMatch(/^widget-dev-scope:sha256:[0-9a-f]{64}$/);
  });
});

describe("compareDevReach", () => {
  it("names a facet that moved to another lane as wider", () => {
    const before = manifest();
    const after = manifest({
      facets: [
        ...before.facets,
        { kind: "tools", id: "com.example.dev.svc", entry: "svc/index.js", isolation: "service", capabilities: [] } as unknown as PackageManifest["facets"][number],
      ],
    });
    const delta = compareDevReach(before, after);

    expect(delta.verdict).toBe("wider");
    expect(delta.facets.added).toEqual(["tools:com.example.dev.svc:service"]);
  });

  it("calls a change that only gives something up narrower", () => {
    const before = manifest({ requestedCapabilities: ["dataset.read@1"] });
    const delta = compareDevReach(before, manifest());

    expect(delta.verdict).toBe("narrower");
    expect(delta.capabilities.removed).toEqual(["dataset.read@1"]);
  });
});
