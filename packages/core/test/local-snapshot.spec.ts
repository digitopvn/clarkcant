import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DirectoryEntry } from "@clarkcant/contracts";

import {
  MAX_PACKAGE_DEPTH,
  artifactIsSnapshot,
  cachedLocalSnapshotPath,
  digestOfDirectory,
  installedDirectoryEntries,
  resolveLocalSource,
  snapshotLocalPackage,
} from "../src/package-fetch.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * A package listed by a path on this machine, copied into the package cache when it is installed.
 *
 * The copy is what runs: these tests check that it holds exactly the bytes its digest names, that nothing written to
 * the path afterwards reaches it, and that the walk refuses what the digest refuses (links, too many files, folders or
 * bytes, folders nested too deep) before anything lands at a servable name. The races a real filesystem cannot be asked
 * to produce on demand are in `local-snapshot-races.spec.ts`.
 */

const LIMITS = { maxFiles: 100, maxBytes: 1_000_000 };

let dir: string;
let source: string;
let cacheRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-local-snapshot-"));
  source = join(dir, "source");
  cacheRoot = join(dir, "package-cache");
  mkdirSync(join(source, "assets"), { recursive: true });
  writeFileSync(join(source, "clarkcant.json"), JSON.stringify({ id: "com.example.local" }));
  writeFileSync(join(source, "assets", "icon.svg"), "<svg></svg>");
});

afterEach(async () => {
  await removeTestDirectory(dir);
});

function digestOf(path: string): string {
  const digest = digestOfDirectory(path, { exclude: [".git"], excludeAnyCase: true });
  if (!digest.ok) throw new Error(digest.message);
  return digest.digest;
}

function snapshot(expectedDigest?: string) {
  return snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS, ...(expectedDigest === undefined ? {} : { expectedDigest }) });
}

/** What the snapshot folder holds besides finished snapshots: staged or stale copies left behind would show here. */
const leftovers = (): string[] =>
  existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")).filter((name) => name.startsWith(".")) : [];

/** Makes a symbolic link, or answers false where this machine may not (Windows without Developer Mode). */
function trySymlink(target: string, path: string, type?: "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EPERM") return false;
    throw cause;
  }
}

describe("snapshotLocalPackage", () => {
  it("copies the package to its content-addressed name, with the digest of the path it was copied from", async () => {
    const expected = digestOf(source);
    const result = await snapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.digest).toBe(expected);
    expect(result.artifact.path).toBe(cachedLocalSnapshotPath(cacheRoot, expected));
    expect(digestOf(result.artifact.path)).toBe(expected);
    expect(readFileSync(join(result.artifact.path, "assets", "icon.svg"), "utf8")).toBe("<svg></svg>");
    expect(leftovers()).toEqual([]);
  });

  it("digests the copy the way digestOfDirectory does, whatever order the names sort in", async () => {
    // `a-b` sorts before `a/b` as a relative path but after the folder `a` in a walk: the digest is of the sorted paths.
    mkdirSync(join(source, "a"));
    writeFileSync(join(source, "a", "b"), "inside");
    writeFileSync(join(source, "a-b"), "beside");
    writeFileSync(join(source, "empty.txt"), "");
    const result = await snapshot();
    if (!result.ok) throw new Error(result.message);
    expect(result.artifact.digest).toBe(digestOf(source));
    expect(digestOf(result.artifact.path)).toBe(result.artifact.digest);
  });

  it("keeps the copy as it was when the path is edited afterwards", async () => {
    const result = await snapshot();
    if (!result.ok) throw new Error(result.message);
    writeFileSync(join(source, "clarkcant.json"), JSON.stringify({ id: "com.example.local", changed: true }));
    writeFileSync(join(source, "added.txt"), "after");

    expect(readFileSync(join(result.artifact.path, "clarkcant.json"), "utf8")).toBe(JSON.stringify({ id: "com.example.local" }));
    expect(existsSync(join(result.artifact.path, "added.txt"))).toBe(false);
    expect(digestOf(result.artifact.path)).toBe(result.artifact.digest);
  });

  it("reuses the copy already there for the same bytes, and makes a new one for edited bytes", async () => {
    const first = await snapshot();
    const again = await snapshot();
    if (!first.ok || !again.ok) throw new Error("snapshot failed");
    expect(again.artifact).toEqual(first.artifact);

    writeFileSync(join(source, "clarkcant.json"), JSON.stringify({ id: "com.example.local", changed: true }));
    const edited = await snapshot();
    if (!edited.ok) throw new Error(edited.message);
    expect(edited.artifact.digest).not.toBe(first.artifact.digest);
    expect(edited.artifact.path).not.toBe(first.artifact.path);
    // Both stay: a generation that recorded the first one still finds its bytes.
    expect(digestOf(first.artifact.path)).toBe(first.artifact.digest);
    expect(leftovers()).toEqual([]);
  });

  it("replaces a folder at the snapshot's name whose files no longer match it", async () => {
    const first = await snapshot();
    if (!first.ok) throw new Error(first.message);
    writeFileSync(join(first.artifact.path, "clarkcant.json"), "tampered");

    const again = await snapshot();
    if (!again.ok) throw new Error(again.message);
    expect(again.artifact.path).toBe(first.artifact.path);
    expect(digestOf(again.artifact.path)).toBe(again.artifact.digest);
    expect(leftovers()).toEqual([]);
  });

  it("refuses files that differ from the digest the caller was shown, and caches nothing", async () => {
    const shown = digestOf(source);
    writeFileSync(join(source, "added.txt"), "written between the listing and the install");

    const result = await snapshot(shown);
    expect(result).toMatchObject({ ok: false, code: "ARTIFACT_DIGEST_MISMATCH" });
    expect(existsSync(cachedLocalSnapshotPath(cacheRoot, shown) ?? "")).toBe(false);
    expect(existsSync(cachedLocalSnapshotPath(cacheRoot, digestOf(source)) ?? "")).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("refuses more files or more bytes than the bounds, and caches nothing", async () => {
    expect(await snapshotLocalPackage({ path: source, cacheRoot, limits: { maxFiles: 1, maxBytes: 1_000 } })).toMatchObject({
      ok: false,
      code: "ARTIFACT_TOO_LARGE",
    });
    expect(await snapshotLocalPackage({ path: source, cacheRoot, limits: { maxFiles: 10, maxBytes: 5 } })).toMatchObject({
      ok: false,
      code: "ARTIFACT_TOO_LARGE",
    });
    expect(existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")) : []).toEqual([]);
  });

  it("refuses more folders than the bound, even empty ones, as the digest of the path does", async () => {
    for (const name of ["a", "b", "c"]) mkdirSync(join(source, name));
    const limits = { maxFiles: 3, maxBytes: 1_000 };
    expect(await snapshotLocalPackage({ path: source, cacheRoot, limits })).toMatchObject({ ok: false, code: "ARTIFACT_TOO_LARGE" });
    expect(digestOfDirectory(source, { limits })).toMatchObject({ ok: false, code: "ARTIFACT_TOO_LARGE" });
    expect(leftovers()).toEqual([]);
  });

  it("refuses folders nested deeper than the bound, as the digest of the path does", async () => {
    const parts = Array.from({ length: MAX_PACKAGE_DEPTH + 1 }, () => "d");
    mkdirSync(join(source, ...parts), { recursive: true });
    const limits = { maxFiles: 1_000, maxBytes: 1_000 };
    expect(await snapshotLocalPackage({ path: source, cacheRoot, limits })).toMatchObject({ ok: false, code: "ARTIFACT_TOO_LARGE" });
    expect(digestOfDirectory(source, { limits })).toMatchObject({ ok: false, code: "ARTIFACT_TOO_LARGE" });

    // One level fewer is within the bound.
    rmSync(join(source, ...parts), { recursive: true });
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits });
    expect(result.ok).toBe(true);
  });

  it("refuses a symbolic link in the tree", async (context) => {
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret");
    // A file symlink needs Developer Mode on Windows; the junction tests below cover links without it.
    if (!trySymlink(outside, join(source, "assets", "escape.txt"))) context.skip();
    expect(await snapshot()).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
    expect(existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")) : []).toEqual([]);
  });

  it("refuses a directory link, which Windows makes as a junction", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(source, "linked"), "junction");
    expect(await snapshot()).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
  });

  it("refuses a package whose root is itself a link", async () => {
    const linkedRoot = join(dir, "linked-root");
    symlinkSync(source, linkedRoot, "junction");
    expect(await snapshotLocalPackage({ path: linkedRoot, cacheRoot, limits: LIMITS })).toMatchObject({ ok: false });
  });

  it("refuses a file with a second hard link, whose bytes can change through the other name", async () => {
    linkSync(join(source, "clarkcant.json"), join(dir, "other-name.json"));
    expect(await snapshot()).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
  });

  it("refuses a path that is missing or is not a folder", async () => {
    expect(await snapshotLocalPackage({ path: join(dir, "missing"), cacheRoot, limits: LIMITS })).toMatchObject({
      ok: false,
      code: "LOCAL_SOURCE_UNREADABLE",
    });
    expect(await snapshotLocalPackage({ path: join(source, "clarkcant.json"), cacheRoot, limits: LIMITS })).toMatchObject({
      ok: false,
      code: "LOCAL_SOURCE_UNREADABLE",
    });
    expect(leftovers()).toEqual([]);
  });

  it("leaves a root .git folder out of the copy, as it is out of the digest, and keeps a nested one", async () => {
    mkdirSync(join(source, ".git"));
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(source, "vendor", ".git"), { recursive: true });
    writeFileSync(join(source, "vendor", ".git", "config"), "vendored");

    const result = await snapshot();
    if (!result.ok) throw new Error(result.message);
    expect(existsSync(join(result.artifact.path, ".git"))).toBe(false);
    expect(readFileSync(join(result.artifact.path, "vendor", ".git", "config"), "utf8")).toBe("vendored");
    expect(result.artifact.digest).toBe(digestOf(source));
  });

  it("leaves a root .git folder out in any letter case, which Windows and macOS treat as the same folder", async () => {
    mkdirSync(join(source, ".GIT"));
    writeFileSync(join(source, ".GIT", "config"), "[remote] url = https://token@example.com/repo.git");

    const result = await snapshot();
    if (!result.ok) throw new Error(result.message);
    expect(readdirSync(result.artifact.path).map((name) => name.toLowerCase())).not.toContain(".git");
    // The digest of the path leaves it out the same way, so a listing's `contentDigest` still matches the copy.
    expect(result.artifact.digest).toBe(digestOf(source));
    expect(await snapshot(digestOf(source))).toMatchObject({ ok: true });
  });

  it("copies a read-only file to a copy the cache can still remove", async () => {
    const readOnly = join(source, "assets", "icon.svg");
    chmodSync(readOnly, 0o444);
    try {
      const result = await snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(readFileSync(join(result.artifact.path, "assets", "icon.svg"), "utf8")).toBe("<svg></svg>");
      rmSync(result.artifact.path, { recursive: true });
      expect(existsSync(result.artifact.path)).toBe(false);
    } finally {
      chmodSync(readOnly, 0o644);
    }
  });

  it("names the same snapshot whichever way the path is spelled", async () => {
    const expected = await snapshot();
    if (!expected.ok) throw new Error(expected.message);
    const spellings = [
      relative(process.cwd(), source),
      `${source}/`,
      process.platform === "win32" ? source.replaceAll("\\", "/") : join(source, "assets", ".."),
    ];
    for (const path of spellings) {
      const result = await snapshotLocalPackage({ path, cacheRoot, limits: LIMITS });
      expect(result).toMatchObject({ ok: true, artifact: expected.artifact });
    }
  });

  it("removes staging and set-aside folders an earlier install left behind, once they are old enough", async () => {
    const local = join(cacheRoot, "local");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of [".tmp-crashed", ".stale-locked"]) {
      mkdirSync(join(local, name), { recursive: true });
      writeFileSync(join(local, name, "clarkcant.json"), "left behind");
      utimesSync(join(local, name), old, old);
    }
    // A staging folder another install is writing right now is young, and stays.
    mkdirSync(join(local, ".tmp-in-progress"));

    const result = await snapshot();
    if (!result.ok) throw new Error(result.message);
    expect(leftovers()).toEqual([".tmp-in-progress"]);
  });
});

describe("cachedLocalSnapshotPath", () => {
  it("names a folder only for a sha256 digest, so a recorded value can never walk out of the cache", () => {
    const hex = "a".repeat(64);
    expect(cachedLocalSnapshotPath(cacheRoot, `sha256:${hex}`)).toBe(join(cacheRoot, "local", hex));
    expect(cachedLocalSnapshotPath(cacheRoot, "sha256:../../etc")).toBeUndefined();
    expect(cachedLocalSnapshotPath(cacheRoot, `sha256:${hex}/..`)).toBeUndefined();
    expect(cachedLocalSnapshotPath(cacheRoot, `sha512:${hex}`)).toBeUndefined();
  });
});

describe("artifactIsSnapshot", () => {
  it("tells whether a plan's artifact is the snapshot a generation recorded", () => {
    const hex = "e".repeat(64);
    const path = cachedLocalSnapshotPath(cacheRoot, `sha256:${hex}`) ?? "";
    expect(artifactIsSnapshot(`file:${path}`, `sha256:${hex}`)).toBe(true);
    expect(artifactIsSnapshot(`file:${path}`, `sha256:${"f".repeat(64)}`)).toBe(false);
    expect(artifactIsSnapshot("file:/somewhere/package", `sha256:${hex}`)).toBe(false);
    expect(artifactIsSnapshot(`file:${path}`, "sha256:not-a-digest")).toBe(false);
  });
});

describe("resolveLocalSource for a package listed by a path", () => {
  const entry = { source: { kind: "local" as const, path: "/somewhere/package" } };
  const digest = `sha256:${"b".repeat(64)}`;

  it("points at the snapshot the generation recorded, even when it is gone from the cache", () => {
    expect(resolveLocalSource(entry, cacheRoot, { snapshotDigest: digest })).toEqual({
      kind: "local",
      path: join(cacheRoot, "local", "b".repeat(64)),
    });
  });

  it("keeps the path for a generation installed before snapshots, or with no generation at hand", () => {
    expect(resolveLocalSource(entry, cacheRoot, {})).toBe(entry.source);
    expect(resolveLocalSource(entry, cacheRoot)).toBe(entry.source);
  });
});

describe("installedDirectoryEntries", () => {
  const digest = `sha256:${"c".repeat(64)}`;
  const snapshotPath = (): string => join(cacheRoot, "local", "c".repeat(64));
  const listing = (overrides: Partial<DirectoryEntry> = {}): DirectoryEntry =>
    ({
      packageId: "com.example.local",
      version: "1.0.0",
      digest: "sha256:listed",
      source: { kind: "local", path: "/somewhere/package" },
      ...overrides,
    }) as DirectoryEntry;

  it("re-points a local entry at the snapshot of the active generation that installed it", () => {
    const generation = { packageId: "com.example.local", version: "1.0.0", digest: "sha256:listed", snapshotDigest: digest };
    const installed = installedDirectoryEntries([listing()], [generation], cacheRoot);
    expect(installed.entries.map((entry) => entry.source)).toEqual([{ kind: "local", path: snapshotPath() }]);
    expect(installed.withheld).toEqual([]);
  });

  it("matches a generation recorded under the path it was installed from", () => {
    const generation = { packageId: "/somewhere/package", version: "1.0.0", digest: "sha256:listed", snapshotDigest: digest };
    const installed = installedDirectoryEntries([listing()], [generation], cacheRoot);
    expect(installed.entries.map((entry) => entry.source)).toEqual([{ kind: "local", path: snapshotPath() }]);
  });

  it("withholds a listing that no longer names what a snapshotted generation installed, rather than reading its path", () => {
    const entry = listing();
    const changed = [
      // The same version re-packed with another digest, and not installed again.
      { packageId: "com.example.local", version: "1.0.0", digest: "sha256:other", snapshotDigest: digest },
      // Another version of the package is the one running.
      { packageId: "com.example.local", version: "2.0.0", digest: "sha256:listed", snapshotDigest: digest },
      { packageId: "/somewhere/package", version: "2.0.0", digest: "sha256:listed", snapshotDigest: digest },
    ];
    for (const generation of changed) {
      const installed = installedDirectoryEntries([entry], [generation], cacheRoot);
      expect(installed.entries).toEqual([]);
      expect(installed.withheld).toEqual([{ entry, generation }]);
    }
  });

  it("leaves an entry as listed for a generation installed before snapshots, or for another package", () => {
    const entry = listing();
    const unchanged = [
      [],
      [{ packageId: "com.example.local", version: "1.0.0", digest: "sha256:listed" }],
      [{ packageId: "com.example.local", version: "1.0.0", digest: "sha256:other" }],
      [{ packageId: "com.example.other", version: "1.0.0", digest: "sha256:listed", snapshotDigest: digest }],
    ];
    for (const generations of unchanged) {
      expect(installedDirectoryEntries([entry], generations, cacheRoot)).toEqual({ entries: [entry], withheld: [] });
    }
  });

  it("leaves a git or npm entry to the fetch cache, whatever is installed", () => {
    const entry = listing({ source: { kind: "npm", name: "com-example-local", version: "1.0.0" } } as Partial<DirectoryEntry>);
    const generation = { packageId: "com.example.local", version: "2.0.0", digest: "sha256:listed", snapshotDigest: digest };
    expect(installedDirectoryEntries([entry], [generation], cacheRoot)).toEqual({ entries: [entry], withheld: [] });
  });
});
