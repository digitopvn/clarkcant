import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityDescriptor, type Instant, type MessageRecord } from "@clarkcant/contracts";
import { registerCapability } from "@clarkcant/core";
import { allRows, getTask, parseJson } from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService, type AutomationService } from "../src/automation-service.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { GITHUB_WEBHOOK_BODY_LIMIT, bodyLimitForPath, createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * GitHub delivering to a running node.
 *
 * The node is real — its storage, its gateway, its automation service, `git` for the repository check — and the
 * deliveries are GitHub's own recorded payloads, signed the way GitHub signs them. Only the worker is replaced by a
 * record of what would have been dispatched.
 */

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "packages", "signal-sources", "test", "fixtures", "github");
const SECRET = "shared with the repository webhook";

let dir: string;
let services: NodeServices;
let now: string;
let deps: GatewayDeps;
let service: AutomationService;
let dispatched: { taskId: string }[];
let deliveries = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-github-signals-"));
  now = "2026-09-29T08:00:00.000Z";
  services = bootNodeServices({ dataDir: dir, label: "github node" });
  deps = { services, now: () => now };
  dispatched = [];
  services.conductor.runTask = (input) => {
    dispatched.push(input);
  };
  service = startAutomationService(services, { intervalMs: 3_600_000, now: () => now as Instant });
  services.automation = service;
});

afterEach(() => {
  service.stop();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, `${name}.json`));
}

/** A fixture sent by someone else: the same event, another sender. */
function sentBy(name: string, login: string): Buffer {
  const payload = JSON.parse(fixture(name).toString("utf8")) as { sender: { login: string } };
  payload.sender.login = login;
  return Buffer.from(JSON.stringify(payload));
}

function sign(body: Uint8Array | string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** A delivery exactly as GitHub makes it: no bearer token, a signature, an event and a delivery id. */
async function deliver(
  event: string,
  body: Buffer,
  options: { signature?: string | null; deliveryId?: string } = {},
): Promise<GatewayResponse> {
  deliveries += 1;
  const signature = options.signature === undefined ? sign(body) : options.signature;
  return handleRequest(deps, {
    method: "POST",
    path: "/signals/github",
    query: {},
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.deliveryId ?? `delivery-${String(deliveries)}`,
      ...(signature === null ? {} : { "x-hub-signature-256": signature }),
    },
    body: body.toString("utf8"),
    rawBody: body,
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

async function storeSecret(): Promise<void> {
  const stored = await authed("POST", "/credentials", {
    fields: [{ name: "github_webhook_secret", value: SECRET, kind: "webhook-secret", consumer: "signals:github" }],
  });
  expect(stored.status).toBe(201);
}

function signalCount(): number {
  return allRows<{ count: number }>(services.runtime.db, "SELECT COUNT(*) AS count FROM signal_deliveries")[0]?.count ?? -1;
}

async function conversation(): Promise<string> {
  const response = await authed("POST", "/conversations", { title: "GitHub" });
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

function clone(name: string, origin: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path], { windowsHide: true });
  execFileSync("git", ["-C", path, "remote", "add", "origin", origin], { windowsHide: true });
  return path;
}

function codeChange(): CapabilityDescriptor {
  return {
    ref: "project.code.change@1" as CapabilityDescriptor["ref"],
    executionNodeId: services.runtime.identity.nodeId as CapabilityDescriptor["executionNodeId"],
    summary: "Apply a bounded code change",
    resourceKinds: ["workspace"],
    effectCategory: "local-write",
    supportsCancellation: true,
    requiresConnection: false,
    readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
    uiAffordances: [],
  };
}

describe("a delivery is checked before anything in it is read", () => {
  it("refuses a missing or wrong signature, and records nothing", async () => {
    await storeSecret();
    const body = fixture("issues.labeled");
    const missing = await deliver("issues", body, { signature: null });
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ code: "SIGNATURE_INVALID" });
    expect((await deliver("issues", body, { signature: sign(body, "a guess") })).status).toBe(401);
    // Signed, then changed on the way.
    const tampered = Buffer.from(body.toString("utf8").replace('"bug"', '"ai-handle"'));
    expect((await deliver("issues", tampered, { signature: sign(body) })).status).toBe(401);
    expect(signalCount()).toBe(0);
  });

  it("accepts nothing while the node has no webhook secret", async () => {
    const response = await deliver("issues", fixture("issues.labeled"));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "GITHUB_WEBHOOK_NOT_CONFIGURED" });
    expect(signalCount()).toBe(0);
  });

  it("records a signed delivery once, however often GitHub redelivers it, without the node's token", async () => {
    await storeSecret();
    const body = fixture("issues.labeled");
    const first = await deliver("issues", body, { deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
    expect(first.status).toBe(202);
    const again = await deliver("issues", body, { deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, signalId: (first.body as { signalId: string }).signalId });
    expect(signalCount()).toBe(1);
  });

  it("answers a ping and an event it does not turn into signals, recording neither", async () => {
    await storeSecret();
    expect(await deliver("ping", fixture("ping"))).toMatchObject({ status: 200, body: { pong: true } });
    const star = Buffer.from(JSON.stringify({ action: "created", repository: { full_name: "a/b" }, sender: { login: "x" } }));
    expect((await deliver("star", star)).status).toBe(200);
    expect(signalCount()).toBe(0);
  });

  it("is only a POST", async () => {
    const response = await handleRequest(deps, { method: "GET", path: "/signals/github", query: {}, headers: {}, body: "" });
    expect(response.status).toBe(405);
  });
});

describe("what a delivery starts", () => {
  it("does not start an automation with what this node's own account did, unless it was asked to", async () => {
    await storeSecret();
    const conversationId = await conversation();
    const create = createTool(conversationId);
    const created = await create({
      summary: "Nhắc khi có nhãn bug",
      topic: "github.issue.labeled",
      match: [{ path: "payload.label", op: "equals", value: "bug" }],
      action: "remind",
      message: "xem issue",
      githubSelfLogins: ["codertocat"],
    });
    expect(created.text).toContain("Set up.");
    expect(created.text).toContain("Signals caused by codertocat are Clark's own");

    // The fixture's sender is Codertocat: Clark itself, on this node.
    expect((await deliver("issues", fixture("issues.labeled"))).status).toBe(202);
    service.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toEqual([]);

    // The same event by a person starts it.
    expect((await deliver("issues", sentBy("issues.labeled", "a-person"))).status).toBe(202);
    service.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toEqual([
      "Nhắc bạn — Nhắc khi có nhãn bug: xem issue",
    ]);
  });

  it("refuses to start work in a checkout that is not a clone of the repository the signal is about", async () => {
    await storeSecret();
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    const conversationId = await conversation();
    const create = createTool(conversationId);
    // Userinfo in a remote is how a token ends up in one; built here so no credential-shaped literal sits in the source.
    const userinfo = ["x-access-token", "not-for-the-conversation"].join(":");
    const elsewhere = clone("elsewhere", `https://${userinfo}@github.com/acme/other.git`);
    const created = await create({
      summary: "Sửa issue có nhãn bug",
      topic: "github.issue.labeled",
      match: [
        { path: "payload.label", op: "equals", value: "bug" },
        { path: "subject.refs.repository", op: "equals", value: "Codertocat/Hello-World" },
      ],
      action: "task",
      goal: "fix the labelled issue",
      repositories: [elsewhere],
      allowedEffects: ["read", "local-write"],
    });
    expect(created.text).toContain("Set up.");

    expect((await deliver("issues", sentBy("issues.labeled", "a-person"))).status).toBe(202);
    service.tick();
    expect(dispatched).toEqual([]);
    const refused = assistantTexts(conversationId).find((text) => text.includes("không chạy"));
    expect(refused).toContain("is a clone of github.com/acme/other, not github.com/Codertocat/Hello-World");
    // The remote is named by repository, never by the URL it was written as.
    expect(assistantTexts(conversationId).join("\n")).not.toContain("not-for-the-conversation");
    const runs = allRows<{ state: string; task_id: string }>(services.runtime.db, "SELECT state, task_id FROM intent_runs");
    expect(runs.map((run) => run.state)).toEqual(["failed"]);
    expect(getTask(services.runtime.db, runs[0]?.task_id ?? "")).toBeUndefined();
  });

  it("starts work in a clone of that repository, whichever way its remote is written", async () => {
    await storeSecret();
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    const conversationId = await conversation();
    const create = createTool(conversationId);
    const checkout = clone("hello-world", "git@github.com:codertocat/hello-world.git");
    await create({
      summary: "Sửa issue có nhãn bug",
      topic: "github.issue.labeled",
      match: [{ path: "subject.refs.repository", op: "equals", value: "Codertocat/Hello-World" }],
      action: "task",
      goal: "fix the labelled issue",
      repositories: [checkout],
      allowedEffects: ["read", "local-write"],
    });
    expect((await deliver("issues", sentBy("issues.labeled", "a-person"))).status).toBe(202);
    service.tick();
    expect(dispatched).toHaveLength(1);
  });

  it("tells the agent what a GitHub automation still needs, and asks for the secret only through request_secret", async () => {
    const conversationId = await conversation();
    const created = await createTool(conversationId)({
      summary: "Nhắc khi có PR",
      topic: "github.pull_request.opened",
      action: "remind",
      message: "xem PR",
    });
    expect(created.text).toContain("POST /signals/github");
    expect(created.text).toContain('request_secret with name "github_webhook_secret"');
    expect(created.text).toContain("pass it as githubSelfLogins");
    // A reminder pushes nothing, so it needs no token.
    expect(created.text).not.toContain('request_secret with name "github_token"');
  });

  it("asks for a token only a task's git and gh can receive, when the automation will push", async () => {
    const conversationId = await conversation();
    const create = createTool(conversationId);
    const repository = clone("hello-world", "git@github.com:Codertocat/Hello-World.git");
    const task = {
      summary: "Sửa issue có nhãn bug",
      topic: "github.issue.labeled",
      action: "task",
      goal: "fix the labelled issue",
      repositories: [repository],
      allowedEffects: ["read", "local-write", "external-write"],
    };
    const created = await create(task);
    expect(created.text).toContain('request_secret with name "github_token", secretKind "token", consumer "command:gh,command:git"');

    // Once it is there, nothing more is asked.
    expect((await authed("POST", "/credentials", { fields: [{ name: "github_token", value: "fixture-token-value", kind: "token", consumer: "command:gh,command:git" }] })).status).toBe(201);
    expect((await create({ ...task, summary: "Lần hai" })).text).not.toContain('name "github_token"');
  });
});

describe("over the wire", () => {
  it("verifies the bytes GitHub sent, and holds no more than the ceiling", async () => {
    expect(bodyLimitForPath("/signals/github")).toBe(GITHUB_WEBHOOK_BODY_LIMIT);
    await storeSecret();
    const server = createNodeServer({
      services,
      origin: "http://127.0.0.1",
      onWarning: () => undefined,
      bodyLimitFor: (path) => (path === "/signals/github" ? 64 * 1024 : undefined),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const body = fixture("issues.labeled");
      const headers = { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "wire-1" };
      const accepted = await fetch(`${base}/signals/github`, { method: "POST", headers: { ...headers, "x-hub-signature-256": sign(body) }, body: body.toString("utf8") });
      expect(accepted.status).toBe(202);
      const oversized = " ".repeat(128 * 1024);
      const refused = await fetch(`${base}/signals/github`, { method: "POST", headers: { ...headers, "x-hub-signature-256": sign(oversized) }, body: oversized });
      expect(refused.status).toBe(413);
      expect(signalCount()).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
