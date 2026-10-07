import type * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compareDevReach, directoryEntrySchema, type PackageManifest, type WidgetDefinition } from "@clarkcant/contracts";

import {
  DEV_ENGINE_WATCH_CATCH_UP_MS,
  cachedLocalSnapshotPath,
  devConsentScopeOf,
  digestOfDirectory,
  startDevEngine,
  type DevEngine,
} from "../src/index.ts";

/** A folder whose `stat` fails with this code, as an antivirus or indexer holding it on Windows makes it fail. */
const statFailure = vi.hoisted(() => ({ path: undefined as string | undefined, code: "EPERM" }));
/** A folder whose file id reads as another one, as a FUSE mount without stable inode numbers reports a folder still there. */
const statNewId = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const statSync = ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (statFailure.path !== undefined && resolve(String(path)) === statFailure.path) {
      throw Object.assign(new Error(`${statFailure.code}: operation not permitted, stat '${String(path)}'`), { code: statFailure.code });
    }
    const stat = actual.statSync(path, options);
    if (statNewId.path !== undefined && resolve(String(path)) === statNewId.path && stat !== undefined && typeof stat.ino === "bigint") {
      stat.ino += 1n;
    }
    return stat;
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

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
  statFailure.path = undefined;
  statNewId.path = undefined;
  vi.useRealTimers();
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

  it("leaves installed dependencies out of the digest, the snapshot and the watch, and keeps built output in", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "bundle.js"), "export {};");
    const engine = engineFor(root, cacheRoot);
    await engine.ready;
    const first = engine.latest();
    const snapshot = first === undefined ? "" : (cachedLocalSnapshotPath(cacheRoot, first.generation.digest) ?? "");

    expect(existsSync(join(snapshot, "node_modules"))).toBe(false);
    expect(existsSync(join(snapshot, "dist", "bundle.js"))).toBe(true);
    // A dependency reinstalled is not a new build; built output that changed is.
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 2;");
    expect((await engine.rebuild("change")).kind).toBe("unchanged");
    writeFileSync(join(root, "dist", "bundle.js"), "export const x = 1;");
    expect((await engine.rebuild("change")).kind).toBe("generation");
  });

  it("refuses a facet that runs outside the widget frame when only framed lanes are allowed", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>", {
      facets: [
        ...manifest().facets,
        {
          kind: "tools",
          id: "com.example.dev.service",
          entry: "service/server.mjs",
          isolation: "service",
          protocol: "mcp-stdio",
          capabilities: [{ tool: "list_items", ref: "com.example.dev.items.list@1", summary: "List the items", effectCategory: "read" }],
        } as unknown as PackageManifest["facets"][number],
      ],
    });
    mkdirSync(join(root, "service"), { recursive: true });
    writeFileSync(join(root, "service", "server.mjs"), "export {};");
    const engine = startDevEngine({ root, watch: false, allowedIsolations: ["isolated-ui", "declarative"] });
    engines.push(engine);
    const first = await engine.ready;

    expect(first.kind).toBe("failed");
    expect(engine.latest()).toBeUndefined();
    expect(engine.lastBuild()?.diagnostics).toEqual([expect.objectContaining({ code: "FACET_LANE_UNSUPPORTED", path: "clarkcant.json" })]);
    // The same folder builds where every lane is allowed (the standalone dev host).
    const anyLane = engineFor(root);
    expect((await anyLane.ready).kind).toBe("generation");
  });

  it("watches the folder for real, builds a saved change, and lets go of the folder when closed", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, onBuild: (event) => built.push(event.kind) });
    engines.push(engine);
    await engine.ready;
    expect(engine.watching()).toBe(true);

    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved</p>");
    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
    expect(built).toContain("generation");

    engine.close();
    expect(engine.watching()).toBe(false);
    // Closed, the folder is no longer held open: on Windows a watched folder cannot be removed.
    rmSync(root, { recursive: true });
    expect(existsSync(root)).toBe(false);
  });

  it("builds a save made before the platform watcher was live, as on macOS where FSEvents starts late", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    let saved = false;
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      onBuild: (event) => built.push(event.kind),
      // Runs inside the first build, after its digest and before `watch` is called: no platform reports this save.
      baseline: () => {
        if (!saved) {
          saved = true;
          writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved early</p>");
        }
        return undefined;
      },
    });
    engines.push(engine);
    expect((await engine.ready).kind).toBe("generation");
    expect(engine.latest()?.generation.generation).toBe(1);

    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
    expect(built).toEqual(["generation"]);
  });

  it("notices a watched folder that was deleted, though the platform may report nothing, and stops watching", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    let gone = 0;
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 50, onRootGone: () => (gone += 1) });
    engines.push(engine);
    await engine.ready;
    expect(engine.watching()).toBe(true);

    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    const deadline = Date.now() + 5_000;
    while (gone === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(gone).toBe(1);
    expect(engine.watching()).toBe(false);
    // Told once: the check stops with the watch.
    await new Promise((done) => setTimeout(done, 150));
    expect(gone).toBe(1);
  });

  it("watches a folder deleted and made again before it looks, and builds it, though the old watcher hears nothing", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    let gone = 0;
    const failures: Error[] = [];
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 50,
      onRootGone: () => (gone += 1),
      onWatchError: (error) => failures.push(error),
    });
    engines.push(engine);
    await engine.ready;

    // In one turn of the event loop: no existence check runs between the delete and the new folder, as `rm -rf out && build`.
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    writePackage(root, "<p>new folder</p>");
    const waitFor = async (generation: number): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (engine.latest()?.generation.generation !== generation && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      expect(engine.latest()?.generation.generation).toBe(generation);
    };
    await waitFor(2);
    expect(gone).toBe(0);
    expect(failures).toEqual([]);
    expect(engine.watching()).toBe(true);
    expect(engine.rootGone()).toBe(false);

    // The new folder is the one watched now: a save in it builds.
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved in the new folder</p>");
    await waitFor(3);
    expect(gone).toBe(0);
  });

  it("watches a folder that is still there under a new file id again, and builds it, rather than stopping", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    let gone = 0;
    const built: string[] = [];
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 20,
      onRootGone: () => (gone += 1),
      onBuild: (event) => built.push(`${event.build.trigger}:${event.kind}`),
    });
    engines.push(engine);
    await engine.ready;
    // Past the catch-up build, so the only build that follows is the one the new id asks for.
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 200));
    built.length = 0;

    statNewId.path = engine.root;
    const deadline = Date.now() + 5_000;
    while (built.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(built).toEqual(["change:unchanged"]);
    expect(gone).toBe(0);
    expect(engine.watching()).toBe(true);
    expect(engine.rootGone()).toBe(false);

    // Watched again once: the new id is the folder's id now, and a save still builds.
    await new Promise((done) => setTimeout(done, 150));
    expect(built).toEqual(["change:unchanged"]);
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved</p>");
    const saved = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < saved) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
  });

  it("stops watching, and says why, a folder it has not been able to look at for the time bound", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    let gone = 0;
    const failures: Error[] = [];
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 20,
      rootUnreadableMs: 300,
      onRootGone: () => (gone += 1),
      onWatchError: (error) => failures.push(error),
    });
    engines.push(engine);
    await engine.ready;

    statFailure.path = engine.root;
    statFailure.code = "EPERM";
    const started = Date.now();
    const deadline = started + 5_000;
    while (failures.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    expect(failures).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(failures[0]?.message).toContain("could not be looked at");
    expect(failures[0]?.message).toContain("EPERM");
    expect(engine.watching()).toBe(false);
    expect(gone).toBe(0);
    // Told once: the check stops with the watch.
    await new Promise((done) => setTimeout(done, 150));
    expect(failures).toHaveLength(1);
  });

  it("starts the time bound again after the folder could be looked at", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const failures: Error[] = [];
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 20, rootUnreadableMs: 300, onWatchError: (error) => failures.push(error) });
    engines.push(engine);
    await engine.ready;

    for (let round = 0; round < 3; round += 1) {
      statFailure.path = engine.root;
      await new Promise((done) => setTimeout(done, 200));
      statFailure.path = undefined;
      await new Promise((done) => setTimeout(done, 80));
    }
    expect(failures).toEqual([]);
    expect(engine.watching()).toBe(true);
  });

  it("keeps watching through a folder it cannot look at for a moment, rather than taking it as gone", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    let gone = 0;
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 20, onRootGone: () => (gone += 1) });
    engines.push(engine);
    await engine.ready;

    statFailure.path = engine.root;
    for (const code of ["EPERM", "EBUSY"]) {
      statFailure.code = code;
      // Several existence checks run while the folder answers with the error.
      await new Promise((done) => setTimeout(done, 150));
      expect(gone).toBe(0);
      expect(engine.watching()).toBe(true);
    }
    expect(engine.rootGone()).toBe(false);

    statFailure.path = undefined;
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved</p>");
    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
  });

  it("leaves the last build as it was when the catch-up build finds nothing new", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    // Only the catch-up builds here: a scanner reading the new files can make Windows report changes the watcher would build.
    const engine = startDevEngine({ root, watch: true, debounceMs: 60_000, onBuild: (event) => built.push(event.kind) });
    engines.push(engine);
    await engine.ready;
    const first = engine.lastBuild();
    expect(first).toMatchObject({ ok: true, trigger: "start", generation: 1 });

    // Past the catch-up build, which found the files as the first build left them.
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 300));
    expect(engine.lastBuild()).toBe(first);
    expect(built).toEqual([]);
  });

  it("does not report a first build's failure twice when the catch-up runs before that build ends", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    // Only timeouts are paused, so the catch-up can be fired while the first build still waits on the files.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = startDevEngine({
      root,
      cacheRoot,
      watch: true,
      // Only the catch-up builds here: a scanner reading the new files can make Windows report changes the watcher would build.
      debounceMs: 60_000,
      // Too small for the folder, so the first build fails once it has looked at the files.
      limits: { maxFiles: 1, maxBytes: 1024 },
      onBuild: (event) => built.push(event.kind),
    });
    engines.push(engine);
    vi.advanceTimersByTime(DEV_ENGINE_WATCH_CATCH_UP_MS);
    vi.useRealTimers();

    expect((await engine.ready).kind).toBe("failed");
    const first = engine.lastBuild();
    // The catch-up build runs after the first one and fails the same way: nothing new to say.
    await new Promise((done) => setTimeout(done, 300));
    expect(built).toEqual([]);
    expect(engine.lastBuild()).toBe(first);
  });

  it("names a folder over the size limit, and a link out of it, apart from files that could not be read", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    const tooSmall = startDevEngine({ root, watch: false, cacheRoot, limits: { maxFiles: 1, maxBytes: 1024 } });
    engines.push(tooSmall);
    expect((await tooSmall.ready).kind).toBe("failed");
    expect(tooSmall.lastBuild()?.diagnostics).toEqual([expect.objectContaining({ code: "FILES_TOO_LARGE" })]);

    const outside = tempDir("dev-engine-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "linked"), "junction");
    for (const engine of [engineFor(root, cacheRoot), engineFor(root)]) {
      expect((await engine.ready).kind).toBe("failed");
      expect(engine.lastBuild()?.diagnostics).toEqual([expect.objectContaining({ code: "FILES_LINK_REFUSED" })]);
    }
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

  it("changes when the package asks for another capability or moves a facet, read from the snapshot", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root, cacheRoot);
    await engine.ready;
    const first = engine.latest();
    writePackage(root, "<p>one</p>", { requestedCapabilities: ["notes.write@1"] });
    await engine.rebuild("change");
    const second = engine.latest();

    if (first === undefined || second === undefined) throw new Error("expected two generations");
    // The listing alone does not carry the capability; the scope reads it from the immutable snapshot.
    expect(devConsentScopeOf(second.listing)).not.toBe(devConsentScopeOf(first.listing));
    expect(devConsentScopeOf(second.listing)).toBe(devConsentScopeOf(second.listing, second.manifest));
    const moved = manifest({ facets: [{ ...manifest().facets[0], isolation: "declarative" } as PackageManifest["facets"][number]] });
    expect(devConsentScopeOf(first.listing, moved)).not.toBe(devConsentScopeOf(first.listing, first.manifest));
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
