import type { Instant } from "@clarkcant/contracts";
import { ingestSignal, readRegisteredPreference } from "@clarkcant/core";
import {
  GITHUB_WEBHOOK_CONSUMER,
  GITHUB_WEBHOOK_SECRET_NAME,
  type SourceDelivery,
  githubWebhookAdapter,
} from "@clarkcant/signal-sources";
import type { Database } from "@clarkcant/storage";

import { createSecretBroker } from "../secret-broker.ts";
import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

/**
 * GitHub's webhook, as a signal source.
 *
 *   POST /signals/github    a delivery exactly as GitHub sends it
 *
 * Answered before the node's token check, because GitHub cannot hold that token and must not: what it presents instead
 * is the delivery's signature, made with the webhook secret this node and the repository share. The signature is
 * checked before anything in the body is read, and a delivery that fails it is refused with nothing recorded.
 *
 * A verified delivery is recorded and answered `202` before anything is matched — GitHub gives up on a slow hook — and
 * a redelivery of the same `X-GitHub-Delivery` is `200` with the signal already recorded. The body is capped by the
 * transport (see `GITHUB_WEBHOOK_BODY_LIMIT`), since anyone who can reach the node can send to this path.
 */

export const GITHUB_SIGNAL_PATH = "/signals/github";
export const GITHUB_SELF_LOGINS_PREFERENCE = "signals.github.selfLogins";

export interface GithubSignalRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "automation">;
  request: GatewayRequest;
  at: () => string;
}

/** The GitHub accounts that are this node itself, as the person set them. */
export function githubSelfLogins(db: Database, principalId: string, now: () => Instant): string[] {
  const stored = readRegisteredPreference({ db, now }, { principalId, key: GITHUB_SELF_LOGINS_PREFERENCE })?.value;
  return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
}

export function handleGithubSignalRoute(deps: GithubSignalRouteDeps): GatewayResponse | undefined {
  const { services, request } = deps;
  if (request.path !== GITHUB_SIGNAL_PATH) return undefined;
  if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "GitHub delivers with POST");

  const { runtime } = services;
  // SAFETY: the gateway's clock is `nowInstant` or a test's injected instant, typed as a string for every family.
  const now = (): Instant => deps.at() as Instant;
  const principalId = runtime.identity.ownerPrincipalId;
  const delivery: SourceDelivery = { headers: request.headers, rawBody: request.rawBody ?? Buffer.from(request.body, "utf8") };

  // The secret goes from the store into the comparison and nowhere else.
  const checked = createSecretBroker({ db: runtime.db, principalId, now }).withSecret(
    { name: GITHUB_WEBHOOK_SECRET_NAME, consumer: GITHUB_WEBHOOK_CONSUMER },
    (secret) => githubWebhookAdapter.verify(delivery, secret),
  );
  if (!checked.ok) {
    return fail(
      503,
      "GITHUB_WEBHOOK_NOT_CONFIGURED",
      checked.code === "SECRET_NOT_FOUND"
        ? "this node has no GitHub webhook secret yet; set up a GitHub automation in the conversation and Clark asks for it"
        : `this node cannot use its GitHub webhook secret to check deliveries (${checked.code})`,
    );
  }
  if (!checked.result.ok) return fail(401, "SIGNATURE_INVALID", checked.result.reason);

  const normalized = githubWebhookAdapter.normalize(delivery, {
    selfLogins: githubSelfLogins(runtime.db, principalId, now),
    now: () => deps.at(),
  });
  switch (normalized.kind) {
    case "ping":
      return json(200, { pong: true });
    case "ignored":
      // Answered as received, so GitHub does not retry it; nothing is recorded, because nothing can match it.
      return json(200, { ignored: normalized.reason });
    case "invalid":
      return fail(400, "DELIVERY_INVALID", normalized.reason);
    case "signal":
      break;
  }

  const recorded = ingestSignal(
    { db: runtime.db, nodeId: runtime.identity.nodeId, now, newId: services.conductor.newId },
    normalized.signal,
  );
  if (!recorded.ok) return fail(recorded.code === "SIGNAL_TOO_LARGE" ? 413 : 400, recorded.code, recorded.message);
  services.automation?.kick();
  return json(recorded.created ? 202 : 200, { signalId: recorded.signalId, duplicate: !recorded.created });
}
