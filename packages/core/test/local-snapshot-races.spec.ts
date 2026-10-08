import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cachedLocalSnapshotPath, digestOfDirectory, snapshotLocalPackage } from "../src/package-fetch.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * The moments of a snapshot a real filesystem cannot be asked to produce on demand: a file replaced or grown between
 * the listing and the open, a file edited while the copy runs, an identical copy winning the rename, and the cache
 * refusing a write. Each is a race between two calls rather than a state of the disk, so a fixture could only reach it
 * by accident. That is why this file mocks and `local-snapshot.spec.ts` does not.
 *
 * The mock runs one hook before the real call and passes every call to the real implementation, so the snapshot still
 * lists, opens, checks and writes real files; the hook only changes the disk at the moment the race would.
 */

interface Hooks {
  /** Runs before a real `open`, with the path and the flags the snapshot passed. */
  beforeOpen?: (path: string, flags: unknown) => void;
  /** Replaces a `rename`, given the real one. */
  rename?: (from: string, to: string, real: (from: string, to: string) => Promise<void>) => Promise<void>;
}

const hooks = vi.hoisted((): Hooks => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags?: string | number, mode?: number) => {
      hooks.beforeOpen?.(String(path), flags);
      return actual.open(path, flags, mode);
    },
    rename: async (from: string, to: string) =>
      hooks.rename === undefined ? actual.rename(from, to) : hooks.rename(String(from), String(to), actual.rename),
  };
});

const LIMITS = { maxFiles: 100, maxBytes: 1_000 };

let dir: string;
let source: string;
let cacheRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-local-snapshot-races-"));
  source = join(dir, "source");
  cacheRoot = join(dir, "package-cache");
  mkdirSync(join(source, "assets"), { recursive: true });
  writeFileSync(join(source, "clarkcant.json"), JSON.stringify({ id: "com.example.local" }));
  writeFileSync(join(source, "assets", "icon.svg"), "<svg></svg>");
});

afterEach(async () => {
  delete hooks.beforeOpen;
  delete hooks.rename;
  await removeTestDirectory(dir);
});

function digestOf(path: string): string {
  const digest = digestOfDirectory(path, { exclude: [".git"], excludeAnyCase: true });
  if (!digest.ok) throw new Error(digest.message);
  return digest.digest;
}

/** Everything in the snapshot folder: finished snapshots and anything staged or set aside. */
const cached = (): string[] => (existsSync(join(cacheRoot, "local")) ? readdirSync(join(cacheRoot, "local")) : []);

/** Runs `change` once, just before the snapshot opens the source file whose path ends with `name` to read it. */
function onceBeforeReading(name: string, change: (path: string) => void): void {
  let done = false;
  hooks.beforeOpen = (path, flags) => {
    if (done || typeof flags !== "number" || !path.endsWith(name)) return;
    done = true;
    change(path);
  };
}

describe("a snapshot racing the files it copies", () => {
  it("refuses a file replaced by another file after it was listed, on every platform", async () => {
    // A rename over the name, so the new file is a different file (never a reused one) with the same name and bytes.
    onceBeforeReading("icon.svg", (path) => {
      writeFileSync(join(dir, "replacement.svg"), "<svg></svg>");
      renameSync(join(dir, "replacement.svg"), path);
    });
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS });
    expect(result).toMatchObject({ ok: false, code: "ARTIFACT_SYMLINK_ESCAPE" });
    expect(cached()).toEqual([]);
  });

  it("checks a file's size on the opened handle before reading it, so a file grown since the listing is not read", async () => {
    onceBeforeReading("clarkcant.json", (path) => appendFileSync(path, "x".repeat(2_000)));
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS });
    expect(result).toMatchObject({ ok: false, code: "ARTIFACT_TOO_LARGE" });
    expect(cached()).toEqual([]);
  });

  it("refuses a copy whose files were edited while it ran, when no digest says which files were meant", async () => {
    // `assets/icon.svg` is copied first; it is edited once the copy has moved on, so the copy would mix two versions.
    onceBeforeReading("clarkcant.json", () => writeFileSync(join(source, "assets", "icon.svg"), "<svg>edited</svg>"));
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS });
    expect(result).toMatchObject({ ok: false, code: "LOCAL_SOURCE_CHANGED" });
    expect(cached()).toEqual([]);
  });

  it("keeps a copy that matches the digest it was asked for, whatever the files became afterwards", async () => {
    const expectedDigest = digestOf(source);
    onceBeforeReading("clarkcant.json", () => writeFileSync(join(source, "assets", "icon.svg"), "<svg>edited</svg>"));
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS, expectedDigest });
    expect(result).toMatchObject({ ok: true, artifact: { digest: expectedDigest } });
    if (!result.ok) return;
    expect(readFileSync(join(result.artifact.path, "assets", "icon.svg"), "utf8")).toBe("<svg></svg>");
  });

  it("refuses two names the cache's filesystem stores as one, rather than writing one over the other", async () => {
    let done = false;
    hooks.beforeOpen = (path, flags) => {
      if (done || flags !== "wx" || !path.endsWith("clarkcant.json")) return;
      done = true;
      // What a case-insensitive cache does with a second name differing only in case: the name is already taken.
      writeFileSync(path, "");
    };
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS });
    expect(result).toMatchObject({ ok: false, code: "LOCAL_SOURCE_UNREADABLE" });
    if (!result.ok) expect(result.message).toContain("same name");
    expect(cached()).toEqual([]);
  });
});

describe("a snapshot placing its copy in the cache", () => {
  it("keeps an identical copy that won the rename, and leaves nothing staged", async () => {
    hooks.rename = async (from, to, real) => {
      if (from.includes(".tmp-") && !existsSync(to)) cpSync(from, to, { recursive: true });
      await real(from, to);
    };
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS });
    expect(result).toMatchObject({ ok: true, artifact: { digest: digestOf(source) } });
    if (!result.ok) return;
    expect(digestOf(result.artifact.path)).toBe(result.artifact.digest);
    expect(cached()).toEqual([result.artifact.digest.slice("sha256:".length)]);
  });

  it("reports a cache it cannot write as the cache's failure, not the files', and leaves the files as they were", async () => {
    hooks.rename = () => {
      const cause = new Error("ENOSPC: no space left on device, rename") as NodeJS.ErrnoException;
      cause.code = "ENOSPC";
      return Promise.reject(cause);
    };
    const before = digestOf(source);
    const result = await snapshotLocalPackage({ path: source, cacheRoot, limits: LIMITS });
    expect(result).toMatchObject({ ok: false, code: "PACKAGE_CACHE_UNAVAILABLE" });
    if (!result.ok) expect(result.message).toContain("ENOSPC");
    expect(digestOf(source)).toBe(before);
    expect(existsSync(cachedLocalSnapshotPath(cacheRoot, before) ?? "")).toBe(false);
    expect(cached()).toEqual([]);
  });
});
