import { randomUUID } from "node:crypto";

import { type Instant, nowInstant } from "@clarkcant/contracts";
import { verifyFrameGrant } from "@clarkcant/core";

import { type PairingDeps } from "./peers.ts";
import { type NodeServices } from "./services.ts";
import { type GatewayRequest, type GatewayResponse, bearer, fail, tokenMatches } from "./routes/http.ts";
import { handlePairingRoutes, handlePeerUplinkRoutes } from "./routes/peers.ts";
import { handlePublicRoutes } from "./routes/public.ts";
import { handleNodeRoutes } from "./routes/node.ts";
import { handleVoiceRoutes } from "./routes/voice.ts";
import { handleControlRoutes } from "./routes/control.ts";
import { handleCredentialRoutes } from "./routes/credentials.ts";
import { handleRecordReadRoutes } from "./routes/record-read.ts";
import { handleMiniAppDataRoutes } from "./routes/mini-app-data.ts";
import { handleMemoryRoutes, handleSearchRoutes } from "./routes/search-memory.ts";
import { handleWidgetServingRoutes } from "./routes/widget-serving.ts";
import { handleAttachmentRoutes } from "./routes/attachments.ts";
import { handlePreviewRoutes } from "./routes/previews.ts";
import { handlePreferenceRoutes } from "./routes/preferences.ts";
import { handlePackageRoutes } from "./routes/packages.ts";
import { handleInteractionRoutes } from "./routes/interactions.ts";
import { handleConversationRoutes, handleRawCommand } from "./routes/conversations.ts";

/*
 * Re-exported from the module that now owns them, so the voice session keeps importing the same
 * symbols from the same place: the decision these make has to be identical in both callers, and a
 * second copy written beside the first is a second copy that can drift.
 */
export { answerQuestionForNode, decideApprovalForNode, interactionDepsFor } from "./routes/conversations.ts";
export {
  invokeWidgetAction,
  widgetActionTarget,
  type WidgetActionRequest,
  type WidgetActionResult,
} from "./application/widget-actions.ts";

export type { GatewayRequest, GatewayResponse } from "./routes/http.ts";
/**
 * Re-exported so the voice socket keeps importing the one constant-time comparison from where it always
 * has: the check is the same decision, and a second copy of it is a second copy that can drift.
 */
export { tokenMatches } from "./routes/http.ts";

/**
 * Authenticated command gateway.
 *
 * The gateway's main job is to refuse things, and to build the caller's identity from the
 * transport rather than from the request body. A payload that names its own principal is
 * data, not authority, which is why no route below reads an identity out of JSON.
 *
 * The transport is `node:http` with no framework so the authorization path has nowhere to
 * hide: every authenticated route goes through exactly one check.
 */

export interface GatewayDeps {
  services: NodeServices;
  /** Injected so tests can make time deterministic. */
  now?: () => string;
  /** Injected so conversation identifiers are deterministic in tests. */
  newConversationId?: () => string;
}

/**
 * Handle one request.
 *
 * Returning a discriminated result rather than throwing keeps every refusal visible in one
 * place, which is what makes the negative tests meaningful.
 */
export async function handleRequest(deps: GatewayDeps, request: GatewayRequest): Promise<GatewayResponse> {
  const at = deps.now ?? (() => nowInstant());
  const { services } = deps;
  const { runtime } = services;

  /*
   * The routes that answer before the token check: the preflight, the readiness probe and the web build.
   *
   * Answered first because a browser sends `OPTIONS` without credentials before any request that carries an
   * `Authorization` header, so requiring a token there would make every cross-origin request fail at the preflight
   * and look like a network error in the client. The preflight grants nothing: the actual request still has to
   * present the token.
   */
  const publicResponse = handlePublicRoutes({ services, request, at });
  if (publicResponse !== undefined) return publicResponse;

  /*
   * One route accepts a scoped grant instead of the bearer token, and it is the only one.
   *
   * A widget's document is fetched by the browser as a navigation, and a navigation cannot carry an
   * `Authorization` header — so without this the frame would be served a 401 and nothing would ever render. The grant
   * is checked here, before the token, and it has to name the exact package the URL asks for: a grant that read
   * "some instance" could be replayed against any other package on the node.
   */
  /*
   * The frame grant travels as a **path segment**, not as a cookie and not as a query.
   *
   * A cookie is an ambient credential, and this one would have to be `SameSite=None` to be sent from a sandboxed
   * frame — whose opaque origin makes every request cross-site — which is a worse trade than it looks. A query would
   * only cover the document itself: a subresource URL is the author's, so `./main.js` arrives with nothing attached
   * and the widget's own module would be refused.
   *
   * A path segment covers both, because relative URLs inherit it: `/frame/<grant>/widgets/main/index.html` asks for
   * `/frame/<grant>/widgets/main/main.js` next, and the same grant authorizes it for exactly the package it names.
   */
  const grantSegment =
    request.method === "GET" && request.path.startsWith("/frame/") ? request.path.split("/")[2] : undefined;
  const grant =
    grantSegment === undefined || grantSegment === ""
      ? undefined
      : verifyFrameGrant({
          grant: grantSegment,
          secret: runtime.identity.localToken,
          nowMs: Date.parse(nowInstant()),
        });
  const grantCovers = grant?.ok === true;
  /*
   * A grant that was presented and did not verify is refused as itself, not as "no token".
   *
   * The difference is the whole reason the codes exist: "your grant expired" is something a person can act on, and
   * "unauthenticated" for a URL the node itself just minted reads like a bug in the node.
   */
  if (grantSegment !== undefined && grantSegment !== "" && grant !== undefined && !grant.ok) {
    return fail(403, grant.code, grant.message);
  }

  /*
   * The two routes another node calls, answered before the local token check.
   *
   * A peer does not hold this node's local token and must not: that token authorizes commands on this
   * machine. What a peer presents is a token derived from its own identity when the pairing was made,
   * and the peer that token identifies is the only value `authenticatedSenderNodeId` is ever allowed
   * to be - an envelope that names its own sender is exactly the mistake acceptance test T08 covers.
   */
  const pairing: PairingDeps = {
    db: runtime.db,
    identity: runtime.identity,
    now: () => at() as Instant,
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
  };

  const peerUplinkResponse = handlePeerUplinkRoutes({ pairing, runtime, request });
  if (peerUplinkResponse !== undefined) return peerUplinkResponse;

  if (!grantCovers && !tokenMatches(runtime.identity.localToken, bearer(request.headers))) {
    // Identical for a missing and a wrong token: distinguishing them would tell an
    // attacker which half to work on.
    return fail(401, "UNAUTHENTICATED", "a valid bearer token is required for every command");
  }

  const segments = request.path.split("/").filter((segment) => segment.length > 0);

  /*
   * Pairing, from the side a person drives.
   *
   * Each of these is a decision about this machine, which is why they sit after the token check and
   * none of them is reachable by a peer. The module owns the routes, this only hands them the pairing
   * seam it already built.
   */
  const pairingResponse = handlePairingRoutes({ pairing, runtime, now: at, request, segments });
  if (pairingResponse !== undefined) return pairingResponse;

  /*
   * The node, what it can do, and the settings that decide what it runs.
   *
   * Called here, where `/node` used to be: every path in the family is a distinct path or top-level segment, so the
   * order between families is not observable, and the control family below is reached before the settings routes
   * for the same reason.
   */
  const nodeResponse = await handleNodeRoutes({ services, request, segments, at });
  if (nodeResponse !== undefined) return nodeResponse;

  const voiceResponse = handleVoiceRoutes({ services, request, segments, env: process.env });
  if (voiceResponse !== undefined) return voiceResponse;

  const controlResponse = await handleControlRoutes({ services, request, segments, at });
  if (controlResponse !== undefined) return controlResponse;

  const preferenceResponse = handlePreferenceRoutes({ services, request, segments, at });
  if (preferenceResponse !== undefined) return preferenceResponse;

  const recordResponse = handleRecordReadRoutes({ services, request, segments, at });
  if (recordResponse !== undefined) return recordResponse;

  const miniAppDataResponse = handleMiniAppDataRoutes({ services, request, segments, at });
  if (miniAppDataResponse !== undefined) return miniAppDataResponse;

  if (segments[0] === "attachments") {
    return handleAttachmentRoutes({ services, request, segments, at });
  }

  if (segments[0] === "previews") {
    return handlePreviewRoutes({ services, request, segments });
  }

  const searchResponse = await handleSearchRoutes({ services, request, segments });
  if (searchResponse !== undefined) return searchResponse;

  const memoryResponse = handleMemoryRoutes({ services, request, segments });
  if (memoryResponse !== undefined) return memoryResponse;

  const interactionResponse = await handleInteractionRoutes({ services, request, segments, at });
  if (interactionResponse !== undefined) return interactionResponse;

  if (segments[0] === "conversations") {
    return await handleConversationRoutes({
      services,
      request,
      segments,
      at,
      // Passed through rather than dropped: a test that injects it is the reason the id is not a clock.
      ...(deps.newConversationId === undefined ? {} : { newConversationId: deps.newConversationId }),
    });
  }

  const credentialResponse = handleCredentialRoutes({ services, request, segments });
  if (credentialResponse !== undefined) return credentialResponse;

  const packageResponse = handlePackageRoutes({ services, request, segments });
  if (packageResponse !== undefined) return packageResponse;


  /*
   * A package's files, reached through a frame grant.
   *
   * The grant was verified above and is handed on unchanged: this is the only route that serves package bytes to
   * a navigation, and the module refuses anything the grant does not name.
   */
  const widgetResponse = handleWidgetServingRoutes({ request, segments, grant: grantCovers ? grant : undefined });
  if (widgetResponse !== undefined) return widgetResponse;

  if (request.method === "POST" && request.path === "/command") {
    return handleRawCommand({ services, request, at });
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}
