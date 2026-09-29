import { type SignalInput, signalInputSchema, signalTopicSchema } from "@clarkcant/contracts";

import { type SignalSourceAdapter, headerValue, verifySha256Signature } from "./adapter.ts";

/**
 * Any system that can sign a POST, as a signal source.
 *
 * The person names the source (`deploys`, `home-sensor`) and shares a secret with whatever sends to it. A delivery is
 * JSON the sender writes in one small shape and signs the way GitHub does — HMAC-SHA256 over the exact bytes, as
 * `X-Signature-256: sha256=<hex>` — so `openssl` or three lines in any language can produce it:
 *
 *   { "id": "build-812", "topic": "build.failed", "payload": { "branch": "main" },
 *     "subject": { "type": "build", "id": "812" }, "occurredAt": "2026-09-29T10:00:00Z" }
 *
 * `id` is the sender's own name for the event, and a resend carries the same one, so it is recorded once. The topic
 * the core sees is always `webhook.<source>.<topic>`: whatever a sender writes, it cannot make its event look like a
 * GitHub delivery, a timer or another source, because the part of the topic that says where it came from is not its to
 * write. Nothing in this file knows what the events mean — that is the point of it.
 */

export const WEBHOOK_PROVIDER = "webhook";
export const WEBHOOK_SIGNATURE_HEADER = "X-Signature-256";
export const WEBHOOK_TOPIC_PREFIX = "webhook";

const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A source name a person can say and a URL can carry: lower-case letters, digits, `-` and `_`. */
export function isWebhookSourceId(value: string): boolean {
  return SOURCE_ID.test(value);
}

/** The name the node keeps a source's shared secret under. */
export function webhookSecretName(sourceId: string): string {
  return `webhook_${sourceId}_secret`;
}

/** Who uses that secret, as the secret's metadata records consumers. */
export function webhookConsumer(sourceId: string): string {
  return `signals:webhook:${sourceId}`;
}

/** The source a `webhook.<source>.…` topic answers, or nothing for any other topic. */
export function webhookSourceOfTopic(topic: string): string | undefined {
  const [prefix, sourceId] = topic.split(".");
  return prefix === WEBHOOK_TOPIC_PREFIX && sourceId !== undefined && isWebhookSourceId(sourceId) ? sourceId : undefined;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** The adapter for one named source. Stateless: the secret is handed in per delivery. */
export function createWebhookAdapter(sourceId: string): SignalSourceAdapter {
  if (!isWebhookSourceId(sourceId)) throw new Error(`"${sourceId}" is not a webhook source name`);
  return {
    provider: WEBHOOK_PROVIDER,
    verify(delivery, secret) {
      return verifySha256Signature(delivery.rawBody, headerValue(delivery.headers, WEBHOOK_SIGNATURE_HEADER), secret, WEBHOOK_SIGNATURE_HEADER);
    },
    normalize(delivery, context) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(delivery.rawBody).toString("utf8"));
      } catch {
        return { kind: "invalid", reason: "the body is not JSON" };
      }
      const body = record(parsed);
      if (body === undefined) return { kind: "invalid", reason: "the body is a JSON object with id and topic" };

      const id = typeof body["id"] === "string" ? body["id"].trim() : "";
      if (id === "" || id.length > 200) return { kind: "invalid", reason: "id is the sender's name for this event, 1 to 200 characters" };
      const ownTopic = typeof body["topic"] === "string" ? body["topic"].trim() : "";
      if (!signalTopicSchema.safeParse(ownTopic).success) {
        return { kind: "invalid", reason: "topic is dotted lower-case words, such as build.failed" };
      }
      const payload = body["payload"] === undefined ? {} : record(body["payload"]);
      if (payload === undefined) return { kind: "invalid", reason: "payload, when sent, is a JSON object" };
      const occurredAt = body["occurredAt"] === undefined ? context.now() : body["occurredAt"];
      if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
        return { kind: "invalid", reason: "occurredAt, when sent, is an ISO time" };
      }

      const candidate: SignalInput = {
        source: { kind: "external", provider: WEBHOOK_PROVIDER, sourceId },
        topic: `${WEBHOOK_TOPIC_PREFIX}.${sourceId}.${ownTopic}`,
        ...(body["subject"] === undefined ? {} : { subject: body["subject"] as SignalInput["subject"] }),
        payload,
        occurredAt: new Date(occurredAt).toISOString() as SignalInput["occurredAt"],
        dedupeKey: `event:${id}`,
        provenance: { via: "signed webhook" },
      };
      const checked = signalInputSchema.safeParse(candidate);
      if (!checked.success) {
        return {
          kind: "invalid",
          reason: checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        };
      }
      return { kind: "signal", signal: candidate };
    },
  };
}
