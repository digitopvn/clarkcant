import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NODE_KEEP_ALIVE_TIMEOUT_MS, createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The node keeps an idle connection open long enough that a client which ignores the `Keep-Alive` hint can reuse it
 * after a pause. With Node's default the node closes it about 6 s after the last response, and a client sending just
 * then gets `ECONNRESET`. One raw socket makes this deterministic: it cannot reconnect behind the test's back, so a
 * second answer after a 7 s pause exists only if the node kept the connection.
 */

let dir: string;
let services: NodeServices;
let server: ReturnType<typeof createNodeServer>;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-keepalive-"));
  services = bootNodeServices({ dataDir: dir, label: "keep-alive test" });
  server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

const HEALTH = "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n";

describe("the node's idle connections", () => {
  it("answer a second request on the same connection after a 7 s pause", async () => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    let closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", () => undefined);
    const answers = (): number => received.split("HTTP/1.1 200").length - 1;
    const until = async (done: () => boolean, ms: number): Promise<void> => {
      const end = Date.now() + ms;
      while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    };

    socket.write(HEALTH);
    await until(() => answers() === 1, 5_000);
    expect(received).toContain(`Keep-Alive: timeout=${NODE_KEEP_ALIVE_TIMEOUT_MS / 1000}`);

    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(closed).toBe(false);
    socket.write(HEALTH);
    await until(() => answers() === 2, 5_000);
    expect(answers()).toBe(2);
    socket.destroy();
  }, 20_000);
});
