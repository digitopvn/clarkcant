import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * happens after the file would have been read; the startup line naming what was read is the observable.
 */

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
const PROBE = "CC_ENV_FILE_FLAG_PROBE";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function holdPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  cleanups.push(() => server.close());
  return { server, port: address.port };
}

/** Run the node in `cwd` until it exits, and return what it wrote to stderr. */
async function runNodeIn(cwd: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const env = { ...process.env };
    delete env[PROBE];
    const child = spawn(process.execPath, [MAIN, ...args], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`The runtime did not exit within 20000ms; stderr so far:\n${stderr}`));
    }, 20_000);
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
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, ".env"), `${PROBE}=from-file\n`);
  const { port } = await holdPort();
  return { cwd, args: ["--data-dir", join(cwd, "data"), "--port", String(port), "--label", "env-file-flag"] };
}

describe("the node's .env file", () => {
  it("is read by default", async () => {
    const { cwd, args } = await setup();
    const stderr = await runNodeIn(cwd, args);
    expect(stderr).toContain(`from .env: ${PROBE}`);
  }, 30_000);

  it("is not read with --no-env-file", async () => {
    const { cwd, args } = await setup();
    const stderr = await runNodeIn(cwd, [...args, "--no-env-file"]);
    // The node still got as far as the bind, so the absence below is the flag and not an earlier exit.
    expect(stderr).toMatch(/port|address|in use/i);
    expect(stderr).not.toContain(".env");
  }, 30_000);
});
