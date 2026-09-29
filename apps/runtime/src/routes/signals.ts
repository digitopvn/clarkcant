import { type Instant, signalInputSchema } from "@clarkcant/contracts";
import { ingestSignal, listAutomations } from "@clarkcant/core";

import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * Signals in, and the standing requests they answer.
 *
 *   POST /signals        one signal: { source, topic, subject?, payload, occurredAt, dedupeKey, provenance? }
 *   GET  /automations    the owner's automations, each with what it did lately
 *
 * A signal is recorded and answered `202` before anything is matched: the source is told it was heard, and the node
 * does the work durably afterwards. The same `(source.sourceId, dedupeKey)` sent again is `200` with the signal that was
 * already recorded, never a second one — every source delivers at least once, and that is not an error.
 *
 * Behind the gateway's bearer check like every route after it. Timer and system signals are the node's own and are
 * refused here, so nothing outside the node can fire an automation's timer or claim to be the node.
 */
export interface SignalRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "automation">;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

export function handleSignalRoutes(deps: SignalRouteDeps): GatewayResponse | undefined {
  const { services, request, segments } = deps;
  if (segments[0] !== "signals" && segments[0] !== "automations") return undefined;
  if (segments.length !== 1) return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);

  if (segments[0] === "automations") {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "automations are read with GET and changed in the conversation");
    const principalId = services.runtime.identity.ownerPrincipalId;
    return json(200, { automations: listAutomations({ db: services.runtime.db }, principalId) });
  }

  if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a signal is sent with POST");
  const body = readJson(request);
  if (!body.ok) return body.response;
  const parsed = signalInputSchema.safeParse(body.value);
  if (!parsed.success) {
    return fail(
      400,
      "INVALID_SCHEMA",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  if (parsed.data.source.kind === "timer" || parsed.data.source.kind === "system") {
    return fail(403, "SOURCE_RESERVED", `${parsed.data.source.kind} signals come from this node itself and cannot be sent to it`);
  }
  const recorded = ingestSignal(
    {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      // SAFETY: the gateway's clock is `nowInstant` or a test's injected instant, typed as a string for every family.
      now: () => deps.at() as Instant,
      newId: services.conductor.newId,
    },
    parsed.data,
  );
  if (!recorded.ok) return fail(recorded.code === "SIGNAL_TOO_LARGE" ? 413 : 400, recorded.code, recorded.message);
  services.automation?.kick();
  return json(recorded.created ? 202 : 200, { signalId: recorded.signalId, duplicate: !recorded.created });
}
