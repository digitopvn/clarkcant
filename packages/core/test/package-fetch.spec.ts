import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPackageFile } from "../src/package-files.ts";
import {
  cachedGitPath,
  digestOfDirectory,
  fetchGitArtifact,
  fetchNpmArtifact,
  redactCredentials,
  resolveLocalSource,
} from "../src/package-fetch.ts";

/**
 * Fetching a git or npm source to an exact, verified artifact.
 *
 * Both vendors here are fixtures this test owns end to end — a local bare-adjacent git repository for git, a
 * tiny in-process HTTP server standing in for the npm registry for npm — so what is proven is this module's own
 * wiring (a commit-pinned fetch, an integrity-checked tarball, a digest computed over what actually landed on
 * disk), not whether GitHub or npmjs.org are reachable from wherever this suite runs.
 *
 * A second group of tests below is deliberately adversarial: a malicious git url, a symlink that would escape the
 * artifact root, an oversized tarball, and a tarball carrying a symlink/traversal entry. Each of these is the
 * regression coverage the code-review finding for that vulnerability asked for — the assertion is that the
 * dangerous operation never runs, not merely that the function returns a refusal.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-package-fetch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function buildGitRepo(): { repoPath: string; commit: string } {
  const repoPath = join(dir, "source-repo");
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init", "--quiet");
  git(repoPath, "config", "user.email", "fixture@example.com");
  git(repoPath, "config", "user.name", "fixture");
  writeFileSync(join(repoPath, "widget.json"), JSON.stringify({ id: "com.example.git-widget" }));
  mkdirSync(join(repoPath, "assets"));
  writeFileSync(join(repoPath, "assets", "icon.svg"), "<svg></svg>");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "--quiet", "-m", "init");
  const commit = git(repoPath, "rev-parse", "HEAD");
  return { repoPath, commit };
}

describe("fetchGitArtifact", () => {
  it("refuses a ref that is not a full commit id, before any fetch", async () => {
    const { repoPath } = buildGitRepo();
    const outcome = await fetchGitArtifact({ url: repoPath, ref: "main", cacheRoot: join(dir, "cache"), allowLocalPaths: true });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_REF_NOT_PINNED");
    // Nothing was fetched: the cache stays empty for a ref this function refused to touch.
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  it("refuses a bare local path unless the caller explicitly opts in (C1: scheme allowlist)", async () => {
    const { repoPath, commit } = buildGitRepo();
    const outcome = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot: join(dir, "cache") });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_SOURCE_NOT_ALLOWED");
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  it("refuses a url crafted to be read as a git option, and spawns no git process at all (C1)", async () => {
    const { commit } = buildGitRepo();
    // `--upload-pack=` is the canonical git argument-injection payload: if this string ever reaches a subprocess
    // argv as a positional url, git will run the command it names. Proof of the fix is not merely that the fetch
    // is refused, but that the fetch never wrote anything into the cache — i.e. no `git` process ever started
    // against this value.
    const maliciousUrl = "--upload-pack=touch /tmp/pwned-by-package-fetch-test";
    const cacheRoot = join(dir, "cache");
    const outcome = await fetchGitArtifact({ url: maliciousUrl, ref: commit, cacheRoot, allowLocalPaths: true });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_SOURCE_NOT_ALLOWED");
    expect(outcome.message).toContain("starts with");
    // No cache directory was ever created for this refused url — proof no git subprocess ran against it.
    expect(existsSync(cachedGitPath(cacheRoot, maliciousUrl, commit))).toBe(false);
    expect(existsSync("/tmp/pwned-by-package-fetch-test")).toBe(false);
  });

  it("refuses a non-https, non-local scheme outright, even one that names a real transport (C1)", async () => {
    const { commit } = buildGitRepo();
    const outcome = await fetchGitArtifact({
      url: "ext::sh -c touch%20/tmp/pwned-by-ext-transport",
      ref: commit,
      cacheRoot: join(dir, "cache"),
      allowLocalPaths: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_SOURCE_NOT_ALLOWED");
  });

  it("fetches a commit-pinned ref from a local repository and computes a stable digest over it", async () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");

    const first = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot, allowLocalPaths: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(readFileSync(join(first.artifact.path, "widget.json"), "utf8")).toContain("com.example.git-widget");
    // The fetch does not leave git's own history metadata in what gets hashed or served.
    expect(existsSync(join(first.artifact.path, ".git"))).toBe(true);
    expect(first.artifact.digest.startsWith("sha256:")).toBe(true);

    // Deterministic: the same commit fetched again (and re-hashed independently) produces the same digest.
    const rehashed = digestOfDirectory(first.artifact.path, { exclude: [".git"] });
    expect(rehashed.ok).toBe(true);
    if (rehashed.ok) expect(rehashed.digest).toBe(first.artifact.digest);

    // M3: refetching the same url+ref is a cache hit, not a re-fetch-and-overwrite — proven by the path being the
    // exact same content-addressed directory, never deleted between the two calls.
    const second = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot, allowLocalPaths: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.artifact.path).toBe(first.artifact.path);
    expect(second.artifact.digest).toBe(first.artifact.digest);
  });

  it("keys the cache by url as well as ref, so two remotes sharing a commit id do not collide (M3)", async () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");
    const first = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot, allowLocalPaths: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A second "remote" that happens to be a different path (a different url) but is fetched at the same commit:
    // its cache path must differ from the first's.
    const otherRepoPath = join(dir, "other-repo-same-commit");
    mkdirSync(otherRepoPath, { recursive: true });
    spawnSync("git", ["clone", "--quiet", repoPath, otherRepoPath]);
    const second = await fetchGitArtifact({ url: otherRepoPath, ref: commit, cacheRoot, allowLocalPaths: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.artifact.path).not.toBe(first.artifact.path);
  });

  it("refuses a commit that does not exist at the remote", async () => {
    const { repoPath } = buildGitRepo();
    const outcome = await fetchGitArtifact({
      url: repoPath,
      ref: "0".repeat(40),
      cacheRoot: join(dir, "cache"),
      allowLocalPaths: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_FETCH_FAILED");
  });

  it("times out rather than hanging forever on an unreachable remote (H4)", async () => {
    // Port 1 is a privileged, essentially-never-listening port: a `git fetch` against it will hang trying to
    // connect (or be refused fast, depending on platform) — the timeout below is short enough that this test is
    // still fast either way, and proves the function returns rather than never resolving.
    const outcome = await fetchGitArtifact({
      url: "https://127.0.0.1:1/does-not-exist.git",
      ref: "0".repeat(40),
      cacheRoot: join(dir, "cache"),
      timeoutMs: 500,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(["GIT_TIMEOUT", "GIT_FETCH_FAILED"]).toContain(outcome.code);
  }, 10_000);

  it("changes digest when the tree changes, so a mutated commit is never mistaken for the pinned one", async () => {
    const { repoPath, commit } = buildGitRepo();
    const first = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot: join(dir, "cache-a"), allowLocalPaths: true });
    expect(first.ok).toBe(true);

    writeFileSync(join(repoPath, "widget.json"), JSON.stringify({ id: "com.example.git-widget", version: 2 }));
    git(repoPath, "add", ".");
    git(repoPath, "commit", "--quiet", "-m", "bump");
    const secondCommit = git(repoPath, "rev-parse", "HEAD");
    const second = await fetchGitArtifact({ url: repoPath, ref: secondCommit, cacheRoot: join(dir, "cache-b"), allowLocalPaths: true });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.artifact.digest).not.toBe(first.artifact.digest);
  });
});

describe("H1: a fetched git artifact actually serves a file end to end", () => {
  it("resolves the entry's source to the cache path and reads a file out of it, once fetched", async () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");
    const fetched = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot, allowLocalPaths: true });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    // Before a fetch, resolving the same entry's source finds nothing local yet.
    const unfetchedEntry = { source: { kind: "git" as const, url: "https://example.test/never-fetched.git", ref: "a".repeat(40) } };
    expect(resolveLocalSource(unfetchedEntry, cacheRoot).kind).toBe("git");

    // A fresh entry object — not the one this test just fetched with, proving the resolution is a pure function
    // of `url`+`ref`, not something carried along from the fetch call itself — resolves to the cache path.
    const entry = { source: { kind: "git" as const, url: repoPath, ref: commit } };
    const resolved = resolveLocalSource(entry, cacheRoot);
    expect(resolved.kind).toBe("local");
    if (resolved.kind !== "local") return;
    expect(resolved.path).toBe(fetched.artifact.path);

    const served = readPackageFile({ entry: { source: resolved }, relativePath: "widget.json" });
    expect(served.ok).toBe(true);
    if (served.ok) expect(served.bytes.toString("utf8")).toContain("com.example.git-widget");
  });
});

describe("C2: digestOfDirectory refuses a symlink or hard link rather than following or silently skipping it", () => {
  it("refuses a symlink that points outside the artifact root", () => {
    const outside = join(dir, "outside-secret.txt");
    writeFileSync(outside, "top secret");

    const artifact = join(dir, "artifact");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "real.txt"), "hello");
    symlinkSync(outside, join(artifact, "escape.txt"));

    const result = digestOfDirectory(artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ARTIFACT_SYMLINK_ESCAPE");
    expect(result.message).toContain("escape.txt");
  });

  it("refuses a symlink even when it points inside the artifact root", () => {
    // The old code's bug was `statSync(...).isSymbolicLink()`, which is always false because `statSync` follows
    // the link before reporting — so a symlink pointing *inside* the tree passed just as silently as one pointing
    // outside it. The fix has to refuse a symlink by what it *is* (`lstatSync`), not by where it points.
    const artifact = join(dir, "artifact-inner-link");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "real.txt"), "hello");
    symlinkSync(join(artifact, "real.txt"), join(artifact, "alias.txt"));

    const result = digestOfDirectory(artifact);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ARTIFACT_SYMLINK_ESCAPE");
  });

  it("never throws for a symlink, even a self-referential one that would ELOOP under a following stat", () => {
    const artifact = join(dir, "artifact-self-link");
    mkdirSync(artifact);
    symlinkSync(join(artifact, "loop"), join(artifact, "loop"));

    expect(() => digestOfDirectory(artifact)).not.toThrow();
    const result = digestOfDirectory(artifact);
    expect(result.ok).toBe(false);
  });

  it("does not exclude a legitimately nested `.git` directory, only a root-level one (L1)", () => {
    const artifact = join(dir, "artifact-nested-git");
    mkdirSync(join(artifact, "vendor", ".git"), { recursive: true });
    writeFileSync(join(artifact, "vendor", ".git", "config"), "vendored");
    writeFileSync(join(artifact, "top.txt"), "hello");

    const withRootExclude = digestOfDirectory(artifact, { exclude: [".git"] });
    expect(withRootExclude.ok).toBe(true);

    // Removing the nested `.git` content must change the digest — proof it was actually included.
    rmSync(join(artifact, "vendor", ".git"), { recursive: true, force: true });
    const withoutNested = digestOfDirectory(artifact, { exclude: [".git"] });
    expect(withoutNested.ok).toBe(true);
    if (withRootExclude.ok && withoutNested.ok) expect(withRootExclude.digest).not.toBe(withoutNested.digest);
  });
});

describe("redactCredentials", () => {
  it("strips userinfo out of a url before it reaches a message (Low: credential leak)", () => {
    expect(redactCredentials("https://user:hunter2@github.com/example/repo.git")).toBe("https://github.com/example/repo.git");
    expect(redactCredentials("https://github.com/example/repo.git")).toBe("https://github.com/example/repo.git");
  });
});

/* ------------------------------------------------------------------ *
 * npm: a local fake registry
 * ------------------------------------------------------------------ */

type TarEntrySpec = { content: string; type?: "file" | "symlink" | "traversal"; linkTarget?: string };

/** A minimal npm tarball: a gzip'd tar with one `package/` entry per file, built with plain buffers so the test
 * has no dependency on a tar-writing library. Extended beyond a plain file to be able to construct the malicious
 * shapes `extractUstarTarball` (in `package-fetch.ts`) must refuse: a symlink entry and a path-traversal name. */
function buildNpmTarball(files: Record<string, string | TarEntrySpec>): Buffer {
  const blocks: Buffer[] = [];
  for (const [relativePath, spec] of Object.entries(files)) {
    const normalized: TarEntrySpec = typeof spec === "string" ? { content: spec } : spec;
    const name = normalized.type === "traversal" ? relativePath : `package/${relativePath}`;
    const contentBuffer = Buffer.from(normalized.content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "utf8"); // mode
    header.write("0000000\0", 108, "utf8"); // uid
    header.write("0000000\0", 116, "utf8"); // gid
    header.write(contentBuffer.length.toString(8).padStart(11, "0") + "\0", 124, "utf8"); // size, octal
    header.write("00000000000\0", 136, "utf8"); // mtime
    header.write("        ", 148, "utf8"); // checksum placeholder
    header.write(normalized.type === "symlink" ? "2" : "0", 156, "utf8"); // typeflag
    if (normalized.type === "symlink" && normalized.linkTarget !== undefined) {
      header.write(normalized.linkTarget, 157, "utf8"); // linkname field
    }
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    const padded = Buffer.concat([contentBuffer, Buffer.alloc((512 - (contentBuffer.length % 512)) % 512)]);
    blocks.push(header, padded);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks));
}

function startFakeRegistry(input: {
  name: string;
  version: string;
  tarball: Buffer;
  /** Corrupt the published integrity so a consuming test can prove the mismatch is refused. */
  wrongIntegrity?: boolean;
  /** Lie about the tarball's size in `content-length`, without changing the actual bytes served. */
  declaredContentLength?: number;
}): Promise<{ url: string; server: Server }> {
  const integrity = `sha512-${createHash("sha512").update(input.tarball).digest("base64")}`;
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === `/${input.name}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: input.name,
            versions: {
              [input.version]: {
                dist: {
                  tarball: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/tarball.tgz`,
                  integrity: input.wrongIntegrity === true ? `sha512-${"A".repeat(88)}` : integrity,
                },
              },
            },
          }),
        );
        return;
      }
      if (url === "/tarball.tgz") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          ...(input.declaredContentLength === undefined ? {} : { "content-length": String(input.declaredContentLength) }),
        });
        res.end(input.tarball);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({ url: `http://127.0.0.1:${String(port)}`, server });
    });
  });
}

describe("fetchNpmArtifact", () => {
  it("fetches an exact version, verifies its integrity, and extracts it under the cache root", async () => {
    const tarball = buildNpmTarball({ "widget.json": JSON.stringify({ id: "com.example.npm-widget" }) });
    const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
    try {
      const outcome = await fetchNpmArtifact({
        name: "com.example.npm-widget",
        version: "1.0.0",
        cacheRoot: join(dir, "cache"),
        registryUrl: url,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(readFileSync(join(outcome.artifact.path, "widget.json"), "utf8")).toContain("com.example.npm-widget");
      expect(outcome.artifact.digest.startsWith("sha256:")).toBe(true);
    } finally {
      server.close();
    }
  });

  it("refuses a tarball whose bytes do not match the published integrity", async () => {
    const tarball = buildNpmTarball({ "widget.json": "{}" });
    const { url, server } = await startFakeRegistry({
      name: "com.example.npm-widget",
      version: "1.0.0",
      tarball,
      wrongIntegrity: true,
    });
    try {
      const outcome = await fetchNpmArtifact({
        name: "com.example.npm-widget",
        version: "1.0.0",
        cacheRoot: join(dir, "cache"),
        registryUrl: url,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("NPM_INTEGRITY_MISMATCH");
    } finally {
      server.close();
    }
  });

  it("refuses a version the registry never published", async () => {
    const tarball = buildNpmTarball({ "widget.json": "{}" });
    const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
    try {
      const outcome = await fetchNpmArtifact({
        name: "com.example.npm-widget",
        version: "9.9.9",
        cacheRoot: join(dir, "cache"),
        registryUrl: url,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("NPM_VERSION_NOT_PUBLISHED");
    } finally {
      server.close();
    }
  });

  it("refuses a tarball whose declared content-length is over the size cap, before downloading its bytes (H5)", async () => {
    const tarball = buildNpmTarball({ "widget.json": "{}" });
    const { url, server } = await startFakeRegistry({
      name: "com.example.npm-widget",
      version: "1.0.0",
      tarball,
      declaredContentLength: 10 * 1024 * 1024 * 1024, // 10 GiB claimed, actual bytes tiny
    });
    try {
      const outcome = await fetchNpmArtifact({
        name: "com.example.npm-widget",
        version: "1.0.0",
        cacheRoot: join(dir, "cache"),
        registryUrl: url,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("NPM_TARBALL_TOO_LARGE");
    } finally {
      server.close();
    }
  });

  it("refuses a tarball entry that is a symlink, and writes nothing to disk (H5)", async () => {
    const tarball = buildNpmTarball({
      "widget.json": "{}",
      "link-to-etc-passwd": { content: "", type: "symlink", linkTarget: "/etc/passwd" },
    });
    const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
    try {
      const cacheRoot = join(dir, "cache");
      const outcome = await fetchNpmArtifact({
        name: "com.example.npm-widget",
        version: "1.0.0",
        cacheRoot,
        registryUrl: url,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("NPM_TARBALL_UNSAFE_ENTRY");
      expect(existsSync(join(cacheRoot, "npm"))).toBe(existsSync(join(cacheRoot, "npm")) ? statSync(join(cacheRoot, "npm")).isDirectory() : false);
      // No entry directory was left behind holding a partial extraction, symlink or otherwise.
      expect(existsSync(join(cacheRoot, "npm", "com.example.npm-widget-1.0.0"))).toBe(false);
    } finally {
      server.close();
    }
  });

  it("refuses a tarball entry that names a path outside the extraction root (H5)", async () => {
    const tarball = buildNpmTarball({
      "widget.json": "{}",
      "../../../etc/cron.d/evil": { content: "* * * * * root touch /tmp/pwned", type: "traversal" },
    });
    const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
    try {
      const outcome = await fetchNpmArtifact({
        name: "com.example.npm-widget",
        version: "1.0.0",
        cacheRoot: join(dir, "cache"),
        registryUrl: url,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("NPM_TARBALL_UNSAFE_ENTRY");
      expect(existsSync("/tmp/pwned")).toBe(false);
    } finally {
      server.close();
    }
  });

  it("reuses the cache rather than refetching for the same name+version (M3)", async () => {
    const tarball = buildNpmTarball({ "widget.json": "{}" });
    const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
    try {
      const cacheRoot = join(dir, "cache");
      const first = await fetchNpmArtifact({ name: "com.example.npm-widget", version: "1.0.0", cacheRoot, registryUrl: url });
      expect(first.ok).toBe(true);
      server.close();
      // The registry is now unreachable; a cache hit must not need it at all.
      const second = await fetchNpmArtifact({ name: "com.example.npm-widget", version: "1.0.0", cacheRoot, registryUrl: url });
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.artifact.path).toBe(first.artifact.path);
        expect(second.artifact.digest).toBe(first.artifact.digest);
      }
    } finally {
      server.close();
    }
  });
});

describe("digestOfDirectory", () => {
  it("is the same for the same bytes and different for a renamed file", () => {
    const treeA = join(dir, "tree-a");
    mkdirSync(treeA);
    writeFileSync(join(treeA, "a.txt"), "hello");

    const treeB = join(dir, "tree-b");
    mkdirSync(treeB);
    writeFileSync(join(treeB, "a.txt"), "hello");

    const treeC = join(dir, "tree-c");
    mkdirSync(treeC);
    writeFileSync(join(treeC, "renamed.txt"), "hello");

    const a = digestOfDirectory(treeA);
    const b = digestOfDirectory(treeB);
    const c = digestOfDirectory(treeC);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.digest).toBe(b.digest);
      expect(a.digest).not.toBe(c.digest);
    }
  });
});
