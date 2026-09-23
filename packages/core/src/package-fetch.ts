import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import type { PackageSource } from "@clarkcant/contracts";

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
  | "CACHE_ESCAPE";

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
 */
export function digestOfDirectory(
  dir: string,
  options: { exclude?: readonly string[] } = {},
): { ok: true; digest: string } | { ok: false; code: "ARTIFACT_SYMLINK_ESCAPE"; message: string } {
  // `.git` (and any other caller-supplied exclusion) is only ever meaningful at the artifact root — a package that
  // legitimately ships a directory named `.git` deeper in its tree (a vendored git checkout, say) must not have it
  // silently dropped from the digest.
  const exclude = new Set(options.exclude ?? []);
  const root = resolve(dir);
  const files: string[] = [];

  function walk(current: string, isRoot: boolean): { ok: true } | { ok: false; message: string } {
    for (const name of readdirSync(current).sort()) {
      if (isRoot && exclude.has(name)) continue;
      const full = join(current, name);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat === undefined) continue;

      if (stat.isSymbolicLink()) {
        return { ok: false, message: `"${relative(root, full)}" is a symlink, which is refused rather than followed` };
      }
      // A hard link (nlink > 1 on a regular file) shares inode/bytes with a path outside the artifact that this
      // function never walked, so a digest over "the file at this path" would not describe bytes unique to this
      // artifact. Directories cannot be hard-linked on the filesystems this runs on, so the check is scoped to
      // regular files.
      if (stat.isFile() && stat.nlink > 1) {
        return { ok: false, message: `"${relative(root, full)}" is a hard link, which is refused rather than read` };
      }
      if (stat.isDirectory()) {
        const sub = walk(full, false);
        if (!sub.ok) return sub;
        continue;
      }
      if (stat.isFile()) files.push(full);
    }
    return { ok: true };
  }

  const walked = walk(root, true);
  if (!walked.ok) return { ok: false, code: "ARTIFACT_SYMLINK_ESCAPE", message: walked.message };
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(root, file);
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
export function resolveLocalSource(entry: { source: PackageSource }, cacheRoot: string): PackageSource {
  if (entry.source.kind === "git") {
    const path = cachedGitPath(cacheRoot, entry.source.url, entry.source.ref);
    if (existsSync(path)) return { kind: "local", path };
    return entry.source;
  }
  if (entry.source.kind === "npm") {
    const path = cachedNpmPath(cacheRoot, entry.source.name, entry.source.version);
    if (existsSync(path)) return { kind: "local", path };
    return entry.source;
  }
  return entry.source;
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
    const child = spawn("git", fullArgs, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
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
        resolvePromise({ ok: false, code: "GIT_FETCH_FAILED", message: `git ${args[0] ?? ""} failed: ${stderr.trim()}` });
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
  const bytes = Buffer.from(await tarRes.arrayBuffer());
  if (bytes.byteLength > MAX_TARBALL_BYTES) {
    return {
      ok: false,
      code: "NPM_TARBALL_TOO_LARGE",
      message: `tarball for ${input.name}@${input.version} is ${String(bytes.byteLength)} bytes, over the ${String(MAX_TARBALL_BYTES)} byte cap`,
    };
  }

  const integrityCheck = verifyNpmIntegrity(bytes, versionMeta.dist);
  if (!integrityCheck.ok) {
    return { ok: false, code: "NPM_INTEGRITY_MISMATCH", message: integrityCheck.message };
  }

  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (cause) {
    return {
      ok: false,
      code: "NPM_TARBALL_TOO_LARGE",
      message: `tarball for ${input.name}@${input.version} did not decompress within the ${String(MAX_DECOMPRESSED_BYTES)} byte cap: ${String(cause)}`,
    };
  }

  const extraction = extractUstarTarball(decompressed, { maxEntries: MAX_TAR_ENTRIES, stripComponents: 1 });
  if (!extraction.ok) {
    return { ok: false, code: "NPM_TARBALL_UNSAFE_ENTRY", message: extraction.message };
  }

  const tempDest = join(input.cacheRoot, "npm", `.tmp-${fingerprint(`${input.name}@${input.version}#${String(Date.now())}#${String(Math.random())}`)}`);
  mkdirSync(tempDest, { recursive: true });
  try {
    for (const entry of extraction.entries) {
      const target = resolve(tempDest, entry.name);
      // Defense in depth on top of `extractUstarTarball`'s own traversal check: the resolved path must still land
      // inside `tempDest`.
      if (target !== resolve(tempDest) && !target.startsWith(resolve(tempDest) + sep)) {
        return { ok: false, code: "NPM_TARBALL_UNSAFE_ENTRY", message: `tar entry "${entry.name}" resolves outside the extraction root` };
      }
      if (entry.type === "directory") {
        mkdirSync(target, { recursive: true });
      } else {
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, entry.content);
      }
    }

    mkdirSync(join(input.cacheRoot, "npm"), { recursive: true });
    if (existsSync(dest)) {
      rmSync(tempDest, { recursive: true, force: true });
    } else {
      renameSync(tempDest, dest);
    }
  } finally {
    rmSync(tempDest, { recursive: true, force: true });
  }

  const digest = digestOfDirectory(dest);
  if (!digest.ok) return { ok: false, code: digest.code, message: digest.message };
  return { ok: true, artifact: { path: dest, digest: digest.digest } };
}

interface TarEntry {
  name: string;
  type: "file" | "directory";
  content: Buffer;
}

/**
 * A minimal, safety-first reader for the ustar tar format npm publishes tarballs in.
 *
 * Deliberately does not shell out to a `tar` binary: this node then depends on whatever tar implementation happens
 * to be installed (GNU tar's and bsdtar's `-tv` listings are not even the same text format to parse), and text-
 * parsing a listing is not a reliable way to learn an entry's true type. Reading the header's typeflag byte
 * directly is authoritative and portable.
 *
 * Only regular files (`'0'`/NUL) and directories (`'5'`) are accepted; a symlink (`'2'`), hard link (`'1'`), or any
 * device/fifo type is refused by name rather than silently skipped, per the same "never silently drop a hostile
 * entry" rule `digestOfDirectory` follows for symlinks. An entry name containing a `..` path segment, or an
 * absolute path, is refused as path traversal regardless of typeflag. npm tarballs wrap their contents in one
 * top-level `package/` directory; `stripComponents` unwraps it the same way `tar --strip-components=1` did.
 */
function extractUstarTarball(
  buffer: Buffer,
  options: { maxEntries: number; stripComponents: number },
): { ok: true; entries: TarEntry[] } | { ok: false; message: string } {
  const entries: TarEntry[] = [];
  let offset = 0;
  let entryCount = 0;

  while (offset + 512 <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive all-zero blocks mark end-of-archive.
    if (header.every((byte) => byte === 0)) break;

    entryCount += 1;
    if (entryCount > options.maxEntries) {
      return { ok: false, message: `tarball has more than ${String(options.maxEntries)} entries` };
    }

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const fullName = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim();
    const size = sizeField.length === 0 ? 0 : Number.parseInt(sizeField, 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);

    if (Number.isNaN(size) || size < 0) {
      return { ok: false, message: `tar entry "${fullName}" has an unreadable size field` };
    }

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

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.byteLength) {
      return { ok: false, message: `tar entry "${fullName}" claims a size larger than the archive` };
    }
    const content = buffer.subarray(contentStart, contentEnd);

    const strippedSegments = segments.slice(options.stripComponents);
    // An entry that strips down to nothing (the top-level `package/` directory entry itself) is skipped, not an
    // error: it carries no content of its own.
    if (strippedSegments.length > 0) {
      entries.push({
        name: strippedSegments.join("/"),
        type: typeflag === "5" ? "directory" : "file",
        content: Buffer.from(content),
      });
    }

    // Advance past this entry's content, padded up to the next 512-byte boundary.
    const paddedSize = Math.ceil(size / 512) * 512;
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
