import {
  type AppIntent,
  type AppIntentConfirmationFailure,
  appIntentConfirmRequestSchema,
  appIntentRequestSchema,
  describeAppIntent,
} from "@clarkcant/contracts";
import { recordAppIntentEvent } from "@clarkcant/core";
import { type Database } from "@clarkcant/storage";

import {
  type AppIntentDeps,
  consumeConfirmation,
  decideAppIntent,
  mintConfirmation,
  preferredAppIntentLocale,
} from "../app-intents.ts";
import { buildSuggestions } from "../suggestions.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The interaction family: what to offer next, and what a typed or spoken request means to the application.
 *
 * The route owns the HTTP: parsing the body against the contract's own schema, mapping a refusal to a
 * status, and the shape of the answer. Every dependency is a parameter, narrowed to the node fields
 * these routes read, so nothing here reaches for state it was not handed.
 */
export interface InteractionRouteDeps {
  services: {
    runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string } };
    conductor: { newId: (prefix: string) => string };
  };
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/** What these routes need from the node, named once so the helpers below do not repeat it. */
type InteractionServices = InteractionRouteDeps["services"];

/**
 * The interaction routes. `undefined` means the request is not one of these.
 */
export async function handleInteractionRoutes(deps: InteractionRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments, at } = deps;
  const services = deps.services;

  if (segments.length === 1 && segments[0] === "suggestions") {
    if (request.method !== "GET") {
      return fail(405, "METHOD_NOT_ALLOWED", "a suggestion list is read, not written");
    }
    return suggestionsResponse(services);
  }

  if (segments[0] === "app-intents") {
    return await handleAppIntentRoutes(services, request, segments, at);
  }

  return undefined;
}


/**
 * What each confirmation failure means, in words.
 *
 * Spelled out here rather than left to a caller: an expired confirmation and a wrong one lead a person to different
 * next actions, and a bare code on screen sends them looking for a bug that is not there.
 */
const CONFIRMATION_MESSAGES: Record<AppIntentConfirmationFailure, string> = {
  CONFIRMATION_NOT_FOUND: "Không có lời xác nhận nào đang chờ.",
  CONFIRMATION_EXPIRED: "Lời xác nhận đã quá hạn. Bạn nói lại câu lệnh nhé.",
  CONFIRMATION_ALREADY_USED: "Lời xác nhận này đã được dùng rồi.",
};

/** Said when someone declines. Nothing happened, and the answer says so rather than staying silent. */
const DECLINED_SAY = "Tôi đã bỏ qua câu lệnh đó.";

/**
 * Application intents.
 *
 * Two routes and one rule: a request comes back as a decision, and only `kind: "intent"` is executable. Quitting
 * always comes back as `needs-confirmation` carrying a token, so no single request - typed, clicked or spoken - can
 * end the application on its own. A request that maps to nothing is answered `none`, which means "not my business,
 * carry on as before" and is deliberately not the same answer as a refusal.
 */
/**
 * What to offer next.
 *
 * Read on demand rather than cached, and the transport says so: it owns the cache headers on every response, so
 * this route does not write one it could not enforce. An empty store is an empty list and a 200, not a 404 -
 * there is nothing wrong with having nothing to suggest, and a 404 would make the client treat a normal state as
 * an error it has to recover from.
 */
function suggestionsResponse(services: InteractionServices): GatewayResponse {
  const { runtime } = services;
  const items = buildSuggestions({
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    now: () => new Date().toISOString(),
    principalId: runtime.identity.ownerPrincipalId,
  });
  return { status: 200, body: { items } };
}

async function handleAppIntentRoutes(
  services: InteractionServices,
  request: GatewayRequest,
  segments: readonly string[],
  at: () => string,
): Promise<GatewayResponse> {
  const { runtime } = services;
  const principalId = runtime.identity.ownerPrincipalId;
  const intentDeps: AppIntentDeps = {
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    now: () => at() as never,
    newId: services.conductor.newId,
  };

  if (segments.length === 1 && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const body = appIntentRequestSchema.safeParse(parsed.value);
    if (!body.success) {
      return fail(400, "INVALID_SCHEMA", "an app intent request needs text or a kind, and a source");
    }
    const asked = body.data;
    const decision = decideAppIntent(
      intentDeps,
      {
        principalId,
        request: asked,
        ...(asked.conversationId === undefined ? {} : { conversationId: asked.conversationId as never }),
      },
      (intent: AppIntent) => mintConfirmation(intentDeps, { principalId, intent, source: asked.source }),
    );
    return json(200, { decision });
  }

  if (segments.length === 2 && segments[1] === "confirm" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const body = appIntentConfirmRequestSchema.safeParse(parsed.value);
    if (!body.success) {
      return fail(400, "INVALID_SCHEMA", "a confirmation needs a token and a granted or denied decision");
    }
    // Spent before the decision is read, so a denial also burns the token and a second answer cannot reverse it.
    const outcome = consumeConfirmation(intentDeps, { principalId, token: body.data.confirmationToken });
    if (!outcome.ok) {
      const status =
        outcome.code === "CONFIRMATION_ALREADY_USED" ? 409 : outcome.code === "CONFIRMATION_EXPIRED" ? 410 : 404;
      return fail(status, outcome.code, CONFIRMATION_MESSAGES[outcome.code]);
    }
    if (body.data.decision === "denied") {
      return json(200, { granted: false, decision: { kind: "refused", say: DECLINED_SAY } });
    }
    recordAppIntentEvent(intentDeps, {
      intent: outcome.intent,
      source: outcome.source,
      confirmed: true,
      ...(body.data.conversationId === undefined ? {} : { conversationId: body.data.conversationId as never }),
    });
    return json(200, {
      granted: true,
      decision: {
        kind: "intent",
        intent: outcome.intent,
        requiresConfirmation: false,
        readBack: describeAppIntent(outcome.intent, preferredAppIntentLocale(intentDeps, principalId)),
      },
    });
  }

  return fail(404, "NOT_FOUND", "no such app-intent route");
}
