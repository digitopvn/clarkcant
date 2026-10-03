import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DirectoryEntry } from "@clarkcant/contracts";

import {
  cachedLocalSnapshotPath,
  digestOfDirectory,
  installedDirectoryEntries,
  resolveLocalSource,
  snapshotLocalPackage,
} from "../src/package-fetch.ts";

/**
 * A package listed by a path on this machine, copied into the package cache when it is installed.
 *
 * The copy is what runs: these tests check that it holds exactly the bytes its digest names, that nothing written to
 * the path afterwards reaches it, and that the walk refuses what the digest refuses (links, too many files, too many
 * bytes) before anything lands at a servable name.
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

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function digestOf(path: string): string {
  const digest = digestOfDirectory(path, { exclude: [".git"] });
  if (!digest.ok) throw new Error(digest.message);
  return digest.digest;
}

function snapshot(expectedDigest?: string) {
  return snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS, ...(expectedDigest === undefined ? {} : { expectedDigest }) });
}

/** What the snapshot folder holds besides finished snapshots: staged or stale copies left behind would show here. */
const leftovers = (): string[] =>
  existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")).filter((name) => name.startsWith(".")) : [];

describe("snapshotLocalPackage", () => {
  it("copies the package to its content-addressed name, with the digest of the path it was copied from", () => {
    const expected = digestOf(source);
    const result = snapshot();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.digest).toBe(expected);
    expect(result.artifact.path).toBe(cachedLocalSnapshotPath(cacheRoot, expected));
    expect(digestOf(result.artifact.path)).toBe(expected);
    expect(readFileSync(join(result.artifact.path, "assets", "icon.svg"), "utf8")).toBe("<svg></svg>");
    expect(leftovers()).toEqual([]);
  });

  it("keeps the copy as it was when the path is edited afterwards", () => {
    const result = snapshot();
    if (!result.ok) throw new Error(result.message);
    writeFileSync(join(source, "clarkcant.json"), JSON.stringify({ id: "com.example.local", changed: true }));
    writeFileSync(join(source, "added.txt"), "after");

    expect(readFileSync(join(result.artifact.path, "clarkcant.json"), "utf8")).toBe(JSON.stringify({ id: "com.example.local" }));
    expect(existsSync(join(result.artifact.path, "added.txt"))).toBe(false);
    expect(digestOf(result.artifact.path)).toBe(result.artifact.digest);
  });

  it("reuses the copy already there for the same bytes, and makes a new one for edited bytes", () => {
    const first = snapshot();
    const again = snapshot();
    if (!first.ok || !again.ok) throw new Error("snapshot failed");
    expect(again.artifact).toEqual(first.artifact);

    writeFileSync(join(source, "clarkcant.json"), JSON.stringify({ id: "com.example.local", changed: true }));
    const edited = snapshot();
    if (!edited.ok) throw new Error(edited.message);
    expect(edited.artifact.digest).not.toBe(first.artifact.digest);
    expect(edited.artifact.path).not.toBe(first.artifact.path);
    // Both stay: a generation that recorded the first one still finds its bytes.
    expect(digestOf(first.artifact.path)).toBe(first.artifact.digest);
    expect(leftovers()).toEqual([]);
  });

  it("replaces a folder at the snapshot's name whose files no longer match it", () => {
    const first = snapshot();
    if (!first.ok) throw new Error(first.message);
    writeFileSync(join(first.artifact.path, "clarkcant.json"), "tampered");

    const again = snapshot();
    if (!again.ok) throw new Error(again.message);
    expect(again.artifact.path).toBe(first.artifact.path);
    expect(digestOf(again.artifact.path)).toBe(again.artifact.digest);
    expect(leftovers()).toEqual([]);
  });

  it("refuses files that differ from the digest the caller was shown, and caches nothing", () => {
    const shown = digestOf(source);
    writeFileSync(join(source, "added.txt"), "written between the listing and the install");

    const result = snapshot(shown);
    expect(result).toMatchObject({ ok: false, code: "ARTIFACT_DIGEST_MISMATCH" });
    expect(existsSync(cachedLocalSnapshotPath(cacheRoot, shown) ?? "")).toBe(false);
    expect(existsSync(cachedLocalSnapshotPath(cacheRoot, digestOf(source)) ?? "")).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("refuses more files or more bytes than the bounds, and caches nothing", () => {
    expect(snapshotLocalPackage({ path: source, cacheRoot, limits: { maxFiles: 1, maxBytes: 1_000 } })).toMatchObject({
      ok: false,
      code: "ARTIFACT_TOO_LARGE",
    });
    expect(snapshotLocalPackage({ path: source, cacheRoot, limits: { maxFiles: 10, maxBytes: 5 } })).toMatchObject({
      ok: false,
      code: "ARTIFACT_TOO_LARGE",
    });
    expect(existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")) : []).toEqual([]);
  });

  it("refuses a symbolic link in the tree", () => {
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(source, "assets", "escape.txt"));
    expect(snapshot()).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
    expect(existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")) : []).toEqual([]);
  });

  it("refuses a directory link, which Windows makes as a junction", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(source, "linked"), "junction");
    expect(snapshot()).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
  });

  it("refuses a package whose root is itself a link", () => {
    const linkedRoot = join(dir, "linked-root");
    symlinkSync(source, linkedRoot, "junction");
    expect(snapshotLocalPackage({ path: linkedRoot, cacheRoot, limits: LIMITS })).toMatchObject({ ok: false });
  });

  it("refuses a file with a second hard link, whose bytes can change through the other name", () => {
    linkSync(join(source, "clarkcant.json"), join(dir, "other-name.json"));
    expect(snapshot()).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
  });

  it("refuses a path that is missing or is not a folder", () => {
    expect(snapshotLocalPackage({ path: join(dir, "missing"), cacheRoot, limits: LIMITS })).toMatchObject({
      ok: false,
      code: "LOCAL_SOURCE_UNREADABLE",
    });
    expect(snapshotLocalPackage({ path: join(source, "clarkcant.json"), cacheRoot, limits: LIMITS })).toMatchObject({
      ok: false,
      code: "LOCAL_SOURCE_UNREADABLE",
    });
    expect(leftovers()).toEqual([]);
  });

  it("leaves a root .git folder out of the copy, as it is out of the digest, and keeps a nested one", () => {
    mkdirSync(join(source, ".git"));
    writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(join(source, "vendor", ".git"), { recursive: true });
    writeFileSync(join(source, "vendor", ".git", "config"), "vendored");

    const result = snapshot();
    if (!result.ok) throw new Error(result.message);
    expect(existsSync(join(result.artifact.path, ".git"))).toBe(false);
    expect(readFileSync(join(result.artifact.path, "vendor", ".git", "config"), "utf8")).toBe("vendored");
    expect(result.artifact.digest).toBe(digestOf(source));
  });

  it("copies a read-only file to a copy the cache can still remove", () => {
    const readOnly = join(source, "assets", "icon.svg");
    chmodSync(readOnly, 0o444);
    try {
      const result = snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(readFileSync(join(result.artifact.path, "assets", "icon.svg"), "utf8")).toBe("<svg></svg>");
      rmSync(result.artifact.path, { recursive: true });
      expect(existsSync(result.artifact.path)).toBe(false);
    } finally {
      chmodSync(readOnly, 0o644);
    }
  });

  it("names the same snapshot whichever way the path is spelled", () => {
    const expected = snapshot();
    if (!expected.ok) throw new Error(expected.message);
    const spellings = [
      relative(process.cwd(), source),
      `${source}/`,
      process.platform === "win32" ? source.replaceAll("\\", "/") : join(source, "assets", ".."),
    ];
    for (const path of spellings) {
      const result = snapshotLocalPackage({ path, cacheRoot, limits: LIMITS });
      expect(result).toEqual(expected);
    }
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
  const listing = (overrides: Partial<DirectoryEntry> = {}): DirectoryEntry =>
    ({
      packageId: "com.example.local",
      version: "1.0.0",
      digest: "sha256:listed",
      source: { kind: "local", path: "/somewhere/package" },
      ...overrides,
    }) as DirectoryEntry;

  it("re-points a local entry at the snapshot of the active generation that installed it", () => {
    const [mapped] = installedDirectoryEntries(
      [listing()],
      [{ packageId: "com.example.local", version: "1.0.0", digest: "sha256:listed", snapshotDigest: digest }],
      cacheRoot,
    );
    expect(mapped?.source).toEqual({ kind: "local", path: join(cacheRoot, "local", "c".repeat(64)) });
  });

  it("matches a generation recorded under the path it was installed from", () => {
    const [mapped] = installedDirectoryEntries(
      [listing()],
      [{ packageId: "/somewhere/package", version: "1.0.0", digest: "sha256:listed", snapshotDigest: digest }],
      cacheRoot,
    );
    expect(mapped?.source).toEqual({ kind: "local", path: join(cacheRoot, "local", "c".repeat(64)) });
  });

  it("leaves an entry as listed when no generation with a snapshot installed exactly it", () => {
    const entry = listing();
    const unchanged = [
      [{ packageId: "com.example.local", version: "1.0.0", digest: "sha256:listed" }],
      [{ packageId: "com.example.local", version: "2.0.0", digest: "sha256:listed", snapshotDigest: digest }],
      [{ packageId: "com.example.local", version: "1.0.0", digest: "sha256:other", snapshotDigest: digest }],
      [{ packageId: "com.example.other", version: "1.0.0", digest: "sha256:listed", snapshotDigest: digest }],
    ];
    for (const generations of unchanged) {
      expect(installedDirectoryEntries([entry], generations, cacheRoot)).toEqual([entry]);
    }
  });
});
