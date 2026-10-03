import { type NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

/**
 * Run the package update check once, now, on a node started with the update-check fixture.
 *
 * Unreachable on a real node, like the frame-grant fixture's route: with no fixture loaded there is no seam and this
 * answers 404. It sits after the bearer check like every other command. It writes only what the periodic check would
 * write on its next pass: a notice for each installed package the directory lists a newer version of.
 *
 * `undefined` means the request is not this route.
 */
export async function handleUpdateCheckFixtureRoutes(deps: {
  services: Pick<NodeServices, "updateCheckFixture">;
  request: GatewayRequest;
  segments: string[];
}): Promise<GatewayResponse | undefined> {
  if (deps.segments[0] !== "update-check-fixture") return undefined;
  const fixture = deps.services.updateCheckFixture;
  if (fixture === undefined) return fail(404, "NOT_FOUND", "no update-check fixture is loaded on this node");
  if (deps.segments.length !== 2 || deps.segments[1] !== "run" || deps.request.method !== "POST") {
    return fail(404, "NOT_FOUND", "no such update-check-fixture route");
  }
  return json(200, await fixture.run());
}
