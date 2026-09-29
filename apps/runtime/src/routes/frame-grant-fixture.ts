import { FRAME_GRANT_LIFETIME_MS } from "@clarkcant/core";

import { type NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The frame-grant fixture's one setting: how long the next grants this node mints last.
 *
 * Unreachable on a real node, the way the voice fixture's route is: with no fixture loaded there is no seam and this
 * answers 404. It sits after the bearer check like every other command, and it can only shorten the lifetime — a
 * value above the production lifetime is refused, so even a node started with the gate cannot be made to mint a
 * longer-lived URL. `null` puts the production lifetime back.
 *
 * `undefined` means the request is not this route.
 */
export function handleFrameGrantFixtureRoutes(deps: {
  services: Pick<NodeServices, "frameGrantFixture">;
  request: GatewayRequest;
  segments: string[];
}): GatewayResponse | undefined {
  const { request, segments } = deps;
  if (segments[0] !== "frame-grant-fixture") return undefined;
  const fixture = deps.services.frameGrantFixture;
  if (fixture === undefined) return fail(404, "NOT_FOUND", "no frame-grant fixture is loaded on this node");
  if (segments.length !== 2 || segments[1] !== "lifetime" || request.method !== "POST") {
    return fail(404, "NOT_FOUND", "no such frame-grant-fixture route");
  }
  const parsed = readJson(request);
  if (!parsed.ok) return parsed.response;
  const lifetimeMs = parsed.value.lifetimeMs;
  if (lifetimeMs === null) {
    fixture.setLifetimeMs(undefined);
    return json(200, { ok: true, lifetimeMs: FRAME_GRANT_LIFETIME_MS });
  }
  if (typeof lifetimeMs !== "number" || !Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > FRAME_GRANT_LIFETIME_MS) {
    return fail(
      400,
      "INVALID_SCHEMA",
      `lifetimeMs must be null or a whole number of milliseconds from 1 to ${String(FRAME_GRANT_LIFETIME_MS)}`,
    );
  }
  fixture.setLifetimeMs(lifetimeMs);
  return json(200, { ok: true, lifetimeMs });
}
