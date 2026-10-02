import {
  type BrowserTokenRefusal,
  browserTokenIssueBodySchema,
  browserTokenSessionSchema,
} from "@clarkcant/contracts";
import { getInstance } from "@clarkcant/core";
import { instanceIsInConversation } from "@clarkcant/storage";

import type { NodeServices } from "../services.ts";
import { locateIsolatedFrame } from "./conversations.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * Browser tokens for one widget frame.
 *
 * - `POST /conversations/:cid/widgets/:iid/browser-tokens` with `{ session, request }` asks for a token for the frame
 *   the host chrome mounted under `session`. Person-only (`isPersonOnlyRoute`): a machine surface relaying it would be
 *   asking for a provider credential to keep. The instance must be in the conversation, be the owner's, and run a
 *   package this node has active; what it may ask for is what that package's UI facet declared.
 * - `DELETE /conversations/:cid/widgets/:iid/browser-tokens/:session` ends that frame's tokens. Anyone who may reach
 *   the instance may end them: withdrawing a token grants nothing.
 *
 * A refusal says what was wrong and never carries a provider's own answer.
 */
export interface BrowserTokenRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "browserTokens">;
  request: GatewayRequest;
  segments: string[];
}

const REFUSAL_STATUS: Record<BrowserTokenRefusal, number> = {
  TOKEN_PROVIDER_NOT_DECLARED: 403,
  TOKEN_SCOPE_NOT_DECLARED: 403,
  TOKEN_PROVIDER_UNAVAILABLE: 503,
  TOKEN_PROVIDER_UNSCOPED: 422,
  TOKEN_SCOPE_NOT_SUPPORTED: 422,
  TOKEN_TTL_TOO_LONG: 422,
  TOKEN_SESSION_ENDED: 409,
  TOKEN_ISSUE_FAILED: 502,
};

export async function handleBrowserTokenRoutes(deps: BrowserTokenRouteDeps): Promise<GatewayResponse | undefined> {
  const { segments, request, services } = deps;
  if (segments[0] !== "conversations" || segments[2] !== "widgets" || segments[4] !== "browser-tokens") return undefined;
  const issuing = request.method === "POST" && segments.length === 5;
  const ending = request.method === "DELETE" && segments.length === 6;
  if (!issuing && !ending) return undefined;

  const conversationId = decodeURIComponent(segments[1] ?? "");
  const instanceId = decodeURIComponent(segments[3] ?? "");
  const notHere = fail(404, "RESOURCE_NOT_FOUND", "that widget is not in this conversation");
  if (conversationId === "" || instanceId === "") return notHere;
  if (!instanceIsInConversation(services.runtime.db, { conversationId, instanceId })) return notHere;
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined || instance.ownerPrincipalId !== services.runtime.identity.ownerPrincipalId) return notHere;

  const broker = services.browserTokens;
  if (ending) {
    const session = browserTokenSessionSchema.safeParse(decodeURIComponent(segments[5] ?? ""));
    if (!session.success) return fail(400, "INVALID_SCHEMA", "a frame session id is 16 to 128 letters, digits, _ or -");
    const revoked = broker === undefined ? 0 : await broker.endSession(instanceId, session.data);
    return json(200, { ended: true, revoked });
  }

  const parsed = readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = browserTokenIssueBodySchema.safeParse(parsed.value);
  if (!body.success) {
    return fail(400, "INVALID_SCHEMA", `the request is not a browser-token request: ${body.error.issues[0]?.message ?? "invalid"}`);
  }
  if (broker === undefined) {
    return fail(503, "TOKEN_PROVIDER_UNAVAILABLE", "browser tokens are not available on this node");
  }
  const located = locateIsolatedFrame(services.runtime, instance.definitionRef.id);
  if (!located.ok || !located.active) {
    // An instance whose package is gone is shown from what it kept; it is given nothing new.
    return fail(409, "TOKEN_PACKAGE_NOT_ACTIVE", "this widget's package is not running on this node, so it is given no token");
  }
  const outcome = await broker.issue({
    packageId: located.packageId,
    instanceId,
    session: body.data.session,
    declared: located.browserTokens,
    request: body.data.request,
  });
  if (!outcome.ok) return fail(REFUSAL_STATUS[outcome.code], outcome.code, outcome.message);
  // The answer to a POST, which no cache keeps: the value is the frame's, for its lifetime, and nobody else's.
  return json(200, { token: outcome.grant });
}

/**
 * What the in-process fixture providers minted, values included, for a browser journey to search for.
 *
 * Unreachable on a real node: with no fixture loaded there is no seam and this answers 404, like the frame-grant
 * fixture's route. `undefined` means the request is not this route.
 */
export function handleBrowserTokenFixtureRoutes(deps: {
  services: Pick<NodeServices, "browserTokenFixture">;
  request: GatewayRequest;
  segments: string[];
}): GatewayResponse | undefined {
  if (deps.segments[0] !== "browser-token-fixture") return undefined;
  const fixture = deps.services.browserTokenFixture;
  if (fixture === undefined) return fail(404, "NOT_FOUND", "no browser-token fixture is loaded on this node");
  if (deps.segments.length !== 2 || deps.segments[1] !== "issued" || deps.request.method !== "GET") {
    return fail(404, "NOT_FOUND", "no such browser-token-fixture route");
  }
  return json(200, { issued: fixture.issued() });
}
