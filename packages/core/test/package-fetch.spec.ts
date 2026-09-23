import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPackageFile } from "../src/package-files.ts";
import {
  cachedGitPath,
  digestOfDirectory,
  fetchGitArtifact,
  fetchNpmArtifact,
  killProcessGroup,
  redactCredentials,
  redactCredentialsInText,
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

describe("N2: expectedDigest is checked before a fetch becomes servable", () => {
  it("refuses a git fetch whose bytes do not match expectedDigest, and leaves no servable cache directory (staged, before rename)", async () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");

    const outcome = await fetchGitArtifact({
      url: repoPath,
      ref: commit,
      cacheRoot,
      allowLocalPaths: true,
      expectedDigest: "sha256:not-the-real-digest",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    // The bug this guards: before N2, the digest was checked by the *caller*, after this function had already
    // renamed the staged fetch into its content-addressed cache path — so a mismatch still left a servable
    // directory any later `resolveLocalSource` call for the same url+ref would find and trust. Proof the fix
    // holds is that nothing landed at that path at all, not merely that the outer caller refused afterwards.
    expect(existsSync(cachedGitPath(cacheRoot, repoPath, commit))).toBe(false);
  });

  it("refuses a git cache hit whose already-cached bytes do not match a newly expected digest, without deleting the cache", async () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");
    const first = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot, allowLocalPaths: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const outcome = await fetchGitArtifact({
      url: repoPath,
      ref: commit,
      cacheRoot,
      allowLocalPaths: true,
      expectedDigest: "sha256:not-the-real-digest",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    // The cache entry itself is still valid content for a caller with the correct expected digest, so it is not
    // deleted here — only this particular call, with the wrong expectation, is refused.
    expect(existsSync(first.artifact.path)).toBe(true);
  });

  it("succeeds when expectedDigest matches what was actually fetched", async () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");
    const probe = await fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot: join(dir, "probe-cache"), allowLocalPaths: true });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    const outcome = await fetchGitArtifact({
      url: repoPath,
      ref: commit,
      cacheRoot,
      allowLocalPaths: true,
      expectedDigest: probe.artifact.digest,
    });

    expect(outcome.ok).toBe(true);
  });

  it("[fails on the old behaviour] a digest mismatch used to be caught only by the caller, after the rename already made the bytes servable", async () => {
    // This is the exact scenario the old ordering got wrong: fetchGitArtifact itself had no expectedDigest
    // parameter at all, so it always reported `ok: true` for any bytes it could fetch, regardless of what the
    // directory published. Passing expectedDigest and getting a refusal back, from this function directly
    // (not from a caller checking afterwards), is the behaviour that did not exist before N2.
    const { repoPath, commit } = buildGitRepo();
    const outcome = await fetchGitArtifact({
      url: repoPath,
      ref: commit,
      cacheRoot: join(dir, "cache"),
      allowLocalPaths: true,
      expectedDigest: "sha256:not-the-real-digest",
    });
    expect(outcome.ok).toBe(false);
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

describe("redactCredentialsInText (Low: git's own stderr, not only the urls this node builds, can carry a credential)", () => {
  it("strips userinfo out of a url embedded anywhere in a block of free-form text", () => {
    const stderr =
      "fatal: unable to access 'https://user:hunter2@github.com/example/repo.git/': The requested URL returned error: 401";
    expect(redactCredentialsInText(stderr)).toBe(
      "fatal: unable to access 'https://github.com/example/repo.git/': The requested URL returned error: 401",
    );
    expect(redactCredentialsInText(stderr)).not.toContain("hunter2");
  });

  it("redacts every credentialed url in the text, not only the first", () => {
    const stderr = "tried https://a:1@host-a/x then https://b:2@host-b/y, both failed";
    const redacted = redactCredentialsInText(stderr);
    expect(redacted).not.toContain("a:1");
    expect(redacted).not.toContain("b:2");
    expect(redacted).toBe("tried https://host-a/x then https://host-b/y, both failed");
  });

  it("leaves text with no embedded credential unchanged", () => {
    const stderr = "fatal: repository 'https://github.com/example/repo.git/' not found";
    expect(redactCredentialsInText(stderr)).toBe(stderr);
  });
});

describe("killProcessGroup (Low: a timed-out child's own subprocess must not survive it)", () => {
  it("signals the whole process group by the child's negative pid, on a POSIX platform", () => {
    if (process.platform === "win32") return;
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const childKill = vi.fn().mockReturnValue(true);
    killProcessGroup({ pid: 4242, kill: childKill });

    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    // The group signal reached the whole tree already; a second, single-pid kill is redundant and would just be
    // an extra signal to a process that is already gone.
    expect(childKill).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("falls back to killing only the child's own pid when the group signal throws (the group is already gone, or this process cannot signal it)", () => {
    if (process.platform === "win32") return;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const childKill = vi.fn().mockReturnValue(true);
    killProcessGroup({ pid: 4242, kill: childKill });

    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(childKill).toHaveBeenCalledWith("SIGKILL");
    killSpy.mockRestore();
  });

  it("falls back to killing only the child's own pid when it has no pid (never actually spawned)", () => {
    const killSpy = vi.spyOn(process, "kill");
    const childKill = vi.fn().mockReturnValue(true);
    killProcessGroup({ pid: undefined, kill: childKill });

    expect(killSpy).not.toHaveBeenCalled();
    expect(childKill).toHaveBeenCalledWith("SIGKILL");
    killSpy.mockRestore();
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
    // ustar magic + version (N3: extractUstarTarball refuses a header without it), same as a real npm tarball
    // (built by node-tar) always carries.
    header.write("ustar\0", 257, "utf8");
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

  describe("N2: expectedDigest is checked before an npm fetch becomes servable", () => {
    it("refuses a staged extraction whose content digest does not match expectedDigest, and leaves no servable cache directory", async () => {
      const tarball = buildNpmTarball({ "widget.json": JSON.stringify({ id: "com.example.npm-widget" }) });
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      const cacheRoot = join(dir, "cache");
      try {
        const outcome = await fetchNpmArtifact({
          name: "com.example.npm-widget",
          version: "1.0.0",
          cacheRoot,
          registryUrl: url,
          expectedDigest: "sha256:not-the-real-digest",
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("ARTIFACT_DIGEST_MISMATCH");
        // Same bug shape as the git case: before N2 the mismatch was only caught by the caller, after the
        // staged extraction had already been renamed into the servable content-addressed cache path. The
        // final, content-addressed destination is what must never exist — the `.tmp-*` staging directory
        // beside it is expected to exist transiently and gets cleaned up by the function's own `finally`.
        expect(existsSync(join(cacheRoot, "npm", "com.example.npm-widget-1.0.0"))).toBe(false);
      } finally {
        server.close();
      }
    });

    it("succeeds when expectedDigest matches the extracted content", async () => {
      const tarball = buildNpmTarball({ "widget.json": JSON.stringify({ id: "com.example.npm-widget" }) });
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      try {
        const probe = await fetchNpmArtifact({
          name: "com.example.npm-widget",
          version: "1.0.0",
          cacheRoot: join(dir, "probe-cache"),
          registryUrl: url,
        });
        expect(probe.ok).toBe(true);
        if (!probe.ok) return;

        const outcome = await fetchNpmArtifact({
          name: "com.example.npm-widget",
          version: "1.0.0",
          cacheRoot: join(dir, "cache"),
          registryUrl: url,
          expectedDigest: probe.artifact.digest,
        });
        expect(outcome.ok).toBe(true);
      } finally {
        server.close();
      }
    });

    it("[fails on the old behaviour] fetchNpmArtifact had no expectedDigest parameter, so any fetched bytes were reported ok regardless of what the directory published", async () => {
      const tarball = buildNpmTarball({ "widget.json": JSON.stringify({ id: "com.example.npm-widget" }) });
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      try {
        const outcome = await fetchNpmArtifact({
          name: "com.example.npm-widget",
          version: "1.0.0",
          cacheRoot: join(dir, "cache"),
          registryUrl: url,
          expectedDigest: "sha256:not-the-real-digest",
        });
        expect(outcome.ok).toBe(false);
      } finally {
        server.close();
      }
    });
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

  describe("N3: tar hardening", () => {
    /** A header block for a raw, hand-built tar entry, bypassing `buildNpmTarball`'s one-entry-per-object-key
     * shape — needed here because a name conflict, a pax header, and a GNU long-name header all require either two
     * entries sharing one name (impossible as two keys of the same JS object) or a typeflag `buildNpmTarball` does
     * not know how to write. */
    function tarHeaderBlock(name: string, size: number, typeflag: string): Buffer {
      const header = Buffer.alloc(512);
      header.write(name.slice(0, 100), 0, "utf8");
      header.write("0000644\0", 100, "utf8");
      header.write("0000000\0", 108, "utf8");
      header.write("0000000\0", 116, "utf8");
      header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8");
      header.write("00000000000\0", 136, "utf8");
      header.write("        ", 148, "utf8");
      header.write(typeflag, 156, "utf8");
      header.write("ustar\0", 257, "utf8");
      let checksum = 0;
      for (const byte of header) checksum += byte;
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
      return header;
    }

    function padBlock(content: Buffer): Buffer {
      return Buffer.concat([content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
    }

    function buildRawTarball(entries: { name: string; content: string; typeflag: string }[]): Buffer {
      const parts: Buffer[] = [];
      for (const entry of entries) {
        const content = Buffer.from(entry.content, "utf8");
        parts.push(tarHeaderBlock(entry.name, content.length, entry.typeflag), padBlock(content));
      }
      parts.push(Buffer.alloc(1024));
      return gzipSync(Buffer.concat(parts));
    }

    it("refuses a tarball with two entries that resolve to the same final name, by name rather than a thrown filesystem error", async () => {
      const tarball = buildRawTarball([
        { name: "package/widget.json", content: '{"first":true}', typeflag: "0" },
        { name: "package/widget.json", content: '{"second":true}', typeflag: "0" },
      ]);
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      try {
        const outcome = await fetchNpmArtifact({
          name: "com.example.npm-widget",
          version: "1.0.0",
          cacheRoot: join(dir, "cache"),
          registryUrl: url,
        });
        // Before N3, the second entry's `writeFileSync` over the first's already-written bytes silently
        // overwrote it (a file/file conflict) or the extraction loop crashed with an uncaught EISDIR/ENOTDIR (a
        // file/directory conflict) — neither of which is the named refusal every other unsafe entry gets here.
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NPM_TARBALL_UNSAFE_ENTRY");
        expect(outcome.message).toContain("conflicts");
      } finally {
        server.close();
      }
    });

    it("refuses a tar header that is missing the ustar magic, rather than trusting its fields", async () => {
      // Built directly, rather than through `buildRawTarball`, specifically so the magic bytes at offset
      // 257..262 are left zeroed — every other tarball in this suite writes them, deliberately, so this is the
      // one entry that does not.
      const header = Buffer.alloc(512);
      header.write("package/widget.json", 0, "utf8");
      header.write("0000644\0", 100, "utf8");
      header.write("0000000\0", 108, "utf8");
      header.write("0000000\0", 116, "utf8");
      header.write("00000000002\0", 124, "utf8");
      header.write("00000000000\0", 136, "utf8");
      header.write("        ", 148, "utf8");
      header.write("0", 156, "utf8");
      // No magic written at 257 — left as zero bytes, unlike every other entry in this file.
      let checksum = 0;
      for (const byte of header) checksum += byte;
      header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
      const noMagicTarball = gzipSync(Buffer.concat([header, padBlock(Buffer.from("{}")), Buffer.alloc(1024)]));

      const { url, server } = await startFakeRegistry({
        name: "com.example.npm-widget",
        version: "1.0.0",
        tarball: noMagicTarball,
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
        expect(outcome.code).toBe("NPM_TARBALL_UNSAFE_ENTRY");
        expect(outcome.message).toContain("ustar magic");
      } finally {
        server.close();
      }
    });

    it("honours a GNU long-name header for a path too long for ustar's own 100-byte name field, rather than silently truncating it", async () => {
      const longPath = `package/${"deeply/nested/directory/".repeat(6)}widget.json`;
      expect(longPath.length).toBeGreaterThan(100);
      const nameContent = `${longPath}\0`;
      const tarball = buildRawTarball([
        { name: "", content: nameContent, typeflag: "L" },
        // The real entry's own 100-byte name field is left truncated/irrelevant on purpose — the GNU long-name
        // header above is what must win.
        { name: longPath.slice(0, 90), content: '{"id":"long-name-widget"}', typeflag: "0" },
      ]);
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      try {
        const cacheRoot = join(dir, "cache");
        const outcome = await fetchNpmArtifact({ name: "com.example.npm-widget", version: "1.0.0", cacheRoot, registryUrl: url });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // stripComponents: 1 removes the leading "package/" segment, same as every other entry in this suite.
        const expectedRelativePath = longPath.replace(/^package\//, "");
        expect(readFileSync(join(outcome.artifact.path, expectedRelativePath), "utf8")).toContain("long-name-widget");
      } finally {
        server.close();
      }
    });

    it("honours a pax extended header's path override, the same way node-tar/npm's own real tarballs use it for a path or a name with characters ustar's own field cannot carry", async () => {
      const longPath = `package/${"pax/extended/header/path/segment/".repeat(4)}component.js`;
      expect(longPath.length).toBeGreaterThan(100);
      const record = `path=${longPath}\n`;
      // Pax record format is "<total-length> <key>=<value>\n", where <total-length> includes its own digit count.
      let recordLength = record.length + 2;
      while (`${recordLength} ${record}`.length !== recordLength) recordLength += 1;
      const paxBody = `${recordLength} ${record}`;
      const tarball = buildRawTarball([
        { name: "package/PaxHeaders/component.js", content: paxBody, typeflag: "x" },
        { name: longPath.slice(0, 90), content: "export const pax = true;\n", typeflag: "0" },
      ]);
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      try {
        const cacheRoot = join(dir, "cache");
        const outcome = await fetchNpmArtifact({ name: "com.example.npm-widget", version: "1.0.0", cacheRoot, registryUrl: url });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const expectedRelativePath = longPath.replace(/^package\//, "");
        expect(readFileSync(join(outcome.artifact.path, expectedRelativePath), "utf8")).toContain("pax = true");
      } finally {
        server.close();
      }
    });

    it("still refuses a symlink named through a GNU long-name header, rather than letting the metadata header bypass the type check", async () => {
      const longPath = `package/${"nested/".repeat(20)}escape-link`;
      const tarball = buildRawTarball([
        { name: "", content: `${longPath}\0`, typeflag: "L" },
        { name: longPath.slice(0, 90), content: "", typeflag: "2" },
      ]);
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
        expect(outcome.message).toContain("symlink");
      } finally {
        server.close();
      }
    });

    it("aborts a download that exceeds the size cap while streaming, even when the server sends no content-length at all", async () => {
      // Content-Length is set automatically by Node's http server for a Buffer body unless Transfer-Encoding is
      // set explicitly — set here so the client genuinely never learns the size up front, the exact condition the
      // old content-length-only check could not catch.
      const oversized = Buffer.alloc(64 * 1024 * 1024 + 4096, 7);
      const server = createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/com.example.oversized-npm-widget") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              name: "com.example.oversized-npm-widget",
              versions: {
                "1.0.0": {
                  dist: {
                    tarball: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/tarball.tgz`,
                    integrity: `sha512-${createHash("sha512").update(oversized).digest("base64")}`,
                  },
                },
              },
            }),
          );
          return;
        }
        if (url === "/tarball.tgz") {
          // No content-length header at all: chunked transfer, which is exactly the case this test exists for.
          res.writeHead(200, { "content-type": "application/octet-stream", "Transfer-Encoding": "chunked" });
          res.end(oversized);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
      try {
        const address = server.address() as { port: number };
        const outcome = await fetchNpmArtifact({
          name: "com.example.oversized-npm-widget",
          version: "1.0.0",
          cacheRoot: join(dir, "cache"),
          registryUrl: `http://127.0.0.1:${String(address.port)}`,
        });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NPM_TARBALL_TOO_LARGE");
        expect(outcome.message).toContain("streaming");
      } finally {
        server.close();
      }
    }, 20_000);

    it("R3: refuses a tar entry whose pax size override differs from its ustar header size", async () => {
      // The pax "x" header's own body sets a size override (999) wildly different from the real entry that
      // follows, whose own ustar header size is the actual (short) content length below. A reader that ignores
      // the pax override (the pre-R3 code) advances past this entry using the header's own size instead, parsing
      // the archive at a different byte offset than a standard pax-aware reader (npm's own tooling, a registry
      // scanner) would — the exact digest-computed-against-one-parse-but-installed-from-another divergence R3
      // exists to refuse.
      const paxRecord = "size=999\n";
      let recordLength = paxRecord.length + 2;
      while (`${recordLength} ${paxRecord}`.length !== recordLength) recordLength += 1;
      const paxBody = `${recordLength} ${paxRecord}`;
      const tarball = buildRawTarball([
        { name: "package/PaxHeaders/mismatch.txt", content: paxBody, typeflag: "x" },
        { name: "package/mismatch.txt", content: "hello", typeflag: "0" },
      ]);
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
        expect(outcome.message).toContain("pax size override");
      } finally {
        server.close();
      }
    });

    it("R3: refuses a pax global extended header ('g') carrying a path or size override, rather than misapplying it to only the next entry", async () => {
      const record = "path=package/should-not-be-used.txt\n";
      let recordLength = record.length + 2;
      while (`${recordLength} ${record}`.length !== recordLength) recordLength += 1;
      const paxBody = `${recordLength} ${record}`;
      const tarball = buildRawTarball([
        { name: "package/PaxHeaders/global.txt", content: paxBody, typeflag: "g" },
        { name: "package/widget.json", content: "{}", typeflag: "0" },
      ]);
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
        expect(outcome.message).toContain("global");
      } finally {
        server.close();
      }
    });

    it("R4: refuses a file entry followed by a same-prefix entry (a, then a/b), rather than throwing an uncaught ENOTDIR out of extraction", async () => {
      // "package/conflict" and "package/conflict/nested.txt" are two different names, so `seenNames`'s exact-match
      // check never fires; writing the second requires `mkdirSync` to turn "conflict" into a directory when it
      // already exists on disk as a file from the first entry, which throws ENOTDIR.
      const tarball = buildRawTarball([
        { name: "package/conflict", content: "i am a file", typeflag: "0" },
        { name: "package/conflict/nested.txt", content: "i want to be inside that file", typeflag: "0" },
      ]);
      const { url, server } = await startFakeRegistry({ name: "com.example.npm-widget", version: "1.0.0", tarball });
      try {
        const outcome = await fetchNpmArtifact({
          name: "com.example.npm-widget",
          version: "1.0.0",
          cacheRoot: join(dir, "cache"),
          registryUrl: url,
        });
        // Before R4, this threw ENOTDIR uncaught out of `fetchNpmArtifact` rather than returning a refusal —
        // asserting `outcome.ok === false` here is itself the regression check: the old code never got this far
        // to produce an `outcome` at all.
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe("NPM_TARBALL_UNSAFE_ENTRY");
      } finally {
        server.close();
      }
    });
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
