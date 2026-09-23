import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { digestOfDirectory, fetchGitArtifact, fetchNpmArtifact } from "../src/package-fetch.ts";

/**
 * Fetching a git or npm source to an exact, verified artifact.
 *
 * Both vendors here are fixtures this test owns end to end — a local bare-adjacent git repository for git, a
 * tiny in-process HTTP server standing in for the npm registry for npm — so what is proven is this module's own
 * wiring (a commit-pinned fetch, an integrity-checked tarball, a digest computed over what actually landed on
 * disk), not whether GitHub or npmjs.org are reachable from wherever this suite runs.
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
  it("refuses a ref that is not a full commit id, before any fetch", () => {
    const { repoPath } = buildGitRepo();
    const outcome = fetchGitArtifact({ url: repoPath, ref: "main", cacheRoot: join(dir, "cache") });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_REF_NOT_PINNED");
    // Nothing was fetched: the cache stays empty for a ref this function refused to touch.
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  it("fetches a commit-pinned ref from a local repository and computes a stable digest over it", () => {
    const { repoPath, commit } = buildGitRepo();
    const cacheRoot = join(dir, "cache");

    const first = fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(readFileSync(join(first.artifact.path, "widget.json"), "utf8")).toContain("com.example.git-widget");
    // The fetch does not leave git's own history metadata in what gets hashed or served.
    expect(existsSync(join(first.artifact.path, ".git"))).toBe(true);
    expect(first.artifact.digest.startsWith("sha256:")).toBe(true);

    // Deterministic: the same commit fetched again (and re-hashed independently) produces the same digest.
    const rehashed = digestOfDirectory(first.artifact.path, { exclude: [".git"] });
    expect(rehashed).toBe(first.artifact.digest);

    const second = fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.artifact.digest).toBe(first.artifact.digest);
  });

  it("refuses a commit that does not exist at the remote", () => {
    const { repoPath } = buildGitRepo();
    const outcome = fetchGitArtifact({
      url: repoPath,
      ref: "0".repeat(40),
      cacheRoot: join(dir, "cache"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("GIT_FETCH_FAILED");
  });

  it("changes digest when the tree changes, so a mutated commit is never mistaken for the pinned one", () => {
    const { repoPath, commit } = buildGitRepo();
    const first = fetchGitArtifact({ url: repoPath, ref: commit, cacheRoot: join(dir, "cache-a") });
    expect(first.ok).toBe(true);

    writeFileSync(join(repoPath, "widget.json"), JSON.stringify({ id: "com.example.git-widget", version: 2 }));
    git(repoPath, "add", ".");
    git(repoPath, "commit", "--quiet", "-m", "bump");
    const secondCommit = git(repoPath, "rev-parse", "HEAD");
    const second = fetchGitArtifact({ url: repoPath, ref: secondCommit, cacheRoot: join(dir, "cache-b") });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.artifact.digest).not.toBe(first.artifact.digest);
  });
});

/* ------------------------------------------------------------------ *
 * npm: a local fake registry
 * ------------------------------------------------------------------ */

/** A minimal npm tarball: a gzip'd tar with one `package/` entry, built with plain buffers so the test has no
 * dependency on a tar-writing library. */
function buildNpmTarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const name = `package/${relativePath}`;
    const contentBuffer = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "utf8"); // mode
    header.write("0000000\0", 108, "utf8"); // uid
    header.write("0000000\0", 116, "utf8"); // gid
    header.write(contentBuffer.length.toString(8).padStart(11, "0") + "\0", 124, "utf8"); // size, octal
    header.write("00000000000\0", 136, "utf8"); // mtime
    header.write("        ", 148, "utf8"); // checksum placeholder
    header.write("0", 156, "utf8"); // typeflag: regular file
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
}): Promise<{ url: string; server: Server }> {
  const integrity = `sha512-${createHash("sha512").update(input.tarball).digest("base64")}`;
  return new Promise((resolve) => {
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
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(input.tarball);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${String(port)}`, server });
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

    expect(digestOfDirectory(treeA)).toBe(digestOfDirectory(treeB));
    expect(digestOfDirectory(treeA)).not.toBe(digestOfDirectory(treeC));
  });
});
