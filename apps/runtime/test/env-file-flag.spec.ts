import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `--no-env-file`: a node started from a directory with a `.env` in it does not read that file.
 *
 * The browser suite starts the node from the checkout and blanks the provider keys it is handed. The file fills
 * variables that are unset or blank, so without this flag a developer's local `.env` put those keys back and the suite's
 * outcome depended on whose machine ran it. The node is run for real and made to exit on a port it cannot bind, which
 * happens after the file would have been read; the startup line naming what was read is the observable. Where that
 * line is expected, the node is stopped once it appears; where it must be absent, the node is left to reach the bind.
 */

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
const PROBE = "CC_ENV_FILE_FLAG_PROBE";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}, 30_000);

async function holdPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  cleanups.push(() => server.close());
  return { server, port: address.port };
}

/**
 * How long a node may take to get as far as the bind: a full boot. The test gets room past this wait, so a node that
 * really never exits is reported as that, with its stderr, rather than as a bare test timeout.
 */
const BOOT_WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

/**
 * Run the node in `cwd` and return what it wrote to stderr: as soon as `enough` says that already shows what the test
 * needs (the node is then stopped), or else once the node exits by itself.
 */
async function runNodeIn(cwd: string, args: string[], enough: (stderr: string) => boolean = () => false): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const env = { ...process.env };
    delete env[PROBE];
    const child = spawn(process.execPath, [MAIN, ...args], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (enough(stderr)) child.kill();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The runtime did not exit within ${BOOT_WAIT_MS}ms; stderr so far:\n${stderr}`));
    }, BOOT_WAIT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stderr);
    });
  });
}

async function setup(): Promise<{ cwd: string; args: string[] }> {
  const cwd = mkdtempSync(join(tmpdir(), "cc-envfile-"));
  // Windows can hold the node's working directory after `close` (for seconds while the whole suite runs and the files
  // just written are being scanned), which fails the removal with EPERM; the retries back off for up to about 20s.
  cleanups.push(() => rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  writeFileSync(join(cwd, ".env"), `${PROBE}=from-file\n`);
  const { port } = await holdPort();
  return { cwd, args: ["--data-dir", join(cwd, "data"), "--port", String(port), "--label", "env-file-flag"] };
}

describe("the node's .env file", () => {
  it("is read by default", async () => {
    const { cwd, args } = await setup();
    // The file is read before anything else the node does, and the line naming it is all this needs: there is no reason
    // to wait for the rest of the boot.
    const read = `from .env: ${PROBE}`;
    const stderr = await runNodeIn(cwd, args, (sofar) => sofar.includes(read));
    expect(stderr).toContain(read);
  }, TEST_TIMEOUT_MS);

  it("is not read with --no-env-file", async () => {
    const { cwd, args } = await setup();
    const stderr = await runNodeIn(cwd, [...args, "--no-env-file"]);
    // The node still got as far as the bind, so the absence below is the flag and not an earlier exit.
    expect(stderr).toMatch(/port|address|in use/i);
    expect(stderr).not.toContain(".env");
  }, TEST_TIMEOUT_MS);
});
