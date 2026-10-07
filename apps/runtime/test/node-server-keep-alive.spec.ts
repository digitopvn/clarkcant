import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NODE_KEEP_ALIVE_TIMEOUT_MS, createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The node keeps idle connections long enough that a client which ignores the `Keep-Alive` hint does not reuse a
 * socket the node is closing. Proving the race itself needs an idle gap on the 6 s boundary and many samples, so this
 * checks what the node advertises and configures on the server it actually boots.
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

describe("the node's idle connections", () => {
  it("are kept well past the pause a client leaves between calls", () => {
    expect(NODE_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(server.keepAliveTimeout).toBe(NODE_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it("advertise that lifetime to clients that keep the connection", async () => {
    const header = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/health", headers: { connection: "keep-alive" } }, (res) => {
        res.resume();
        res.on("end", () => {
          const value = res.headers["keep-alive"];
          resolve(Array.isArray(value) ? value.join(",") : value);
        });
      });
      req.on("error", reject);
      req.end();
    });
    expect(header).toBe(`timeout=${NODE_KEEP_ALIVE_TIMEOUT_MS / 1000}`);
  });
});
