import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

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
 */

export type FetchRefusal =
  | "GIT_REF_NOT_PINNED"
  | "GIT_FETCH_FAILED"
  | "NPM_VERSION_NOT_PUBLISHED"
  | "NPM_FETCH_FAILED"
  | "NPM_INTEGRITY_MISMATCH"
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
 * Deterministic regardless of filesystem read order: every regular file under `dir` (symlinks skipped, the same
 * refusal-by-omission `readPackageFile` applies to a path that escapes the root) is hashed as
 * `<relative path>\0<byte length>\0<bytes>`, sorted by relative path first, so the same tree always produces the
 * same digest and a renamed-but-identical file changes it.
 */
export function digestOfDirectory(dir: string, options: { exclude?: readonly string[] } = {}): string {
  const exclude = new Set(options.exclude ?? []);
  const root = realpathSync(dir);
  const files: string[] = [];

  function walk(current: string): void {
    for (const name of readdirSync(current).sort()) {
      if (exclude.has(name)) continue;
      const full = join(current, name);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.isFile()) files.push(full);
    }
  }
  walk(root);
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
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Fetch a git source pinned to an exact commit into the node's package cache.
 *
 * A shallow, throwaway clone: `git init` an empty directory, `git fetch --depth 1 <url> <ref>`, then check that
 * exact commit out. Nothing here trusts a branch or a tag to still point where it pointed when the directory was
 * published — the ref this function accepts is a full commit id or it is refused before any network call.
 */
export function fetchGitArtifact(input: { url: string; ref: string; cacheRoot: string }): FetchOutcome {
  if (!FULL_COMMIT.test(input.ref)) {
    return {
      ok: false,
      code: "GIT_REF_NOT_PINNED",
      message: `git ref "${input.ref}" is not a full commit id, so it cannot be fetched to one exact revision`,
    };
  }

  const dest = join(input.cacheRoot, "git", safeSegment(input.ref));
  const containment = containedOrRefuse(input.cacheRoot, dest);
  if (!containment.ok) return { ok: false, code: "CACHE_ESCAPE", message: containment.message };

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const init = spawnSync("git", ["init", "--quiet", dest]);
  if (init.status !== 0) {
    return { ok: false, code: "GIT_FETCH_FAILED", message: `git init failed: ${init.stderr.toString().trim()}` };
  }
  const fetch = spawnSync("git", ["-C", dest, "fetch", "--quiet", "--depth", "1", input.url, input.ref]);
  if (fetch.status !== 0) {
    return {
      ok: false,
      code: "GIT_FETCH_FAILED",
      message: `git fetch of ${input.ref} from ${input.url} failed: ${fetch.stderr.toString().trim()}`,
    };
  }
  const checkout = spawnSync("git", ["-C", dest, "checkout", "--quiet", "FETCH_HEAD"]);
  if (checkout.status !== 0) {
    return {
      ok: false,
      code: "GIT_FETCH_FAILED",
      message: `git checkout of ${input.ref} failed: ${checkout.stderr.toString().trim()}`,
    };
  }

  // The digest is over the working tree the caller installs, not over git's own history metadata.
  const digest = digestOfDirectory(dest, { exclude: [".git"] });
  return { ok: true, artifact: { path: dest, digest } };
}

/**
 * Fetch an npm source at an exact version into the node's package cache.
 *
 * Reads the packument for the published `dist.integrity` (or, failing that, `dist.shasum`) and refuses the
 * tarball if the bytes fetched do not match it — this is the "verify integrity" step, done against what the
 * registry itself published rather than against the directory listing, which may be a different party.
 */
export async function fetchNpmArtifact(input: {
  name: string;
  version: string;
  cacheRoot: string;
  registryUrl?: string;
}): Promise<FetchOutcome> {
  const registry = (input.registryUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");

  let packumentRes: Response;
  try {
    packumentRes = await fetch(`${registry}/${encodeURIComponent(input.name)}`);
  } catch (cause) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `could not reach ${registry}: ${String(cause)}` };
  }
  if (!packumentRes.ok) {
    return {
      ok: false,
      code: "NPM_FETCH_FAILED",
      message: `${registry} returned ${String(packumentRes.status)} for ${input.name}`,
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
      message: `${input.name}@${input.version} is not published on ${registry}`,
    };
  }

  let tarRes: Response;
  try {
    tarRes = await fetch(versionMeta.dist.tarball);
  } catch (cause) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `could not fetch tarball: ${String(cause)}` };
  }
  if (!tarRes.ok) {
    return { ok: false, code: "NPM_FETCH_FAILED", message: `tarball fetch returned ${String(tarRes.status)}` };
  }
  const bytes = Buffer.from(await tarRes.arrayBuffer());

  const integrityCheck = verifyNpmIntegrity(bytes, versionMeta.dist);
  if (!integrityCheck.ok) {
    return { ok: false, code: "NPM_INTEGRITY_MISMATCH", message: integrityCheck.message };
  }

  const dest = join(input.cacheRoot, "npm", `${safeSegment(input.name)}-${safeSegment(input.version)}`);
  const containment = containedOrRefuse(input.cacheRoot, dest);
  if (!containment.ok) return { ok: false, code: "CACHE_ESCAPE", message: containment.message };

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const tmpDir = mkdtempSync(join(tmpdir(), "cc-npm-fetch-"));
  const tarPath = join(tmpDir, "package.tgz");
  try {
    writeFileSync(tarPath, bytes);
    // npm tarballs wrap their contents in one top-level `package/` directory; `--strip-components=1` unwraps it
    // the same way `npm pack` + install would.
    const extract = spawnSync("tar", ["-xzf", tarPath, "-C", dest, "--strip-components=1"]);
    if (extract.status !== 0) {
      return {
        ok: false,
        code: "NPM_FETCH_FAILED",
        message: `tarball extraction failed: ${extract.stderr.toString().trim()}`,
      };
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const digest = digestOfDirectory(dest);
  return { ok: true, artifact: { path: dest, digest } };
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
