import type * as fs from "node:fs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compareDevReach, directoryEntrySchema, type PackageManifest, type WidgetDefinition } from "@clarkcant/contracts";

import {
  DEV_ENGINE_EXCLUDED_ROOT_NAMES,
  DEV_ENGINE_REARM_MAX,
  DEV_ENGINE_WATCH_CATCH_UP_MS,
  cachedLocalSnapshotPath,
  devConsentScopeOf,
  digestOfDirectory,
  removeLocalSnapshot,
  startDevEngine,
  type DevEngine,
} from "../src/index.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/** A folder whose `stat` fails with this code, as an antivirus or indexer holding it on Windows makes it fail. */
const statFailure = vi.hoisted(() => ({ path: undefined as string | undefined, code: "EPERM" }));
/** A folder whose file id reads as another one, as a FUSE mount without stable inode numbers reports a folder still there. */
const statNewId = vi.hoisted(() => ({ path: undefined as string | undefined, flap: false, shift: 0n, step: 1n }));

/** Runs once just before this file is read: a build reading its manifest, at the moment something else changes the folder. */
const beforeRead = vi.hoisted(() => ({ path: undefined as string | undefined, run: undefined as (() => void) | undefined }));

/** The newest listener given to `watch` for each folder, to report a change as the platform watcher would, when a test says. */
const watchListeners = vi.hoisted(() => new Map<string, fs.WatchListener<string>>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const readFileSync = ((path: fs.PathOrFileDescriptor, options?: Parameters<typeof actual.readFileSync>[1]) => {
    if (beforeRead.run !== undefined && typeof path === "string" && resolve(path) === beforeRead.path) {
      const run = beforeRead.run;
      beforeRead.run = undefined;
      run();
    }
    return actual.readFileSync(path, options);
  }) as typeof actual.readFileSync;
  const statSync = ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (statFailure.path !== undefined && resolve(String(path)) === statFailure.path) {
      throw Object.assign(new Error(`${statFailure.code}: operation not permitted, stat '${String(path)}'`), { code: statFailure.code });
    }
    const stat = actual.statSync(path, options);
    if (statNewId.path !== undefined && resolve(String(path)) === statNewId.path && stat !== undefined && typeof stat.ino === "bigint") {
      // Flapping: a new id on every look, as a filesystem that keeps no file id stable at all would report.
      if (statNewId.flap) statNewId.shift += 1n;
      stat.ino += statNewId.flap ? statNewId.shift : statNewId.step;
    }
    return stat;
  }) as typeof actual.statSync;
  const watch = ((path: fs.PathLike, options: fs.WatchOptionsWithStringEncoding, listener: fs.WatchListener<string>) => {
    const watcher = actual.watch(path, options, listener);
    watchListeners.set(resolve(String(path)), listener);
    return watcher;
  }) as typeof actual.watch;
  return { ...actual, statSync, readFileSync, watch, default: { ...actual, statSync, readFileSync, watch } };
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

/**
 * Source for a child process that makes a folder again whole, as a build tool that writes its output elsewhere and moves
 * it into place does: `remake(source, out)` copies into a sibling folder, then renames it to `out`, so the folder is
 * readable the moment it is back. Copied straight to `out`, a look could find the folder with only some of its files,
 * a pause a loaded runner can stretch past the debounce, and the engine would rightly build that half-written folder.
 */
const REMAKE_WHOLE = [
  "const remake = (source, out) => {",
  "  const next = out + '.next';",
  "  fs.cpSync(source, next, { recursive: true });",
  "  for (const until = Date.now() + 2000; ; ) {",
  "    try {",
  "      return fs.renameSync(next, out);",
  "    } catch (error) {",
  // Windows refuses the move for a moment while an antivirus or indexer holds a file just written.
  "      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() > until) throw error;",
  "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
  "    }",
  "  }",
  "};",
].join("\n");

afterEach(() => {
  beforeRead.path = undefined;
  beforeRead.run = undefined;
  statFailure.path = undefined;
  statNewId.path = undefined;
  statNewId.flap = false;
  statNewId.shift = 0n;
  statNewId.step = 1n;
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

  it("holds its newest generation's snapshot against removal until a newer one replaces it or the engine closes", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root, cacheRoot);
    await engine.ready;
    const pathOf = (): string => cachedLocalSnapshotPath(cacheRoot, engine.latest()?.generation.digest ?? "") ?? "";
    const remove = (path: string) => removeLocalSnapshot(path, { inUse: () => false, options: { recursive: true, force: true } });
    const first = pathOf();
    expect(await remove(first)).toBe("kept");
    // A build of the same files again keeps one hold, not two: the newest generation's.
    expect((await engine.rebuild("rebuild")).kind).toBe("unchanged");

    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>two</p>");
    expect((await engine.rebuild("change")).kind).toBe("generation");
    const second = pathOf();
    expect(await remove(second)).toBe("kept");
    expect(await remove(first)).toBe("removed");
    expect(existsSync(first)).toBe(false);

    engine.close();
    expect(await remove(second)).toBe("removed");
    expect(existsSync(second)).toBe(false);
  });

  it("lets go of a build's snapshot when the caller's baseline throws, keeping the newest generation's", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    let failing = false;
    const engine = startDevEngine({
      root,
      watch: false,
      cacheRoot,
      now: () => "2026-10-06T00:00:00.000Z",
      baseline: () => {
        if (failing) throw new Error("the baseline could not be read");
        return undefined;
      },
    });
    engines.push(engine);
    expect((await engine.ready).kind).toBe("generation");
    const first = cachedLocalSnapshotPath(cacheRoot, engine.latest()?.generation.digest ?? "") ?? "";
    const remove = (path: string) => removeLocalSnapshot(path, { inUse: () => false, options: { recursive: true, force: true } });

    failing = true;
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>two</p>");
    await expect(engine.rebuild("change")).rejects.toThrow("the baseline could not be read");
    const digested = digestOfDirectory(root, { exclude: DEV_ENGINE_EXCLUDED_ROOT_NAMES, excludeAnyCase: true });
    if (!digested.ok) throw new Error(digested.message);
    const second = cachedLocalSnapshotPath(cacheRoot, digested.digest) ?? "";
    expect(existsSync(second)).toBe(true);
    // The build that threw is not the newest generation, so nothing holds its snapshot; the first one is still held.
    expect(engine.latest()?.generation.generation).toBe(1);
    expect(await remove(second)).toBe("removed");
    expect(existsSync(second)).toBe(false);
    expect(await remove(first)).toBe("kept");
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

  it("counts a facet of a kind it does not know in its declared lane, or as native when it declares none", async () => {
    const later = (isolation?: string) =>
      ({ kind: "agents", id: "com.example.dev.agents", entry: "agents/index.json", ...(isolation === undefined ? {} : { isolation }) }) as unknown as PackageManifest["facets"][number];
    for (const isolation of ["trusted-native", undefined]) {
      const root = tempDir("dev-engine-");
      writePackage(root, "<p>one</p>", { facets: [...manifest().facets, later(isolation)] });
      const engine = startDevEngine({ root, watch: false, allowedIsolations: ["isolated-ui", "declarative"] });
      engines.push(engine);
      expect((await engine.ready).kind, String(isolation)).toBe("failed");
      const diagnostic = engine.lastBuild()?.diagnostics[0];
      expect(diagnostic?.code).toBe("FACET_LANE_UNSUPPORTED");
      expect(diagnostic?.message).toContain("does not understand");
    }
    // A declarative one fits the allowed lanes, and the listing's tier still counts it.
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>", { facets: [...manifest().facets, later("declarative")] });
    const engine = startDevEngine({ root, watch: false, allowedIsolations: ["isolated-ui", "declarative"] });
    engines.push(engine);
    expect((await engine.ready).kind).toBe("generation");
    expect(engine.latest()?.skippedFacets).toEqual([{ kind: "agents", id: "com.example.dev.agents", isolation: "declarative" }]);
    const native = tempDir("dev-engine-");
    writePackage(native, "<p>one</p>", { facets: [...manifest().facets, later("service")] });
    const anyLane = engineFor(native);
    await anyLane.ready;
    expect(anyLane.latest()?.listing.riskTier).toBe("service");
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

    await removeTestDirectory(root);
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

    // In one turn of the event loop: no existence check runs between the delete and the new folder. Synchronous on purpose;
    // no retries are asked for, since `rmSync` would not run them.
    rmSync(root, { recursive: true, force: true });
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

  it("reports no unchanged build for writes a new watcher reports late, and still builds a save made right after", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 20,
      onBuild: (event) => built.push(`${event.build.trigger}:${event.kind}`),
    });
    engines.push(engine);
    await engine.ready;
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 200));
    built.length = 0;

    // Watched anew under a new id: the build the re-arm asks for is reported.
    statNewId.path = engine.root;
    const deadline = Date.now() + 5_000;
    while (built.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    expect(built).toEqual(["change:unchanged"]);
    const reported = engine.lastBuild();

    // The same bytes written again, as FSEvents reports the writes that made a folder from just before its stream began:
    // the build it causes finds nothing new, and says nothing.
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>one</p>");
    await new Promise((done) => setTimeout(done, 200));
    expect(built).toEqual(["change:unchanged"]);
    expect(engine.lastBuild()).toBe(reported);

    // A real save in the same moments is news, and builds.
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved right after</p>");
    const saved = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < saved) await new Promise((done) => setTimeout(done, 10));
    expect(engine.latest()?.generation.generation).toBe(2);
    await new Promise((done) => setTimeout(done, 100));
    expect(built).toEqual(["change:unchanged", "change:generation"]);
  });

  /** A link to a folder: a junction on Windows, which needs no privilege, and a symbolic link elsewhere. */
  const linkFolder = (target: string, path: string): void => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

  /** Watch `root` until the engine says it is gone, and report what it built and said meanwhile. */
  async function watchUntilGone(root: string, swap: () => void): Promise<{ engine: DevEngine; gone: number; built: string[]; failures: Error[] }> {
    const seen = { gone: 0, built: [] as string[], failures: [] as Error[] };
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 20,
      onRootGone: () => (seen.gone += 1),
      onBuild: (event) => seen.built.push(event.kind === "generation" ? `generation:${event.record.generation.packageId}` : event.kind),
      onWatchError: (error) => seen.failures.push(error),
    });
    engines.push(engine);
    await engine.ready;
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));
    seen.built.length = 0;

    swap();
    const deadline = Date.now() + 5_000;
    while (seen.gone === 0 && seen.failures.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    // Long enough for a build the swap would have scheduled to have run.
    await new Promise((done) => setTimeout(done, 200));
    return { engine, ...seen };
  }

  it("takes a folder swapped for a link to another folder as gone, rather than watching a folder nobody chose", async () => {
    const base = tempDir("dev-engine-");
    const root = join(base, "chosen");
    const elsewhere = join(base, "elsewhere");
    writePackage(root, "<p>chosen</p>");
    writePackage(elsewhere, "<p>elsewhere</p>", { id: "com.example.elsewhere" });

    const seen = await watchUntilGone(root, () => {
      rmSync(root, { recursive: true, force: true });
      linkFolder(elsewhere, root);
    });
    expect(seen.gone).toBe(1);
    expect(seen.failures).toEqual([]);
    expect(seen.built).toEqual([]);
    expect(seen.engine.watching()).toBe(false);
    expect(seen.engine.rootGone()).toBe(true);
    expect(seen.engine.latest()?.generation.packageId).toBe("com.example.dev");
  });

  it("takes a folder whose parent was swapped for a link to another tree as gone, rather than building that tree", async () => {
    const base = tempDir("dev-engine-");
    const parent = join(base, "chosen");
    const root = join(parent, "out");
    const elsewhere = join(base, "elsewhere");
    writePackage(root, "<p>chosen</p>");
    writePackage(join(elsewhere, "out"), "<p>elsewhere</p>", { id: "com.example.elsewhere" });

    const seen = await watchUntilGone(root, () => {
      rmSync(parent, { recursive: true, force: true });
      linkFolder(elsewhere, parent);
    });
    expect(seen.gone).toBe(1);
    expect(seen.failures).toEqual([]);
    expect(seen.built).toEqual([]);
    expect(seen.engine.watching()).toBe(false);
    expect(seen.engine.rootGone()).toBe(true);
    expect(seen.engine.latest()?.generation.packageId).toBe("com.example.dev");
  });

  it("stops watching, and says why, a folder whose file id keeps changing", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const failures: Error[] = [];
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 5, onWatchError: (error) => failures.push(error) });
    engines.push(engine);
    await engine.ready;

    statNewId.path = engine.root;
    statNewId.flap = true;
    const deadline = Date.now() + 5_000;
    while (failures.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain(`more than ${String(DEV_ENGINE_REARM_MAX)} looks in a row`);
    expect(failures[0]?.message).toContain("no longer watched");
    expect(engine.watching()).toBe(false);
  });

  it("keeps watching a folder made again many times, each new id followed by a look that finds it unchanged", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const failures: Error[] = [];
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 5, onWatchError: (error) => failures.push(error) });
    engines.push(engine);
    await engine.ready;

    // Each round gives the folder one new id, which the following looks see unchanged, as a folder made again per build.
    statNewId.path = engine.root;
    for (let round = 1; round <= DEV_ENGINE_REARM_MAX + 10; round += 1) {
      statNewId.step = BigInt(round);
      await new Promise((done) => setTimeout(done, 40));
    }
    expect(failures).toEqual([]);
    expect(engine.watching()).toBe(true);
  });

  it("watches a folder another process deletes and makes again a moment later, rather than taking it as gone", async () => {
    const base = tempDir("dev-engine-");
    const root = join(base, "out");
    const source = join(base, "source");
    writePackage(root, "<p>one</p>");
    writePackage(source, "<p>made again by another process</p>");
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
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));

    // As a build tool in its own process: delete the output folder, work for a moment, then write it again.
    const script = [
      "const fs = require('node:fs');",
      "const [out, source] = process.argv.slice(1);",
      "fs.rmSync(out, { recursive: true, force: true });",
      "setTimeout(() => fs.cpSync(source, out, { recursive: true }), 400);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, root, source], { stdio: "ignore" });
    expect(await new Promise((done) => child.on("exit", done))).toBe(0);

    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
    expect(gone).toBe(0);
    expect(failures).toEqual([]);
    expect(engine.watching()).toBe(true);
    expect(engine.rootGone()).toBe(false);

    // The folder made again is the one watched now: a save in it builds.
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved</p>");
    const saved = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 3 && Date.now() < saved) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(3);
  });

  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "watches a folder made again with its name in another case, where the filesystem ignores case",
    async () => {
      const base = tempDir("dev-engine-");
      const root = join(base, "out");
      writePackage(root, "<p>one</p>");
      let gone = 0;
      const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 50, onRootGone: () => (gone += 1) });
      engines.push(engine);
      await engine.ready;

      rmSync(root, { recursive: true, force: true });
      writePackage(join(base, "Out"), "<p>made again as Out</p>");
      const deadline = Date.now() + 5_000;
      while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      expect(engine.latest()?.generation.generation).toBe(2);
      expect(gone).toBe(0);
    },
  );

  it("builds nothing from a folder whose path leads through a link swapped in after the last look", async () => {
    const base = tempDir("dev-engine-");
    const parent = join(base, "chosen");
    const root = join(parent, "out");
    const elsewhere = join(base, "elsewhere");
    writePackage(root, "<p>chosen</p>");
    writePackage(join(elsewhere, "out"), "<p>elsewhere</p>", { id: "com.example.elsewhere" });
    const engine = engineFor(root);
    await engine.ready;

    rmSync(parent, { recursive: true, force: true });
    linkFolder(elsewhere, parent);
    const event = await engine.rebuild();
    expect(event.kind).toBe("failed");
    expect(event.build.diagnostics[0]?.code).toBe("FILES_LINK_REFUSED");
    expect(engine.latest()?.generation.packageId).toBe("com.example.dev");
  });

  it("builds a folder given through a link or junction, as the standalone dev host does, at the real path it leads to", async () => {
    const base = tempDir("dev-engine-");
    const real = join(base, "real");
    const linked = join(base, "linked");
    writePackage(real, "<p>one</p>");
    linkFolder(real, linked);
    const engine = startDevEngine({ root: linked, watch: false });
    engines.push(engine);

    expect((await engine.ready).kind).toBe("generation");
    expect(engine.root).toBe(realpathSync.native(real));
    writeFileSync(join(real, "widgets", "main", "index.html"), "<p>saved</p>");
    const event = await engine.rebuild();
    expect(event.kind).toBe("generation");
    expect(engine.latest()?.generation.generation).toBe(2);
  });

  it("watches a folder given through a link or junction, and builds a save in it rather than refusing the link", async () => {
    const base = tempDir("dev-engine-");
    const real = join(base, "real");
    const linked = join(base, "linked");
    writePackage(real, "<p>one</p>");
    linkFolder(real, linked);
    let gone = 0;
    const engine = startDevEngine({ root: linked, watch: true, debounceMs: 30, rootCheckMs: 20, onRootGone: () => (gone += 1) });
    engines.push(engine);
    expect((await engine.ready).kind).toBe("generation");

    writeFileSync(join(linked, "widgets", "main", "index.html"), "<p>saved</p>");
    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
    expect(engine.lastBuild()?.ok).toBe(true);
    expect(gone).toBe(0);
    expect(engine.rootGone()).toBe(false);
  });

  it("does not call a watched folder gone while it may still come back, and does once the grace is over", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    let gone = 0;
    const built: string[] = [];
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 20,
      rootMissingGraceMs: 400,
      onRootGone: () => (gone += 1),
      onBuild: (event) => built.push(event.kind),
    });
    engines.push(engine);
    await engine.ready;
    // A new watcher can report the writes that made the folder late (FSEvents on macOS), and the build that change runs
    // is reported. Builds run one at a time, so once a rebuild settles every build already started has ended; nothing
    // can start between that and the removal below, and a change the watcher reports after it finds the folder missing.
    await engine.rebuild();
    built.length = 0;
    const good = engine.lastBuild();

    rmSync(root, { recursive: true, force: true });
    // A rebuild asked for while the folder may still come back waits for it rather than failing on the missing files.
    let settled = false;
    const rebuilt = engine.rebuild().finally(() => (settled = true));
    await new Promise((done) => setTimeout(done, 150));
    expect(settled).toBe(false);
    expect(engine.rootGone()).toBe(false);
    expect(engine.watching()).toBe(true);
    expect(engine.lastBuild()).toBe(good);

    // Not back within the grace: the rebuild settles with why nothing was built, and the folder is gone.
    const event = await rebuilt;
    expect(event.kind).toBe("failed");
    expect(event.build.diagnostics).toEqual([expect.objectContaining({ code: "FILES_UNREADABLE" })]);
    expect(gone).toBe(1);
    expect(engine.rootGone()).toBe(true);
    expect(built).toEqual([]);
  });

  it("holds a build that fails because the folder went while it ran, and builds the folder once when it is back", async () => {
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
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));
    built.length = 0;
    const good = engine.lastBuild();

    // The folder goes just as the rebuild reads it, so that build fails on the missing files.
    beforeRead.path = join(engine.root, "clarkcant.json");
    beforeRead.run = () => rmSync(engine.root, { recursive: true, force: true });
    let settled = false;
    const rebuilt = engine.rebuild().finally(() => (settled = true));
    await new Promise((done) => setTimeout(done, 200));
    expect(beforeRead.run).toBeUndefined();
    expect(settled).toBe(false);
    expect(built).toEqual([]);
    expect(engine.lastBuild()).toBe(good);
    expect(engine.rootGone()).toBe(false);

    writePackage(root, "<p>made again</p>");
    const event = await rebuilt;
    expect(event.kind).toBe("generation");
    expect(event.build.trigger).toBe("rebuild");
    // Past the catch-up build of the new watcher, and any change the build itself made the platform report.
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 300));
    expect(built).toEqual(["rebuild:generation"]);
    expect(engine.latest()?.generation.generation).toBe(2);
    expect(gone).toBe(0);
  });

  it("builds a folder another process makes again exactly once, with no failed build, though rebuilds overlap the absence", async () => {
    const base = tempDir("dev-engine-");
    const root = join(base, "out");
    const source = join(base, "source");
    writePackage(root, "<p>one</p>");
    writePackage(source, "<p>made again by another process</p>");
    const cacheRoot = tempDir("dev-engine-cache-");
    let gone = 0;
    const failures: Error[] = [];
    const built: string[] = [];
    const engine = startDevEngine({
      root,
      cacheRoot,
      watch: true,
      debounceMs: 30,
      rootCheckMs: 50,
      onRootGone: () => (gone += 1),
      onWatchError: (error) => failures.push(error),
      onBuild: (event) => built.push(`${event.build.trigger}:${event.kind}`),
    });
    engines.push(engine);
    expect((await engine.ready).kind).toBe("generation");
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));
    built.length = 0;

    // As a build tool in its own process: delete the output folder, work for a moment, then write it again, whole. It
    // writes the folder again once the rebuilds below have been asked for (or after 1.5 s, inside the grace), so a slow
    // runner cannot let the folder come back before they are.
    const go = join(base, "go");
    const script = [
      "const fs = require('node:fs');",
      REMAKE_WHOLE,
      "const [out, source, go] = process.argv.slice(1);",
      "fs.rmSync(out, { recursive: true, force: true });",
      "const until = Date.now() + 1500;",
      "const wait = () => (fs.existsSync(go) || Date.now() > until ? remake(source, out) : setTimeout(wait, 10));",
      "wait();",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, root, source, go], { stdio: "ignore" });
    const exited = new Promise((done) => child.on("exit", done));
    const missing = Date.now() + 5_000;
    while (existsSync(root) && Date.now() < missing) await new Promise((done) => setTimeout(done, 5));
    // Rebuilds asked for while the folder is missing, as saves and a person asking again would.
    const rebuilds: Promise<{ kind: string }>[] = [];
    for (let round = 0; round < 4; round += 1) {
      rebuilds.push(engine.rebuild());
      await new Promise((done) => setTimeout(done, 60));
    }
    expect(existsSync(root)).toBe(false);
    writeFileSync(go, "");
    expect(await exited).toBe(0);

    const events = await Promise.all(rebuilds);
    expect(events.map((event) => event.kind)).toEqual(["generation", "generation", "generation", "generation"]);
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 300));
    expect(built).toEqual(["rebuild:generation"]);
    expect(engine.latest()?.generation.generation).toBe(2);
    expect(engine.lastBuild()?.ok).toBe(true);
    expect(gone).toBe(0);
    expect(failures).toEqual([]);
    expect(engine.watching()).toBe(true);
  });

  it("builds a folder another process made again once, though the build's own reading makes the platform report changes", async () => {
    const base = tempDir("dev-engine-");
    const root = join(base, "out");
    const source = join(base, "source");
    writePackage(root, "<p>one</p>");
    writePackage(source, "<p>made again by another process</p>");
    const built: string[] = [];
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, rootCheckMs: 50, onBuild: (event) => built.push(`${event.build.trigger}:${event.kind}`) });
    engines.push(engine);
    expect((await engine.ready).kind).toBe("generation");
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));
    built.length = 0;

    const script = [
      "const fs = require('node:fs');",
      REMAKE_WHOLE,
      "const [out, source] = process.argv.slice(1);",
      "fs.rmSync(out, { recursive: true, force: true });",
      "remake(source, out);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, root, source], { stdio: "ignore" });
    expect(await new Promise((done) => child.on("exit", done))).toBe(0);
    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
    // Past the catch-up build of the new watcher, and any change listing the new folders made the platform report.
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 300));
    expect(built).toEqual(["change:generation"]);

    // A save right after the folder is watched anew still builds.
    writeFileSync(join(root, "widgets", "main", "index.html"), "<p>saved</p>");
    const saved = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 3 && Date.now() < saved) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(3);
  });

  it("builds a save that adds a folder, once, and a save right after it", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    const engine = startDevEngine({ root, watch: true, debounceMs: 30, onBuild: (event) => built.push(`${event.build.trigger}:${event.kind}`) });
    engines.push(engine);
    await engine.ready;
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));
    built.length = 0;

    mkdirSync(join(root, "widgets", "main", "parts", "deeper"), { recursive: true });
    writeFileSync(join(root, "widgets", "main", "parts", "deeper", "part.js"), "export const part = 1;");
    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);
    await new Promise((done) => setTimeout(done, 400));
    expect(built).toEqual(["change:generation"]);

    // A save right after still builds.
    writeFileSync(join(root, "widgets", "main", "parts", "deeper", "part.js"), "export const part = 2;");
    const saved = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 3 && Date.now() < saved) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(3);
  });

  it("reports nothing for a change the platform watcher reports late, after a build already built it, and still builds a save after it", async () => {
    const root = tempDir("dev-engine-");
    writePackage(root, "<p>one</p>");
    const built: string[] = [];
    const generations: number[] = [];
    const engine = startDevEngine({
      root,
      watch: true,
      debounceMs: 30,
      onBuild: (event) => {
        built.push(`${event.build.trigger}:${event.kind}`);
        if (event.kind === "generation") generations.push(event.record.generation.generation);
      },
    });
    engines.push(engine);
    await engine.ready;
    await new Promise((done) => setTimeout(done, DEV_ENGINE_WATCH_CATCH_UP_MS + 100));
    built.length = 0;
    generations.length = 0;

    const part = join(root, "widgets", "main", "parts", "deeper", "part.js");
    mkdirSync(join(root, "widgets", "main", "parts", "deeper"), { recursive: true });
    writeFileSync(part, "export const part = 1;");
    const deadline = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(2);

    // FSEvents on macOS can deliver part of a save after the build that read all of it: the same change, reported late.
    const listener = watchListeners.get(engine.root);
    expect(listener).toBeDefined();
    listener?.("rename", join("widgets", "main", "parts", "deeper", "part.js"));
    // Past the debounce, so the late change has started its build; a rebuild then runs after it, in order.
    await new Promise((done) => setTimeout(done, 60));
    expect((await engine.rebuild()).kind).toBe("unchanged");
    expect(built).toEqual(["change:generation", "rebuild:unchanged"]);

    // A save right after is news, and builds.
    writeFileSync(part, "export const part = 2;");
    const saved = Date.now() + 5_000;
    while (engine.latest()?.generation.generation !== 3 && Date.now() < saved) await new Promise((done) => setTimeout(done, 25));
    expect(engine.latest()?.generation.generation).toBe(3);
    await new Promise((done) => setTimeout(done, 100));
    expect(built).toEqual(["change:generation", "rebuild:unchanged", "change:generation"]);
    expect(generations).toEqual([2, 3]);
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

  it("changes when the package adds a facet of a kind this host does not know, read from the snapshot too", async () => {
    const root = tempDir("dev-engine-");
    const cacheRoot = tempDir("dev-engine-cache-");
    writePackage(root, "<p>one</p>");
    const engine = engineFor(root, cacheRoot);
    await engine.ready;
    const first = engine.latest();
    const later = { kind: "agents", id: "com.example.dev.agents", entry: "agents/index.json", isolation: "isolated-ui" };
    writePackage(root, "<p>one</p>", { facets: [...manifest().facets, later as unknown as PackageManifest["facets"][number]] });
    await engine.rebuild("change");
    const second = engine.latest();

    if (first === undefined || second === undefined) throw new Error("expected two generations");
    // Same listed lanes and reach: only the skipped facet tells the two apart.
    expect(second.listing.riskTier).toBe(first.listing.riskTier);
    expect(devConsentScopeOf(second.listing)).not.toBe(devConsentScopeOf(first.listing));
    expect(devConsentScopeOf(second.listing)).toBe(devConsentScopeOf(second.listing, { ...second.manifest, skippedFacets: second.skippedFacets }));
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
