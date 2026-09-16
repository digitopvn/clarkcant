import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A node that cannot bind its port.
 *
 * This is the failure an operator of a local node meets most often — a second node, or one
 * left running from last time — and until this was handled it produced Node's default
 * unhandled `'error'` event: a stack trace that names `Server.setupListenHandle` and never
 * says which port was taken or what to do. The test asserts the message, because the message
 * is the whole point of the change.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the node to completion with a deadline, so a hang fails rather than stalling the suite. */
async function runNode(args: string[], deadlineMs = 20_000): Promise<Ran> {
  return await new Promise<Ran>((resolve) => {
    const child = spawn(process.execPath, ["apps/runtime/src/main.ts", ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr });
    }, deadlineMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A port no other test is using.
 *
 * Picked from a high range and verified by trying it, because a test that assumes a port is
 * free fails for reasons that have nothing to do with the behaviour under test.
 */
async function startHolder(): Promise<{ port: number; stop: () => void }> {
  const dataDir = mkdtempSync(join(tmpdir(), "cc-bind-"));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const port = 19_100 + Math.floor(Math.random() * 800);
    const holder = spawn(
      process.execPath,
      ["apps/runtime/src/main.ts", "--data-dir", dataDir, "--port", String(port), "--label", "holder"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );

    const started = await new Promise<boolean>((resolve) => {
      let out = "";
      const timer = setTimeout(() => resolve(false), 12_000);
      holder.stderr.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("listening on")) {
          clearTimeout(timer);
          resolve(true);
        }
        if (out.includes("already in use")) {
          clearTimeout(timer);
          resolve(false);
        }
      });
      holder.on("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (started) return { port, stop: () => holder.kill("SIGKILL") };
    holder.kill("SIGKILL");
  }
  throw new Error("could not find a free port for the test");
}

describe("a node that cannot bind its port", () => {
  it("names the port and says what to do, instead of a stack trace", async () => {
    const holder = await startHolder();
    try {
      const second = await runNode([
        "--data-dir",
        mkdtempSync(join(tmpdir(), "cc-bind2-")),
        "--port",
        String(holder.port),
        "--label",
        "second",
      ]);

      expect(second.code).toBe(1);
      expect(second.stderr).toContain(`Port ${holder.port} on 127.0.0.1 is already in use`);
      expect(second.stderr).toContain("Another node is probably running");
      expect(second.stderr).toContain("--port <number>");

      // The refusal has to be readable. An unhandled `'error'` event is what this replaced, so
      // the test refuses the shape of that failure rather than only checking the message.
      expect(second.stderr).not.toContain("Unhandled 'error' event");
      expect(second.stderr).not.toContain("setupListenHandle");
    } finally {
      holder.stop();
    }
  }, 60_000);
});
