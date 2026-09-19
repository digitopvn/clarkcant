import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_UPLOAD_BODY_LIMIT, bodyLimitForPath, createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The HTTP transport, exercised by making real requests to a real server.
 *
 * The body ceiling lives in the request listener rather than in the handler, so a test that calls
 * `handleRequest` cannot reach it — which is exactly how a ceiling stops working without anybody
 * noticing. This boots the same server the node boots and sends bytes at it.
 *
 * The ceiling is supplied through the transport's options so the test can use a small number: the
 * deployed value is asserted separately, and sending 35 MiB to prove it would make this the slowest
 * file in the suite while proving nothing extra.
 */

const TEST_LIMIT = 4096;

let dir: string;
let services: NodeServices;
let close: () => Promise<void>;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-server-"));
  services = bootNodeServices({ dataDir: dir, label: "server test" });
  const server = createNodeServer({
    services,
    origin: "http://127.0.0.1",
    onWarning: () => undefined,
    bodyLimitFor: (path) => (path === "/attachments" ? TEST_LIMIT : undefined),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
});

afterEach(async () => {
  await close();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function token(): string {
  return services.runtime.identity.localToken;
}

describe("the deployed body ceiling", () => {
  it("applies to the upload route and to nothing else", () => {
    expect(bodyLimitForPath("/attachments")).toBe(ATTACHMENT_UPLOAD_BODY_LIMIT);
    expect(bodyLimitForPath("/attachments/att_1")).toBeUndefined();
    expect(bodyLimitForPath("/command")).toBeUndefined();
    expect(bodyLimitForPath("/conversations/conv_1/messages")).toBeUndefined();
    // 35 MiB is the base64 inflation of the 25 MiB per-file ceiling, which is the number that has to
    // fit; a smaller transport ceiling would refuse a file the contract accepts.
    expect(ATTACHMENT_UPLOAD_BODY_LIMIT).toBeGreaterThan(25 * 1024 * 1024);
  });
});

describe("an oversized request", () => {
  it("is refused with 413 before the node holds more than the ceiling", async () => {
    const oversized = "x".repeat(TEST_LIMIT * 2);
    const response = await fetch(`${base}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conv_1", filename: "a.txt", mime: "text/plain", contentBase64: oversized }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(body.error.message).toContain(String(TEST_LIMIT));
  });

  it("leaves every other path's behaviour exactly as it was", async () => {
    // The same size, on a path with no ceiling: the handler answers, which is what it did before the
    // attachment route existed. A global ceiling would have changed this request's answer.
    const sameSize = "x".repeat(TEST_LIMIT * 2);
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ nonsense: sameSize }),
    });
    expect(response.status).not.toBe(413);
    expect(response.status).toBe(400);
  });

  it("serves a normal request through the same server", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ok");
  });
});
