import { type Instant, mapTilePolicyView, mapTileProblem } from "@clarkcant/contracts";

import { type MapTileProxy, mapTileCredential, mapTileCredentialProblem, mapTileProxyFor, readMapTilePolicy } from "../map-tiles.ts";
import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

export interface MapTileRouteDeps {
  services: Pick<NodeServices, "runtime">;
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
 * `null`; this route never returns the path template or anything of the key (the person's own preference read shows the
 * policy, which names the secret but never holds its value). `GET /map-tiles/:z/:x/:y` is one tile from that provider, through the proxy in
 * `map-tiles.ts`. With no policy — the default — every tile request is refused with 404 and the node asks nobody.
 */
export async function handleMapTileRoutes(deps: MapTileRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments } = deps;
  if (segments[0] !== "map-tiles") return undefined;
  if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "map tiles are only read");
  const { runtime } = deps.services;
  const principalId = runtime.identity.ownerPrincipalId;
  const now = (): Instant => deps.at() as Instant;
  const policy = readMapTilePolicy({ db: runtime.db, now }, principalId);

  if (segments.length === 1) return json(200, mapTilePolicyView(policy));
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
  // still records when it was last used, and the policy that names it is the person's own recorded choice.
  const keyProblem = mapTileCredentialProblem({ db: runtime.db, principalId }, policy);
  if (keyProblem !== undefined) return fail(503, "MAP_TILE_KEY_UNAVAILABLE", keyProblem);
  const credential = mapTileCredential({ db: runtime.db, principalId, now }, policy);
  const outcome = await proxy.tile({ provider: policy, z, x, y, credential });
  if (!outcome.ok) return fail(outcome.status, outcome.code, outcome.message);
  return {
    status: 200,
    body: null,
    binary: { bytes: outcome.bytes, contentType: outcome.contentType, cache: "private", headers: { "x-content-type-options": "nosniff" } },
  };
}
