import { createHmac } from "node:crypto";

import { signalInputSchema } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import {
  type SourceDelivery,
  createWebhookAdapter,
  isWebhookSourceId,
  webhookConsumer,
  webhookSecretName,
  webhookSourceOfTopic,
} from "../src/index.ts";

/**
 * A signed POST from anything, as a signal the core matches the same way it matches GitHub's.
 */

const SECRET = "fixture shared secret";
const NOW = "2026-09-29T10:00:00.000Z";
const context = { selfLogins: [] as string[], now: () => NOW };
const adapter = createWebhookAdapter("deploys");

function sign(body: Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function delivery(body: unknown, headers: Record<string, string> = {}): SourceDelivery {
  const rawBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return { headers: { "content-type": "application/json", "x-signature-256": sign(rawBody), ...headers }, rawBody };
}

describe("a signed webhook's signature", () => {
  const body = { id: "build-812", topic: "build.failed" };

  it("is accepted when made with the shared secret, whatever case the header arrives in", () => {
    expect(adapter.verify(delivery(body), SECRET)).toEqual({ ok: true });
    const raw = Buffer.from(JSON.stringify(body));
    expect(adapter.verify({ headers: { "X-Signature-256": sign(raw) }, rawBody: raw }, SECRET)).toEqual({ ok: true });
  });

  it("is refused when missing, malformed, made with another secret, or over different bytes", () => {
    const raw = Buffer.from(JSON.stringify(body));
    expect(adapter.verify({ headers: {}, rawBody: raw }, SECRET)).toEqual({ ok: false, reason: "the delivery carries no X-Signature-256" });
    expect(adapter.verify(delivery(body, { "x-signature-256": "sha256=zz" }), SECRET)).toMatchObject({ ok: false });
    expect(adapter.verify(delivery(body, { "x-signature-256": sign(raw, "a guess") }), SECRET)).toMatchObject({
      ok: false,
      reason: "the signature does not match",
    });
    const tampered = Buffer.from(JSON.stringify({ ...body, topic: "build.passed" }));
    expect(adapter.verify({ headers: { "x-signature-256": sign(raw) }, rawBody: tampered }, SECRET)).toMatchObject({ ok: false });
    expect(adapter.verify(delivery(body), "")).toEqual({ ok: false, reason: "no webhook secret is set" });
  });
});

describe("a signed webhook's body, as a signal", () => {
  it("becomes one signal under the source's own topic, keyed by the sender's event id", () => {
    const result = adapter.normalize(
      delivery({
        id: "build-812",
        topic: "build.failed",
        payload: { branch: "main" },
        subject: { type: "build", id: "812" },
        occurredAt: "2026-09-29T09:58:00+07:00",
      }),
      context,
    );
    expect(result).toEqual({
      kind: "signal",
      signal: {
        source: { kind: "external", provider: "webhook", sourceId: "deploys" },
        topic: "webhook.deploys.build.failed",
        subject: { type: "build", id: "812" },
        payload: { branch: "main" },
        occurredAt: "2026-09-29T02:58:00.000Z",
        dedupeKey: "event:build-812",
        provenance: { via: "signed webhook" },
      },
    });
    if (result.kind === "signal") expect(signalInputSchema.safeParse(result.signal).success).toBe(true);
  });

  it("cannot pass itself off as another source: the sender writes only the part after its own name", () => {
    const result = adapter.normalize(delivery({ id: "x", topic: "github.issue.labeled" }), context);
    expect(result).toMatchObject({ kind: "signal", signal: { topic: "webhook.deploys.github.issue.labeled" } });
  });

  it("takes the node's clock and an empty payload when the sender leaves them out", () => {
    expect(adapter.normalize(delivery({ id: "ping-1", topic: "ping" }), context)).toMatchObject({
      kind: "signal",
      signal: { topic: "webhook.deploys.ping", payload: {}, occurredAt: NOW },
    });
  });

  it("says why a body is not one it can read", () => {
    const reasons = [
      delivery("not json"),
      delivery([1, 2]),
      delivery({ topic: "build.failed" }),
      delivery({ id: "x".repeat(201), topic: "build.failed" }),
      delivery({ id: "1", topic: "Build Failed" }),
      delivery({ id: "1", topic: "build.failed", payload: [1] }),
      delivery({ id: "1", topic: "build.failed", occurredAt: "yesterday" }),
      delivery({ id: "1", topic: "build.failed", subject: { unexpected: true } }),
      delivery({ id: "1", topic: `a.${"b".repeat(118)}` }),
    ].map((one) => adapter.normalize(one, context));
    for (const result of reasons) expect(result.kind).toBe("invalid");
  });
});

describe("a webhook source's name", () => {
  it("is lower-case words a URL can carry, and names its secret, its consumer and the topics it answers", () => {
    expect(isWebhookSourceId("home-sensor_2")).toBe(true);
    for (const bad of ["", "Deploys", "-x", "a/b", "a.b", "x".repeat(64)]) expect(isWebhookSourceId(bad)).toBe(false);
    expect(() => createWebhookAdapter("Not ok")).toThrow();
    expect(webhookSecretName("deploys")).toBe("webhook_deploys_secret");
    expect(webhookConsumer("deploys")).toBe("signals:webhook:deploys");
    expect(webhookSourceOfTopic("webhook.deploys.build.failed")).toBe("deploys");
    expect(webhookSourceOfTopic("github.issue.labeled")).toBeUndefined();
    expect(webhookSourceOfTopic("webhook")).toBeUndefined();
  });
});
