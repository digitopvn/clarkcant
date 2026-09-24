import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createPiSessionWatcher } from "../src/pi-session-watch.ts";
import { attachTerminalGateway, type TerminalGateway } from "../src/terminal-gateway.ts";
import { createTerminalRegistry, type TerminalRegistry } from "../src/terminal-sessions.ts";

/**
 * The live terminal socket: authenticated in its first frame, and one driver per terminal.
 */
const TOKEN = "test-local-token-0123456789";
let dir: string;
let server: Server;
let gateway: TerminalGateway;
let registry: TerminalRegistry;
let url: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-terminal-gw-"));
  registry = createTerminalRegistry({
    dataDir: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, SHELL: "/bin/bash" },
    platform: "linux",
  });
  server = createServer((_request, response) => response.end());
  gateway = attachTerminalGateway({
    server,
    localToken: TOKEN,
    terminals: registry,
    piSessions: createPiSessionWatcher({ roots: () => [] }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/terminal`;
});

afterEach(async () => {
  registry.stopAll();
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

interface Client {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  next(type: string): Promise<Record<string, unknown>>;
  send(frame: Record<string, unknown>): void;
}

async function connect(token = TOKEN): Promise<Client> {
  const socket = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  const waiting: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  let seen = 0;
  socket.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    frames.push(frame);
    for (const waiter of [...waiting]) {
      if (waiter.type === frame.type) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "auth", token }));
  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: (type) => {
      const found = frames.slice(seen).find((frame) => frame.type === type);
      if (found !== undefined) {
        seen = frames.indexOf(found) + 1;
        return Promise.resolve(found);
      }
      return new Promise((resolve) => waiting.push({ type, resolve }));
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the terminal socket", () => {
  it("closes a connection whose first frame is not a valid token", async () => {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send(JSON.stringify({ type: "auth", token: "wrong" }));
    expect(await closed).toBe(4401);
  });

  it("says a terminal is gone rather than attaching to nothing", async () => {
    const client = await connect();
    await client.next("ready");
    client.send({ type: "attach", terminalId: "term_missing", cols: 80, rows: 24 });
    expect(await client.next("error")).toMatchObject({ code: "TERMINAL_GONE" });
    client.socket.close();
  });

  it("gives one card the keyboard and lets the other watch until it takes over", async () => {
    const opened = await registry.open({ cwd: dir });
    if (!opened.ok) throw new Error(opened.reason);
    const id = opened.info.terminalId;
    await registry.ready(id);

    const first = await connect();
    await first.next("ready");
    first.send({ type: "attach", terminalId: id, cols: 100, rows: 30 });
    expect(await first.next("attached")).toMatchObject({ driver: true });
    expect(registry.get(id)?.cols).toBe(100);

    const second = await connect();
    await second.next("ready");
    second.send({ type: "attach", terminalId: id, cols: 80, rows: 24 });
    expect(await second.next("attached")).toMatchObject({ driver: false });

    second.send({ type: "input", data: "echo from-observer\r" });
    expect(await second.next("error")).toMatchObject({ code: "NOT_DRIVER" });

    first.send({ type: "input", data: "echo from-driver\r" });
    const finished = await first.next("command");
    expect(finished).toMatchObject({ phase: "started" });

    second.send({ type: "take", cols: 90, rows: 20 });
    // The first card also saw its own claim when it attached; what matters is the latest word on who drives.
    await until(() => first.frames.filter((frame) => frame.type === "driver").at(-1)?.driver === false);
    await until(() => second.frames.filter((frame) => frame.type === "driver").at(-1)?.driver === true);
    expect(registry.get(id)?.cols).toBe(90);

    first.socket.close();
    second.socket.close();
  }, 20_000);
});
