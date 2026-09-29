import { type Instant, effectReconcileRequestSchema } from "@clarkcant/contracts";

import { reconcileEffectForNode } from "../effect-reconciliation.ts";
import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The effects family.
 *
 *   POST /effects/:effectId/reconcile { outcome: "confirmed" | "failed", source? }
 *       record what the person saw of an effect whose outcome was unknown: 404 for an effect this caller cannot answer
 *       for, 409 once it is no longer unknown.
 *
 * Person-only (`isPersonOnlyRoute`): MCP has no tool for it, and the WebSocket relay and `clarkcant api` refuse it, so
 * an AI client cannot clear its own task's uncertainty. The principal is the authenticated owner, never a body field.
 */
export interface EffectRouteDeps {
  services: NodeServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

export function handleEffectRoutes(deps: EffectRouteDeps): GatewayResponse | undefined {
  const { services, request, segments } = deps;
  if (segments[0] !== "effects") return undefined;
  if (segments.length === 3 && segments[2] === "reconcile") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "an effect's outcome is recorded with POST");
    const body = readJson(request);
    if (!body.ok) return body.response;
    const parsed = effectReconcileRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(400, "INVALID_SCHEMA", 'outcome must be "confirmed" or "failed"');
    const result = reconcileEffectForNode(services, {
      effectId: segments[1] ?? "",
      outcome: parsed.data.outcome,
      source: parsed.data.source ?? "click",
      // SAFETY: the gateway's clock is `nowInstant` or a test's injected instant.
      at: deps.at() as Instant,
    });
    return result.ok ? json(200, result.response) : fail(result.status, result.code, result.message);
  }
  return fail(404, "NOT_FOUND", `no effects handler for ${request.method} ${request.path}`);
}
