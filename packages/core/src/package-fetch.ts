import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

import type { DirectoryEntry, PackageGeneration, PackageSource } from "@clarkcant/contracts";

/**
 * Fetching a git or npm package source to an exact artifact this node holds.
 *
 * `package-sources.ts` resolves a git/npm source against a directory's *published* digest — a claim the publisher
 * made, not bytes this node has looked at. This is the module that goes and gets the bytes: a commit-pinned git
 * fetch or an exact-version npm tarball, verified against the registry's own integrity, landing in a node-owned
 * cache directory. What comes back is deliberately shaped like a local source (`path` + `digest`), because the
 * point of this phase is that there is still only one install path — `installFromSource` already knows what to do
 * with a local digest, and a fetched artifact is fed into exactly that rather than a second installer.
 *
 * Refusals are named rather than thrown, the same convention `resolvePackageSource` uses, so a caller can show the
 * reason instead of an exception.
 *
 * The directory listing this module fetches from is treated as untrusted input throughout: its `url`, `ref`,
 * `name` and `version` fields are attacker-reachable strings the moment a directory is served from anywhere other
 * than this node's own disk, so every one of them is validated before it reaches a subprocess or a filesystem path.
 */

export type FetchRefusal =
  | "GIT_REF_NOT_PINNED"
  | "GIT_SOURCE_NOT_ALLOWED"
  | "GIT_FETCH_FAILED"
  | "GIT_TIMEOUT"
  | "NPM_VERSION_NOT_PUBLISHED"
  | "NPM_FETCH_FAILED"
  | "NPM_TARBALL_TOO_LARGE"
  | "NPM_TARBALL_UNSAFE_ENTRY"
  | "NPM_INTEGRITY_MISMATCH"
  | "ARTIFACT_SYMLINK_ESCAPE"
  // Only a `digestOfDirectory` caller that passes `limits` can see this; the fetches digest their artifact uncapped.
  | "ARTIFACT_TOO_LARGE"
  | "CACHE_ESCAPE"
  | "ARTIFACT_DIGEST_MISMATCH";

export interface FetchedArtifact {
  /** Absolute path to the node-owned cache directory holding the fetched bytes. */
  path: string;
  /** sha256 over the fetched bytes, canonical form `sha256:<hex>`. */
  digest: string;
}

export type FetchOutcome =
  | { ok: true; artifact: FetchedArtifact }
  | { ok: false; code: FetchRefusal; message: string };

/** A full commit id. A short id or a tag is refused here: `git fetch <url> <ref>` needs an exact object name to be
 * deterministic, and a tag can be moved by its own publisher after this node last saw it. */
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/** Characters safe to use verbatim in a cache directory name. Anything else is replaced, so a crafted package
 * name (`../../etc`) cannot walk the cache path out of its root. */
function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9@._-]/g, "_");
}

/** A short, non-reversible fingerprint of an arbitrary string, safe to use as a path segment. */
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/** Strips user:password@ credentials out of a url before it reaches an error message, an audit record or a log —
 * a git/npm source url can carry HTTP basic-auth credentials, and a refusal or audit trail is not the place those
 * survive. Non-url strings (a malformed value that never parsed) are returned with everything before an `@` in the
 * authority position removed, on a best-effort basis, rather than left to leak verbatim. */
export function redactCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    // Not a parseable URL (a bare local path, or a deliberately malformed value). Best-effort: drop anything that
    // looks like `scheme://user:pass@host`.
    return url.replace(/:\/\/[^/@]*@/, "://");
  }
}

/**
 * The same credential redaction as `redactCredentials`, applied to a block of free-form text rather than to a
 * single url value (Low).
 *
 * `runGit`'s own refusal messages already pass every *url this node constructed* through `redactCredentials`, but
 * git's own stderr is neither: it is text the `git` subprocess wrote, and a git built with a credential helper, or
 * one that simply echoes the url it tried, can put `https://user:hunter2@host/...` into that text on its own —
 * `fatal: Authentication failed for 'https://user:hunter2@host/repo.git'` is a real message a real git prints. That
 * text reaches a refusal, an audit trail, or (per this repository's git rules) a PR comment verbatim unless this
 * function runs over it first. The regex is global (`/g`) rather than `redactCredentials`'s single match, because
 * unlike a single url value, free-form text can carry more than one.
 */
export function redactCredentialsInText(text: string): string {
  return text.replace(/:\/\/[^/\s@]*@/g, "://");
}

/** Refuses a candidate cache directory whose canonical path is not inside the canonical cache root — the same
 * symlink-safe containment check `package-files.ts` uses when serving a file, applied here to where a fetch is
 * allowed to write. */
function containedOrRefuse(cacheRoot: string, dest: string): { ok: true } | { ok: false; message: string } {
  const lexicalRoot = resolve(cacheRoot);
  const lexicalDest = resolve(dest);
  if (lexicalDest !== lexicalRoot && !lexicalDest.startsWith(lexicalRoot + sep)) {
    return { ok: false, message: "the fetch destination resolves outside the package cache" };
  }
  return { ok: true };
}

/**
 * sha256 over a directory's bytes and relative layout.
 *
 * Deterministic regardless of filesystem read order: every regular file under `dir` is hashed as
 * `<relative path>\0<byte length>\0<bytes>`, sorted by relative path first, so the same tree always produces the
 * same digest and a renamed-but-identical file changes it.
 *
 * Uses `lstatSync`, never `statSync`: `statSync` follows a symlink to what it points at, so a directory entry that
 * is a symlink always reports as a regular file or directory and the old "skip a symlink" check never fired. A
 * symlink or hard link that would let the digest (and, downstream, whatever reads this directory as a package)
 * reach bytes outside the artifact root is refused by name — never silently skipped and never allowed to throw an
 * unhandled `ELOOP`, which `lstatSync` cannot raise in the first place because it never follows the final
 * component of the path it is asked about.
 *
 * `limits` bounds the work for a caller that digests a directory it did not fetch (a path on this machine, digested
 * when it is listed or installed): past `maxFiles` regular files, `maxFiles` folders, `MAX_PACKAGE_DEPTH` levels of
 * nesting or `maxBytes` of file bytes in total, the walk stops before a byte is read and the answer is
 * `ARTIFACT_TOO_LARGE` rather than a digest.
 *
 * `excludeAnyCase` matches `exclude` in any letter case. A path on this machine sets it, because on Windows and macOS
 * `.GIT` is the same folder as `.git`; a fetched artifact keeps the exact match its published digest was made with.
 */
export function digestOfDirectory(
  dir: string,
  options: { exclude?: readonly string[]; excludeAnyCase?: boolean; limits?: { maxFiles: number; maxBytes: number } } = {},
): { ok: true; digest: string } | { ok: false; code: "ARTIFACT_SYMLINK_ESCAPE" | "ARTIFACT_TOO_LARGE"; message: string } {
  // `.git` (and any other caller-supplied exclusion) is only ever meaningful at the artifact root — a package that
  // legitimately ships a directory named `.git` deeper in its tree (a vendored git checkout, say) must not have it
  // silently dropped from the digest.
  const anyCase = options.excludeAnyCase === true;
  const exclude = new Set((options.exclude ?? []).map((name) => (anyCase ? name.toLowerCase() : name)));
  const limits = options.limits;
  const root = resolve(dir);
  const files: string[] = [];
  let folders = 0;
  let totalBytes = 0;
  const tooLarge = (): { ok: false; code: "ARTIFACT_TOO_LARGE"; message: string } => ({
    ok: false,
    code: "ARTIFACT_TOO_LARGE",
    message: `it holds more than ${String(limits?.maxFiles)} files, ${String(limits?.maxFiles)} folders or ${String(limits?.maxBytes)} bytes, or folders nested more than ${String(MAX_PACKAGE_DEPTH)} deep`,
  });

  function walk(
    current: string,
    depth: number,
  ): { ok: true } | { ok: false; code: "ARTIFACT_SYMLINK_ESCAPE" | "ARTIFACT_TOO_LARGE"; message: string } {
    if (limits !== undefined && depth > MAX_PACKAGE_DEPTH) return tooLarge();
    for (const name of readdirSync(current).sort()) {
      if (depth === 0 && exclude.has(anyCase ? name.toLowerCase() : name)) continue;
      const full = join(current, name);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat === undefined) continue;

      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          code: "ARTIFACT_SYMLINK_ESCAPE",
          message: `"${relative(root, full)}" is a symlink, which is refused rather than followed`,
        };
      }
      // A hard link (nlink > 1 on a regular file) shares inode/bytes with a path outside the artifact that this
      // function never walked, so a digest over "the file at this path" would not describe bytes unique to this
      // artifact. Directories cannot be hard-linked on the filesystems this runs on, so the check is scoped to
      // regular files.
      if (stat.isFile() && stat.nlink > 1) {
        return {
          ok: false,
          code: "ARTIFACT_SYMLINK_ESCAPE",
          message: `"${relative(root, full)}" is a hard link, which is refused rather than read`,
        };
      }
      if (stat.isDirectory()) {
        folders += 1;
        if (limits !== undefined && folders > limits.maxFiles) return tooLarge();
        const sub = walk(full, depth + 1);
        if (!sub.ok) return sub;
        continue;
      }
      if (stat.isFile()) {
        files.push(full);
        totalBytes += stat.size;
        if (limits !== undefined && (files.length > limits.maxFiles || totalBytes > limits.maxBytes)) return tooLarge();
      }
    }
    return { ok: true };
  }

  const walked = walk(root, 0);
  if (!walked.ok) return { ok: false, code: walked.code, message: walked.message };
  // The relative path is hashed with `/` separators and sorted in that form, so a package has one digest on every
  // OS: hashing `widgets\main\index.html` on Windows would never match the digest a directory published from POSIX.
  const entries = files
    .map((file) => ({ file, rel: relative(root, file).split(sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  for (const { file, rel } of entries) {
    const bytes = readFileSync(file);
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
  }
  return { ok: true, digest: `sha256:${hash.digest("hex")}` };
}

/** The content-addressed cache location a git source's exact `url`+`ref` fetches into — and the same path any
 * later caller (serving a widget frame, serving a file) recomputes from the same `url`+`ref` to find bytes this
 * node already fetched, with no separate persisted mapping required. Keying by url as well as ref (M3) means two
 * different remotes that happen to share a commit id never collide on one cache directory. */
export function cachedGitPath(cacheRoot: string, url: string, ref: string): string {
  return join(cacheRoot, "git", `${fingerprint(url)}-${safeSegment(ref)}`);
}

/** The content-addressed cache location an npm source's exact `name`+`version` fetches into, on the same
 * recompute-don't-persist principle as `cachedGitPath`. */
export function cachedNpmPath(cacheRoot: string, name: string, version: string): string {
  return join(cacheRoot, "npm", `${safeSegment(name)}-${safeSegment(version)}`);
}

/**
 * Resolves a directory entry's `source` to where its bytes actually live on this node, when this node has already
 * fetched them.
 *
 * This is the other half of the content-addressed cache design (H1/M3): a git or npm entry's cache path is a pure
 * function of its own `url`+`ref` or `name`+`version`, so anything holding the same directory entry — the install
 * route that just fetched it, or a later request serving a widget frame or a package file — can recompute the same
 * path without any separate persisted "what did we install" table. If the bytes are not there (never fetched, or
 * evicted), the entry's original `git`/`npm` source is returned unchanged, and the caller refuses it exactly the
 * way it always refused a non-local source.
 */
export function resolveLocalSource(
  entry: { source: PackageSource },
  cacheRoot: string,
  /**
   * The generation that installed this entry, when the caller has it. A package listed by a path on this machine is
   * served from the snapshot its generation recorded (`snapshotDigest`), never from the path itself: the path holds
   * whatever was written there since, and the snapshot holds the bytes that were digested and installed. A generation
   * without one was installed before snapshots, and keeps reading its path until it is installed again.
   */
  installed?: { snapshotDigest?: string | undefined },
): PackageSource {
  if (entry.source.kind === "local") {
    const snapshot = installed?.snapshotDigest === undefined ? undefined : cachedLocalSnapshotPath(cacheRoot, installed.snapshotDigest);
    // Returned whether or not it still exists: a snapshot that left the cache is a package whose files are gone, and
    // falling back to the live path would serve bytes nobody digested.
    return snapshot === undefined ? entry.source : { kind: "local", path: snapshot };
  }
  if (entry.source.kind === "git") {
    const path = cachedGitPath(cacheRoot, entry.source.url, entry.source.ref);
    if (existsSync(path)) return { kind: "local", path };
    return entry.source;
  }
  const path = cachedNpmPath(cacheRoot, entry.source.name, entry.source.version);
  if (existsSync(path)) return { kind: "local", path };
  return entry.source;
}

/* ------------------------------------------------------------------ *
 * Snapshots of a package listed by a path on this machine
 * ------------------------------------------------------------------ */

/** A content digest a snapshot can be named by. Anything else names no folder, so it can never become a path. */
const SNAPSHOT_DIGEST = /^sha256:([0-9a-f]{64})$/;

/**
 * The content-addressed cache location of a snapshot of a local package: a pure function of its content digest, so a
 * generation that records the digest finds its bytes again with no mapping kept anywhere else. Undefined for a value
 * that is not a sha256 digest.
 */
export function cachedLocalSnapshotPath(cacheRoot: string, digest: string): string | undefined {
  const hex = SNAPSHOT_DIGEST.exec(digest)?.[1];
  return hex === undefined ? undefined : join(cacheRoot, "local", hex);
}

/**
 * Whether an install plan's artifact (`file:<package cache>/local/<hex>`) is the snapshot a generation recorded. An
 * install of a local package plans its snapshot as the artifact, so this is how a plan and a generation are told to
 * be the same bytes without knowing where the cache is.
 */
export function artifactIsSnapshot(artifactUrl: string, snapshotDigest: string): boolean {
  const hex = SNAPSHOT_DIGEST.exec(snapshotDigest)?.[1];
  if (hex === undefined) return false;
  const segments = artifactUrl.split(/[\\/]/);
  return segments.at(-1) === hex && segments.at(-2) === "local";
}

/** What `installedDirectoryEntries` needs to know about an active generation. */
export type SnapshottedGeneration = Pick<PackageGeneration, "packageId" | "version" | "digest" | "snapshotDigest">;

/**
 * A directory listing as the node may read it, given what is installed: every local entry an active generation
 * installed from a snapshot is re-pointed at that snapshot, so a reader that walks the listing reads the bytes that
 * were installed rather than the path's.
 *
 * A local entry for a package whose active generation runs from a snapshot is never read from its path. When the
 * listing no longer names exactly what that generation installed (the same version listed with another digest after a
 * re-pack, or another version of the package), the entry is `withheld`: the generation's own snapshot is not what the
 * entry describes, and its path holds bytes nobody digested or approved. A reader answers a withheld entry with
 * `409 NOT_INSTALLED`, as the files route does, until the package is installed again.
 *
 * Matched the way `packageRootFrom` matches a generation to its entry: the package id or, for a generation recorded
 * under its path before local packages took their listed name, that path. A generation installed before snapshots (no
 * `snapshotDigest`) keeps reading its path, and an entry for a package with no such active generation is left as it is.
 */
export function installedDirectoryEntries<G extends SnapshottedGeneration>(
  entries: readonly DirectoryEntry[],
  generations: readonly G[],
  cacheRoot: string,
): { entries: DirectoryEntry[]; withheld: { entry: DirectoryEntry; generation: G }[] } {
  const readable: DirectoryEntry[] = [];
  const withheld: { entry: DirectoryEntry; generation: G }[] = [];
  for (const entry of entries) {
    if (entry.source.kind !== "local") {
      readable.push(entry);
      continue;
    }
    const localPath = entry.source.path;
    const owning = generations.filter(
      (candidate) =>
        candidate.snapshotDigest !== undefined && (candidate.packageId === entry.packageId || candidate.packageId === localPath),
    );
    const [first] = owning;
    if (first === undefined) {
      readable.push(entry);
      continue;
    }
    const installed = owning.find((candidate) => candidate.version === entry.version && candidate.digest === entry.digest);
    if (installed === undefined) {
      withheld.push({ entry, generation: first });
      continue;
    }
    const source = resolveLocalSource(entry, cacheRoot, installed);
    readable.push(source === entry.source ? entry : { ...entry, source });
  }
  return { entries: readable, withheld };
}

/** Why a withheld entry (`installedDirectoryEntries`) is not served: what failed, what was kept, and what to do next. */
export function notInstalledAsListedMessage(packageId: string, version: string): string {
  return `${packageId}@${version} is listed with files other than the copy installed on this node, so neither is served. Nothing was changed: the installed copy and its widgets' state are kept. Install the package again to run the files it lists now.`;
}

export type SnapshotRefusal =
  | "ARTIFACT_SYMLINK_ESCAPE"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "CACHE_ESCAPE"
  | "LOCAL_SOURCE_UNREADABLE"
  // The files at the path changed while they were being copied, and no expected digest says which version was meant.
  | "LOCAL_SOURCE_CHANGED"
  // The node could not write the copy into its own package cache; the files at the path are not at fault.
  | "PACKAGE_CACHE_UNAVAILABLE";

export type SnapshotOutcome =
  | { ok: true; artifact: FetchedArtifact }
  | { ok: false; code: SnapshotRefusal; message: string };

type SnapshotRefused = { ok: false; code: SnapshotRefusal; message: string };

/** How deep a package's folders may nest for the node to copy or digest it within bounds. */
export const MAX_PACKAGE_DEPTH = 64;
/** How old a staging or set-aside folder in the snapshot cache must be before a later install removes it. */
const LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;
/** How long, in total, Windows may refuse a rename in the cache (a scanner holding a file just written) before it counts. */
const WINDOWS_RENAME_BUDGET_MS = 3_000;
const COPY_CHUNK_BYTES = 64 * 1024;
/** `O_NOFOLLOW` where the platform has it. Windows has none, which is why every open is also checked by identity. */
const NO_FOLLOW: number = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * A failure on the cache's side of a snapshot: creating, writing, renaming or removing in the node's package cache.
 * Kept apart from failures reading the path, so a full disk or a locked cache folder is not reported as the person's
 * files being unreadable.
 */
class PackageCacheFailure extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "PackageCacheFailure";
  }
}

/**
 * Copy a package listed by a path on this machine into the node's package cache, and digest the copy.
 *
 * What an install of a local package runs is this copy, not the path: the path can be written to at any moment, so a
 * digest of it says what it held once, while the copy holds exactly the bytes the digest names for as long as anything
 * reads it. The same shape as a git or npm fetch (`path` + `digest`), and the same order: the copy is staged in a
 * temporary folder, digested from the very bytes written there, checked against `expectedDigest` when the caller has
 * one, and only then renamed to its content-addressed name (`cachedLocalSnapshotPath`). Copying the same bytes again
 * reuses the folder already there; a mismatch is refused and its staged copy discarded, so bytes nobody agreed to never
 * reach a servable name.
 *
 * With no `expectedDigest`, nothing says which version of the files was meant, so a copy taken while they were being
 * edited would be a tree that never existed at the path. The path is listed again after the copy, and any file or
 * folder whose size, modification time or identity changed refuses the snapshot (`LOCAL_SOURCE_CHANGED`).
 *
 * The walk refuses what `digestOfDirectory` refuses: a symlink or junction anywhere in the tree, and a regular file
 * with more than one hard link. Each file is opened without following a final link where the platform can do that
 * (`O_NOFOLLOW`; Windows cannot), and on every platform the opened handle must be the same file (device and file id)
 * as the one listed, so a name swapped for a link or another file after it was listed is refused rather than read
 * through. Each folder's canonical path must stay inside the package's, and the folder must still be the one listed
 * once it has been read. It is bounded by `limits` the same way (`LOCAL_DIGEST_MAX_FILES`, `LOCAL_DIGEST_MAX_BYTES` at
 * the install): at most `maxFiles` files and `maxFiles` folders, nested at most `MAX_PACKAGE_DEPTH` deep, and at most
 * `maxBytes` bytes, checked on each opened file's own size before it is read and read no further than that size, so a
 * file that grows during the copy cannot carry it past the bound. `.git` at the package root, in any letter case, is
 * left out, as the digest of a local path leaves it out.
 *
 * Asynchronous throughout, so a large package does not hold up the node while it is copied.
 *
 * Failures writing the cache are `PACKAGE_CACHE_UNAVAILABLE`, not `LOCAL_SOURCE_UNREADABLE`. Staging and set-aside
 * folders a crash or a locked file left behind are removed by a later snapshot once they are an hour old.
 *
 * Portable by construction: names are compared and written as the filesystem gives them, a file is written with
 * `wx` so two names a case-insensitive filesystem (Windows, macOS by default) cannot hold apart are refused rather
 * than one silently replacing the other, and every copy is written owner-writable whatever the source's permissions
 * or read-only attribute, so the node can always remove a copy it made.
 */
export async function snapshotLocalPackage(input: {
  path: string;
  cacheRoot: string;
  limits: { maxFiles: number; maxBytes: number };
  expectedDigest?: string;
  /**
   * Names left out at the package root, in any letter case, besides `.git`: a development folder's `node_modules`,
   * say, which its package does not ship and which may hold links the snapshot refuses. Left out of the copy, the
   * listings and the digest alike, so the digest stays the digest of the copy.
   */
  excludeRootNames?: readonly string[];
}): Promise<SnapshotOutcome> {
  const snapshotsRoot = join(input.cacheRoot, "local");
  const leftOut = new Set([".git", ...(input.excludeRootNames ?? [])].map((name) => name.toLowerCase()));
  const tempDest = join(snapshotsRoot, `.tmp-${fingerprint(`${input.path}#${String(Date.now())}#${String(Math.random())}`)}`);
  const tempContained = containedOrRefuse(input.cacheRoot, tempDest);
  if (!tempContained.ok) return { ok: false, code: "CACHE_ESCAPE", message: tempContained.message };
  const source = resolve(input.path);

  try {
    const listed = await listPackageTree(source, input.limits, leftOut);
    if (!listed.ok) return listed;

    await inCache(`could not create ${snapshotsRoot}`, () => mkdir(snapshotsRoot, { recursive: true }));
    await sweepLeftovers(snapshotsRoot);
    await inCache(`could not create ${tempDest}`, () => mkdir(tempDest));

    const copied = await copyAndDigest(listed.tree, tempDest, input.limits);
    if (!copied.ok) return copied;
    if (input.expectedDigest !== undefined && copied.digest !== input.expectedDigest) {
      return {
        ok: false,
        code: "ARTIFACT_DIGEST_MISMATCH",
        message: `the files at ${input.path} hash to ${copied.digest}, not ${input.expectedDigest}`,
      };
    }
    if (input.expectedDigest === undefined) {
      const after = await listPackageTree(source, input.limits, leftOut);
      if (!after.ok || !sameTree(listed.tree, after.tree)) {
        return { ok: false, code: "LOCAL_SOURCE_CHANGED", message: `the files at ${input.path} changed while they were being copied` };
      }
    }

    const dest = cachedLocalSnapshotPath(input.cacheRoot, copied.digest);
    if (dest === undefined) return { ok: false, code: "CACHE_ESCAPE", message: "the snapshot digest names no cache folder" };
    const destContained = containedOrRefuse(input.cacheRoot, dest);
    if (!destContained.ok) return { ok: false, code: "CACHE_ESCAPE", message: destContained.message };

    await placeSnapshot(tempDest, dest, copied.digest, input.limits);
    return { ok: true, artifact: { path: dest, digest: copied.digest } };
  } catch (cause) {
    if (cause instanceof PackageCacheFailure) return { ok: false, code: "PACKAGE_CACHE_UNAVAILABLE", message: cause.message };
    return { ok: false, code: "LOCAL_SOURCE_UNREADABLE", message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    await removeQuietly(tempDest);
  }
}

/** One regular file of a listed package, as it was when it was listed. */
interface ListedFile {
  /** Relative to the package root, with `/` separators: the form the digest hashes and sorts. */
  rel: string;
  full: string;
  size: number;
  mode: number;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
}

interface ListedFolder {
  rel: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
}

interface ListedTree {
  files: ListedFile[];
  folders: ListedFolder[];
}

/** The order `digestOfDirectory` hashes files in: by relative path with `/` separators. */
const byRel = (a: { rel: string }, b: { rel: string }): number => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

const sameNode = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean => a.dev === b.dev && a.ino === b.ino;

/** Lists a package's folders and regular files, refusing links and stopping at the bounds; see `snapshotLocalPackage`. */
async function listPackageTree(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
  /** Lower-case names left out at the root (`.git`, and whatever the caller adds). */
  leftOut: ReadonlySet<string>,
): Promise<{ ok: true; tree: ListedTree } | SnapshotRefused> {
  const rootStat = await lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink()) {
    return { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: `${root} is a symlink, which is refused rather than followed` };
  }
  if (!rootStat.isDirectory()) return { ok: false, code: "LOCAL_SOURCE_UNREADABLE", message: `${root} is not a folder` };
  const realRoot = await realpath(root);
  const files: ListedFile[] = [];
  const folders: ListedFolder[] = [];
  let totalBytes = 0;
  const tooLarge = (): SnapshotRefused => ({
    ok: false,
    code: "ARTIFACT_TOO_LARGE",
    message: `it holds more than ${String(limits.maxFiles)} files, ${String(limits.maxFiles)} folders or ${String(limits.maxBytes)} bytes, or folders nested more than ${String(MAX_PACKAGE_DEPTH)} deep`,
  });

  // A folder swapped for a link after its parent was read would be read through: its canonical path has to stay
  // inside the package's own.
  async function inside(folder: string, rel: string): Promise<SnapshotRefused | undefined> {
    const real = await realpath(folder);
    return real === realRoot || real.startsWith(realRoot + sep)
      ? undefined
      : { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: `"${rel}" leads outside the package` };
  }

  async function walk(folder: string, relParts: readonly string[], listed: BigIntStats): Promise<{ ok: true } | SnapshotRefused> {
    if (relParts.length > MAX_PACKAGE_DEPTH) return tooLarge();
    const rel = relParts.join("/");
    const escaped = await inside(folder, rel);
    if (escaped !== undefined) return escaped;
    const names = (await readdir(folder)).sort();
    // And it has to still be the folder that was listed once its names were read, not a link put in its place.
    const after = await lstat(folder, { bigint: true });
    if (after.isSymbolicLink() || !sameNode(after, listed)) {
      return { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: `"${rel}" was replaced while it was read, which is refused rather than followed` };
    }
    const escapedAfter = await inside(folder, rel);
    if (escapedAfter !== undefined) return escapedAfter;

    for (const name of names) {
      // `.git` (and the caller's names) only at the root, in any letter case: Windows and macOS treat `.GIT` as `.git`.
      if (relParts.length === 0 && leftOut.has(name.toLowerCase())) continue;
      const full = join(folder, name);
      const childRel = [...relParts, name].join("/");
      const stat = await lstatIfPresent(full);
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) {
        return { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: `"${childRel}" is a symlink, which is refused rather than followed` };
      }
      if (stat.isFile() && stat.nlink > 1n) {
        return { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: `"${childRel}" is a hard link, which is refused rather than read` };
      }
      if (stat.isDirectory()) {
        folders.push({ rel: childRel, dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs });
        if (folders.length > limits.maxFiles) return tooLarge();
        const sub = await walk(full, [...relParts, name], stat);
        if (!sub.ok) return sub;
        continue;
      }
      // Sockets, fifos and devices hold no package bytes, and the digest does not count them either.
      if (!stat.isFile()) continue;
      const size = Number(stat.size);
      files.push({ rel: childRel, full, size, mode: Number(stat.mode), dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs });
      totalBytes += size;
      if (files.length > limits.maxFiles || totalBytes > limits.maxBytes) return tooLarge();
    }
    return { ok: true };
  }

  const walked = await walk(root, [], rootStat);
  if (!walked.ok) return walked;
  return { ok: true, tree: { files, folders } };
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

/** Whether two listings of the same path name the same files and folders, unchanged. */
function sameTree(before: ListedTree, after: ListedTree): boolean {
  const sameFolders =
    before.folders.length === after.folders.length &&
    before.folders.every((folder, index) => {
      const other = after.folders[index];
      return other !== undefined && other.rel === folder.rel && sameNode(other, folder) && other.mtimeNs === folder.mtimeNs;
    });
  return (
    sameFolders &&
    before.files.length === after.files.length &&
    before.files.every((file, index) => {
      const other = after.files[index];
      return other !== undefined && other.rel === file.rel && sameNode(other, file) && other.size === file.size && other.mtimeNs === file.mtimeNs;
    })
  );
}

/**
 * Reads every listed file once, in digest order, hashing the bytes as they are read and, when `dest` is given, writing
 * those same bytes there. The answer is the digest `digestOfDirectory` gives the copy, taken from the bytes that were
 * written rather than from a second read.
 */
async function copyAndDigest(
  tree: ListedTree,
  dest: string | undefined,
  limits: { maxFiles: number; maxBytes: number },
): Promise<{ ok: true; digest: string } | SnapshotRefused> {
  if (dest !== undefined) {
    // A parent sorts before its children, so each folder's parent exists by the time it is made.
    for (const folder of [...tree.folders].sort(byRel)) {
      const made = await createInCache(`could not create a folder in ${dest}`, () => mkdir(join(dest, ...folder.rel.split("/"))));
      if (!made.created) return nameClash(folder.rel);
    }
  }

  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let totalBytes = 0;
  for (const file of [...tree.files].sort(byRel)) {
    const handle = await open(file.full, constants.O_RDONLY | NO_FOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) {
        return { ok: false, code: "LOCAL_SOURCE_UNREADABLE", message: `"${file.rel}" stopped being a file while it was copied` };
      }
      if (opened.nlink > 1n) {
        return { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: `"${file.rel}" is a hard link, which is refused rather than read` };
      }
      if (!sameNode(opened, file)) {
        return {
          ok: false,
          code: "ARTIFACT_SYMLINK_ESCAPE",
          message: `"${file.rel}" was replaced by a link or another file while it was copied, which is refused rather than read through`,
        };
      }
      // Checked on the opened file's own size before a byte is read, and read no further than it.
      const size = Number(opened.size);
      totalBytes += size;
      if (totalBytes > limits.maxBytes) {
        return { ok: false, code: "ARTIFACT_TOO_LARGE", message: `it holds more than ${String(limits.maxBytes)} bytes` };
      }

      // Owner-writable whatever the source said (a read-only attribute on Windows, `0444` elsewhere), with the rest of
      // its mode kept, so an executable stays executable and the node can always remove what it copied.
      const target = dest === undefined ? undefined : join(dest, ...file.rel.split("/"));
      const created =
        target === undefined
          ? undefined
          : await createInCache(`could not write ${target}`, () => open(target, "wx", (file.mode & 0o777) | 0o600));
      if (created !== undefined && !created.created) return nameClash(file.rel);
      const out = created?.created === true ? created.value : undefined;
      try {
        hash.update(file.rel);
        hash.update("\0");
        hash.update(String(size));
        hash.update("\0");
        let read = 0;
        while (read < size) {
          const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - read), read);
          if (bytesRead === 0) break;
          const bytes = chunk.subarray(0, bytesRead);
          hash.update(bytes);
          if (out !== undefined) await inCache(`could not write ${String(target)}`, () => writeAll(out, bytes));
          read += bytesRead;
        }
        const grew = read === size ? (await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead > 0 : false;
        if (read !== size || grew) {
          return { ok: false, code: "LOCAL_SOURCE_CHANGED", message: `"${file.rel}" changed size while it was copied` };
        }
      } finally {
        if (out !== undefined) await inCache(`could not finish ${String(target)}`, () => out.close());
      }
    } finally {
      await handle.close();
    }
  }
  return { ok: true, digest: `sha256:${hash.digest("hex")}` };
}

async function writeAll(out: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await out.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

/** The digest of a snapshot folder already in the cache, or undefined when it cannot be read as one. */
async function digestOfSnapshot(path: string, limits: { maxFiles: number; maxBytes: number }): Promise<string | undefined> {
  try {
    const listed = await listPackageTree(path, limits, new Set([".git"]));
    if (!listed.ok) return undefined;
    const digested = await copyAndDigest(listed.tree, undefined, limits);
    return digested.ok ? digested.digest : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a step that writes the package cache, so its failure is reported as the cache's. */
async function inCache<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (cause) {
    throw cause instanceof PackageCacheFailure ? cause : new PackageCacheFailure(what, cause);
  }
}

/** Runs a create in the cache that refuses an existing name, and answers `created: false` when the name was taken. */
async function createInCache<T>(what: string, create: () => Promise<T>): Promise<{ created: true; value: T } | { created: false }> {
  try {
    return { created: true, value: await create() };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
    throw new PackageCacheFailure(what, cause);
  }
}

/** Two names in the package that this filesystem stores as one (`Theme.json` and `theme.json` on Windows or macOS). */
function nameClash(rel: string): SnapshotRefused {
  return {
    ok: false,
    code: "LOCAL_SOURCE_UNREADABLE",
    message: `"${rel}" has the same name as another entry on this file system, which does not tell letter case apart`,
  };
}

/**
 * Moves a digested staging folder to its content-addressed name.
 *
 * A folder already there under the same digest is reused when it still holds those bytes: the staged copy is the same
 * content, and replacing a folder a running generation may be reading gains nothing. One that no longer does was
 * changed after it was written, so it is set aside and the fresh copy takes its name. A rename that loses a race to an
 * identical copy keeps the winner. Windows can refuse a rename for a moment while another process (an antivirus scan,
 * an indexer) holds a file just written, so those refusals are retried, for up to `WINDOWS_RENAME_BUDGET_MS`, before
 * they count.
 */
async function placeSnapshot(tempDest: string, dest: string, digest: string, limits: { maxFiles: number; maxBytes: number }): Promise<void> {
  if (existsSync(dest)) {
    if ((await digestOfSnapshot(dest, limits)) === digest) return;
    const aside = join(dest, "..", `.stale-${fingerprint(`${dest}#${String(Date.now())}#${String(Math.random())}`)}`);
    await renameInCache(dest, aside);
    await removeQuietly(aside);
  }
  try {
    await renameInCache(tempDest, dest);
  } catch (cause) {
    if (existsSync(dest) && (await digestOfSnapshot(dest, limits)) === digest) return;
    throw cause;
  }
}

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameInCache(from: string, to: string): Promise<void> {
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? "";
      const transient =
        process.platform === "win32" && TRANSIENT_RENAME_CODES.has(code) && !existsSync(to) && Date.now() - started < WINDOWS_RENAME_BUDGET_MS;
      if (!transient) throw new PackageCacheFailure(`could not move ${from} to ${to}`, cause);
      await delay(Math.min(50 * attempt, 250));
    }
  }
}

/**
 * Removes staging (`.tmp-*`) and set-aside (`.stale-*`) folders left in the snapshot cache by a process that stopped
 * mid-copy or a removal Windows refused while a file was still open. Only folders at least `LEFTOVER_MIN_AGE_MS` old,
 * so a copy another install is making right now is never touched. Never throws.
 */
async function sweepLeftovers(snapshotsRoot: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(snapshotsRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - LEFTOVER_MIN_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(".tmp-") && !name.startsWith(".stale-")) continue;
    const path = join(snapshotsRoot, name);
    try {
      if ((await lstat(path)).mtimeMs < cutoff) await removeQuietly(path);
    } catch {
      // Gone already, or not readable: the next sweep tries again.
    }
  }
}

/** Removes a folder the node made, and never throws: a leftover staging folder is garbage, not a failed install. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Left for a later snapshot to sweep (`sweepLeftovers`).
  }
}

/** Schemes a git url is allowed to use. `https` always; `file` only when the caller explicitly opts in
 * (`allowLocalPaths`), which production install traffic never does — only tests, and any future explicit
 * "install from a path on this machine" flow, set it. Every other scheme (`ssh`, `git`, `http`, `ext`, anything a
 * publisher could invent) is refused, because several of them (`ext::`, in particular) can run an arbitrary
 * command by design. */
function classifyGitUrl(url: string, allowLocalPaths: boolean): { ok: true } | { ok: false; message: string } {
  // A value that could be read as a git command-line option rather than a positional argument is refused
  // outright, before anything else — this is the option-injection vector (`--upload-pack=...`) itself, and no
  // scheme classification below matters if the string never reaches `git` as a url at all.
  if (url.startsWith("-")) {
    return { ok: false, message: `git source url "${url}" starts with "-", which git would read as an option` };
  }
  if (/^https:\/\//i.test(url)) return { ok: true };
  const isBareLocalPath = /^(?:\.{0,2}\/|[a-zA-Z]:\\|\\\\)/.test(url) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url);
  const isFileUrl = /^file:\/\//i.test(url);
  if ((isBareLocalPath || isFileUrl) && allowLocalPaths) return { ok: true };
  if (isBareLocalPath || isFileUrl) {
    return { ok: false, message: `git source url "${redactCredentials(url)}" is a local path, which this fetch does not allow` };
  }
  return { ok: false, message: `git source url "${redactCredentials(url)}" does not use an allowed scheme (https)` };
}

/**
 * Kills the whole process group a spawned, `detached: true` child leads (POSIX), not just that one pid (Low).
 *
 * `child.kill()` alone only ever signals the exact pid this node spawned. A `git` that spawns a child of its own —
 * an askpass helper, an ssh subprocess, an smudge filter this module's own hardening did not think to disable — is
 * not reached by that signal at all, and outlives the timeout as an orphan once the direct child exits or is
 * killed. `detached: true` (set by the caller, at spawn time) makes the child the leader of a new process group
 * whose id equals its own pid, so `process.kill(-pid, ...)` reaches everything in that group, group leader and any
 * child it spawned alike — `kill(2)`'s own negative-pid convention for "send to a process group".
 *
 * Exported (and taking a minimal structural type rather than the real `ChildProcess`) so this fallback logic is
 * provable directly, by spying on `process.kill`, rather than only by spawning a real subprocess and reasoning
 * about whether its own child actually died — which is a timing-sensitive, platform-dependent thing to assert
 * about a live process tree, and not what this function's own logic actually needs proving.
 */
export function killProcessGroup(child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean }): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group may already be gone (the child exited between the timer firing and this running), or this
      // process lacks permission to signal it — either way, fall through to the single-pid kill below.
    }
  }
  child.kill("SIGKILL");
}

/** Runs `git` asynchronously with a hard wall-clock timeout, so a stalled network fetch cannot block the process
 * that spawned it (previously `spawnSync`, which blocks the entire event loop — and therefore the whole runtime —
 * for as long as the subprocess runs, with no way to time it out at all). Hardened against everything a hostile
 * remote or a hostile url could otherwise reach:
 *  - `--` always separates git's own flags from the positional url/ref, so a value that slipped past
 *    `classifyGitUrl` still cannot be read as an option;
 *  - `protocol.allow=never` plus an explicit allow for exactly the scheme this call intends disables every other
 *    transport (`ext::`, `fd::`, and any protocol handler this git install has) outright;
 *  - hooks, submodules and LFS smudge filters are disabled, so cloning cannot run a script the remote shipped;
 *  - `GIT_TERMINAL_PROMPT=0` and a batch-mode `GIT_SSH_COMMAND` mean a hung credential prompt cannot substitute for
 *    the timeout not firing. */
function runGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; allowedScheme: "https" | "file" },
): Promise<{ ok: true } | { ok: false; code: "GIT_TIMEOUT" | "GIT_FETCH_FAILED"; message: string }> {
  return new Promise((resolvePromise) => {
    const hardening = [
      "-c",
      "protocol.allow=never",
      "-c",
      `protocol.${options.allowedScheme}.allow=always`,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-c",
      "filter.lfs.smudge=cat",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
    ];
    const fullArgs = [...hardening, ...args];
    /*
     * `detached: true` puts this child in its own process group (POSIX) rather than this node's, so the timeout
     * below can kill the whole group, not just the one pid this node spawned directly (Low). Without it, a `git`
     * that itself spawns a child — an askpass helper, an ssh subprocess, an smudge filter this hardening did not
     * think to disable — outlives the timeout as an orphan: `child.kill()` only ever signalled the immediate pid.
     * `.unref()` keeps this detached child from holding the node process open on its own; the timer and the
     * `close`/`error` listeners below are what actually resolve this promise once the child (or its group) exits.
     */
    const child = spawn("git", fullArgs, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
      },
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    if (process.platform !== "win32") child.unref();

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, options.timeoutMs);

    child.on("error", (cause) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: "GIT_FETCH_FAILED", message: `git ${fullArgs.join(" ")} could not start: ${String(cause)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({ ok: false, code: "GIT_TIMEOUT", message: `git ${args[0] ?? ""} timed out after ${String(options.timeoutMs)}ms` });
        return;
      }
      if (code !== 0) {
        // Low: git's own stderr, not just the urls this node built, can carry `user:pass@host` (a credential
        // helper failure, or git simply echoing the remote it tried) — redacted before it reaches this message,
        // an audit trail, or a refusal a caller might surface verbatim.
        resolvePromise({
          ok: false,
          code: "GIT_FETCH_FAILED",
          message: `git ${args[0] ?? ""} failed: ${redactCredentialsInText(stderr.trim())}`,
        });
        return;
      }
      resolvePromise({ ok: true });
    });
  });
}

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/**
 * Fetch a git source pinned to an exact commit into the node's package cache.
 *
 * A shallow, throwaway clone: `git init` an empty directory, `git fetch --depth 1 -- <url> <ref>`, then check that
 * exact commit out. Nothing here trusts a branch or a tag to still point where it pointed when the directory was
 * published — the ref this function accepts is a full commit id or it is refused before any network call, and
 * nothing here trusts the url either: it must be `https://`, or an explicitly-allowed local path, before a
 * subprocess is ever spawned.
 *
 * The destination is content-addressed by `url`+`ref` (`cachedGitPath`): a cache hit for the exact same source is
 * reused rather than refetched or deleted, so a concurrent or later caller reusing the same url+ref never has a
 * live artifact removed out from under it, and the same path is trivially recomputed by anything that needs to
 * find this artifact again without a separate persisted index.
 */
export async function fetchGitArtifact(input: {
  url: string;
  ref: string;
  cacheRoot: string;
  /** Opt-in for `file://`/bare-path sources. Only tests and an explicit "install from local path" flow set this;
   * production installs sourced from a directory listing never do. */
  allowLocalPaths?: boolean;
  timeoutMs?: number;
  /**
   * The digest the caller's directory entry already published for this artifact (N2). When given, checked
   * *before* anything reaches the content-addressed cache path a later request can find by `resolveLocalSource`
   * alone: a mismatch is refused and the staged bytes are discarded rather than renamed into place, so a
   * digest that never matched what was claimed never becomes servable in the first place. Without this, the
   * mismatch was only ever caught by the caller *after* the rename already happened — leaving exactly the
   * artifact the digest check was supposed to keep unservable sitting at the cache path anyway.
   */
  expectedDigest?: string;
}): Promise<FetchOutcome> {
  if (!FULL_COMMIT.test(input.ref)) {
    return {
      ok: false,
      code: "GIT_REF_NOT_PINNED",
      message: `git ref "${input.ref}" is not a full commit id, so it cannot be fetched to one exact revision`,
    };
  }

  const scheme = classifyGitUrl(input.url, input.allowLocalPaths ?? false);
  if (!scheme.ok) {
    return { ok: false, code: "GIT_SOURCE_NOT_ALLOWED", message: scheme.message };
  }
  const allowedScheme: "https" | "file" = /^https:\/\//i.test(input.url) ? "https" : "file";

  const dest = cachedGitPath(input.cacheRoot, input.url, input.ref);
  const containment = containedOrRefuse(input.cacheRoot, dest);
  if (!containment.ok) return { ok: false, code: "CACHE_ESCAPE", message: containment.message };

  if (existsSync(dest)) {
    // Same url + same pinned commit can only ever mean the same bytes, so this is a pure cache hit: no fetch, and
    // — the M3 requirement — no `rmSync` of a directory a live generation may still be reading.
    const digest = digestOfDirectory(dest, { exclude: [".git"] });
    if (!digest.ok) return { ok: false, code: digest.code, message: digest.message };
    if (input.expectedDigest !== undefined && digest.digest !== input.expectedDigest) {
      // The cached bytes are the real, deterministic result of this exact url+ref — they are not tampered — but
      // they do not match what this caller's directory entry claims, so this caller does not get to treat the
      // cache hit as satisfying its own claim. Left in place rather than deleted: some other caller's entry, with
      // an honest digest, is still entitled to this same url+ref's cache hit.
      return {
        ok: false,
        code: "ARTIFACT_DIGEST_MISMATCH",
        message: `git ${redactCredentials(input.url)}#${input.ref} resolved to ${digest.digest}, not the published ${input.expectedDigest}`,
      };
    }
    return { ok: true, artifact: { path: dest, digest: digest.digest } };
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const tempDest = join(input.cacheRoot, "git", `.tmp-${fingerprint(`${input.url}#${input.ref}#${String(Date.now())}#${String(Math.random())}`)}`);
  mkdirSync(tempDest, { recursive: true });

  try {
    const init = await runGit(["init", "--quiet", tempDest], { timeoutMs, allowedScheme });
    if (!init.ok) return { ok: false, code: init.code, message: init.message };

    const fetch = await runGit(
      ["-C", tempDest, "fetch", "--quiet", "--depth", "1", "--no-recurse-submodules", "--", input.url, input.ref],
      { timeoutMs, allowedScheme },
    );
    if (!fetch.ok) {
      return {
        ok: false,
        code: fetch.code,
        message: `git fetch of ${input.ref} from ${redactCredentials(input.url)} failed: ${fetch.message}`,
      };
    }

    const checkout = await runGit(["-C", tempDest, "checkout", "--quiet", "FETCH_HEAD", "--"], { timeoutMs, allowedScheme });
    if (!checkout.ok) {
      return { ok: false, code: checkout.code, message: `git checkout of ${input.ref} failed: ${checkout.message}` };
    }

    // The digest is over the working tree the caller installs, not over git's own history metadata.
    const digest = digestOfDirectory(tempDest, { exclude: [".git"] });
    if (!digest.ok) return { ok: false, code: digest.code, message: digest.message };

    // Checked here, on the staged temp directory, before it is ever renamed into the cache path a later
    // `resolveLocalSource` call can find by url+ref alone (N2): a mismatch is refused and the `finally` below
    // discards `tempDest`, so bytes that never matched what the directory published never become servable.
    if (input.expectedDigest !== undefined && digest.digest !== input.expectedDigest) {
      return {
        ok: false,
        code: "ARTIFACT_DIGEST_MISMATCH",
        message: `git ${redactCredentials(input.url)}#${input.ref} resolved to ${digest.digest}, not the published ${input.expectedDigest}`,
      };
    }

    mkdirSync(join(input.cacheRoot, "git"), { recursive: true });
    if (existsSync(dest)) {
      // Lost a race with another fetch of the same url+ref: the existing directory is just as valid (same key,
      // same content), so keep it rather than overwrite a possibly-in-use artifact.
      rmSync(tempDest, { recursive: true, force: true });
    } else {
      renameSync(tempDest, dest);
    }
    return { ok: true, artifact: { path: dest, digest: digest.digest } };
  } finally {
    rmSync(tempDest, { recursive: true, force: true });
  }
}

const DEFAULT_NPM_TIMEOUT_MS = 30_000;
/** A tarball larger than this is refused before it is ever fully read into memory or extracted — an upper bound on
 * what a widget package's published artifact is expected to be, generous enough for real packages and small enough
 * that a hostile registry response cannot exhaust memory by lying about its size. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/** Cap on the decompressed size zlib will produce — the gzip-bomb guard. A tarball under `MAX_TARBALL_BYTES`
 * compressed can, in principle, decompress to far more; this bounds the blast radius regardless of what the
 * compressed size claimed. */
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
/** Cap on how many entries one tarball may contain, independent of size — a bound against a tarball built from
 * many tiny entries, which a pure byte-size cap would not catch. */
const MAX_TAR_ENTRIES = 20_000;

/**
 * Fetch an npm source at an exact version into the node's package cache.
 *
 * Reads the packument for the published `dist.integrity` (or, failing that, `dist.shasum`) and refuses the
 * tarball if the bytes fetched do not match it — this is the "verify integrity" step, done against what the
 * registry itself published rather than against the directory listing, which may be a different party.
 *
 * Extraction does not shell out to a `tar` binary: it reads the (gzip + ustar) archive itself, so every entry's
 * type is checked against the authoritative typeflag byte in its own header before any byte of it is written to
 * disk. A symlink, hard link, device, fifo, or path-traversal/absolute entry name is refused by name; the
 * extraction never proceeds partway and leaves whatever it already wrote.
 */
export async function fetchNpmArtifact(input: {
  name: string;
  version: string;
  cacheRoot: string;
  registryUrl?: string;
  timeoutMs?: number;
  /** The digest the caller's directory entry already published for this artifact (N2). Same contract as
   * `fetchGitArtifact`'s own `expectedDigest`: checked before the staged bytes are ever renamed into the
   * content-addressed cache path, so a mismatch never becomes servable. */
  expectedDigest?: string;
}): Promise<FetchOutcome> {
  const registry = (input.registryUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_NPM_TIMEOUT_MS;

  const dest = cachedNpmPath(input.cacheRoot, input.name, input.version);
  const containment = containedOrRefuse(input.cacheRoot, dest);
  if (!containment.ok) return { ok: false, code: "CACHE_ESCAPE", message: containment.message };

  if (existsSync(dest)) {
    // Same registry package name + exact version can only ever mean the same published bytes: reuse rather than
    // refetch or remove a possibly-live artifact (M3).
    const digest = digestOfDirectory(dest);
    if (!digest.ok) return { ok: false, code: digest.code, message: digest.message };
    if (input.expectedDigest !== undefined && digest.digest !== input.expectedDigest) {
      return {
        ok: false,
        code: "ARTIFACT_DIGEST_MISMATCH",
        message: `npm ${input.name}@${input.version} resolved to ${digest.digest}, not the published ${input.expectedDigest}`,
      };
    }
    return { ok: true, artifact: { path: dest, digest: digest.digest } };
  }

  let packumentRes: Response;
  try {
    packumentRes = await fetch(`${registry}/${encodeURIComponent(input.name)}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `could not reach ${redactCredentials(registry)}: ${String(cause)}` };
  }
  if (!packumentRes.ok) {
    return {
      ok: false,
      code: "NPM_FETCH_FAILED",
      message: `${redactCredentials(registry)} returned ${String(packumentRes.status)} for ${input.name}`,
    };
  }
  const packument = (await packumentRes.json()) as {
    versions?: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>;
  };
  const versionMeta = packument.versions?.[input.version];
  if (versionMeta?.dist?.tarball === undefined) {
    return {
      ok: false,
      code: "NPM_VERSION_NOT_PUBLISHED",
      message: `${input.name}@${input.version} is not published on ${redactCredentials(registry)}`,
    };
  }

  let tarRes: Response;
  try {
    tarRes = await fetch(versionMeta.dist.tarball, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `could not fetch tarball: ${String(cause)}` };
  }
  if (!tarRes.ok) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `tarball fetch returned ${String(tarRes.status)}` };
  }
  const contentLength = tarRes.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_TARBALL_BYTES) {
    return {
      ok: false,
      code: "NPM_TARBALL_TOO_LARGE",
      message: `tarball for ${input.name}@${input.version} is ${contentLength} bytes, over the ${String(MAX_TARBALL_BYTES)} byte cap`,
    };
  }
  /*
   * N3: a hostile or misconfigured registry can simply omit Content-Length — the check above is a fast, cheap
   * refusal when the header is honest, not the actual guard. The real guard has to run against bytes as they
   * arrive: `tarRes.arrayBuffer()` used to buffer the entire response before any size was checked at all, which
   * means the cap only ever applied after the memory it exists to bound was already spent. Streaming the body and
   * counting as each chunk arrives aborts the download itself once the cap is crossed, regardless of what (or
   * whether) the server declared up front.
   */
  if (tarRes.body === null) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `tarball response for ${input.name}@${input.version} has no body` };
  }
  const reader = tarRes.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_TARBALL_BYTES) {
      await reader.cancel(`tarball exceeded the ${String(MAX_TARBALL_BYTES)} byte cap while streaming`).catch(() => undefined);
      return {
        ok: false,
        code: "NPM_TARBALL_TOO_LARGE",
        message: `tarball for ${input.name}@${input.version} exceeded the ${String(MAX_TARBALL_BYTES)} byte cap while streaming, with no (or an understated) content-length header`,
      };
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

  const integrityCheck = verifyNpmIntegrity(bytes, versionMeta.dist);
  if (!integrityCheck.ok) {
    return { ok: false, code: "NPM_INTEGRITY_MISMATCH", message: integrityCheck.message };
  }

  const tempDest = join(input.cacheRoot, "npm", `.tmp-${fingerprint(`${input.name}@${input.version}#${String(Date.now())}#${String(Math.random())}`)}`);
  mkdirSync(tempDest, { recursive: true });
  try {
    const unpacked = unpackNpmTarball(bytes, tempDest, `${input.name}@${input.version}`);
    if (!unpacked.ok) return unpacked;

    // Digested and checked on `tempDest`, before the rename below — the same N2 ordering `fetchGitArtifact`
    // uses, and for the same reason: renaming first and checking after (the previous order here) left an artifact
    // that failed the caller's own digest check sitting at the cache path anyway, servable to anything that
    // resolves the same name+version afterward.
    const digest = digestOfDirectory(tempDest);
    if (!digest.ok) return { ok: false, code: digest.code, message: digest.message };
    if (input.expectedDigest !== undefined && digest.digest !== input.expectedDigest) {
      return {
        ok: false,
        code: "ARTIFACT_DIGEST_MISMATCH",
        message: `npm ${input.name}@${input.version} resolved to ${digest.digest}, not the published ${input.expectedDigest}`,
      };
    }

    mkdirSync(join(input.cacheRoot, "npm"), { recursive: true });
    if (existsSync(dest)) {
      rmSync(tempDest, { recursive: true, force: true });
    } else {
      renameSync(tempDest, dest);
    }
    return { ok: true, artifact: { path: dest, digest: digest.digest } };
  } finally {
    rmSync(tempDest, { recursive: true, force: true });
  }
}

/**
 * Gunzip, read and write one npm tarball into `dest`, with the leading `package/` component stripped.
 *
 * The one extraction both `fetchNpmArtifact` and `inspectNpmTarball` run, so the content digest an author computes
 * before publishing is, by construction, the digest a node computes after fetching the same bytes.
 */
function unpackNpmTarball(
  bytes: Buffer,
  dest: string,
  label: string,
): { ok: true } | { ok: false; code: "NPM_TARBALL_TOO_LARGE" | "NPM_TARBALL_UNSAFE_ENTRY"; message: string } {
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (cause) {
    return {
      ok: false,
      code: "NPM_TARBALL_TOO_LARGE",
      message: `tarball for ${label} did not decompress within the ${String(MAX_DECOMPRESSED_BYTES)} byte cap: ${String(cause)}`,
    };
  }

  const extraction = extractUstarTarball(decompressed, { maxEntries: MAX_TAR_ENTRIES, stripComponents: 1 });
  if (!extraction.ok) {
    return { ok: false, code: "NPM_TARBALL_UNSAFE_ENTRY", message: extraction.message };
  }

  for (const entry of extraction.entries) {
    const target = resolve(dest, entry.name);
    // Defense in depth on top of `extractUstarTarball`'s own traversal check: the resolved path must still land
    // inside `dest`.
    if (target !== resolve(dest) && !target.startsWith(resolve(dest) + sep)) {
      return { ok: false, code: "NPM_TARBALL_UNSAFE_ENTRY", message: `tar entry "${entry.name}" resolves outside the extraction root` };
    }
    // R4: `extractUstarTarball`'s own `seenNames` check only catches an *exact* name collision (two entries
    // both named "a"). It does not catch a file entry "a" followed by a file entry "a/b": those are two
    // different names in that set, but writing "a/b" requires `mkdirSync(dirname("a/b"), ...)` to create "a" as
    // a directory when "a" already exists on disk as a *file* — which throws ENOTDIR, uncaught, out of this
    // loop. Any filesystem error while writing an entry (ENOTDIR, EISDIR, or anything else a hostile or merely
    // malformed tarball can provoke) is caught here and turned into the same named refusal every other unsafe
    // entry in this reader produces, rather than propagating as an unhandled exception/500.
    try {
      if (entry.type === "directory") {
        mkdirSync(target, { recursive: true });
      } else {
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, entry.content);
      }
    } catch (cause) {
      return {
        ok: false,
        code: "NPM_TARBALL_UNSAFE_ENTRY",
        message: `tar entry "${entry.name}" could not be extracted (${String(cause)}), which usually means it conflicts with another entry's path (e.g. a file and a directory sharing a name)`,
      };
    }
  }
  return { ok: true };
}

/** What an npm tarball holds, measured the way a node measures it after fetching. */
export interface NpmTarballFacts {
  /** The SRI value npm records as `dist.integrity` for exactly these bytes. */
  integrity: string;
  /** `digestOfDirectory` over the extracted contents: what a directory entry for this npm version publishes. */
  contentDigest: string;
  /** Every regular file in the archive, `/`-separated and sorted, relative to the stripped `package/` root. */
  files: { path: string; bytes: number }[];
}

/**
 * Measure an npm tarball before it is published: its integrity, its runtime content digest and its file list.
 *
 * Extracts into a fresh directory under `scratchRoot` with the same reader, caps and refusals a fetch uses, and
 * removes it before returning. `inspect`, when given, reads the extracted tree first (a caller that wants to run
 * its own checks on the archived contents rather than on the source directory).
 */
export function inspectNpmTarball(
  bytes: Buffer,
  scratchRoot: string,
  inspect?: (extractedRoot: string) => void,
): { ok: true; facts: NpmTarballFacts } | { ok: false; code: FetchRefusal; message: string } {
  if (bytes.byteLength > MAX_TARBALL_BYTES) {
    return { ok: false, code: "NPM_TARBALL_TOO_LARGE", message: `the tarball is ${String(bytes.byteLength)} bytes, over the ${String(MAX_TARBALL_BYTES)} byte cap` };
  }
  mkdirSync(scratchRoot, { recursive: true });
  const dest = join(scratchRoot, `.inspect-${fingerprint(`${String(Date.now())}#${String(Math.random())}`)}`);
  mkdirSync(dest, { recursive: true });
  try {
    const unpacked = unpackNpmTarball(bytes, dest, "the archive");
    if (!unpacked.ok) return unpacked;
    const digest = digestOfDirectory(dest);
    if (!digest.ok) return { ok: false, code: digest.code, message: digest.message };
    const files: { path: string; bytes: number }[] = [];
    const walk = (current: string): void => {
      for (const name of readdirSync(current)) {
        const full = join(current, name);
        const stat = lstatSync(full);
        if (stat.isDirectory()) walk(full);
        else files.push({ path: relative(dest, full).split(sep).join("/"), bytes: stat.size });
      }
    };
    walk(dest);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    inspect?.(dest);
    return {
      ok: true,
      facts: { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, contentDigest: digest.digest, files },
    };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

interface TarEntry {
  name: string;
  type: "file" | "directory";
  content: Buffer;
}

/** Parses a pax extended-header body (`"<record-length> <key>=<value>\n"`, repeated) into the subset of keys this
 * reader honours. Everything else in the record set is real pax vocabulary this node has no use for (uid, gid,
 * mtime, uname...) and is silently ignored, the same way an unrecognised header field always has been here. */
function parsePaxRecords(body: Buffer): { path?: string; linkpath?: string; size?: number } {
  const overrides: { path?: string; linkpath?: string; size?: number } = {};
  const text = body.toString("utf8");
  let cursor = 0;
  while (cursor < text.length) {
    const spaceIndex = text.indexOf(" ", cursor);
    if (spaceIndex === -1) break;
    const recordLength = Number.parseInt(text.slice(cursor, spaceIndex), 10);
    if (Number.isNaN(recordLength) || recordLength <= 0) break;
    const record = text.slice(cursor, cursor + recordLength);
    const equalsIndex = record.indexOf("=");
    if (equalsIndex !== -1) {
      const key = record.slice(spaceIndex - cursor + 1, equalsIndex);
      // Trailing "\n" is part of the record length and must be stripped from the value.
      const value = record.slice(equalsIndex + 1).replace(/\n$/, "");
      if (key === "path") overrides.path = value;
      else if (key === "linkpath") overrides.linkpath = value;
      else if (key === "size") {
        const parsedSize = Number.parseInt(value, 10);
        if (!Number.isNaN(parsedSize) && parsedSize >= 0) overrides.size = parsedSize;
      }
    }
    cursor += recordLength;
  }
  return overrides;
}

/**
 * A minimal, safety-first reader for the ustar tar format npm publishes tarballs in.
 *
 * Deliberately does not shell out to a `tar` binary: this node then depends on whatever tar implementation happens
 * to be installed (GNU tar's and bsdtar's `-tv` listings are not even the same text format to parse), and text-
 * parsing a listing is not a reliable way to learn an entry's true type. Reading the header's typeflag byte
 * directly is authoritative and portable.
 *
 * Every header this reader trusts carries the ustar magic (`"ustar"` at offset 257, both the POSIX `"ustar\0"` and
 * the GNU `"ustar "` variants share the same first five bytes) — a block that lacks it is not a tar header this
 * reader understands, and is refused by name rather than parsed on faith (N3).
 *
 * Two metadata header types are honoured before the entry they describe: a pax extended header (`'x'`) whose body
 * is `key=value` records, and a GNU long-name header (`'L'`) whose body is a NUL-terminated long path. Both exist
 * because a ustar header's own 100-byte name field cannot hold every real npm package path; skipping them (as this
 * reader used to) meant a long or pax-carried name silently fell back to the truncated 100-byte field instead,
 * which is a correctness bug wearing a security bug's shape — the file that got written was not the file the
 * archive named. Only `path`, `linkpath` and `size` are read out of a pax record; the rest of the pax vocabulary
 * (uid, gid, mtime, uname...) has no bearing on what gets written to disk and is ignored, same as any other
 * unrecognised header field always was here. The type the *real* entry declares afterwards is still what decides
 * whether it is refused — a pax or GNU-longname header carries metadata only, never a type of its own, so a
 * symlink or hard link named this way is refused exactly as it always was.
 *
 * Only regular files (`'0'`/NUL) and directories (`'5'`) are accepted; a symlink (`'2'`), hard link (`'1'`), or any
 * device/fifo type is refused by name rather than silently skipped, per the same "never silently drop a hostile
 * entry" rule `digestOfDirectory` follows for symlinks. An entry name containing a `..` path segment, or an
 * absolute path, is refused as path traversal regardless of typeflag. Two entries that resolve to the same final
 * name (after `stripComponents`) are refused by name too (N3): writing the second would either silently overwrite
 * the first's bytes or throw an unhandled `EISDIR`/`ENOTDIR` out of the extraction loop — neither of which is the
 * named, caught refusal every other unsafe entry in this reader gets. npm tarballs wrap their contents in one
 * top-level `package/` directory; `stripComponents` unwraps it the same way `tar --strip-components=1` did.
 */
function extractUstarTarball(
  buffer: Buffer,
  options: { maxEntries: number; stripComponents: number },
): { ok: true; entries: TarEntry[] } | { ok: false; message: string } {
  const entries: TarEntry[] = [];
  const seenNames = new Set<string>();
  let offset = 0;
  let entryCount = 0;
  // Carried from a pax (`'x'`) or GNU long-name (`'L'`) header into the very next header, then cleared. Tar only
  // ever defines these as applying to the single entry that immediately follows.
  let pendingOverrides: { path?: string; linkpath?: string; size?: number } = {};

  while (offset + 512 <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive all-zero blocks mark end-of-archive.
    if (header.every((byte) => byte === 0)) break;

    entryCount += 1;
    if (entryCount > options.maxEntries) {
      return { ok: false, message: `tarball has more than ${String(options.maxEntries)} entries` };
    }

    const magic = header.subarray(257, 262).toString("utf8");
    if (magic !== "ustar") {
      return { ok: false, message: `tar header at byte offset ${String(offset)} is missing the ustar magic, so its fields cannot be trusted` };
    }

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const headerName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim();
    const headerSize = sizeField.length === 0 ? 0 : Number.parseInt(sizeField, 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);

    if (Number.isNaN(headerSize) || headerSize < 0) {
      return { ok: false, message: `tar entry "${headerName}" has an unreadable size field` };
    }

    const contentStart = offset + 512;
    const contentEnd = contentStart + headerSize;
    if (contentEnd > buffer.byteLength) {
      return { ok: false, message: `tar entry "${headerName}" claims a size larger than the archive` };
    }
    const content = buffer.subarray(contentStart, contentEnd);
    const paddedSize = Math.ceil(headerSize / 512) * 512;

    // A pax extended header describes the *next* entry only, not itself; its own name/size are this header's own
    // bookkeeping and are never written to disk.
    if (typeflag === "x") {
      const records = parsePaxRecords(Buffer.from(content));
      pendingOverrides = { ...pendingOverrides, ...records };
      offset = contentStart + paddedSize;
      continue;
    }
    // R3: a pax global extended header ('g') is, per POSIX, meant to apply to every entry from here to the end of
    // the archive, not just the next one — a fundamentally different scope than 'x'. Silently folding it into
    // `pendingOverrides` (the previous code here) applied it only to the immediate next entry, which is not what
    // the standard says and not what a `g`-emitting archiver's own reader would do, so a `path`/`size` carried by
    // a global header is refused by name rather than misapplied to the wrong scope. npm's own publish tooling
    // never emits a `g` header carrying `path` or `size` (only `x` per-entry headers), so this refusal costs
    // nothing against any tarball this node needs to install.
    if (typeflag === "g") {
      const records = parsePaxRecords(Buffer.from(content));
      if (records.path !== undefined || records.size !== undefined) {
        return {
          ok: false,
          message: `tar header at byte offset ${String(offset)} is a pax global extended header ("g") carrying a path or size override, which this reader refuses rather than misapply`,
        };
      }
      offset = contentStart + paddedSize;
      continue;
    }
    if (typeflag === "L") {
      pendingOverrides = { ...pendingOverrides, path: Buffer.from(content).toString("utf8").replace(/\0.*$/s, "") };
      offset = contentStart + paddedSize;
      continue;
    }
    if (typeflag === "K") {
      pendingOverrides = { ...pendingOverrides, linkpath: Buffer.from(content).toString("utf8").replace(/\0.*$/s, "") };
      offset = contentStart + paddedSize;
      continue;
    }

    // R3: a pax `size` override, per POSIX/GNU tar, is authoritative over the ustar header's own size field for
    // where the *next* header starts — a reader that ignores it (the previous code here) parses the archive
    // physically differently from any standard tar reader. A pax `size` smaller than the header's own size makes
    // bytes that a standard reader treats as trailing content of *this* entry parse, here, as a wholly separate
    // "next" entry instead — one a standard tool building or scanning this tarball never saw. The reverse (pax
    // `size` larger) can hide a real entry a standard tool would see from this reader instead. Either direction
    // is a genuine divergence between what a publisher's tooling computed a digest against and what this node
    // would install, so it is refused by name rather than silently accepted: npm's own tarballs (built by
    // node-tar) never need this to differ from the header's own size.
    if (pendingOverrides.size !== undefined && pendingOverrides.size !== headerSize) {
      return {
        ok: false,
        message: `tar entry "${headerName}" has a pax size override (${String(pendingOverrides.size)}) that differs from its ustar header size (${String(headerSize)}), which this reader refuses rather than let the two readings diverge`,
      };
    }

    const fullName = pendingOverrides.path ?? headerName;
    pendingOverrides = {};

    const segments = fullName.split("/").filter((segment) => segment.length > 0);
    if (fullName.startsWith("/") || segments.includes("..")) {
      return { ok: false, message: `tar entry "${fullName}" is a path-traversal or absolute entry name` };
    }

    if (typeflag === "2") return { ok: false, message: `tar entry "${fullName}" is a symlink, which is refused` };
    if (typeflag === "1") return { ok: false, message: `tar entry "${fullName}" is a hard link, which is refused` };
    if (typeflag === "3" || typeflag === "4") {
      return { ok: false, message: `tar entry "${fullName}" is a device file, which is refused` };
    }
    if (typeflag === "6") return { ok: false, message: `tar entry "${fullName}" is a fifo, which is refused` };
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      return { ok: false, message: `tar entry "${fullName}" has an unsupported type "${typeflag}"` };
    }

    const strippedSegments = segments.slice(options.stripComponents);
    // An entry that strips down to nothing (the top-level `package/` directory entry itself) is skipped, not an
    // error: it carries no content of its own.
    if (strippedSegments.length > 0) {
      const name = strippedSegments.join("/");
      if (seenNames.has(name)) {
        return { ok: false, message: `tar entry "${name}" conflicts with a previously extracted entry of the same name` };
      }
      seenNames.add(name);
      entries.push({
        name,
        type: typeflag === "5" ? "directory" : "file",
        content: Buffer.from(content),
      });
    }

    // Advance past this entry's content, padded up to the next 512-byte boundary. `headerSize` (what `paddedSize`
    // is derived from) and any pax `size` override are guaranteed equal by the refusal above, so there is no
    // remaining divergence between "where this reader thinks the entry ends" and "where a standard reader would".
    offset = contentStart + paddedSize;
  }

  return { ok: true, entries };
}

function verifyNpmIntegrity(
  bytes: Buffer,
  dist: { integrity?: string; shasum?: string },
): { ok: true } | { ok: false; message: string } {
  if (dist.integrity !== undefined) {
    const dash = dist.integrity.indexOf("-");
    const algo = dash === -1 ? "" : dist.integrity.slice(0, dash);
    const expected = dash === -1 ? "" : dist.integrity.slice(dash + 1);
    const nodeAlgo = algo === "sha512" ? "sha512" : algo === "sha384" ? "sha384" : algo === "sha256" ? "sha256" : undefined;
    if (nodeAlgo !== undefined) {
      const computed = createHash(nodeAlgo).update(bytes).digest("base64");
      if (computed !== expected) {
        return { ok: false, message: `tarball integrity did not match the published ${algo} value` };
      }
      return { ok: true };
    }
  }
  if (dist.shasum !== undefined) {
    const computed = createHash("sha1").update(bytes).digest("hex");
    if (computed !== dist.shasum) {
      return { ok: false, message: "tarball shasum did not match the published value" };
    }
    return { ok: true };
  }
  return { ok: false, message: "the registry published no integrity or shasum to verify the tarball against" };
}
