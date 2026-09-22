import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AutomationAction, observationIdSchema } from "@clarkcant/contracts";
import { createDriver, type BrowserDriver } from "@clarkcant/browser-playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { blobPathForDigest, readBlob } from "../src/blobs.ts";
import { handleRequest, type GatewayDeps, type GatewayRequest } from "../src/gateway.ts";
import { captureSessionPreview } from "../src/session-preview.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The preview path with a browser at the end of it (V14, phase 6).
 *
 * Everything here is real: a Chromium this pack really launches, a page really served over HTTP, the driver's own
 * `capturePreview()`, the node's blob store, and the authenticated route reading the bytes back. The reason it is
 * worth a browser is that the defect this phase closes was invisible without one — the path used to be proven with
 * a hand-written PNG prefix, and a truncated PNG decodes to no picture at all, so a journey could be green while no
 * browser had drawn anything.
 *
 * Two pages, not one, because that is what makes the digest mean something: if the bytes were a constant, the
 * digest would be a constant, and a card showing "the screen" would be showing the same picture forever.
 *
 * The frame is served by the node's own principal. A frame is a picture of somebody's screen, so the boundary that
 * matters is who is asking, not which machine is.
 */

const PAGE_ONE = `<!doctype html>
<html><head><title>One</title></head><body style="margin:0;background:#0a0a0a">
  <h1 style="color:#fff;font:700 96px system-ui;padding:64px">Phiên browser một</h1>
</body></html>`;

const PAGE_TWO = `<!doctype html>
<html><head><title>Two</title></head><body style="margin:0;background:#f5f0e6">
  <h1 style="color:#111;font:700 96px system-ui;padding:64px">Phiên browser hai</h2>
  <button>Hoàn tất</button>
</body></html>`;

let server: Server;
let origin: string;
/** Where the browsers under test keep their profiles. One directory, removed whole when the file is done. */
let profiles: string;
/** The node's data directory, removed when the file is done — not between tests, because the node outlives them. */
let dataDir: string;
let services: NodeServices;
let deps: GatewayDeps;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/two" ? PAGE_TWO : PAGE_ONE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  origin = `http://127.0.0.1:${String(address.port)}`;

  profiles = mkdtempSync(join(tmpdir(), "clarkcant-preview-profiles-"));
  dataDir = mkdtempSync(join(tmpdir(), "clarkcant-preview-node-"));
  services = bootNodeServices({ dataDir, label: "preview test node" });
  deps = { services, now: () => "2026-09-22T10:00:00.000Z" };
});

afterAll(async () => {
  services.runtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(profiles, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * A driver with the page already open, closed when the test is done.
 *
 * `act` is the same call the agent makes, so the origin rule is applied here exactly as it is for a real session:
 * the page a preview is taken of must be one the profile declared.
 */
async function withPage<T>(path: string, fn: (driver: BrowserDriver) => Promise<T>): Promise<T> {
  const created = createDriver({
    profileName: `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    nodeId: services.runtime.identity.nodeId,
    allowedOrigins: [origin],
    profileDir: join(profiles, `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
  });
  if (!created.ok) throw new Error(created.refused);
  const { driver } = created;
  try {
    const navigation: AutomationAction = {
      actionId: "act_preview_test_navigate",
      targetId: driver.target.targetId,
      observationId: observationIdSchema.parse("obs_preview_test"),
      leaseEpoch: driver.leaseEpoch,
      operation: "navigate",
      arguments: { url: `${origin}${path}` },
      expectedTargetVersion: driver.targetVersion,
      consequential: false,
    };
    const navigated = await driver.act(navigation, { approvalGranted: true });
    if (navigated.status !== "applied") throw new Error(navigated.message);
    return await fn(driver);
  } finally {
    await driver.close();
  }
}

/** The frame the node stores, and the digest it can be served under. */
async function captureThroughDriver(driver: BrowserDriver): Promise<{
  digest: string;
  viewport: { width: number; height: number };
  bytes: number;
}> {
  const captured = await captureSessionPreview({ dataDir: services.runtime.dataDir, driver });
  if (!captured.ok) throw new Error(captured.message);
  return { digest: captured.digest, viewport: captured.viewport, bytes: captured.bytes };
}

async function request(path: string, options: { authed?: boolean } = {}): Promise<Awaited<ReturnType<typeof handleRequest>>> {
  const outgoing: GatewayRequest = {
    method: "GET",
    path,
    query: {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  return await handleRequest(deps, outgoing);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A PNG that ends with its IEND chunk, which a hand-written prefix does not. */
function isCompletePng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const end = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return (
    signature.every((byte, index) => bytes[index] === byte) &&
    end.every((byte, index) => bytes[bytes.byteLength - end.length + index] === byte)
  );
}

describe("a frame captured from a real browser", () => {
  it("is served back from the route under its own digest, with the size it was captured at", async () => {
    const captured = await withPage("/", async (driver) => captureThroughDriver(driver));

    // A page really rendered: a picture of it is a complete PNG of a real size, not a prefix that decodes to
    // nothing. This is the assertion the old fixed-bytes fixture could not survive.
    const stored = readBlob({
      dataDir: services.runtime.dataDir,
      blobPath: blobPathForDigest({ dataDir: services.runtime.dataDir, digest: captured.digest }) ?? "",
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(isCompletePng(stored.bytes)).toBe(true);
    expect(stored.bytes.byteLength).toBeGreaterThan(1_000);
    expect(pngSize(stored.bytes)).toEqual(captured.viewport);
    // The digest is the bytes' own, so a card naming a digest is naming exactly this frame.
    expect(sha256(stored.bytes)).toBe(captured.digest);

    const response = await request(`/previews/${captured.digest}`);
    expect(response.status).toBe(200);
    expect(response.binary?.contentType).toBe("image/png");
    // A frame is a picture of a screen: a cached one is a stale one presented as current.
    expect(response.binary?.headers["cache-control"]).toBe("no-store");
    // The route serves the bytes the digest addresses — the same frame the card was told about.
    expect(sha256(response.binary?.bytes ?? new Uint8Array())).toBe(captured.digest);
    expect(pngSize(response.binary?.bytes ?? new Uint8Array())).toEqual(captured.viewport);
  });

  it("changes digest when the page changes, and keeps both frames addressable", async () => {
    const one = await withPage("/", async (driver) => captureThroughDriver(driver));
    const two = await withPage("/two", async (driver) => captureThroughDriver(driver));

    expect(one.digest).not.toBe(two.digest);
    // Both stay served: a preview that replaced the previous frame would make the earlier card show the wrong
    // picture, and a content-addressed store cannot do that.
    for (const captured of [one, two]) {
      const response = await request(`/previews/${captured.digest}`);
      expect(response.status).toBe(200);
      expect(sha256(response.binary?.bytes ?? new Uint8Array())).toBe(captured.digest);
    }
  });

  it("is not served to a caller without this node's token, and a digest it does not hold is not found", async () => {
    const captured = await withPage("/", async (driver) => captureThroughDriver(driver));

    const unauthenticated = await request(`/previews/${captured.digest}`, { authed: false });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.binary).toBeUndefined();

    // A digest nobody wrote and a string that was never a digest get the same answer, so the route cannot be used
    // to ask what this machine holds.
    const missing = await request(`/previews/sha256:${"0".repeat(64)}`);
    expect(missing.status).toBe(404);
    const malformed = await request("/previews/not-a-digest");
    expect(malformed.status).toBe(404);
  });
});
