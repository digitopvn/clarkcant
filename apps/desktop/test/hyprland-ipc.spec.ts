import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createHyprlandSocketTransport, hyprlandSocketPath } from "../src/hyprland-ipc.mjs";

/**
 * The request socket, spoken to by a real local server that behaves the way Hyprland's does: read one request, write
 * the reply, close. On Windows the same server listens on a named pipe, so the transport's framing and its bounds are
 * checked on every CI system even though only Linux has Hyprland.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function socketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\clarkcant-hypr-${randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), "cc-hypr-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, ".socket.sock");
}

async function serve(path: string, onRequest: (text: string, reply: (body: string) => void) => void): Promise<Server> {
  const server = createServer((socket) => {
    socket.once("data", (chunk) => onRequest(chunk.toString("utf8"), (body) => socket.end(body)));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => server.close());
  return server;
}

describe("Hyprland's request socket", () => {
  it("lives under the runtime directory, in the instance's own folder", () => {
    expect(hyprlandSocketPath({ runtimeDir: "/run/user/1000", signature: "abc_123" })).toBe(
      join("/run/user/1000", "hypr", "abc_123", ".socket.sock"),
    );
  });

  it("sends one request and answers everything written before the socket closed", async () => {
    const path = socketPath();
    const seen: string[] = [];
    await serve(path, (text, reply) => {
      seen.push(text);
      reply(text === "j/clients" ? "[]" : "ok");
    });
    const request = createHyprlandSocketTransport(path);
    expect(await request("j/clients")).toBe("[]");
    expect(await request("dispatch pin address:0x1")).toBe("ok");
    expect(seen).toEqual(["j/clients", "dispatch pin address:0x1"]);
  });

  it("fails, rather than hangs, when Hyprland does not answer", async () => {
    const path = socketPath();
    await serve(path, () => {
      // Never replies.
    });
    await expect(createHyprlandSocketTransport(path, { timeoutMs: 50 })("j/clients")).rejects.toThrow(/did not answer/);
  });

  it("fails with the reason when there is no socket", async () => {
    await expect(createHyprlandSocketTransport(socketPath())("j/clients")).rejects.toThrow(/could not be used/);
  });
});
