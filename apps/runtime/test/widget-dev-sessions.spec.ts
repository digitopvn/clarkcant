import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant, type WidgetDefinition, type WidgetDevSessionView } from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";

import { createWidgetDevSessions } from "../src/application/widget-dev-sessions.ts";
import { createDevelopWidgetTool } from "../src/develop-widget-tool.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A live widget authoring session, driven over the HTTP API the app uses.
 *
 * Each build of the folder is installed through the node's one install path and served by the same frame route a
 * published widget is: what is asserted is what the conversation would mount (the live frame's document), what the
 * session says about it, and that a change to what the package may reach goes back to the execution policy while a
 * change inside it does not.
 */

const PACKAGE = "com.example.timer";
const WIDGET_ID = "com.example.timer.main@1";
const VERSION = "0.1.0";

const DEFINITION: WidgetDefinition = {
  id: WIDGET_ID,
  version: VERSION,
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "A timer.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A timer",
  requestedCapabilities: [],
};

let dir: string;
let root: string;
let services: NodeServices;
let deps: GatewayDeps;

function writePackage(html: string, networkOrigins: string[] = []): void {
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), html);
  writeFileSync(join(root, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PACKAGE,
      version: VERSION,
      displayName: "Timer",
      description: "A timer.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "widget", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" }],
      requestedCapabilities: [],
      permissions: { networkOrigins, filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
}

async function call(method: string, path: string, body?: Record<string, unknown>): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function conversation(): Promise<string> {
  const created = await call("POST", "/conversations", { title: "widget dev" });
  expect(created.status).toBe(201);
  return (created.body as { conversationId: string }).conversationId;
}

function askEveryInstall(): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "local-write", decision: "ask" }] },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

const session = (response: GatewayResponse): WidgetDevSessionView => response.body as WidgetDevSessionView;
const live = async (conversationId: string, instanceId: string) => {
  const response = await call("GET", `/conversations/${conversationId}/widgets/${instanceId}/live`);
  expect(response.status).toBe(200);
  return response.body as { frame: { url: string; document: string }; development?: { sessionId: string } };
};
const served = async (url: string): Promise<string> => {
  const response = await handleRequest(deps, { method: "GET", path: url, query: {}, headers: {}, body: "" });
  expect(response.status).toBe(200);
  return Buffer.from(response.binary?.bytes ?? new Uint8Array()).toString("utf8");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-widget-dev-"));
  root = join(dir, "timer");
  writePackage("<!doctype html><p>first</p>\n");
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "widget dev test node" });
  services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
  deps = { services, now: () => new Date().toISOString() as never };
});

afterEach(() => {
  services.widgetDev?.close();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a widget dev session", () => {
  it("installs the folder, places it, and reloads only the frame when the code changes", async () => {
    const conversationId = await conversation();
    const started = await call("POST", "/widget-dev/sessions", { root, conversationId });
    expect(started.status).toBe(201);
    const first = session(started);
    expect(first).toMatchObject({ status: "live", packageId: PACKAGE, activation: { state: "active", generation: 1 }, showingLastKnownGood: false });
    expect(first.latest?.delta.verdict).toBe("initial");
    const instanceId = first.placed?.instanceId ?? "";
    expect(first.placed?.conversationId).toBe(conversationId);

    const before = await live(conversationId, instanceId);
    expect(before.development).toEqual({ sessionId: first.sessionId });
    expect(await served(before.frame.url)).toContain("first");

    writePackage("<!doctype html><p>second</p>\n");
    const rebuilt = session(await call("POST", `/widget-dev/sessions/${first.sessionId}/rebuild`));
    expect(rebuilt).toMatchObject({ activation: { state: "active", generation: 2 }, showingLastKnownGood: false });
    expect(rebuilt.latest?.delta.verdict).toBe("unchanged");

    // The same placed widget, with a new document: the frame remounts, the instance and its state stay.
    const after = await live(conversationId, instanceId);
    expect(after.frame.document).not.toBe(before.frame.document);
    expect(await served(after.frame.url)).toContain("second");
    expect(session(await call("GET", `/widget-dev/sessions/${first.sessionId}`)).placed?.instanceId).toBe(instanceId);
  });

  it("keeps the last good build running when the files stop reading as a package, and says so", async () => {
    const conversationId = await conversation();
    const first = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    const instanceId = first.placed?.instanceId ?? "";
    const before = await live(conversationId, instanceId);

    writeFileSync(join(root, "widgets", "main", "widget.json"), "{ not json");
    const failed = session(await call("POST", `/widget-dev/sessions/${first.sessionId}/rebuild`));
    expect(failed.lastBuild?.ok).toBe(false);
    expect(failed.lastBuild?.diagnostics.length).toBeGreaterThan(0);
    expect(failed).toMatchObject({ activation: { state: "active", generation: 1 }, showingLastKnownGood: true });
    expect((await live(conversationId, instanceId)).frame.document).toBe(before.frame.document);
  });

  it("asks once for the folder's reach, runs code changes inside it, and asks again when it widens", async () => {
    askEveryInstall();
    const conversationId = await conversation();
    const asked = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    expect(asked.activation.state).toBe("awaiting-approval");
    expect(asked.placed).toBeUndefined();

    // The question is the inbox's ordinary install question, decided on the ordinary route.
    const inbox = await call("GET", "/inbox");
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).toContain(PACKAGE);
    const approvalId = asked.activation.state === "awaiting-approval" ? asked.activation.approvalId : "";
    const row = services.runtime.db.prepare("SELECT operation_digest FROM approvals WHERE approval_id = ?").get(approvalId) as { operation_digest: string };
    expect(row.operation_digest.startsWith("widget-dev-scope:")).toBe(true);
    const decided = await call("POST", `/packages/approvals/${approvalId}/decision`, { decision: "granted", digest: row.operation_digest });
    expect(decided.status).toBe(200);

    const approved = session(await call("GET", `/widget-dev/sessions/${asked.sessionId}`));
    expect(approved).toMatchObject({ activation: { state: "active", generation: 1 }, showingLastKnownGood: false });
    expect(approved.placed?.conversationId).toBe(conversationId);

    // Code inside the same reach: no second question.
    writePackage("<!doctype html><p>inside the reach</p>\n");
    const inside = session(await call("POST", `/widget-dev/sessions/${asked.sessionId}/rebuild`));
    expect(inside).toMatchObject({ activation: { state: "active", generation: 2 } });

    // A new origin is a wider reach: the policy is asked again, and generation 2 keeps running meanwhile.
    writePackage("<!doctype html><p>wider</p>\n", ["https://api.example.com"]);
    const wider = session(await call("POST", `/widget-dev/sessions/${asked.sessionId}/rebuild`));
    expect(wider.latest?.delta.verdict).toBe("wider");
    expect(wider.activation.state).toBe("awaiting-approval");
    expect(wider.running?.generation).toBe(2);
    expect(wider.showingLastKnownGood).toBe(true);
    if (wider.activation.state === "awaiting-approval") expect(wider.activation.approvalId).not.toBe(approvalId);
  });

  it("says in the conversation when a policy that does not ask runs a build that reaches more", async () => {
    const conversationId = await conversation();
    const first = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    writePackage("<!doctype html><p>wider</p>\n", ["https://api.example.com"]);
    const wider = session(await call("POST", `/widget-dev/sessions/${first.sessionId}/rebuild`));
    expect(wider).toMatchObject({ activation: { state: "active", generation: 2 }, latest: { delta: { verdict: "wider" } } });

    const said = (
      services.runtime.db.prepare("SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence").all(conversationId) as { document: string }[]
    ).map((row) => row.document);
    expect(said.some((document) => document.includes("https://api.example.com"))).toBe(true);
  });

  it("stops watching without taking the running widget away, and resumes after a restart", async () => {
    const conversationId = await conversation();
    const first = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    const instanceId = first.placed?.instanceId ?? "";

    const stopped = await call("DELETE", `/widget-dev/sessions/${first.sessionId}`);
    expect(session(stopped)).toMatchObject({ status: "stopped", activation: { state: "active", generation: 1 } });
    expect(await served((await live(conversationId, instanceId)).frame.url)).toContain("first");
    expect((await call("POST", `/widget-dev/sessions/${first.sessionId}/rebuild`)).status).toBe(409);

    // Started again for the same folder: the same session, counting on from where it was.
    writePackage("<!doctype html><p>again</p>\n");
    const again = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(again).toMatchObject({ sessionId: first.sessionId, status: "live", activation: { state: "active", generation: 2 } });

    // A restart: a new registry over the same node resumes the live session from its store.
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    await services.widgetDev.resume();
    const resumed = session(await call("GET", `/widget-dev/sessions/${first.sessionId}`));
    expect(resumed).toMatchObject({ status: "live", running: { generation: 2 } });
    expect(JSON.parse(readFileSync(join(dir, "node", "widget-dev", "sessions.json"), "utf8"))).toMatchObject({ version: 1 });
  });

  it("is the same session from the conversation, and a machine surface's turn cannot start one", async () => {
    const conversationId = await conversation();
    const tool = (origin?: "mcp") =>
      createDevelopWidgetTool({
        sessions: () => services.widgetDev,
        conversationId,
        messageId: () => undefined,
        ...(origin === undefined ? {} : { origin: () => origin }),
      });

    const refused = await tool("mcp").execute({ action: "start", root });
    expect(refused.text).toContain("Nothing was done");
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    const started = await tool().execute({ action: "start", root });
    expect(started.text).toContain("Running generation 1.");
    const [only] = ((await call("GET", "/widget-dev/sessions")).body as { sessions: WidgetDevSessionView[] }).sessions;
    expect(only?.placed?.conversationId).toBe(conversationId);
    expect((await tool("mcp").execute({ action: "status", sessionId: only?.sessionId })).text).toContain("Running generation 1.");
  });

  it("refuses a folder it cannot develop, with the reason", async () => {
    expect((await call("POST", "/widget-dev/sessions", { root: "relative/path" })).body).toMatchObject({ code: "ROOT_NOT_ABSOLUTE" });
    expect((await call("POST", "/widget-dev/sessions", { root: join(dir, "missing") })).status).toBe(404);
    expect((await call("POST", "/widget-dev/sessions", { root, extra: true })).status).toBe(400);
    expect((await call("GET", "/widget-dev/sessions/wdev_nope")).status).toBe(404);

    // A folder that does not read as a package starts a session with a failed build and nothing running.
    writeFileSync(join(root, "clarkcant.json"), "{");
    const broken = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(broken).toMatchObject({ activation: { state: "none" }, showingLastKnownGood: false, lastBuild: { ok: false } });
  });
});
