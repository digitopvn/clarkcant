import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageRecord } from "@clarkcant/contracts";
import { allRows, parseJson } from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService, type AutomationService } from "../src/automation-service.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { SIGNED_WEBHOOK_BODY_LIMIT, bodyLimitForPath, createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Anything that can sign a POST, delivering to a running node.
 *
 * The second source beside GitHub and the timer, through the same core: a person names the source in the conversation,
 * the secret goes in through the card, and a signed delivery reaches the automation the way a GitHub label does. The
 * node is real — storage, gateway, Secret Broker, automation service; nothing here knows what the events mean.
 */

const SECRET = "shared with the deploy system";

let dir: string;
let services: NodeServices;
let now: string;
let deps: GatewayDeps;
let service: AutomationService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-webhook-signals-"));
  now = "2026-09-29T08:00:00.000Z";
  services = bootNodeServices({ dataDir: dir, label: "webhook node" });
  deps = { services, now: () => now };
  service = startAutomationService(services, { intervalMs: 3_600_000, now: () => now as Instant });
  services.automation = service;
});

afterEach(() => {
  service.stop();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sign(body: Uint8Array | string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** A delivery the way a sender makes one: no bearer token, a body it wrote, and its signature over those bytes. */
async function deliver(sourceId: string, body: unknown, options: { signature?: string | null } = {}): Promise<GatewayResponse> {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const signature = options.signature === undefined ? sign(raw) : options.signature;
  return handleRequest(deps, {
    method: "POST",
    path: `/signals/webhook/${sourceId}`,
    query: {},
    headers: { "content-type": "application/json", ...(signature === null ? {} : { "x-signature-256": signature }) },
    body: raw.toString("utf8"),
    rawBody: raw,
  });
}

async function authed(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function storeSecret(sourceId = "deploys", value = SECRET): Promise<void> {
  const stored = await authed("POST", "/credentials", {
    fields: [{ name: `webhook_${sourceId}_secret`, value, kind: "webhook-secret", consumer: `signals:webhook:${sourceId}` }],
  });
  expect(stored.status).toBe(201);
}

function signalCount(): number {
  return allRows<{ count: number }>(services.runtime.db, "SELECT COUNT(*) AS count FROM signal_deliveries")[0]?.count ?? -1;
}

async function conversation(): Promise<string> {
  const response = await authed("POST", "/conversations", { title: "Deploys" });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

function createTool(conversationId: string) {
  const tool = createAutomationTools({
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId,
    now: () => now as Instant,
    newId: services.conductor.newId,
    ownedRoots: () => [dir],
    kick: () => undefined,
  }).find((candidate) => candidate.name === "create_automation");
  if (tool === undefined) throw new Error("no create_automation");
  return (params: Record<string, unknown>) => tool.execute(params as never) as Promise<{ text: string }>;
}

function assistantTexts(conversationId: string): string[] {
  return allRows<{ document: string }>(
    services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence",
    conversationId,
  ).flatMap((row) => {
    const message = parseJson<MessageRecord>(row.document, "messages.document");
    if (message.role !== "assistant") return [];
    return message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : []));
  });
}

describe("a signed webhook is checked before anything in it is read", () => {
  it("refuses a missing, wrong or stale signature with 401, and records nothing", async () => {
    await storeSecret();
    const body = { id: "build-812", topic: "build.failed" };
    const missing = await deliver("deploys", body, { signature: null });
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ code: "SIGNATURE_INVALID" });
    expect((await deliver("deploys", body, { signature: sign(JSON.stringify(body), "a guess") })).status).toBe(401);
    // Signed, then changed on the way.
    expect((await deliver("deploys", { ...body, topic: "build.passed" }, { signature: sign(JSON.stringify(body)) })).status).toBe(401);
    expect(signalCount()).toBe(0);
  });

  it("does not find a source nobody set up, and does not let one source's secret sign for another", async () => {
    const unknown = await deliver("deploys", { id: "1", topic: "build.failed" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "WEBHOOK_SOURCE_UNKNOWN" });

    await storeSecret("home-sensor", "the sensor's own secret");
    // Signed with the sensor's secret, sent as deploys: deploys still has none.
    expect((await deliver("deploys", { id: "1", topic: "build.failed" }, { signature: sign(JSON.stringify({ id: "1", topic: "build.failed" }), "the sensor's own secret") })).status).toBe(404);
    await storeSecret();
    expect((await deliver("deploys", { id: "1", topic: "build.failed" }, { signature: sign(JSON.stringify({ id: "1", topic: "build.failed" }), "the sensor's own secret") })).status).toBe(401);
    expect(signalCount()).toBe(0);
  });

  it("records a signed delivery once however often it is resent, without the node's token", async () => {
    await storeSecret();
    const body = { id: "build-812", topic: "build.failed", payload: { branch: "main" } };
    const first = await deliver("deploys", body);
    expect(first.status).toBe(202);
    const again = await deliver("deploys", body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, signalId: (first.body as { signalId: string }).signalId });
    expect(signalCount()).toBe(1);
    const [stored] = allRows<{ document: string }>(services.runtime.db, "SELECT document FROM signal_deliveries");
    expect(JSON.parse(stored?.document ?? "{}")).toMatchObject({
      topic: "webhook.deploys.build.failed",
      source: { kind: "external", provider: "webhook", sourceId: "deploys" },
    });
  });

  it("says why a signed body is not one it can read, and is only a POST to a source name", async () => {
    await storeSecret();
    const invalid = await deliver("deploys", { topic: "build.failed" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "DELIVERY_INVALID" });
    expect((await handleRequest(deps, { method: "GET", path: "/signals/webhook/deploys", query: {}, headers: {}, body: "" })).status).toBe(405);
    expect((await handleRequest(deps, { method: "POST", path: "/signals/webhook/Not%20A%20Name", query: {}, headers: {}, body: "" })).status).toBe(404);
    expect(signalCount()).toBe(0);
  });
});

describe("what a signed webhook starts", () => {
  it("is set up in the conversation, asks for its secret through the card, and answers the source's events", async () => {
    const conversationId = await conversation();
    const create = createTool(conversationId);
    const created = await create({
      summary: "Báo khi build trên main hỏng",
      topic: "webhook.deploys.build.failed",
      match: [{ path: "payload.branch", op: "equals", value: "main" }],
      action: "remind",
      message: "build trên main vừa hỏng",
    });
    expect(created.text).toContain("Set up.");
    expect(created.text).toContain("POST /signals/webhook/deploys");
    expect(created.text).toContain('request_secret with name "webhook_deploys_secret", secretKind "webhook-secret", consumer "signals:webhook:deploys"');
    await storeSecret();

    expect((await deliver("deploys", { id: "b-1", topic: "build.failed", payload: { branch: "feature" } })).status).toBe(202);
    expect((await deliver("deploys", { id: "b-2", topic: "build.failed", payload: { branch: "main" } })).status).toBe(202);
    service.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toEqual([
      "Nhắc bạn — Báo khi build trên main hỏng: build trên main vừa hỏng",
    ]);

    // Once the secret is set, setting up another automation on the same source does not ask for it again.
    expect((await create({ summary: "Báo khi deploy xong", topic: "webhook.deploys.deploy.done", action: "remind", message: "xong" })).text).not.toContain(
      "request_secret",
    );
  });

  it("cannot start an automation that answers another source, whatever topic the sender writes", async () => {
    await storeSecret();
    const conversationId = await conversation();
    await createTool(conversationId)({ summary: "Nhắc khi có nhãn bug", topic: "github.issue.labeled", action: "remind", message: "xem issue" });
    expect((await deliver("deploys", { id: "x", topic: "github.issue.labeled", payload: { label: "bug" } })).status).toBe(202);
    service.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toEqual([]);
  });
});

describe("a signed webhook's body, over the wire", () => {
  it("is bounded before it is read, since anyone who can reach the node can send to it", async () => {
    expect(bodyLimitForPath("/signals/webhook/deploys")).toBe(SIGNED_WEBHOOK_BODY_LIMIT);
    await storeSecret();
    const server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const body = JSON.stringify({ id: "wire-1", topic: "build.failed" });
      const accepted = await fetch(`${base}/signals/webhook/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-256": sign(body) },
        body,
      });
      expect(accepted.status).toBe(202);
      const oversized = JSON.stringify({ id: "wire-2", topic: "build.failed", payload: { blob: "x".repeat(SIGNED_WEBHOOK_BODY_LIMIT) } });
      const refused = await fetch(`${base}/signals/webhook/deploys`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature-256": sign(oversized) },
        body: oversized,
      });
      expect(refused.status).toBe(413);
      expect(signalCount()).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
