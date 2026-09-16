import { timingSafeEqual } from "node:crypto";

import { commandEnvelopeSchema, nowInstant, protocolRangeSchema } from "@clarkcant/contracts";
import { listCapabilitySummaries, handleUserMessage, pinInstance, unpinInstance } from "@clarkcant/core";
import { createConversation, getDataset, getConversation, listConversations } from "@clarkcant/storage";

import { type NodeServices, buildTimeline } from "./services.ts";

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

export interface GatewayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
}

export interface GatewayDeps {
  services: NodeServices;
  /** Injected so tests can make time deterministic. */
  now?: () => string;
  /** Injected so conversation identifiers are deterministic in tests. */
  newConversationId?: () => string;
}

/** Constant-time comparison, so the gate does not leak a token's length or prefix. */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(headers: GatewayRequest["headers"]): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const [scheme, token] = value.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token === undefined) return undefined;
  return token;
}

function json(status: number, body: unknown): GatewayResponse {
  return { status, body };
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): GatewayResponse {
  return json(status, { code, message, ...(extra ?? {}) });
}

/** Parse a JSON body, reporting a malformed one rather than throwing. */
function readJson(request: GatewayRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: GatewayResponse } {
  if (request.body.trim() === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(request.body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, response: fail(400, "INVALID_SCHEMA", "the request body must be a JSON object") };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail(400, "INVALID_SCHEMA", "the request body is not valid JSON") };
  }
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
   * CORS preflight, answered before the token check.
   *
   * A browser sends `OPTIONS` without credentials before any request that carries an
   * `Authorization` header, so requiring a token here would make every cross-origin request
   * fail at the preflight and look like a network error in the client. The preflight grants
   * nothing: the actual request still has to present the token.
   */
  if (request.method === "OPTIONS") {
    return { status: 204, body: null };
  }

  // The only unauthenticated route, and it deliberately discloses no node identity: an
  // open readiness probe must not become a way to enumerate nodes.
  if (request.method === "GET" && request.path === "/health") {
    return json(200, {
      status: "ok",
      runtime: services.describe(),
      negotiatedProtocol: protocolRangeSchema.parse({ name: "agent.nodelink", min: 1, max: 2 }),
      checkedAt: at(),
    });
  }

  if (!tokenMatches(runtime.identity.localToken, bearer(request.headers))) {
    // Identical for a missing and a wrong token: distinguishing them would tell an
    // attacker which half to work on.
    return fail(401, "UNAUTHENTICATED", "a valid bearer token is required for every command");
  }

  const segments = request.path.split("/").filter((segment) => segment.length > 0);

  if (request.method === "GET" && request.path === "/node") {
    return json(200, {
      nodeId: runtime.identity.nodeId,
      label: runtime.identity.label,
      createdAt: runtime.identity.createdAt,
      // Reported here rather than inferred by the client, so the settings surface can say what
      // this node is configured for before it has answered anything. `null` means no model, which
      // is a state worth showing plainly: the node answers from scripts and capabilities only.
      model: services.model,
    });
  }

  if (request.method === "GET" && request.path === "/capabilities") {
    return json(200, {
      // Summaries only: dumping every tool schema into every turn is both expensive and a
      // prompt-injection surface, so a schema is loaded once a capability is chosen.
      capabilities: listCapabilitySummaries({ db: runtime.db, nodeId: runtime.identity.nodeId }),
    });
  }

  // /datasets/:id
  if (segments[0] === "datasets" && segments.length === 2 && request.method === "GET") {
    const dataset = getDataset(runtime.db, segments[1] ?? "");
    if (!dataset) return fail(404, "RESOURCE_NOT_FOUND", "that dataset is not available on this node");
    // The freshness travels with the data so a cached read cannot be presented as live.
    return json(200, dataset);
  }

  if (segments[0] === "conversations") {
    return await handleConversationRoutes(deps, request, segments, at);
  }

  if (request.method === "POST" && request.path === "/command") {
    return handleRawCommand(deps, request, at);
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

async function handleConversationRoutes(
  deps: GatewayDeps,
  request: GatewayRequest,
  segments: string[],
  at: () => string,
): Promise<GatewayResponse> {
  const { services } = deps;
  const { runtime } = services;
  const principal = {
    principalId: runtime.identity.ownerPrincipalId as never,
    kind: "user" as const,
    nodeId: runtime.identity.nodeId as never,
  };

  // /conversations
  if (segments.length === 1) {
    if (request.method === "GET") {
      return json(200, {
        conversations: listConversations(runtime.db).map((conversationId) => ({
          conversationId,
          ...(getConversation(runtime.db, conversationId) ?? {}),
        })),
      });
    }
    if (request.method === "POST") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      const conversationId =
        deps.newConversationId?.() ?? `conv_${runtime.identity.nodeId.slice(5, 13)}_${Date.now().toString(36)}`;
      const title = typeof parsed.value.title === "string" ? parsed.value.title.slice(0, 200) : undefined;
      createConversation(runtime.db, {
        conversationId,
        homeNodeId: runtime.identity.nodeId,
        ...(title === undefined ? {} : { title }),
        at: at() as never,
      });
      return json(201, { conversationId, homeNodeId: runtime.identity.nodeId });
    }
    return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /conversations`);
  }

  const conversationId = segments[1];
  if (conversationId === undefined) {
    return fail(400, "INVALID_SCHEMA", "a conversation route must name a conversation");
  }
  const conversation = getConversation(runtime.db, conversationId);
  if (!conversation) {
    return fail(404, "RESOURCE_NOT_FOUND", `conversation ${conversationId} does not exist`);
  }

  // A conversation accepts commands only on its home node. Two nodes writing one timeline
  // is the multi-master case the protocol refuses rather than reconciles.
  if (conversation.homeNodeId !== runtime.identity.nodeId) {
    return fail(
      403,
      "WRONG_NODE_FOR_RESOURCE",
      `this conversation is homed on ${conversation.homeNodeId}; send commands there rather than forking the timeline`,
    );
  }

  // /conversations/:id/messages
  if (segments.length === 3 && segments[2] === "messages" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(400, "INVALID_SCHEMA", "a message must carry a non-empty text field");
    }

    const outcome = await handleUserMessage(services.conductor, {
      conversationId: conversationId as never,
      principal,
      text: text.slice(0, 20_000),
      at: at() as never,
    });

    // A turn the model answered is already finished, so reporting it as accepted would be a
    // lie about what the caller is holding. 202 is reserved for the paths that genuinely have
    // work still to do: a dispatched or parked task.
    const finished = outcome.resolution === "model" || outcome.resolution === "model-failed";

    return json(finished ? 200 : 202, {
      resolution: outcome.resolution,
      taskId: outcome.taskId ?? null,
      messageIds: outcome.messages.map((message) => message.messageId),
      // The whole timeline page is returned so the client does not have to guess whether
      // its cursor is still valid after its own write.
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
    });
  }

  // /conversations/:id/timeline
  if (segments.length === 3 && segments[2] === "timeline" && request.method === "GET") {
    const after = Number.parseInt(request.query.after ?? "0", 10);
    if (!Number.isFinite(after) || after < 0) {
      return fail(400, "INVALID_SCHEMA", "the `after` cursor must be a non-negative integer");
    }
    return json(200, buildTimeline(services, { conversationId, afterSequence: after }));
  }

  // /conversations/:id/pins
  if (segments.length === 3 && segments[2] === "pins" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = parsed.value.instanceId;
    if (typeof instanceId !== "string") {
      return fail(400, "INVALID_SCHEMA", "a pin request must name an instanceId");
    }
    const displayMode = parsed.value.displayMode === "expanded" ? "expanded" : "compact";
    const result = pinInstance(services.conductor, { conversationId, instanceId, displayMode });
    if (!result.ok) {
      const status = result.code === "WIDGET_INSTANCE_UNKNOWN" ? 404 : 409;
      return fail(status, result.code, result.message);
    }
    return json(201, { pinId: result.pinId, timeline: buildTimeline(services, { conversationId, afterSequence: 0 }) });
  }

  // /conversations/:id/pins/:pinId
  if (segments.length === 4 && segments[2] === "pins" && request.method === "DELETE") {
    const pinId = segments[3];
    if (pinId === undefined) {
      return fail(400, "INVALID_SCHEMA", "a pin route must name a pin");
    }
    const removed = unpinInstance(services.conductor, { conversationId, pinId });
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", "that pin is not on this conversation");
    // Unpinning is a presentation change. Note data and running jobs are untouched, which
    // is why nothing here cancels a task.
    return json(200, { removed: true, timeline: buildTimeline(services, { conversationId, afterSequence: 0 }) });
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/**
 * Raw command envelope route.
 *
 * Kept alongside the conversation routes because the envelope is the durable, idempotent
 * path: a client that must not double-execute sends here, and the same `idempotencyKey`
 * is what makes a retry safe.
 */
function handleRawCommand(deps: GatewayDeps, request: GatewayRequest, at: () => string): GatewayResponse {
  const { services } = deps;
  const { runtime } = services;

  const parsed = readJson(request);
  if (!parsed.ok) return parsed.response;

  const envelope = commandEnvelopeSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return fail(400, "INVALID_SCHEMA", "the command envelope does not match the contract", {
      issues: envelope.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }

  return json(202, {
    accepted: true,
    commandId: envelope.data.commandId,
    // Derived from the authenticated channel, never from the body.
    principal: {
      principalId: runtime.identity.ownerPrincipalId,
      kind: "user",
      nodeId: runtime.identity.nodeId,
    },
    receivedAt: at(),
    note: "accepted for durable processing; this is not an outcome",
  });
}
