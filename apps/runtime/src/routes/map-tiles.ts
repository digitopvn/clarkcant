import { type Instant, mapTilePolicyView, mapTileProblem } from "@clarkcant/contracts";

import { removeMapTileKey, storeMapTileKey } from "../application/credential-vault.ts";
import {
  type MapTileProxy,
  mapTileCredential,
  mapTileCredentialProblem,
  mapTileProxyFor,
  readMapTileKey,
  readMapTilePolicy,
} from "../map-tiles.ts";
import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

export interface MapTileRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor">;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
  /** The proxy to use; the node's own by default. A test hands one with its own fetch. */
  proxy?: MapTileProxy;
}

/** A tile coordinate as the path spells it: digits only, so `1e3`, `-0` and `0x10` are refused rather than read. */
function coordinate(segment: string | undefined): number | undefined {
  return segment !== undefined && /^\d{1,7}$/u.test(segment) ? Number(segment) : undefined;
}

/**
 * The map tile routes.
 *
 * `GET /map-tiles` says whether the node shows tiles and whose: the provider's origin, attribution and maximum zoom, or
 * `null` with the reason the maps are offline-only (`no-provider`; `key-unavailable` when no key is saved;
 * `key-origin-mismatch` when the saved key was entered for another origin, so the node does not send it to this one).
 * The page then asks for no tile that would fail. This route never returns the path template or anything of the key.
 * `GET /map-tiles/:z/:x/:y` is one tile from that provider, through the proxy in `map-tiles.ts`. With no policy — the
 * default — every tile request is refused with 404 and the node asks nobody.
 *
 * `/map-tiles/key` is the provider's key: `GET` says whether one is saved and the origin it is bound to; `PUT`
 * `{ origin, value }` stores it, bound to that origin; `DELETE` removes it. `PUT` and `DELETE` are person-only
 * (`isPersonOnlyRoute`): only the person, in Settings, binds the key to an origin. No answer carries the value.
 */
export async function handleMapTileRoutes(deps: MapTileRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments } = deps;
  if (segments[0] !== "map-tiles") return undefined;
  const { runtime } = deps.services;
  const principalId = runtime.identity.ownerPrincipalId;
  if (segments.length === 2 && segments[1] === "key") return keyRoute(deps, principalId);
  if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "map tiles are only read");
  const now = (): Instant => deps.at() as Instant;
  const policy = readMapTilePolicy({ db: runtime.db, now }, principalId);

  if (segments.length === 1) {
    const problem = policy === null ? undefined : mapTileCredentialProblem({ db: runtime.db, principalId }, policy);
    return json(200, mapTilePolicyView(policy, problem?.offline));
  }
  if (segments.length !== 4) return fail(404, "NOT_FOUND", "a tile is addressed as /map-tiles/:z/:x/:y");
  if (policy === null) {
    return fail(404, "MAP_TILES_OFF", "this node shows no map tiles: no tile provider is set, so maps draw the offline basemap only");
  }
  const [z, x, y] = [coordinate(segments[1]), coordinate(segments[2]), coordinate(segments[3])];
  const problem = z === undefined || x === undefined || y === undefined ? "z, x and y must be whole numbers" : mapTileProblem(policy, z, x, y);
  if (problem !== undefined || z === undefined || x === undefined || y === undefined) {
    return fail(400, "MAP_TILE_OUT_OF_BOUNDS", problem ?? "z, x and y must be whole numbers");
  }

  const proxy = deps.proxy ?? mapTileProxyFor(runtime.db);
  // No trail row per tile: a pan asks for a dozen at once and would bury every other row. The secret's own metadata
  // still records when it was last used, and the policy that names it is a recorded choice with its source.
  const keyProblem = mapTileCredentialProblem({ db: runtime.db, principalId }, policy);
  if (keyProblem !== undefined) return fail(503, "MAP_TILE_KEY_UNAVAILABLE", keyProblem.message, { offline: keyProblem.offline });
  const credential = mapTileCredential({ db: runtime.db, principalId, now }, policy);
  const outcome = await proxy.tile({ provider: policy, z, x, y, credential });
  if (!outcome.ok) return fail(outcome.status, outcome.code, outcome.message, outcome.offline === undefined ? undefined : { offline: outcome.offline });
  return {
    status: 200,
    body: null,
    binary: { bytes: outcome.bytes, contentType: outcome.contentType, cache: "private", headers: { "x-content-type-options": "nosniff" } },
  };
}

function keyRoute(deps: MapTileRouteDeps, principalId: string): GatewayResponse {
  const { runtime, conductor } = deps.services;
  switch (deps.request.method) {
    case "GET":
      return json(200, { key: readMapTileKey({ db: runtime.db, principalId }) });
    case "PUT": {
      const body = readJson(deps.request);
      if (!body.ok) return body.response;
      const stored = storeMapTileKey(
        { db: runtime.db, ownerPrincipalId: principalId, nodeId: runtime.identity.nodeId, newId: conductor.newId },
        { origin: body.value.origin, value: body.value.value },
      );
      if (!stored.ok) return fail(400, stored.code, stored.message);
      return json(200, { key: { origin: stored.origin } });
    }
    case "DELETE":
      return json(200, removeMapTileKey({ db: runtime.db, ownerPrincipalId: principalId }));
    default:
      return fail(405, "METHOD_NOT_ALLOWED", "the map tile key is read, entered or removed");
  }
}
