import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
  type TurnOrigin,
  type WidgetDefinition,
  type WidgetDevSessionView,
} from "@clarkcant/contracts";
import {
  DIRECTORY_FEED_FORMAT,
  EXECUTION_POLICY_PREFERENCE_KEY,
  OFFICIAL_MARKETPLACE_FEED_URL,
  customFeedId,
  listInstalledPackages,
  refreshDirectory,
  setPreference,
  writeRegisteredPreference,
} from "@clarkcant/core";

import { createWidgetDevSessions } from "../src/application/widget-dev-sessions.ts";
import { WIDGET_DEV_STORE_MAX, readDevSessions, writeDevSessions } from "../src/application/widget-dev-store.ts";
import { createDevelopWidgetTool } from "../src/develop-widget-tool.ts";
import { hostText } from "../src/host-text.ts";
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

function writePackage(
  html: string,
  networkOrigins: string[] = [],
  at: string = root,
  extra: { requestedCapabilities?: string[]; id?: string; facets?: unknown[] } = {},
): void {
  mkdirSync(join(at, "widgets", "main"), { recursive: true });
  writeFileSync(join(at, "widgets", "main", "index.html"), html);
  writeFileSync(join(at, "widgets", "main", "widget.json"), JSON.stringify(DEFINITION));
  writeFileSync(
    join(at, "clarkcant.json"),
    JSON.stringify({
      // A manifest with other facets than widgets is the second schema.
      ...(extra.facets === undefined ? { schemaVersion: 1 } : { schemaVersion: 2, dependencies: [] }),
      id: extra.id ?? PACKAGE,
      version: VERSION,
      displayName: "Timer",
      description: "A timer.",
      hostApi: { min: 1, max: 1 },
      facets: extra.facets ?? [
        { kind: "widget", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" },
      ],
      requestedCapabilities: extra.requestedCapabilities ?? [],
      permissions: { networkOrigins, filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
}

async function call(method: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, ...headers },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

function usePolicy(change: Partial<ExecutionPolicyConfig>): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...change },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

/** Read the session until it says what is expected, or give up after a bounded wait. */
async function eventually(sessionId: string, done: (view: WidgetDevSessionView) => boolean): Promise<WidgetDevSessionView> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const view = session(await call("GET", `/widget-dev/sessions/${sessionId}`));
    if (done(view) || Date.now() > deadline) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const toolFor = (conversationId: string, origin?: TurnOrigin) =>
  createDevelopWidgetTool({
    sessions: () => services.widgetDev,
    conversationId,
    messageId: () => undefined,
    ...(origin === undefined ? {} : { origin: () => origin }),
  });

const conversationText = (conversationId: string): string[] =>
  (services.runtime.db.prepare("SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence").all(conversationId) as { document: string }[]).map(
    (row) => row.document,
  );

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
  root = join(dir, "projects", "timer");
  writePackage("<!doctype html><p>first</p>\n");
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "widget dev test node" });
  // The person's project folders are the test's own, never the developer's home or drive.
  setPreference(
    { db: services.runtime.db, now: () => new Date().toISOString() as never },
    { principalId: services.runtime.identity.ownerPrincipalId, key: "workspace.roots", scope: "global", value: [join(dir, "projects")], source: "user" },
  );
  services.widgetDev = createWidgetDevSessions(() => services, { watch: false, answerPollMs: 20 });
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

    // The session follows the answer on its own; reading it does not.
    const approved = await eventually(asked.sessionId, (view) => view.activation.state === "active" && view.placed !== undefined);
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

    // Approved in the inbox, the wider build runs, and is not announced as taken without asking.
    const widerId = wider.activation.state === "awaiting-approval" ? wider.activation.approvalId : "";
    const widerRow = services.runtime.db.prepare("SELECT operation_digest FROM approvals WHERE approval_id = ?").get(widerId) as { operation_digest: string };
    expect((await call("POST", `/packages/approvals/${widerId}/decision`, { decision: "granted", digest: widerRow.operation_digest })).status).toBe(200);
    expect(await eventually(asked.sessionId, (view) => view.running?.generation === 3)).toMatchObject({ running: { generation: 3 } });
    expect(conversationText(conversationId).some((document) => document.includes("https://api.example.com"))).toBe(false);
  });

  it("asks again when a build only adds a capability the package requests, under a rule that asks", async () => {
    askEveryInstall();
    const conversationId = await conversation();
    const asked = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    const approvalId = asked.activation.state === "awaiting-approval" ? asked.activation.approvalId : "";
    const row = services.runtime.db.prepare("SELECT operation_digest FROM approvals WHERE approval_id = ?").get(approvalId) as { operation_digest: string };
    expect((await call("POST", `/packages/approvals/${approvalId}/decision`, { decision: "granted", digest: row.operation_digest })).status).toBe(200);
    await eventually(asked.sessionId, (view) => view.activation.state === "active");

    // Same code, same origins, one more capability: the granted scope does not cover it.
    writePackage("<!doctype html><p>first</p>\n", [], root, { requestedCapabilities: ["notes.write@1"] });
    const more = session(await call("POST", `/widget-dev/sessions/${asked.sessionId}/rebuild`));
    expect(more.latest?.delta.capabilities.added).toEqual(["notes.write@1"]);
    expect(more.activation.state).toBe("awaiting-approval");
    expect(more.running?.generation).toBe(1);
    if (more.activation.state === "awaiting-approval") expect(more.activation.approvalId).not.toBe(approvalId);
  });

  it("does not build, install or follow an answer when it is only read", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false, answerPollMs: 3_600_000 });
    askEveryInstall();
    const conversationId = await conversation();
    const asked = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    const approvalId = asked.activation.state === "awaiting-approval" ? asked.activation.approvalId : "";
    const row = services.runtime.db.prepare("SELECT operation_digest FROM approvals WHERE approval_id = ?").get(approvalId) as { operation_digest: string };
    expect((await call("POST", `/packages/approvals/${approvalId}/decision`, { decision: "granted", digest: row.operation_digest })).status).toBe(200);

    const store = readFileSync(join(dir, "node", "widget-dev", "sessions.json"), "utf8");
    expect(session(await call("GET", `/widget-dev/sessions/${asked.sessionId}`)).placed).toBeUndefined();
    await call("GET", "/widget-dev/sessions");
    expect(readFileSync(join(dir, "node", "widget-dev", "sessions.json"), "utf8")).toBe(store);

    // An explicit action follows the answer.
    const rebuilt = session(await call("POST", `/widget-dev/sessions/${asked.sessionId}/rebuild`));
    expect(rebuilt).toMatchObject({ activation: { state: "active", generation: 1 }, placed: { conversationId } });
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

  it("is the same session from the conversation, and only the person's own turn can start one", async () => {
    const conversationId = await conversation();
    const tool = (origin?: TurnOrigin) => toolFor(conversationId, origin);

    for (const origin of ["mcp", "relay", "cli-api", "automation", "peer"] as const) {
      const refused = await tool(origin).execute({ action: "start", root });
      expect(refused.text, origin).toContain("Nothing was done");
      expect((await tool(origin).execute({ action: "rebuild", sessionId: "wdev_any" })).text, origin).toContain("Nothing was done");
      expect((await tool(origin).execute({ action: "place", sessionId: "wdev_any" })).text, origin).toContain("Nothing was done");
    }
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    const started = await tool("person").execute({ action: "start", root });
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

  it("never develops the node's own data folder, a folder holding it, or a network path", async () => {
    const data = join(dir, "node");
    mkdirSync(join(data, "widget-dev"), { recursive: true });
    expect((await call("POST", "/widget-dev/sessions", { root: data })).body).toMatchObject({ code: "ROOT_IN_DATA_FOLDER" });
    expect((await call("POST", "/widget-dev/sessions", { root: join(data, "widget-dev") })).body).toMatchObject({ code: "ROOT_IN_DATA_FOLDER" });
    expect((await call("POST", "/widget-dev/sessions", { root: dir })).body).toMatchObject({ code: "ROOT_IN_DATA_FOLDER" });
    if (process.platform === "win32") {
      for (const remote of ["\\\\host\\share\\timer", "\\\\?\\C:\\timer", "\\\\.\\PhysicalDrive0"]) {
        expect((await call("POST", "/widget-dev/sessions", { root: remote })).body, remote).toMatchObject({ code: "ROOT_NOT_LOCAL" });
      }
    }
    // Clark's widget workspace is inside the data folder, and is the one place there that may be developed.
    const scaffolded = join(services.widgetDev?.workspace() ?? "", "timer");
    writePackage("<!doctype html><p>scaffolded</p>\n", [], scaffolded);
    expect((await call("POST", "/widget-dev/sessions", { root: scaffolded })).status).toBe(201);
  });

  it("lets Clark develop only the person's project folders and its own workspace", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });

    const outside = await toolFor(conversationId).execute({ action: "start", root: elsewhere });
    expect(outside.text).toContain("Not started");
    expect(outside.text).toContain("widget-workspace");
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    const scaffolded = join(services.widgetDev?.workspace() ?? "", "counter");
    writePackage("<!doctype html><p>counter</p>\n", [], scaffolded, { id: "com.example.counter" });
    expect((await toolFor(conversationId).execute({ action: "start", root: scaffolded })).text).toContain("Running generation 1.");
    expect((await toolFor(conversationId).execute({ action: "start", root })).text).toContain("Running generation 1.");

    // The person may name the other folder from their own surface.
    expect((await call("POST", "/widget-dev/sessions", { root: elsewhere })).status).toBe(201);
  });

  it("does not count the built-in project roots, or roots Clark wrote, as folders the person chose", async () => {
    const conversationId = await conversation();
    const setRoots = (source: "user" | "agent") =>
      setPreference(
        { db: services.runtime.db, now: () => new Date().toISOString() as never },
        { principalId: services.runtime.identity.ownerPrincipalId, key: "workspace.roots", scope: "global", value: [join(dir, "projects")], source },
      );

    // No configured roots: the default (home and the node's drive) holds the test folder, and still does not count.
    services.runtime.db.prepare("DELETE FROM preferences WHERE key = ?").run("workspace.roots");
    expect(services.projects.roots().length).toBeGreaterThan(0);
    const unset = await toolFor(conversationId).execute({ action: "start", root });
    expect(unset.text).toContain("Not started");
    expect(unset.text).toContain("widget-workspace");
    // Said in the owner's language (Vietnamese by default), with only what works today: copy the project into the
    // widget workspace. Choosing another folder is not offered, since nothing lets the person choose one yet.
    expect(unset.text).toContain("hãy chép thư mục của nó vào không gian widget");
    expect(unset.text).toContain("digitopvn/clarkcant#538");
    expect(unset.text).not.toContain("workspace.roots");
    const english = hostText("en").approvals.devSessionRootNotOwned("/x", "/w");
    expect(english).toContain("copy its folder into the widget workspace");
    expect(english).toContain("not available yet");
    expect(english).not.toMatch(/workspace\.roots|yourself|from the app/);

    setRoots("agent");
    expect((await toolFor(conversationId).execute({ action: "start", root })).text).toContain("Not started");
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    setRoots("user");
    expect((await toolFor(conversationId).execute({ action: "start", root })).text).toContain("Running generation 1.");
  });

  it("decides a session Clark started as Clark's own proposal, so guarded mode asks", async () => {
    usePolicy({ mode: "guarded" });
    const conversationId = await conversation();
    const proposed = await toolFor(conversationId, "person").execute({ action: "start", root });
    expect(proposed.text).toContain("waits for the person's answer");

    // The same kind of folder started by the person themselves is their request, which guarded mode performs.
    const theirs = join(dir, "projects", "clock");
    writePackage("<!doctype html><p>clock</p>\n", [], theirs, { id: "com.example.clock" });
    expect(session(await call("POST", "/widget-dev/sessions", { root: theirs })).activation).toMatchObject({ state: "active", generation: 1 });
  });

  it("refuses to start, rebuild or place for a machine surface, while reading and stopping stay open", async () => {
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    for (const surface of ["mcp", "relay", "cli-api"]) {
      const marked = { "x-clarkcant-surface": surface };
      expect((await call("POST", "/widget-dev/sessions", { root }, marked)).status, surface).toBe(403);
      expect((await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`, undefined, marked)).body, surface).toMatchObject({ code: "PERSON_ONLY" });
      expect((await call("POST", `/widget-dev/sessions/${started.sessionId}/place`, { conversationId: "conv_x" }, marked)).status, surface).toBe(403);
      expect((await call("GET", `/widget-dev/sessions/${started.sessionId}`, undefined, marked)).status, surface).toBe(200);
    }
    expect((await call("DELETE", `/widget-dev/sessions/${started.sessionId}`, undefined, { "x-clarkcant-surface": "mcp" })).status).toBe(200);
  });

  it("refuses a package id another session or another install already owns", async () => {
    const first = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(first.activation.state).toBe("active");

    const copy = join(dir, "projects", "timer-copy");
    writePackage("<!doctype html><p>copy</p>\n", [], copy);
    const second = session(await call("POST", "/widget-dev/sessions", { root: copy }));
    expect(second.activation).toMatchObject({ state: "refused", code: "PACKAGE_IN_OTHER_SESSION" });

    // Stopped, the first session's build still runs, so the id is still taken.
    await call("DELETE", `/widget-dev/sessions/${first.sessionId}`);
    expect(session(await call("POST", `/widget-dev/sessions/${second.sessionId}/rebuild`)).activation).toMatchObject({ code: "PACKAGE_IN_OTHER_SESSION" });

    // A session the node no longer remembers: what runs is an install from elsewhere as far as the copy can tell.
    writeDevSessions(
      join(dir, "node"),
      readDevSessions(join(dir, "node")).filter((stored) => stored.sessionId !== first.sessionId),
    );
    expect(session(await call("POST", `/widget-dev/sessions/${second.sessionId}/rebuild`)).activation).toMatchObject({ code: "PACKAGE_INSTALLED_OTHERWISE" });
  });

  it("refuses a package id and version the node's directory lists", async () => {
    const indexPath = join(dir, "directory.json");
    writeFileSync(
      indexPath,
      JSON.stringify([
        {
          packageId: PACKAGE,
          version: VERSION,
          displayName: "Timer",
          description: "A timer.",
          source: { kind: "local", path: join(dir, "listed") },
          publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
          preview: {},
          facets: ["ui"],
          isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
          platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
          hostApi: { min: 1, max: 1 },
          permissionsSummary: [],
          riskTier: "isolated-ui",
          sizeBytes: 1024,
          digest: `sha256:${"0".repeat(64)}`,
        },
      ]),
    );
    const previous = process.env["CC_DIRECTORY_INDEX"];
    process.env["CC_DIRECTORY_INDEX"] = indexPath;
    try {
      const listed = session(await call("POST", "/widget-dev/sessions", { root }));
      expect(listed.activation).toMatchObject({ state: "refused", code: "PACKAGE_LISTED" });
      expect(listed.running).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env["CC_DIRECTORY_INDEX"];
      else process.env["CC_DIRECTORY_INDEX"] = previous;
    }
  });

  it("refuses a package with a part that runs outside the widget frame", async () => {
    writePackage("<!doctype html><p>first</p>\n", [], root, {
      facets: [
        { kind: "ui", id: WIDGET_ID, entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" },
        {
          kind: "tools",
          id: "com.example.timer.service",
          entry: "service/server.mjs",
          isolation: "service",
          protocol: "mcp-stdio",
          capabilities: [{ tool: "list_timers", ref: "com.example.timer.list@1", summary: "List the timers", effectCategory: "read" }],
        },
      ],
    });
    mkdirSync(join(root, "service"), { recursive: true });
    writeFileSync(join(root, "service", "server.mjs"), "export {};\n");
    const refused = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(refused.lastBuild?.ok).toBe(false);
    expect(refused.lastBuild?.diagnostics).toEqual([expect.objectContaining({ code: "FACET_LANE_UNSUPPORTED" })]);
    expect(refused.activation.state).toBe("none");
  });

  it("removes what superseded generations left behind, keeping what runs and what a rollback returns to", async () => {
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    for (const text of ["second", "third", "fourth"]) {
      writePackage(`<!doctype html><p>${text}</p>\n`);
      expect(session(await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`)).running?.generation).toBeGreaterThan(1);
    }
    const snapshots = readdirSync(join(dir, "node", "package-cache", "local"));
    expect(snapshots).toHaveLength(2);
    const rows = services.runtime.db.prepare("SELECT superseded_at FROM package_generations WHERE package_id = ?").all(PACKAGE) as { superseded_at: string | null }[];
    expect(rows.filter((row) => row.superseded_at === null)).toHaveLength(1);
    expect(rows.filter((row) => row.superseded_at !== null)).toHaveLength(1);
    expect(readDevSessions(join(dir, "node"))[0]?.snapshots).toHaveLength(2);
  });

  it("forgets the oldest stopped sessions rather than failing when the store is full", async () => {
    const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
    writeDevSessions(
      join(dir, "node"),
      Array.from({ length: WIDGET_DEV_STORE_MAX }, (_, index) => ({
        sessionId: `wdev_old_${String(index)}`,
        root: join(dir, "gone", String(index)),
        status: "stopped" as const,
        startedAt: at,
      })),
    );
    expect((await call("POST", "/widget-dev/sessions", { root })).status).toBe(201);
    const kept = readDevSessions(join(dir, "node"));
    expect(kept.length).toBeLessThanOrEqual(WIDGET_DEV_STORE_MAX);
    expect(kept.some((stored) => stored.root.endsWith("timer"))).toBe(true);
  });

  it("moves an unreadable store aside instead of overwriting it", async () => {
    const storeDir = join(dir, "node", "widget-dev");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, "sessions.json"), "{ not json");
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });
    const aside = readdirSync(storeDir).find((name) => name.startsWith("sessions.json.unreadable-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(storeDir, aside ?? ""), "utf8")).toBe("{ not json");
    expect(existsSync(join(storeDir, "sessions.json"))).toBe(false);
  });

  it("says a session it cannot resume is stopped, and why, rather than leaving it reading as live", async () => {
    const at = new Date().toISOString();
    const folders = Array.from({ length: 9 }, (_, index) => join(dir, "projects", `w${String(index)}`));
    for (const folder of folders) mkdirSync(folder, { recursive: true });
    writeDevSessions(join(dir, "node"), [
      ...folders.map((folder, index) => ({ sessionId: `wdev_${String(index)}`, root: folder, status: "live" as const, startedAt: at })),
      { sessionId: "wdev_gone", root: join(dir, "projects", "gone"), status: "live" as const, startedAt: at },
    ]);
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    await services.widgetDev.resume();

    const views = ((await call("GET", "/widget-dev/sessions")).body as { sessions: WidgetDevSessionView[] }).sessions;
    expect(views.filter((view) => view.status === "live")).toHaveLength(8);
    expect(views.find((view) => view.sessionId === "wdev_8")).toMatchObject({ status: "stopped", stopReason: "capacity" });
    expect(views.find((view) => view.sessionId === "wdev_gone")).toMatchObject({ status: "stopped", stopReason: "folder-gone" });
  });

  it("checks a resumed session's folder as a start would, for whoever started it", async () => {
    const at = new Date().toISOString();
    const elsewhere = join(dir, "elsewhere", "timer");
    const theirs = join(dir, "elsewhere", "clock");
    for (const folder of [elsewhere, theirs]) mkdirSync(folder, { recursive: true });
    writeDevSessions(join(dir, "node"), [
      // Clark may not watch a folder outside its workspace and the person's roots, whatever the store says.
      { sessionId: "wdev_clark", root: elsewhere, status: "live" as const, startedAt: at, initiative: { kind: "clark" as const } },
      { sessionId: "wdev_person", root: theirs, status: "live" as const, startedAt: at, initiative: { kind: "person" as const } },
      { sessionId: "wdev_data", root: join(dir, "node"), status: "live" as const, startedAt: at },
    ]);
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    await services.widgetDev.resume();

    const views = ((await call("GET", "/widget-dev/sessions")).body as { sessions: WidgetDevSessionView[] }).sessions;
    expect(views.find((view) => view.sessionId === "wdev_clark")).toMatchObject({ status: "stopped", stopReason: "root-refused" });
    expect(views.find((view) => view.sessionId === "wdev_data")).toMatchObject({ status: "stopped", stopReason: "root-refused" });
    expect(views.find((view) => view.sessionId === "wdev_person")).toMatchObject({ status: "live" });
  });

  it("stops as folder-gone, rather than building again, when the folder is deleted before a rebuild", async () => {
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    const rebuilt = await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    expect(rebuilt.status).toBe(200);
    expect(session(rebuilt)).toMatchObject({ status: "stopped", stopReason: "folder-gone", activation: { state: "active", generation: 1 } });
  });

  it("stops a watched session as folder-gone when its folder is deleted, though the platform may report nothing", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    // Bounded: the node looks for the folder at least once a second (`DEV_ENGINE_ROOT_CHECK_MS`), and on every change.
    const stopped = await eventually(started.sessionId, (view) => view.status === "stopped");
    expect(stopped).toMatchObject({ status: "stopped", stopReason: "folder-gone", activation: { state: "active", generation: 1 } });
  });
});

describe("the directory a widget dev session lists its builds in", () => {
  const restoreEnv: Record<string, string | undefined> = {};
  const servers: Server[] = [];

  /** Set (or, with no value, remove) a directory setting for this test only. */
  function setEnv(name: string, value?: string): void {
    if (!(name in restoreEnv)) restoreEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  /** A marketplace feed on loopback that lists this package's id and version under another publisher's archive. */
  async function startFeed(): Promise<string> {
    const listing = {
      packageId: PACKAGE,
      version: VERSION,
      displayName: "Timer",
      description: "Someone else's timer.",
      source: { kind: "npm", name: "timer", version: VERSION },
      publisher: { id: "someone-else", sourceUrl: "https://example.org", license: "MIT" },
      preview: {},
      facets: ["ui"],
      isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
      platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
      hostApi: { min: 1, max: 1 },
      permissionsSummary: [],
      riskTier: "isolated-ui",
      sizeBytes: 1024,
      digest: `sha256:${"1".repeat(64)}`,
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ format: DIRECTORY_FEED_FORMAT, entries: [listing], nextCursor: null }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the feed did not bind");
    return `http://127.0.0.1:${String(address.port)}/api/v1/directory`;
  }

  const installedSource = () =>
    listInstalledPackages({
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now: () => new Date().toISOString() as Instant,
      newId: (prefix: string) => `${prefix}_x`,
    }).find((installed) => installed.packageId === PACKAGE)?.directorySource;

  /** Every address the node fetched that is not this machine's loopback; none of them is reached. */
  let offLoopback: string[];

  beforeEach(() => {
    // The node's defaults: no index file, no feed of the person's own, and the official Marketplace on.
    setEnv("CC_DIRECTORY_INDEX");
    setEnv("CC_DIRECTORY_MARKETPLACES");
    setEnv("CC_OFFICIAL_MARKETPLACE");
    // A test run never reaches the live Marketplace: it answers as an unavailable one, and only loopback feeds are real.
    offLoopback = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin.startsWith("http://127.0.0.1")) return realFetch(input, init);
      offLoopback.push(url);
      return Promise.resolve(new Response("unavailable in tests", { status: 503 }));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(restoreEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      delete restoreEnv[name];
    }
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("activates and serves the folder on a fresh node whose Marketplace was never fetched", async () => {
    const conversationId = await conversation();
    const started = session(await call("POST", "/widget-dev/sessions", { root, conversationId }));
    expect(started).toMatchObject({ status: "live", activation: { state: "active", generation: 1 } });

    const frame = await live(conversationId, started.placed?.instanceId ?? "");
    expect(await served(frame.frame.url)).toContain("first");
  });

  it("refuses to activate while the person's index file cannot be read", async () => {
    const indexPath = join(dir, "index.json");
    writeFileSync(indexPath, "[ {broken");
    setEnv("CC_DIRECTORY_INDEX", indexPath);

    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.activation).toMatchObject({ state: "refused", code: "DIRECTORY_UNREADABLE" });
    expect(started.running).toBeUndefined();
    // The install looked for the listing in the Marketplace too, so the Marketplace was on.
    expect(offLoopback.some((url) => url.startsWith(OFFICIAL_MARKETPLACE_FEED_URL))).toBe(true);
  });

  it("names its own source, so an install from a row naming a marketplace never takes the session's build", async () => {
    const feedUrl = await startFeed();
    setEnv("CC_DIRECTORY_MARKETPLACES", feedUrl);

    // The feed was never fetched, so nothing tells the session the id and version are listed elsewhere.
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.activation).toMatchObject({ state: "active", generation: 1 });
    expect(installedSource()).toMatchObject({ id: "widget-dev", kind: "widget-dev" });

    // Fetched now, the marketplace lists the same id and version; the person presses Install on its card.
    await refreshDirectory({ env: process.env, dataDir: join(dir, "node") });
    expect(offLoopback.some((url) => url.startsWith(OFFICIAL_MARKETPLACE_FEED_URL))).toBe(true);
    const pressed = await call("POST", "/packages/install", { packageId: PACKAGE, version: VERSION, sourceId: customFeedId(feedUrl) });
    expect(pressed.status).toBe(409);
    expect(pressed.body).toMatchObject({ code: "DIRECTORY_SOURCE_CHANGED" });
    expect(installedSource()?.id).toBe("widget-dev");

    // And the session's next build is refused for the id the directory now lists.
    writePackage("<!doctype html><p>second</p>\n");
    const rebuilt = session(await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`));
    expect(rebuilt.activation).toMatchObject({ code: "PACKAGE_LISTED" });
  });
});
