import type { Instant } from "@clarkcant/contracts";
import { ingestSignal } from "@clarkcant/core";
import {
  type SourceDelivery,
  createWebhookAdapter,
  isWebhookSourceId,
  webhookConsumer,
  webhookSecretName,
} from "@clarkcant/signal-sources";

import { createSecretBroker } from "../secret-broker.ts";
import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

/**
 * A signed webhook from anything, as a signal source.
 *
 *   POST /signals/webhook/<source>    { id, topic, payload?, subject?, occurredAt? }, signed with X-Signature-256
 *
 * The second source beside GitHub, and deliberately not shaped like it: a person names the source and shares a secret
 * with whatever sends to it, and the core sees `webhook.<source>.<topic>` signals it matches like any other. Answered
 * before the node's token check for the same reason GitHub's is — the sender holds the shared secret, never this node's
 * token — so the signature is checked before a byte of the body is read, and a delivery that fails it records nothing.
 *
 * A source with no secret set is not found: a sender cannot tell a name nobody set up from one it guessed wrong, and
 * nothing is recorded for either.
 */

export const WEBHOOK_SIGNAL_PATH_PREFIX = "/signals/webhook/";

export interface WebhookSignalRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "automation">;
  request: GatewayRequest;
  at: () => string;
}

export function handleWebhookSignalRoute(deps: WebhookSignalRouteDeps): GatewayResponse | undefined {
  const { services, request } = deps;
  if (!request.path.startsWith(WEBHOOK_SIGNAL_PATH_PREFIX)) return undefined;
  const sourceId = request.path.slice(WEBHOOK_SIGNAL_PATH_PREFIX.length);
  if (!isWebhookSourceId(sourceId)) return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
  if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a webhook delivers with POST");

  const { runtime } = services;
  // SAFETY: the gateway's clock is `nowInstant` or a test's injected instant, typed as a string for every family.
  const now = (): Instant => deps.at() as Instant;
  const adapter = createWebhookAdapter(sourceId);
  const delivery: SourceDelivery = { headers: request.headers, rawBody: request.rawBody ?? Buffer.from(request.body, "utf8") };

  // The secret goes from the store into the comparison and nowhere else.
  const checked = createSecretBroker({ db: runtime.db, principalId: runtime.identity.ownerPrincipalId, now }).withSecret(
    { name: webhookSecretName(sourceId), consumer: webhookConsumer(sourceId) },
    (secret) => adapter.verify(delivery, secret),
  );
  if (!checked.ok) {
    return checked.code === "SECRET_NOT_FOUND"
      ? fail(404, "WEBHOOK_SOURCE_UNKNOWN", "no signed webhook is set up under this name")
      : fail(503, "WEBHOOK_NOT_USABLE", `this node cannot use the secret for this webhook to check deliveries (${checked.code})`);
  }
  if (!checked.result.ok) return fail(401, "SIGNATURE_INVALID", checked.result.reason);

  const normalized = adapter.normalize(delivery, { selfLogins: [], now: () => deps.at() });
  if (normalized.kind !== "signal") {
    return normalized.kind === "invalid" ? fail(400, "DELIVERY_INVALID", normalized.reason) : json(200, { ignored: true });
  }
  const recorded = ingestSignal(
    { db: runtime.db, nodeId: runtime.identity.nodeId, now, newId: services.conductor.newId },
    normalized.signal,
  );
  if (!recorded.ok) return fail(recorded.code === "SIGNAL_TOO_LARGE" ? 413 : 400, recorded.code, recorded.message);
  services.automation?.kick();
  return json(recorded.created ? 202 : 200, { signalId: recorded.signalId, duplicate: !recorded.created });
}
