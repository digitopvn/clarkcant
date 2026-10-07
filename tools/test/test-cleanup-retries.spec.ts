import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isTestPath, retryingRmSyncLines } from "../invariants/test-cleanup-retries-asynchronously.mjs";
import { removeTestDirectory } from "../test-cleanup.ts";

// The sources below are strings, which the check blanks before it reads a file, so this file does not read as the calls
// it describes.
describe("the check on retrying synchronous removal in test code", () => {
  it("finds a call that asks for retries, wrapped across lines or not", () => {
    const source = [
      'import { rmSync } from "node:fs";',
      "afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));",
      "afterAll(() => {",
      "  rmSync(",
      '    join(dir, "x"),',
      "    { recursive: true, maxRetries: 3, retryDelay: 50 },",
      "  );",
      "});",
      "fs.rmSync(dir, { maxRetries: 2 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([2, 4, 9]);
  });

  it("leaves a call without retries, and the promise form with them, alone", () => {
    const source = [
      "rmSync(root, { recursive: true, force: true });",
      "await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });",
      "await removeTestDirectory(dir);",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("does not read a call named in a comment as a call", () => {
    const source = [
      "// rmSync(dir, { maxRetries: 3 }) never retries on Windows",
      "/* rmSync(dir, {",
      "     maxRetries: 3 }) */",
      "rmSync(dir, { recursive: true }); // no maxRetries here",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("does not let a parenthesis in a string unbalance the call, nor read a call inside a string", () => {
    const source = [
      'rmSync(join(dir, "a("), { recursive: true });',
      "const later = { maxRetries: 3 };",
      "const text = 'rmSync(dir, { maxRetries: 3 })';",
      "const fixture = `rmSync(dir, { maxRetries: 3 })`;",
      "const options = { maxRetries: 3 };",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("reads the code inside a template literal's expression", () => {
    const source = ["const result = `${String(rmSync(dir, { maxRetries: 3 }))} and ${'('}`;", "rmSync(other, { maxRetries: 1 });"].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([1, 2]);
  });

  it("finds rmSync under a name the file gives it", () => {
    const source = [
      'import { rmSync as wipe } from "node:fs";',
      'const { rmSync: erase } = await import("node:fs");',
      "const remove = fs.rmSync;",
      "wipe(dir, { maxRetries: 3 });",
      "erase(dir, { maxRetries: 3 });",
      "remove(dir, { maxRetries: 3 });",
      "wipe(dir, { recursive: true });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([4, 5, 6]);
  });

  it("leaves a call marked as showing the failing form on purpose", () => {
    const source = [
      "// invariant-allow: sync-rm-retries",
      "rmSync(dir, { maxRetries: 3 });",
      "rmSync(dir, { maxRetries: 3 }); // invariant-allow: sync-rm-retries",
      "",
      "rmSync(dir, { maxRetries: 3 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([5]);
  });

  it("covers specs, the helpers in test and e2e folders and CI's widget tooling smoke, not product code", () => {
    expect(isTestPath("apps/runtime/test/live-nodes.ts")).toBe(true);
    expect(isTestPath("apps/web/e2e/fixtures/server.mjs")).toBe(true);
    expect(isTestPath("packages/core/src/thing.spec.ts")).toBe(true);
    expect(isTestPath("tools/smoke-widget-tooling.mjs")).toBe(true);
    expect(isTestPath("apps/runtime/src/worker-process.ts")).toBe(false);
    expect(isTestPath("tools/test-cleanup.ts")).toBe(false);
  });
});

/**
 * A process whose working directory is `dir` until `release` is called, which on Windows keeps `dir` from being removed.
 * Resolves once the process says it runs, so the directory is held by then.
 */
async function holdAsWorkingDirectory(dir: string): Promise<{ release: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], {
    cwd: dir,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  await new Promise<void>((done, fail) => {
    child.stdout.once("data", () => done());
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`the holding process exited (${String(code)}) before it said it runs`)));
  });
  return {
    release: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

/**
 * The reason for the check, measured: a directory held for a moment, as by a child process that is still exiting (or an
 * antivirus, or an indexer). Only Windows refuses to remove a directory another process holds, so only there does this
 * say anything.
 */
describe.runIf(process.platform === "win32")("removing a directory Windows still holds", () => {
  it("fails at once in the synchronous form, though it asks for retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarkcant-cleanup-retry-"));
    writeFileSync(join(dir, "file.txt"), "held");
    const held = await holdAsWorkingDirectory(dir);
    try {
      const started = Date.now();
      // The failing form, on purpose: the check this file tests would otherwise flag it as test cleanup.
      // invariant-allow: sync-rm-retries
      expect(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })).toThrow(/EPERM|EBUSY/);
      // Ten retries 100 ms apart and longer each time would take seconds; none ran.
      expect(Date.now() - started).toBeLessThan(500);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await held.release();
      await removeTestDirectory(dir);
    }
  });

  it("retries in removeTestDirectory until the directory is let go, and removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarkcant-cleanup-retry-"));
    writeFileSync(join(dir, "file.txt"), "held");
    const held = await holdAsWorkingDirectory(dir);
    const holdMs = 700;
    const started = Date.now();
    let releasedAt: number | undefined;
    const released = new Promise<void>((done) =>
      setTimeout(() => {
        void held.release().then(() => {
          releasedAt = Date.now();
          done();
        });
      }, holdMs),
    );
    try {
      await removeTestDirectory(dir);
      expect(existsSync(dir)).toBe(false);
      // Removed only after the holder was let go, so the first attempts failed and a later one, made after waiting,
      // succeeded.
      expect(Date.now() - started).toBeGreaterThanOrEqual(holdMs);
    } finally {
      await released;
    }
    expect(releasedAt).toBeDefined();
  });
});
