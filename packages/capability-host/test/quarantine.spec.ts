import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedBuild, quarantineDownload, unpackQuarantine } from "../src/quarantine.ts";

/**
 * Quarantine and the isolated build (V08).
 *
 * Installing a package means running code that came from somewhere else, so the two steps that touch it are
 * the two that matter: the artifact is hashed before anything is allowed to see it, and the build runs with
 * a working directory inside quarantine and an environment that does not carry the node's credentials.
 *
 * The refusals are tested as carefully as the successes. A digest that does not match has to leave
 * *nothing* behind — an unverified file in the quarantine directory is a file a later step could build — and
 * a build has to be unable to run outside quarantine at all, because "it is in quarantine" is only true if
 * something enforces it.
 */

const POSIX = process.platform !== "win32";

let dirs: string[] = [];

function tempDir(): string {
  const made = mkdtempSync(join(tmpdir(), "clarkcant-quarantine-"));
  dirs.push(made);
  return made;
}

afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
  dirs = [];
});

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A real gzipped tarball, made with the system `tar`, so the unpack step is exercised for real. */
function tarballWith(files: Record<string, string>): { path: string; digest: string } {
  const root = tempDir();
  const source = join(root, "payload");
  mkdirSync(source, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(source, name), contents);
  }
  const path = join(root, "artifact.tar.gz");
  // Relative arguments with the root as the working directory: GNU tar reads a `C:` in an absolute Windows path
  // as a remote host and refuses to run, which is a property of the tool rather than of the archive.
  const made = spawnSync("tar", ["-czf", "artifact.tar.gz", "-C", "payload", "."], { cwd: root, encoding: "utf8" });
  expect(made.status, `tar said: ${made.stderr ?? ""}`).toBe(0);
  return { path, digest: digestOf(readFileSync(path)) };
}

describe("downloading an artifact into quarantine", () => {
  it("stores the bytes it was given, and only after hashing them", async () => {
    const root = tempDir();
    const source = join(root, "artifact.tar.gz");
    writeFileSync(source, "not really a tarball, but bytes are bytes");
    const bytes = readFileSync(source);

    const result = await quarantineDownload({
      source,
      expectedDigest: digestOf(bytes),
      quarantineDir: join(root, "quarantine"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(bytes.byteLength);
    if (POSIX) {
      // Owner-only, like every other byte this node keeps: the mode is the reason the directory exists.
      // Windows does not carry POSIX modes, so this is asserted where it means something.
      expect(statSync(result.artifactPath).mode & 0o777).toBe(0o600);
    }
  });

  it("leaves nothing behind when the bytes are not the ones that were approved", async () => {
    const root = tempDir();
    const source = join(root, "artifact.tar.gz");
    writeFileSync(source, "the bytes that arrived");
    const quarantineDir = join(root, "quarantine");

    const result = await quarantineDownload({
      source,
      // The digest of something else, which is what a tampered or substituted artifact looks like.
      expectedDigest: `sha256:${"a".repeat(64)}`,
      quarantineDir,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("DIGEST_MISMATCH");
    // The whole point: a refusal must not leave an unverified file where a build step could find it.
    expect(existsSync(join(quarantineDir, "artifact.bin"))).toBe(false);
  });

  it("refuses a source that is neither an http(s) URL nor a path", async () => {
    const root = tempDir();
    for (const source of ["file:///etc/passwd", "ftp://example.invalid/x", "https://user:secret@example.invalid/x"]) {
      const result = await quarantineDownload({
        source,
        expectedDigest: `sha256:${"b".repeat(64)}`,
        quarantineDir: join(root, "quarantine"),
      });
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.code).toBe("UNSAFE_SOURCE");
    }
  });

  it("refuses a body over the ceiling, and does not follow a redirect", async () => {
    const root = tempDir();
    const tooLarge = await quarantineDownload({
      source: "https://example.invalid/artifact.tar.gz",
      expectedDigest: `sha256:${"c".repeat(64)}`,
      quarantineDir: join(root, "quarantine"),
      maxBytes: 4,
      fetchImpl: async () => new Response("0123456789"),
    });
    expect(tooLarge.ok ? "" : tooLarge.code).toBe("TOO_LARGE");

    let redirectPolicy: string | undefined;
    const redirect = await quarantineDownload({
      source: "https://example.invalid/artifact.tar.gz",
      expectedDigest: `sha256:${"d".repeat(64)}`,
      quarantineDir: join(root, "quarantine"),
      fetchImpl: async (_url, init) => {
        redirectPolicy = init?.redirect;
        return new Response("", { status: 302, headers: { location: "https://elsewhere.invalid/x" } });
      },
    });
    // The digest consent was bound to the artifact, not to wherever it points next.
    expect(redirectPolicy).toBe("error");
    expect(redirect.ok ? "" : redirect.code).toBe("DOWNLOAD_FAILED");
  });

  it("reports a local source it cannot read", async () => {
    const root = tempDir();
    const result = await quarantineDownload({
      source: join(root, "not-there.tar.gz"),
      expectedDigest: `sha256:${"e".repeat(64)}`,
      quarantineDir: join(root, "quarantine"),
    });
    expect(result.ok ? "" : result.code).toBe("DOWNLOAD_FAILED");
  });
});

describe("unpacking an artifact", () => {
  it("extracts a real tarball and reports what it found", async () => {
    const made = tarballWith({ "package.json": '{"name":"fixture"}', "README.md": "# fixture" });
    const into = join(tempDir(), "unpacked");

    const result = await unpackQuarantine({ artifactPath: made.path, into });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.root, "package.json"))).toBe(true);
    expect(result.entries).toBeGreaterThan(0);
  });

  it("reports an archive that cannot be unpacked instead of throwing", async () => {
    const root = tempDir();
    const broken = join(root, "broken.tar.gz");
    writeFileSync(broken, "this is not a gzip stream");

    const result = await unpackQuarantine({ artifactPath: broken, into: join(root, "unpacked") });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("UNPACK_FAILED");
  });

  it.skipIf(!POSIX)("refuses an archive carrying a symbolic link out of the root", async () => {
    const root = tempDir();
    const source = join(root, "payload");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), "{}");
    // A symlink out of the root is how a later write escapes a root that looked contained, so it fails the
    // install even though `tar` extracted it happily.
    spawnSync("ln", ["-s", "/etc", join(source, "escape")]);
    const path = join(root, "artifact.tar.gz");
    expect(spawnSync("tar", ["-czf", "artifact.tar.gz", "-C", "payload", "."], { cwd: root }).status).toBe(0);

    const result = await unpackQuarantine({ artifactPath: path, into: join(root, "unpacked") });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("ESCAPES_ROOT");
  });
});

describe("the isolated build", () => {
  it("refuses a build whose root is outside quarantine", async () => {
    const root = tempDir();
    const result = await isolatedBuild({
      root,
      quarantineDir: join(root, "quarantine"),
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("REFUSED");
    expect(result.ok ? "" : result.message).toMatch(/only run inside quarantine/);
  });

  it("runs a real build inside quarantine, and the child does not see the node's environment", async () => {
    const root = tempDir();
    const quarantineDir = join(root, "quarantine");
    const buildRoot = join(quarantineDir, "payload");
    mkdirSync(buildRoot, { recursive: true });

    // A variable the node holds and a build script has no business reading. If the child can see this, the
    // isolation is a claim rather than a boundary.
    process.env["TYPESAFE_API_KEY"] = "not-a-real-key";
    try {
      const result = await isolatedBuild({
        root: buildRoot,
        quarantineDir,
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), key: process.env.TYPESAFE_API_KEY ?? null }))"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const seen = JSON.parse(result.stdout) as { cwd: string; key: string | null };
      expect(seen.key).toBeNull();
      expect(seen.cwd.toLowerCase()).toContain("quarantine");
    } finally {
      delete process.env["TYPESAFE_API_KEY"];
    }
  });

  it("reports a build that fails, and one that does not finish", async () => {
    const root = tempDir();
    const quarantineDir = join(root, "quarantine");
    const buildRoot = join(quarantineDir, "payload");
    mkdirSync(buildRoot, { recursive: true });

    const failed = await isolatedBuild({
      root: buildRoot,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "process.stderr.write('the build broke'); process.exit(3)"],
    });
    expect(failed.ok ? "" : failed.code).toBe("BUILD_FAILED");
    // The output is kept, because a build that failed without saying why is a build somebody has to run by hand.
    expect(failed.ok ? "" : failed.stdout).toContain("the build broke");

    const timedOut = await isolatedBuild({
      root: buildRoot,
      quarantineDir,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 300,
    });
    expect(timedOut.ok ? "" : timedOut.code).toBe("TIMED_OUT");
  });
});
