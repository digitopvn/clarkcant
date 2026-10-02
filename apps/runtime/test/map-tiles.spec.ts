import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, MAP_TILE_POLICY_PREFERENCE, MAP_TILE_SECRET_CONSUMER, type MapTileProvider } from "@clarkcant/contracts";
import { writeRegisteredPreference } from "@clarkcant/core";
import { nodeStoreSecretBackend, putSecretMetadata } from "@clarkcant/storage";

import { type MapTileCredential, createMapTileProxy, mapTileCredential, mapTileUrl, readMapTilePolicy, sniffTileType } from "../src/map-tiles.ts";
import { handleMapTileRoutes } from "../src/routes/map-tiles.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The tile proxy and its route.
 *
 * Most assertions are about what does not happen: no request without a policy, no request to another host, no key in
 * anything handed back, no redirect followed, no bytes passed on that are not the picture they claim to be.
 */

const AT = "2026-10-02T08:00:00.000Z" as Instant;
const KEY = "tile-key-that-must-not-escape";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const WEBP_BYTES = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ");

const PROVIDER: MapTileProvider = {
  origin: "https://tiles.example",
  template: "/styles/basic/{z}/{x}/{y}.png",
  attribution: "© Example contributors",
  maxZoom: 17,
};

const noKey: MapTileCredential = (use) => ({ ok: true, result: use(undefined) });
const withKey: MapTileCredential = (use) => ({ ok: true, result: use(KEY) });

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

function fakeFetch(answer: (url: URL) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ url: url.toString(), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    return answer(url);
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

const png = (): Response => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });

describe("the tile proxy", () => {
  it("asks only the policy's origin, for the z/x/y path, without following redirects", async () => {
    const { fetch, seen } = fakeFetch(png);
    const proxy = createMapTileProxy({ fetch });
    const outcome = await proxy.tile({ provider: PROVIDER, z: 3, x: 6, y: 3, credential: noKey });
    expect(outcome).toMatchObject({ ok: true, contentType: "image/png", cached: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://tiles.example/styles/basic/3/6/3.png");
    expect(seen[0]?.redirect).toBe("manual");
    expect(mapTileUrl({ ...PROVIDER, template: "/{z}/{x}/{y}" }, 1, 0, 1)?.origin).toBe("https://tiles.example");
  });

  it("refuses a redirect, a missing tile and a failing provider without passing their bodies on", async () => {
    const redirect = createMapTileProxy({ fetch: fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://other.example/x.png" } })).fetch });
    expect(await redirect.tile({ provider: PROVIDER, z: 1, x: 0, y: 0, credential: noKey })).toMatchObject({ ok: false, status: 502, code: "MAP_TILE_FAILED" });
    const missing = createMapTileProxy({ fetch: fakeFetch(() => new Response("nope", { status: 404 })).fetch });
    expect(await missing.tile({ provider: PROVIDER, z: 1, x: 0, y: 0, credential: noKey })).toMatchObject({ ok: false, status: 404, code: "MAP_TILE_MISSING" });
    const failing = createMapTileProxy({ fetch: fakeFetch(() => new Response("down", { status: 500 })).fetch });
    expect(await failing.tile({ provider: PROVIDER, z: 1, x: 0, y: 0, credential: noKey })).toMatchObject({ ok: false, status: 502, code: "MAP_TILE_FAILED" });
    const unreachable = createMapTileProxy({
      fetch: (async () => {
        throw new Error(`connect failed for https://tiles.example/?key=${KEY}`);
      }) as typeof fetch,
    });
    const outcome = await unreachable.tile({ provider: PROVIDER, z: 1, x: 0, y: 0, credential: withKey });
    expect(outcome).toMatchObject({ ok: false, status: 502, code: "MAP_TILE_FAILED" });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it("serves only PNG or WebP, by the declared type and by the bytes", async () => {
    const tile = (response: () => Response) => createMapTileProxy({ fetch: fakeFetch(response).fetch }).tile({ provider: PROVIDER, z: 1, x: 1, y: 1, credential: noKey });
    expect(await tile(() => new Response(WEBP_BYTES, { headers: { "content-type": "image/webp" } }))).toMatchObject({ ok: true, contentType: "image/webp" });
    expect(await tile(() => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }))).toMatchObject({ ok: false, code: "MAP_TILE_REFUSED" });
    expect(await tile(() => new Response("<html>", { headers: { "content-type": "text/html" } }))).toMatchObject({ ok: false, code: "MAP_TILE_REFUSED" });
    expect(await tile(() => new Response("<script>alert(1)</script>", { headers: { "content-type": "image/png" } }))).toMatchObject({ ok: false, code: "MAP_TILE_REFUSED" });
    expect(await tile(() => new Response(WEBP_BYTES, { headers: { "content-type": "image/png" } }))).toMatchObject({ ok: false, code: "MAP_TILE_REFUSED" });
    expect(await tile(() => new Response(PNG_BYTES))).toMatchObject({ ok: false, code: "MAP_TILE_REFUSED" });
    expect(sniffTileType(PNG_BYTES)).toBe("image/png");
    expect(sniffTileType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffTileType(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("refuses a tile larger than the size bound", async () => {
    const big = new Uint8Array(2048);
    big.set(PNG_BYTES);
    const proxy = createMapTileProxy({ fetch: fakeFetch(() => new Response(big, { headers: { "content-type": "image/png" } })).fetch, limits: { maxBytes: 1024 } });
    const outcome = await proxy.tile({ provider: PROVIDER, z: 1, x: 1, y: 1, credential: noKey });
    expect(outcome).toMatchObject({ ok: false, status: 502, code: "MAP_TILE_REFUSED", message: "the tile is larger than 1 KiB" });
  });

  it("caches a tile so asking again does not reach the provider, until its lifetime ends", async () => {
    let clock = 0;
    const { fetch, seen } = fakeFetch(png);
    const proxy = createMapTileProxy({ fetch, now: () => clock, limits: { cacheTtlMs: 1000 } });
    const request = { provider: PROVIDER, z: 2, x: 1, y: 1, credential: noKey };
    expect(await proxy.tile(request)).toMatchObject({ ok: true, cached: false });
    expect(await proxy.tile(request)).toMatchObject({ ok: true, cached: true });
    expect(seen).toHaveLength(1);
    // Another provider's tile at the same address is its own entry.
    expect(await proxy.tile({ ...request, provider: { ...PROVIDER, template: "/dark/{z}/{x}/{y}.png" } })).toMatchObject({ ok: true, cached: false });
    clock = 1001;
    expect(await proxy.tile(request)).toMatchObject({ ok: true, cached: false });
    expect(seen).toHaveLength(3);
  });

  it("keeps the cache within its entry bound, dropping the least recently used", async () => {
    const { fetch, seen } = fakeFetch(png);
    const proxy = createMapTileProxy({ fetch, limits: { cacheEntries: 2 } });
    const at = (x: number) => ({ provider: PROVIDER, z: 2, x, y: 0, credential: noKey });
    await proxy.tile(at(0));
    await proxy.tile(at(1));
    await proxy.tile(at(0));
    await proxy.tile(at(2));
    expect(await proxy.tile(at(0))).toMatchObject({ cached: true });
    expect(await proxy.tile(at(1))).toMatchObject({ cached: false });
    expect(seen).toHaveLength(4);
  });

  it("rate-limits requests that reach the provider, and refills over time", async () => {
    let clock = 0;
    const { fetch, seen } = fakeFetch(png);
    const proxy = createMapTileProxy({ fetch, now: () => clock, limits: { rate: { burst: 2, refillPerSecond: 1 } } });
    const at = (x: number) => ({ provider: PROVIDER, z: 3, x, y: 0, credential: noKey });
    expect(await proxy.tile(at(0))).toMatchObject({ ok: true });
    expect(await proxy.tile(at(1))).toMatchObject({ ok: true });
    expect(await proxy.tile(at(2))).toMatchObject({ ok: false, status: 429, code: "MAP_TILES_RATE_LIMITED" });
    // A cached tile costs nothing.
    expect(await proxy.tile(at(0))).toMatchObject({ ok: true, cached: true });
    clock = 1000;
    expect(await proxy.tile(at(2))).toMatchObject({ ok: true });
    expect(seen).toHaveLength(3);
  });

  it("adds the key as the header or query parameter the policy names, and returns it nowhere", async () => {
    const header = fakeFetch(png);
    const viaHeader = await createMapTileProxy({ fetch: header.fetch }).tile({
      provider: { ...PROVIDER, credential: { secret: "tiles", header: "x-api-key" } },
      z: 1, x: 0, y: 0, credential: withKey,
    });
    expect(header.seen[0]?.headers["x-api-key"]).toBe(KEY);
    expect(header.seen[0]?.url).not.toContain(KEY);
    const query = fakeFetch(png);
    const viaQuery = await createMapTileProxy({ fetch: query.fetch }).tile({
      provider: { ...PROVIDER, credential: { secret: "tiles", query: "key" } },
      z: 1, x: 0, y: 0, credential: withKey,
    });
    expect(new URL(query.seen[0]?.url ?? "").searchParams.get("key")).toBe(KEY);
    for (const outcome of [viaHeader, viaQuery]) {
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(new TextDecoder().decode(outcome.bytes)).not.toContain(KEY);
      expect(JSON.stringify({ ...outcome, bytes: undefined })).not.toContain(KEY);
    }
    const refused = await createMapTileProxy({ fetch: header.fetch }).tile({
      provider: PROVIDER, z: 1, x: 0, y: 0,
      credential: () => ({ ok: false, message: "the secret tiles has no value on this node" }),
    });
    expect(refused).toMatchObject({ ok: false, status: 503, code: "MAP_TILE_KEY_UNAVAILABLE" });
  });
});

let dir: string;
let services: NodeServices;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function storeKey(consumers: string[]): void {
  const db = services.runtime.db;
  putSecretMetadata(db, {
    secretId: "secret_tiles",
    principalId: owner(),
    name: "tiles",
    description: "Tile provider key",
    kind: "token",
    backend: "node-store",
    backendRef: "tiles",
    allowedConsumers: consumers,
    injectionPolicy: "http-header",
    at: AT,
  });
  nodeStoreSecretBackend(db, owner()).write("tiles", KEY, AT);
}

function setPolicy(value: unknown): void {
  const outcome = writeRegisteredPreference({ db: services.runtime.db, now: () => AT }, { principalId: owner(), key: MAP_TILE_POLICY_PREFERENCE, value });
  expect(outcome.ok).toBe(true);
}

function route(path: string, method = "GET", proxy = createMapTileProxy({ fetch: fakeFetch(png).fetch })) {
  return handleMapTileRoutes({
    services,
    request: { method, path, query: {}, headers: {}, body: "" },
    segments: path.split("/").filter((segment) => segment !== ""),
    at: () => AT,
    proxy,
  });
}

describe("the tile routes on a node", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-map-tiles-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
  });

  afterEach(() => {
    services.runtime.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("has no policy by default, and then asks nobody for any tile", async () => {
    expect(readMapTilePolicy({ db: services.runtime.db, now: () => AT }, owner())).toBeNull();
    expect(await route("/map-tiles")).toMatchObject({ status: 200, body: { provider: null } });
    const { fetch, seen } = fakeFetch(png);
    const response = await route("/map-tiles/1/0/0", "GET", createMapTileProxy({ fetch }));
    expect(response).toMatchObject({ status: 404, body: { code: "MAP_TILES_OFF" } });
    expect(seen).toHaveLength(0);
    expect(await route("/map-tiles/1/0/0", "POST")).toMatchObject({ status: 405 });
    expect(await route("/elsewhere")).toBeUndefined();
  });

  it("tells the page the provider and attribution but never its template or key", async () => {
    storeKey([MAP_TILE_SECRET_CONSUMER]);
    setPolicy({ ...PROVIDER, credential: { secret: "tiles", header: "x-api-key" } });
    const response = await route("/map-tiles");
    expect(response?.body).toEqual({ provider: { origin: "https://tiles.example", attribution: "© Example contributors", maxZoom: 17 } });
    expect(JSON.stringify(response)).not.toContain("styles/basic");
    expect(JSON.stringify(response)).not.toContain(KEY);
  });

  it("bounds the address by the provider's zoom and the grid, and reads only plain digits", async () => {
    setPolicy(PROVIDER);
    const { fetch, seen } = fakeFetch(png);
    const proxy = createMapTileProxy({ fetch });
    for (const path of ["/map-tiles/18/0/0", "/map-tiles/2/4/0", "/map-tiles/2/0/4", "/map-tiles/1e1/0/0", "/map-tiles/-1/0/0", "/map-tiles/0x1/0/0"]) {
      expect(await route(path, "GET", proxy), path).toMatchObject({ status: 400, body: { code: "MAP_TILE_OUT_OF_BOUNDS" } });
    }
    expect(await route("/map-tiles/1/0", "GET", proxy)).toMatchObject({ status: 404 });
    expect(seen).toHaveLength(0);
    const tile = await route("/map-tiles/2/3/1", "GET", proxy);
    expect(tile).toMatchObject({ status: 200, binary: { contentType: "image/png", cache: "private", headers: { "x-content-type-options": "nosniff" } } });
    expect(seen.map((entry) => entry.url)).toEqual(["https://tiles.example/styles/basic/2/3/1.png"]);
  });

  it("sends the key only when the secret is stored for maps:tiles, and never returns it", async () => {
    setPolicy({ ...PROVIDER, credential: { secret: "tiles", header: "x-api-key" } });
    const { fetch, seen } = fakeFetch(png);
    const proxy = createMapTileProxy({ fetch });
    const missing = await route("/map-tiles/1/0/0", "GET", proxy);
    expect(missing).toMatchObject({ status: 503, body: { code: "MAP_TILE_KEY_UNAVAILABLE" } });
    expect(seen).toHaveLength(0);

    storeKey(["command:git"]);
    const elsewhere = await route("/map-tiles/1/0/0", "GET", proxy);
    expect(elsewhere).toMatchObject({ status: 503, body: { code: "MAP_TILE_KEY_UNAVAILABLE", message: `the secret tiles is not stored for ${MAP_TILE_SECRET_CONSUMER}` } });
    expect(seen).toHaveLength(0);

    storeKey([MAP_TILE_SECRET_CONSUMER]);
    const tile = await route("/map-tiles/1/0/0", "GET", proxy);
    expect(tile?.status).toBe(200);
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY);
    expect(JSON.stringify({ ...tile, binary: { ...tile?.binary, bytes: undefined } })).not.toContain(KEY);
    // The key is used through the broker, which leaves no value in the node's audit rows either.
    const rows = services.runtime.db.prepare("SELECT * FROM audit_log").all();
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("is turned off again by setting the policy back to none", async () => {
    setPolicy(PROVIDER);
    expect((await route("/map-tiles/0/0/0"))?.status).toBe(200);
    setPolicy(null);
    expect(await route("/map-tiles/0/0/0")).toMatchObject({ status: 404, body: { code: "MAP_TILES_OFF" } });
  });

  it("refuses to store a policy whose template names another host", () => {
    const outcome = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT },
      { principalId: owner(), key: MAP_TILE_POLICY_PREFERENCE, value: { ...PROVIDER, template: "//other.example/{z}/{x}/{y}.png" } },
    );
    expect(outcome).toMatchObject({ ok: false, code: "PREFERENCE_INVALID" });
    expect(readMapTilePolicy({ db: services.runtime.db, now: () => AT }, owner())).toBeNull();
  });
});

describe("the credential runner", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-map-key-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
  });

  afterEach(() => {
    services.runtime.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("runs without a key when the policy names none", () => {
    const run = mapTileCredential({ db: services.runtime.db, principalId: owner(), now: () => AT }, PROVIDER);
    expect(run((value) => value)).toEqual({ ok: true, result: undefined });
  });

  it("hands the value only to the callback", () => {
    storeKey([MAP_TILE_SECRET_CONSUMER]);
    const run = mapTileCredential({ db: services.runtime.db, principalId: owner(), now: () => AT }, { ...PROVIDER, credential: { secret: "tiles", header: "x-api-key" } });
    let seen = "";
    const outcome = run((value) => {
      seen = value ?? "";
      return value?.length;
    });
    expect(seen).toBe(KEY);
    expect(outcome).toEqual({ ok: true, result: KEY.length });
  });
});
