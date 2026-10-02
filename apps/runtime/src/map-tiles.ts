import { createHash } from "node:crypto";

import {
  type Instant,
  MAP_TILE_CONTENT_TYPES,
  MAP_TILE_POLICY_PREFERENCE,
  MAP_TILE_SECRET_CONSUMER,
  type MapTilePolicy,
  type MapTileProvider,
  mapTilePolicySchema,
} from "@clarkcant/contracts";
import { readRegisteredPreference } from "@clarkcant/core";
import { type Database, getSecretMetadata, secretBackendFor } from "@clarkcant/storage";

import { createSecretBroker } from "./secret-broker.ts";
import { readBounded } from "./service-egress.ts";

/**
 * Map tiles, fetched by the node from the one provider a person named, and only then.
 *
 * A map draws an offline basemap that ships with the client. Raster tiles are an addition the node's tile policy
 * (`maps.tilePolicy`, person-only to write) may switch on, and the page reaches them only through this proxy:
 *
 *   - the provider's origin and path template come from the policy; a page asks for `z/x/y` and nothing else, so no
 *     prop, state or request can name another host;
 *   - `z/x/y` are bounded by the provider's maximum zoom and the grid at that zoom;
 *   - the provider's key, when there is one, is a secret this node holds for the explicit consumer `maps:tiles`; the
 *     node adds it to the request as the header or query parameter the policy names, and it is never part of what the
 *     page receives, the cache key, a log line or an error message;
 *   - a redirect is not followed, so the key never travels to another address;
 *   - only PNG or WebP is served back, checked by the provider's content type and by the bytes themselves, at most
 *     `MAP_TILE_LIMITS.maxBytes`, with only the content type and `nosniff` as headers;
 *   - requests are rate-limited per node, and tiles are kept in a bounded in-memory cache keyed by the policy (never
 *     the key's value) and the tile address, so panning back does not ask the provider twice.
 */

export const MAP_TILE_LIMITS = {
  maxBytes: 512 * 1024,
  timeoutMs: 10_000,
  rate: { burst: 48, refillPerSecond: 12 },
  cacheEntries: 256,
  cacheBytes: 24 * 1024 * 1024,
  cacheTtlMs: 60 * 60 * 1000,
} as const;

/** The node's tile policy as stored, or `null` — the default — when no provider is named or the stored value is unreadable. */
export function readMapTilePolicy(deps: { db: Database; now: () => Instant }, principalId: string): MapTilePolicy {
  const stored = readRegisteredPreference(deps, { principalId, key: MAP_TILE_POLICY_PREFERENCE });
  const parsed = mapTilePolicySchema.safeParse(stored?.value ?? null);
  return parsed.success ? parsed.data : null;
}

/** Runs `use` with the provider's key, or with nothing when the policy names none; a refusal says why without a value. */
export type MapTileCredential = <T>(use: (value: string | undefined) => T) => { ok: true; result: T } | { ok: false; message: string };

/**
 * The credential runner for a provider, from the node's own secret store.
 *
 * The secret must name `maps:tiles` among its consumers: an unrestricted secret stored for something else is not handed
 * to a tile provider just because the policy names it.
 */
export function mapTileCredential(deps: { db: Database; principalId: string; now: () => Instant }, provider: MapTileProvider): MapTileCredential {
  return (use) => {
    const credential = provider.credential;
    if (credential === undefined) return { ok: true, result: use(undefined) };
    const metadata = getSecretMetadata(deps.db, deps.principalId, credential.secret);
    if (metadata === undefined) return { ok: false, message: `the secret ${credential.secret} the tile policy names has not been provided on this node` };
    if (!metadata.allowedConsumers.includes(MAP_TILE_SECRET_CONSUMER)) {
      return { ok: false, message: `the secret ${credential.secret} is not stored for ${MAP_TILE_SECRET_CONSUMER}` };
    }
    const backend = secretBackendFor(deps.db, deps.principalId, metadata.backend);
    if (backend === undefined || !backend.has(metadata.backendRef)) return { ok: false, message: `the secret ${credential.secret} has no value on this node` };
    const used = createSecretBroker(deps).withSecret({ name: credential.secret, consumer: MAP_TILE_SECRET_CONSUMER, exposure: "http-header" }, (value) => use(value));
    return used.ok ? used : { ok: false, message: `the tile provider's key could not be used (${used.code})` };
  };
}

export type MapTileOutcome =
  | { ok: true; bytes: Uint8Array; contentType: (typeof MAP_TILE_CONTENT_TYPES)[number]; cached: boolean }
  | { ok: false; status: 404 | 429 | 502 | 503; code: string; message: string };

export interface MapTileRequest {
  provider: MapTileProvider;
  z: number;
  x: number;
  y: number;
  credential: MapTileCredential;
}

export interface MapTileProxyDeps {
  fetch?: typeof fetch;
  /** Milliseconds, for the rate and the cache's lifetime. */
  now?: () => number;
  limits?: Partial<{ maxBytes: number; timeoutMs: number; rate: { burst: number; refillPerSecond: number }; cacheEntries: number; cacheBytes: number; cacheTtlMs: number }>;
}

export interface MapTileProxy {
  tile(request: MapTileRequest): Promise<MapTileOutcome>;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type the bytes themselves say, or nothing: a PNG signature, or a RIFF container of WebP. */
export function sniffTileType(bytes: Uint8Array): (typeof MAP_TILE_CONTENT_TYPES)[number] | undefined {
  if (bytes.length >= PNG.length && PNG.every((byte, index) => bytes[index] === byte)) return "image/png";
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** What identifies a provider for the cache: where tiles come from and which key is sent, by name. Never its value. */
function providerKey(provider: MapTileProvider): string {
  const credential = provider.credential;
  const named = credential === undefined ? "" : `${credential.secret}|${credential.header ?? ""}|${credential.query ?? ""}`;
  return createHash("sha256").update(`${provider.origin}\n${provider.template}\n${named}`).digest("hex").slice(0, 32);
}

/** The tile's address on the provider. The template is a path on the policy's own origin, so the result cannot leave it. */
export function mapTileUrl(provider: MapTileProvider, z: number, x: number, y: number): URL | undefined {
  const path = provider.template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const url = new URL(path, `${provider.origin}/`);
  return url.origin === provider.origin && url.username === "" && url.password === "" ? url : undefined;
}

interface CachedTile {
  bytes: Uint8Array;
  contentType: (typeof MAP_TILE_CONTENT_TYPES)[number];
  at: number;
}

export function createMapTileProxy(deps: MapTileProxyDeps = {}): MapTileProxy {
  const limits = { ...MAP_TILE_LIMITS, ...deps.limits };
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  // A Map keeps insertion order, so the first key is the least recently used once a hit re-inserts its entry.
  const cache = new Map<string, CachedTile>();
  let cachedBytes = 0;
  let tokens: number = limits.rate.burst;
  let refilledAt = now();

  const evict = (key: string): void => {
    const entry = cache.get(key);
    if (entry === undefined) return;
    cache.delete(key);
    cachedBytes -= entry.bytes.byteLength;
  };

  const remember = (key: string, tile: CachedTile): void => {
    evict(key);
    if (tile.bytes.byteLength > limits.cacheBytes) return;
    cache.set(key, tile);
    cachedBytes += tile.bytes.byteLength;
    while (cache.size > limits.cacheEntries || cachedBytes > limits.cacheBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      evict(oldest);
    }
  };

  const take = (): boolean => {
    const at = now();
    tokens = Math.min(limits.rate.burst, tokens + ((at - refilledAt) / 1000) * limits.rate.refillPerSecond);
    refilledAt = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  return {
    async tile(request) {
      const { provider, z, x, y } = request;
      const key = `${providerKey(provider)}/${String(z)}/${String(x)}/${String(y)}`;
      const hit = cache.get(key);
      if (hit !== undefined) {
        if (now() - hit.at <= limits.cacheTtlMs) {
          cache.delete(key);
          cache.set(key, hit);
          return { ok: true, bytes: hit.bytes, contentType: hit.contentType, cached: true };
        }
        evict(key);
      }

      if (!take()) return { ok: false, status: 429, code: "MAP_TILES_RATE_LIMITED", message: "too many tile requests; the map asks again shortly" };

      const url = mapTileUrl(provider, z, x, y);
      if (url === undefined) return { ok: false, status: 502, code: "MAP_TILE_FAILED", message: "the tile policy's template does not stay on its origin" };

      const fetched = request.credential(async (value): Promise<MapTileOutcome> => {
        const headers: Record<string, string> = { accept: MAP_TILE_CONTENT_TYPES.join(", "), "user-agent": "ClarkCant map tiles" };
        const target = new URL(url);
        if (value !== undefined && provider.credential?.header !== undefined) headers[provider.credential.header] = value;
        if (value !== undefined && provider.credential?.query !== undefined) target.searchParams.set(provider.credential.query, value);
        const signal = AbortSignal.timeout(limits.timeoutMs);
        let response: Response;
        try {
          response = await doFetch(target, { method: "GET", headers, redirect: "manual", signal });
        } catch {
          // The error is not passed on: a fetch error can carry the URL, and with a query credential that holds the key.
          return { ok: false, status: 502, code: "MAP_TILE_FAILED", message: `the tile provider ${provider.origin} could not be reached` };
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 502, code: "MAP_TILE_FAILED", message: `the tile provider ${provider.origin} redirected; tiles are not followed to another address` };
        }
        if (response.status === 404) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 404, code: "MAP_TILE_MISSING", message: "the tile provider has no tile at that address" };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 502, code: "MAP_TILE_FAILED", message: `the tile provider ${provider.origin} answered ${String(response.status)}` };
        }
        const declared = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        if (!(MAP_TILE_CONTENT_TYPES as readonly string[]).includes(declared)) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, status: 502, code: "MAP_TILE_REFUSED", message: `the tile provider sent ${declared === "" ? "no content type" : declared}; only ${MAP_TILE_CONTENT_TYPES.join(" or ")} is shown` };
        }
        let bytes: Buffer | "too-large";
        try {
          bytes = await readBounded(response, limits.maxBytes, signal);
        } catch {
          return { ok: false, status: 502, code: "MAP_TILE_FAILED", message: `the tile from ${provider.origin} did not arrive in time` };
        }
        if (bytes === "too-large") {
          return { ok: false, status: 502, code: "MAP_TILE_REFUSED", message: `the tile is larger than ${String(Math.round(limits.maxBytes / 1024))} KiB` };
        }
        const sniffed = sniffTileType(bytes);
        if (sniffed !== declared) {
          return { ok: false, status: 502, code: "MAP_TILE_REFUSED", message: `the tile's bytes are not the ${declared} its provider said` };
        }
        const tile: CachedTile = { bytes: new Uint8Array(bytes), contentType: sniffed, at: now() };
        remember(key, tile);
        return { ok: true, bytes: tile.bytes, contentType: tile.contentType, cached: false };
      });
      if (!fetched.ok) return { ok: false, status: 503, code: "MAP_TILE_KEY_UNAVAILABLE", message: fetched.message };
      return fetched.result;
    },
  };
}

/** One proxy per node, so its rate and cache are the node's: keyed by the node's database handle. */
const PROXIES = new WeakMap<object, MapTileProxy>();

export function mapTileProxyFor(node: object, deps?: MapTileProxyDeps): MapTileProxy {
  const existing = PROXIES.get(node);
  if (existing !== undefined) return existing;
  const proxy = createMapTileProxy(deps);
  PROXIES.set(node, proxy);
  return proxy;
}
