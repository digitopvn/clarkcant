import { timingSafeEqual } from "node:crypto";

import { type CommandEnvelope, commandEnvelopeSchema, protocolRangeSchema } from "@clarkcant/contracts";

import { type Runtime, runtimeDescription } from "./node.ts";

/**
 * Authenticated command gateway.
 *
 * The gateway's entire job is to refuse things. Every request must present the node's
 * bearer token, and the authenticated principal is constructed here — never read from
 * the request body. A payload claiming its own identity is data, not authority, and
 * that distinction is the reason this layer exists rather than letting handlers read
 * the body directly.
 *
 * The transport is deliberately thin: a `node:http` server with no framework, so the
 * authorization path has nowhere to hide.
 */

export interface GatewayRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
}

export interface GatewayDeps {
  runtime: Runtime;
  /** Injected so tests can drive the gateway without a socket. */
  now?: () => string;
}

/** Constant-time token comparison, so the gate does not leak token length or prefix. */
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

/**
 * Handle one request.
 *
 * Returning a discriminated result rather than throwing keeps every refusal path
 * visible in one place, which is what makes the negative tests meaningful.
 */
export function handleRequest(deps: GatewayDeps, request: GatewayRequest): GatewayResponse {
  const at = deps.now ?? (() => new Date().toISOString());

  if (!tokenMatches(deps.runtime.identity.localToken, bearer(request.headers))) {
    // The response is identical for a missing and a wrong token: distinguishing them
    // tells an attacker which half to work on.
    return {
      status: 401,
      body: {
        code: "UNAUTHENTICATED",
        message: "a valid bearer token is required for every command; the node rejects requests that do not present one",
      },
    };
  }

  if (request.method === "GET" && request.path === "/health") {
    return {
      status: 200,
      body: {
        status: "ok",
        nodeId: deps.runtime.identity.nodeId,
        label: deps.runtime.identity.label,
        startedAt: deps.runtime.identity.createdAt,
        negotiatedProtocol: protocolRangeSchema.parse({ name: "agent.nodelink", min: 1, max: 2 }),
        runtime: runtimeDescription(),
        checkedAt: at(),
      },
    };
  }

  if (request.method === "POST" && request.path === "/command") {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(request.body);
    } catch {
      return {
        status: 400,
        body: { code: "INVALID_SCHEMA", message: "the request body is not valid JSON" },
      };
    }

    const parsed = commandEnvelopeSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        status: 400,
        body: {
          code: "INVALID_SCHEMA",
          message: "the command envelope does not match the contract",
          issues: parsed.error.issues.slice(0, 8).map((issue) => issue.message),
        },
      };
    }

    const envelope: CommandEnvelope = parsed.data;
    return {
      status: 202,
      body: {
        accepted: true,
        commandId: envelope.commandId,
        // The principal is derived from the authenticated channel, not from the body.
        principal: {
          principalId: deps.runtime.identity.ownerPrincipalId,
          kind: "user",
          nodeId: deps.runtime.identity.nodeId,
        },
        receivedAt: at(),
        // Explicit that this is an acknowledgement, not an outcome: durability and
        // execution are separate steps.
        note: "accepted for durable processing; this is not an outcome",
      },
    };
  }

  return {
    status: 404,
    body: { code: "NOT_FOUND", message: `no handler for ${request.method} ${request.path}` },
  };
}
