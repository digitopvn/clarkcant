import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isTestPath, retryingRmSyncLines } from "../invariants/test-cleanup-retries-asynchronously.mjs";
import { removeTestDirectory } from "../test-cleanup.ts";

// Spelled apart so this file does not read as the call it describes.
const RM_SYNC = ["rm", "Sync"].join("");

describe("the check on retrying synchronous removal in test code", () => {
  it("finds a call that asks for retries, wrapped across lines or not", () => {
    const source = [
      `import { ${RM_SYNC} } from "node:fs";`,
      `afterEach(() => ${RM_SYNC}(dir, { recursive: true, force: true, maxRetries: 5 }));`,
      `afterAll(() => {`,
      `  ${RM_SYNC}(`,
      `    join(dir, "x"),`,
      `    { recursive: true, maxRetries: 3, retryDelay: 50 },`,
      `  );`,
      `});`,
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([2, 4]);
  });

  it("leaves a call without retries, and the promise form with them, alone", () => {
    const source = [
      `${RM_SYNC}(root, { recursive: true, force: true });`,
      `await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });`,
      `await removeTestDirectory(dir);`,
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("covers specs and the helpers in test and e2e folders, not product code", () => {
    expect(isTestPath("apps/runtime/test/live-nodes.ts")).toBe(true);
    expect(isTestPath("apps/web/e2e/fixtures/server.mjs")).toBe(true);
    expect(isTestPath("packages/core/src/thing.spec.ts")).toBe(true);
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
      // Called through another name, so the check this file tests does not read it as test cleanup.
      const removeSync = rmSync;
      expect(() => removeSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })).toThrow(/EPERM|EBUSY/);
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
