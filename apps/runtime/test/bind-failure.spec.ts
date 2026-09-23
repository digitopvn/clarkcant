import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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
  return await new Promise<Ran>((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/runtime/src/main.ts", ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    const timer = setTimeout(() => {
      failure = new Error(`The runtime did not exit within ${deadlineMs}ms; stderr so far:\n${stderr}`);
      child.kill("SIGKILL");
    }, deadlineMs);

    child.on("error", (error) => {
      failure = error;
      clearTimeout(timer);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

describe("a node that cannot bind its port", () => {
  it("names the port and says what to do, instead of a stack trace", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cc-bind2-"));
    const holder = createServer();
    try {
      // Keep the OS-assigned port occupied until the actual runtime exits.
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.listen(0, "127.0.0.1", resolve);
      });
      const address = holder.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener address");
      const port = address.port;
      const second = await runNode([
        "--data-dir",
        dataDir,
        "--port",
        String(port),
        "--label",
        "second",
      ]);

      expect(second.code).toBe(1);
      expect(second.stderr).toContain(`Port ${port} on 127.0.0.1 is already in use`);
      expect(second.stderr).toContain("Another node is probably running");
      expect(second.stderr).toContain("--port <number>");

      // The refusal has to be readable. An unhandled `'error'` event is what this replaced, so
      // the test refuses the shape of that failure rather than only checking the message.
      expect(second.stderr).not.toContain("Unhandled 'error' event");
      expect(second.stderr).not.toContain("setupListenHandle");
    } finally {
      try {
        if (holder.listening) {
          await new Promise<void>((resolve, reject) => {
            holder.close((error) => error ? reject(error) : resolve());
          });
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
