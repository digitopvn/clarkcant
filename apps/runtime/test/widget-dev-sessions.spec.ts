import { spawn } from "node:child_process";
import type * as fs from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type * as os from "node:os";
import type * as core from "@clarkcant/core";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  TURN_ORIGINS,
  messageBlockSchema,
  type CommandCard,
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

import { SNAPSHOT_REMOVAL, createWidgetDevSessions } from "../src/application/widget-dev-sessions.ts";
import { WIDGET_DEV_STORE_MAX, readDevSessions, writeDevSessions } from "../src/application/widget-dev-store.ts";
import { createDevelopWidgetTool } from "../src/develop-widget-tool.ts";
import { hostText } from "../src/host-text.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";
import { holdDirectory } from "./hold-directory.ts";

/** A folder whose `stat` fails with `EPERM`, as an antivirus or indexer holding it on Windows makes it fail. */
const statFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));

/**
 * Seen as the runtime starts to remove a path, in either form, before the removal itself runs. The promise form waits
 * for what it returns, so a test can hold a removal (`options` are the ones the runtime asked for).
 */
const removal = vi.hoisted(() => ({ starting: undefined as ((path: string, options?: fs.RmOptions) => void | Promise<void>) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const statSync = ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (statFailure.path !== undefined && resolve(String(path)) === statFailure.path) {
      throw Object.assign(new Error(`EPERM: operation not permitted, stat '${String(path)}'`), { code: "EPERM" });
    }
    return actual.statSync(path, options);
  }) as typeof actual.statSync;
  const rmSync = ((path: fs.PathLike, options?: fs.RmOptions) => {
    void removal.starting?.(resolve(String(path)), options);
    actual.rmSync(path, options);
  }) as typeof actual.rmSync;
  return { ...actual, statSync, rmSync, default: { ...actual, statSync, rmSync } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const rm = (async (path: fs.PathLike, options?: fs.RmOptions) => {
    await removal.starting?.(resolve(String(path)), options);
    await actual.rm(path, options);
  }) as typeof actual.rm;
  return { ...actual, rm, default: { ...actual, rm } };
});

/** The removal itself, past the mock, for a test that tries a path once on its own. */
const { rm: actualRm } = await vi.importActual<typeof fsPromises>("node:fs/promises");

/** The home folder the node sees, when a test needs it to be one of the test's own folders. */
const homeOverride = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  const homedir = (): string => homeOverride.path ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

/** How many dev engines were closed, and an error the next ones throw as they close, as a watcher that will not let go. */
const engineClose = vi.hoisted(() => ({ calls: 0, throws: undefined as Error | undefined }));

vi.mock("@clarkcant/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  const startDevEngine: typeof actual.startDevEngine = (options) => {
    const engine = actual.startDevEngine(options);
    return {
      ...engine,
      close: () => {
        engine.close();
        engineClose.calls += 1;
        if (engineClose.throws !== undefined) throw engineClose.throws;
      },
    };
  };
  return { ...actual, startDevEngine };
});

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
/** The device and file id of the folder at `path` itself, as the session store keeps a chosen folder's. */
const idOf = (path: string): { dev: string; ino: string } => {
  const stat = lstatSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
};
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
  // Canonical, so a path the test builds is the folder itself (macOS reaches its temp folder through a link).
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clarkcant-widget-dev-")));
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

afterEach(async () => {
  statFailure.path = undefined;
  homeOverride.path = undefined;
  removal.starting = undefined;
  engineClose.throws = undefined;
  // A snapshot a session is still removing is finished (or given up on) before the database and the folder go.
  await services.widgetDev?.close();
  services.runtime.close();
  await removeTestDirectory(dir);
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
    // Said in the owner's language (Vietnamese by default), with what the person can do: choose the folder themselves,
    // on the card the answer carries or with /develop. A preference they have no way to write is never offered.
    expect(unset.text).toContain("“Phát triển thư mục này”");
    expect(unset.text).toContain("/develop");
    expect(unset.text).not.toMatch(/workspace\.roots|#538/);
    const english = hostText("en").approvals.devSessionRootNotOwned("/x", "/w");
    expect(english).toContain('press "Develop this folder" on the card, or type /develop');
    expect(english).not.toMatch(/workspace\.roots|#538|not available yet|copy its folder/);

    setRoots("agent");
    expect((await toolFor(conversationId).execute({ action: "start", root })).text).toContain("Not started");
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    setRoots("user");
    expect((await toolFor(conversationId).execute({ action: "start", root })).text).toContain("Running generation 1.");
  });

  it("offers the person a card for a folder Clark may not watch, and lets Clark work there once the person starts it", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });

    const offered = await toolFor(conversationId).execute({ action: "start", root: elsewhere });
    expect(offered.text).toContain("Not started");
    expect(offered.text).toContain("card offering to develop");
    // The card is the host's, valid as a message block, and names the folder Clark asked for; nothing started.
    const card = messageBlockSchema.parse(offered.hostBlocks?.[0]) as CommandCard;
    expect(card).toMatchObject({ type: "command-card", owner: "host", command: "develop" });
    expect(card.rows[0]).toMatchObject({ rowId: "proposed", label: elsewhere, actions: [{ action: { kind: "develop-folder", root: elsewhere } }] });
    expect(card.rows[1]?.actions[0]?.action).toEqual({ kind: "develop-folder" });
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    // The press on the card is the person's own start, on the person-only route: it marks the folder as theirs.
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId }));
    expect(started.activation).toMatchObject({ state: "active", generation: 1 });
    expect(readDevSessions(join(dir, "node")).find((stored) => stored.sessionId === started.sessionId)?.chosenByPerson).toBe(true);
    expect((await call("DELETE", `/widget-dev/sessions/${started.sessionId}`)).status).toBe(200);

    // Clark may now pick that folder up again, keeping the mark, and develop a folder inside it.
    expect((await toolFor(conversationId).execute({ action: "start", root: elsewhere })).text).toContain("Running generation 1.");
    expect(readDevSessions(join(dir, "node")).find((stored) => stored.sessionId === started.sessionId)).toMatchObject({
      status: "live",
      chosenByPerson: true,
      initiative: { kind: "clark" },
    });
    const inner = join(elsewhere, "inner");
    writePackage("<!doctype html><p>inner</p>\n", [], inner, { id: "com.example.inner" });
    expect((await toolFor(conversationId).execute({ action: "start", root: inner })).text).toContain("Running generation 1.");

    // A restart checks the folder again for whoever started the session, and Clark's session in the chosen folder stays live.
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    await services.widgetDev.resume();
    expect(session(await call("GET", `/widget-dev/sessions/${started.sessionId}`))).toMatchObject({ status: "live" });
  });

  it("never lets a session Clark starts mark its folder as chosen", async () => {
    const conversationId = await conversation();
    // Allowed by the person's project root only.
    const started = await toolFor(conversationId).execute({ action: "start", root });
    expect(started.text).toContain("Running generation 1.");
    const stored = readDevSessions(join(dir, "node"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.chosenByPerson).toBeUndefined();

    // Without that root, the folder Clark watched before is not one it may watch again: the person is asked to choose it.
    services.runtime.db.prepare("DELETE FROM preferences WHERE key = ?").run("workspace.roots");
    await call("DELETE", `/widget-dev/sessions/${stored[0]?.sessionId ?? ""}`);
    const again = await toolFor(conversationId).execute({ action: "start", root });
    expect(again.text).toContain("Not started");
    expect((again.hostBlocks?.[0] as CommandCard | undefined)?.command).toBe("develop");
  });

  it("does not follow a chosen folder swapped for a link to somewhere else", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId }));
    expect(services.widgetDev?.chosen()).toEqual([realpathSync.native(elsewhere)]);
    expect((await call("DELETE", `/widget-dev/sessions/${started.sessionId}`)).status).toBe(200);

    // The chosen folder is moved aside and a link to an unrelated folder takes its place.
    const unrelated = join(dir, "unrelated");
    writePackage("<!doctype html><p>unrelated</p>\n", [], join(unrelated, "inner"), { id: "com.example.unrelated" });
    renameSync(elsewhere, join(dir, "elsewhere", "moved"));
    symlinkSync(unrelated, elsewhere, process.platform === "win32" ? "junction" : "dir");

    // The stored choice no longer names the folder its path leads to, so it grants nothing, there or inside it.
    expect(services.widgetDev?.chosen()).toEqual([]);
    const through = await toolFor(conversationId).execute({ action: "start", root: join(elsewhere, "inner") });
    expect(through.text).toContain("Not started");
    expect((await toolFor(conversationId).execute({ action: "start", root: elsewhere })).text).toContain("Not started");
    expect((await call("GET", "/widget-dev/sessions")).body).toMatchObject({ sessions: [{ sessionId: started.sessionId, status: "stopped" }] });
  });

  it("names and starts the folder a path resolves to, and says so when it differs from the words given", () => {
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const real = realpathSync.native(elsewhere);
    const given = `${join(dir, "elsewhere", "timer")}${sep}..${sep}timer`;
    const card = services.widgetDev?.folderCard({ proposed: given, locale: "en" });
    const proposed = card?.rows.find((row) => row.rowId === "proposed");
    expect(proposed).toMatchObject({ label: real, actions: [{ action: { kind: "develop-folder", root: real } }] });
    expect(proposed?.note).toContain(`The path given was ${given}`);
    expect(proposed?.note).toContain("every folder inside it");
    expect(card?.detail).toContain("every folder inside it");

    // Through a link, the card shows where the link leads.
    const link = join(dir, "link");
    symlinkSync(elsewhere, link, process.platform === "win32" ? "junction" : "dir");
    const linked = services.widgetDev?.folderCard({ proposed: link, locale: "en" }).rows.find((row) => row.rowId === "proposed");
    expect(linked).toMatchObject({ label: real, actions: [{ action: { kind: "develop-folder", root: real } }] });
    expect(linked?.note).toContain(`The path given was ${link}`);

    // A path that names nothing now gets no button, and no promise about whatever may appear there later.
    const missing = join(dir, "missing");
    const nothing = services.widgetDev?.folderCard({ proposed: missing, locale: "en" }).rows[0];
    expect(nothing).toMatchObject({ rowId: "proposed", label: missing, actions: [] });
    expect(nothing?.note).toContain("not found on the node now");
    expect(nothing?.note).not.toContain("Afterwards Clark may also develop");
    // Nor does a relative path, or a network share or device path, which a press could only fail on.
    expect(services.widgetDev?.folderCard({ proposed: "projects/timer", locale: "en" }).rows[0]).toMatchObject({ actions: [], note: expect.stringContaining("not a full path") });
    if (process.platform === "win32") {
      for (const remote of ["\\\\host\\share\\timer", "\\\\?\\C:\\timer"]) {
        const row = services.widgetDev?.folderCard({ proposed: remote, locale: "en" }).rows[0];
        expect(row, remote).toMatchObject({ label: remote, actions: [], note: expect.stringContaining("network share or device path") });
      }
    }
    // With nothing to press on the offered row, choosing another folder is the card's first action.
    expect(services.widgetDev?.folderCard({ proposed: missing, locale: "en" }).rows[1]?.actions[0]).toMatchObject({ tone: "primary" });
  });

  it("keeps no choice when the folder the card showed has been swapped for a link before the press", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const card = services.widgetDev?.folderCard({ proposed: elsewhere, locale: "en" });
    const pressed = card?.rows[0]?.actions[0]?.action;
    expect(pressed).toEqual({ kind: "develop-folder", root: elsewhere });

    // Before the press, the folder is moved aside and a link to a wider folder takes its place.
    const wide = join(dir, "wide");
    writePackage("<!doctype html><p>wide</p>\n", [], wide, { id: "com.example.wide" });
    writePackage("<!doctype html><p>secret</p>\n", [], join(wide, "secret"), { id: "com.example.secret" });
    renameSync(elsewhere, join(dir, "elsewhere", "moved"));
    symlinkSync(wide, elsewhere, process.platform === "win32" ? "junction" : "dir");

    // The press still starts what the path leads to, as the person asked, but keeps nothing: the person saw another folder.
    const started = await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId });
    expect(started.status).toBe(201);
    expect(session(started)).toMatchObject({ root: wide });
    expect(session(started).chosenByPerson).toBeUndefined();
    expect(services.widgetDev?.chosen()).toEqual([]);
    expect((await toolFor(conversationId).execute({ action: "start", root: join(wide, "secret") })).text).toContain("Not started");

    // Pressing the folder by its own path is the person choosing it.
    const again = session(await call("POST", "/widget-dev/sessions", { root: wide, conversationId }));
    expect(again.chosenByPerson).toBe(true);
    expect(services.widgetDev?.chosen()).toEqual([wide]);
  });

  it("keeps no choice when a folder missing from the card appears there later as a link", async () => {
    const conversationId = await conversation();
    const later = join(dir, "elsewhere", "later");
    const card = services.widgetDev?.folderCard({ proposed: later, locale: "en" });
    expect(card?.rows[0]).toMatchObject({ rowId: "proposed", actions: [] });

    const wide = join(dir, "wide");
    writePackage("<!doctype html><p>wide</p>\n", [], wide, { id: "com.example.wide" });
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    symlinkSync(wide, later, process.platform === "win32" ? "junction" : "dir");

    // A path typed through the link starts the folder it leads to, without making it a choice.
    const started = await call("POST", "/widget-dev/sessions", { root: later, conversationId });
    expect(started.status).toBe(201);
    expect(session(started).chosenByPerson).toBeUndefined();
    expect(services.widgetDev?.chosen()).toEqual([]);
  });

  it("refuses to offer a folder to choose from a turn the person did not send, and still lists the chosen ones", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    for (const origin of TURN_ORIGINS.filter((candidate) => candidate !== "person")) {
      for (const params of [{ action: "choose", root: elsewhere }, { action: "choose" }]) {
        const refused = await toolFor(conversationId, origin).execute(params);
        expect(refused.hostBlocks, origin).toBeUndefined();
        expect(refused.text, origin).toContain("only a turn the person sent");
      }
      expect((await toolFor(conversationId, origin).execute({ action: "folders" })).hostBlocks, origin).toHaveLength(1);
    }
    expect((await toolFor(conversationId, "person").execute({ action: "choose", root: elsewhere })).hostBlocks).toHaveLength(1);
  });

  it("says a forgotten folder stays reachable through a chosen folder that holds it", async () => {
    const outer = join(dir, "elsewhere", "outer");
    const inner = join(outer, "inner");
    writePackage("<!doctype html><p>outer</p>\n", [], outer, { id: "com.example.outer" });
    writePackage("<!doctype html><p>inner</p>\n", [], inner, { id: "com.example.inner" });
    await call("POST", "/widget-dev/sessions", { root: outer });
    await call("POST", "/widget-dev/sessions", { root: inner });
    expect(services.widgetDev?.chosen()).toEqual([outer, inner]);

    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: inner })).body).toEqual({ root: inner, forgotten: true, stillCoveredBy: outer });
    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: inner })).body).toEqual({ root: inner, forgotten: false, stillCoveredBy: outer });
    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: outer })).body).toEqual({ root: outer, forgotten: true });
    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: inner })).body).toEqual({ root: inner, forgotten: false });
  });

  it("lists a chosen folder that is not found now, so the person can still forget it", async () => {
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere }));
    await call("DELETE", `/widget-dev/sessions/${started.sessionId}`);
    renameSync(elsewhere, join(dir, "elsewhere", "moved"));

    expect(services.widgetDev?.chosen()).toEqual([]);
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: false }]);
    const row = services.widgetDev?.folderCard({ locale: "en", only: "chosen" }).rows[0];
    expect(row).toMatchObject({ label: elsewhere, badge: { text: "not found now", tone: "warning" }, actions: [{ action: { kind: "develop-folder-forget", root: elsewhere } }] });
    expect(row?.note).toContain("not found at this path now");
    // Starting a new folder there is how it is chosen, said in both languages.
    expect(row?.note).toContain("A new folder at this path is chosen when you start developing it yourself");
    expect(services.widgetDev?.folderCard({ locale: "vi", only: "chosen" }).rows[0]?.note).toContain(
      "Một thư mục mới ở đường dẫn này được chọn khi chính bạn bắt đầu phát triển nó",
    );

    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: elsewhere })).body).toEqual({ root: elsewhere, forgotten: true });
    expect(services.widgetDev?.marked()).toEqual([]);
  });

  it("holds a chosen folder's mark to that folder: another folder made at its path does not count, the chosen one moved back does", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>chosen</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId }));
    expect(services.widgetDev?.chosen()).toEqual([elsewhere]);
    await call("DELETE", `/widget-dev/sessions/${started.sessionId}`);

    // The chosen folder is moved away, and a new real folder (no link) is made at its path.
    const moved = join(dir, "elsewhere", "moved");
    renameSync(elsewhere, moved);
    writePackage("<!doctype html><p>another</p>\n", [], elsewhere, { id: "com.example.another" });
    writePackage("<!doctype html><p>inner</p>\n", [], join(elsewhere, "inner"), { id: "com.example.inner" });

    expect(services.widgetDev?.chosen()).toEqual([]);
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: false }]);
    expect(services.widgetDev?.folderCard({ locale: "en", only: "chosen" }).rows[0]).toMatchObject({ badge: { text: "not found now" } });
    expect((await toolFor(conversationId).execute({ action: "start", root: elsewhere })).text).toContain("Not started");
    expect((await toolFor(conversationId).execute({ action: "start", root: join(elsewhere, "inner") })).text).toContain("Not started");

    // The chosen folder itself back at its path counts again.
    renameSync(elsewhere, join(dir, "elsewhere", "another"));
    renameSync(moved, elsewhere);
    expect(services.widgetDev?.chosen()).toEqual([elsewhere]);
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: true }]);
    expect((await toolFor(conversationId).execute({ action: "start", root: elsewhere })).text).toContain("Running generation 1.");
  });

  it("gives a mark stored without a folder id the id of the folder first found at its path, and holds it to that folder", async () => {
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>chosen</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere }));
    await call("DELETE", `/widget-dev/sessions/${started.sessionId}`);
    const store = join(dir, "node");
    const recorded = readDevSessions(store)[0]?.chosenFolderId;
    expect(recorded).toBeDefined();
    // As a store written before folder ids were kept: the mark, with no id.
    writeDevSessions(
      store,
      readDevSessions(store).map(({ chosenFolderId: _id, ...rest }) => rest),
    );

    // Missing at the first look, it is not found and takes no id.
    const moved = join(dir, "elsewhere", "moved");
    renameSync(elsewhere, moved);
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: false }]);
    expect(readDevSessions(store)[0]?.chosenFolderId).toBeUndefined();

    // Found at its path, it counts and takes that folder's id, which is the one the person's start recorded.
    renameSync(moved, elsewhere);
    expect(services.widgetDev?.chosen()).toEqual([elsewhere]);
    expect(readDevSessions(store)[0]?.chosenFolderId).toEqual(recorded);

    // From then on, another folder made at the path is not it.
    renameSync(elsewhere, moved);
    writePackage("<!doctype html><p>another</p>\n", [], elsewhere, { id: "com.example.another" });
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: false }]);
  });

  it("drops a chosen folder's id along with the mark when the person forgets it", async () => {
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>chosen</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere }));
    await call("DELETE", `/widget-dev/sessions/${started.sessionId}`);
    const store = join(dir, "node");
    expect(readDevSessions(store)[0]).toMatchObject({ chosenByPerson: true, chosenFolderId: idOf(elsewhere) });

    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: elsewhere })).body).toEqual({ root: elsewhere, forgotten: true });
    const forgotten = readDevSessions(store)[0];
    expect(forgotten?.sessionId).toBe(started.sessionId);
    expect(forgotten?.chosenByPerson).toBeUndefined();
    expect(forgotten?.chosenFolderId).toBeUndefined();
  });

  it("records the folder now at the path when the person starts a live session again after its folder was made again", async () => {
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>chosen</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere }));
    const store = join(dir, "node");
    const first = idOf(elsewhere);
    expect(readDevSessions(store)[0]?.chosenFolderId).toEqual(first);

    // The chosen folder is moved away and another folder is made at its path while the session is still live.
    renameSync(elsewhere, join(dir, "elsewhere", "moved"));
    writePackage("<!doctype html><p>another</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const second = idOf(elsewhere);
    expect(second).not.toEqual(first);
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: false }]);

    // The person's start picks up the live session and chooses the folder that is there now.
    const again = session(await call("POST", "/widget-dev/sessions", { root: elsewhere }));
    expect(again).toMatchObject({ sessionId: started.sessionId, status: "live" });
    expect(readDevSessions(store)[0]?.chosenFolderId).toEqual(second);
    expect(services.widgetDev?.marked()).toEqual([{ root: elsewhere, found: true }]);
  });

  it("stops a session Clark started in a chosen folder made again, at the next restart, and asks the person to choose it again", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>chosen</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const chosen = session(await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId }));
    await call("DELETE", `/widget-dev/sessions/${chosen.sessionId}`);
    expect((await toolFor(conversationId).execute({ action: "start", root: elsewhere })).text).toContain("Running generation 1.");

    // The node stops; meanwhile the chosen folder is replaced by another folder at the same path.
    await services.widgetDev?.close();
    renameSync(elsewhere, join(dir, "elsewhere", "moved"));
    writePackage("<!doctype html><p>another</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    await services.widgetDev.resume();

    const views = ((await call("GET", "/widget-dev/sessions")).body as { sessions: WidgetDevSessionView[] }).sessions;
    expect(views.find((view) => view.sessionId === chosen.sessionId)).toMatchObject({ status: "stopped", stopReason: "root-refused" });
    const card = services.widgetDev.folderCard({ locale: "en" });
    const row = card.rows.find((candidate) => candidate.rowId === `session:${chosen.sessionId}`);
    expect(row?.note).toContain("Press Develop again to choose the folder again");
    expect(row?.actions).toMatchObject([{ action: { kind: "develop-folder", root: elsewhere } }]);
    expect(services.widgetDev.folderCard({ locale: "vi" }).rows.find((candidate) => candidate.rowId === row?.rowId)?.note).toContain(
      "Bấm Phát triển lại để chọn lại thư mục",
    );

    // That press, the person's own start, chooses the folder now at the path.
    session(await call("POST", "/widget-dev/sessions", { root: elsewhere }));
    expect(services.widgetDev.chosen()).toEqual([elsewhere]);
  });

  it("warns that a whole drive or the home folder is watched for the session only, and keeps no choice of it", async () => {
    const drive = parse(dir).root;
    const driveRow = services.widgetDev?.folderCard({ proposed: drive, locale: "en" }).rows[0];
    expect(driveRow?.note).toContain("whole drive");
    expect(driveRow?.note).not.toContain("Afterwards Clark may also develop");

    // The home folder is the test's own folder here, so a session can start in it.
    const home = join(dir, "home");
    writePackage("<!doctype html><p>home</p>\n", [], home, { id: "com.example.home" });
    homeOverride.path = home;
    const homeRow = services.widgetDev?.folderCard({ proposed: home, locale: "en" }).rows[0];
    expect(homeRow?.note).toContain("your home folder");
    const started = session(await call("POST", "/widget-dev/sessions", { root: home }));
    expect(started.activation).toMatchObject({ state: "active", generation: 1 });
    expect(readDevSessions(join(dir, "node")).find((stored) => stored.sessionId === started.sessionId)?.chosenByPerson).toBeUndefined();
    expect(services.widgetDev?.chosen()).toEqual([]);
    // Started again by the person, it is still not kept.
    await call("DELETE", `/widget-dev/sessions/${started.sessionId}`);
    await call("POST", "/widget-dev/sessions", { root: home });
    expect(services.widgetDev?.chosen()).toEqual([]);
  });

  it("lets the person forget a folder they chose, and nothing else forget it for them", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });
    const started = session(await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId }));
    await call("DELETE", `/widget-dev/sessions/${started.sessionId}`);
    const real = realpathSync.native(elsewhere);

    // The card lists the chosen folder, with what it covers and a way to take it back.
    const listed = services.widgetDev?.folderCard({ locale: "en", only: "chosen" });
    expect(listed).toMatchObject({ command: "develop", title: "Folders Clark may develop in" });
    expect(listed?.rows).toEqual([
      expect.objectContaining({ label: real, note: expect.stringContaining("every folder inside it"), actions: [expect.objectContaining({ action: { kind: "develop-folder-forget", root: real } })] }),
    ]);

    for (const surface of ["mcp", "relay", "cli-api"]) {
      const refused = await call("POST", "/widget-dev/chosen-folders/forget", { root: real }, { "x-clarkcant-surface": surface });
      expect(refused.status, surface).toBe(403);
      expect(refused.body, surface).toMatchObject({ code: "PERSON_ONLY" });
    }
    expect(services.widgetDev?.chosen()).toEqual([real]);
    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: "relative" })).status).toBe(400);
    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: real, extra: 1 })).status).toBe(400);
    expect((await call("GET", "/widget-dev/chosen-folders/forget")).status).toBe(405);

    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: elsewhere })).body).toEqual({ root: real, forgotten: true });
    expect(services.widgetDev?.chosen()).toEqual([]);
    expect(readDevSessions(join(dir, "node")).find((stored) => stored.sessionId === started.sessionId)?.chosenByPerson).toBeUndefined();
    const refused = await toolFor(conversationId).execute({ action: "start", root: elsewhere });
    expect(refused.text).toContain("Not started");
    // Forgetting is idempotent, and leaves the empty list saying so.
    expect((await call("POST", "/widget-dev/chosen-folders/forget", { root: real })).body).toEqual({ root: real, forgotten: false });
    expect(services.widgetDev?.folderCard({ locale: "en", only: "chosen" })).toMatchObject({ rows: [], empty: "You have not chosen any folder for Clark." });
  });

  it("shows the person the folder card and the chosen folders when asked in words", async () => {
    const conversationId = await conversation();
    const elsewhere = join(dir, "elsewhere", "timer");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], elsewhere, { id: "com.example.elsewhere" });

    const offered = await toolFor(conversationId).execute({ action: "choose", root: elsewhere });
    const card = messageBlockSchema.parse(offered.hostBlocks?.[0]) as CommandCard;
    expect(card.rows[0]).toMatchObject({ rowId: "proposed", actions: [{ action: { kind: "develop-folder", root: realpathSync.native(elsewhere) } }] });
    const blank = messageBlockSchema.parse((await toolFor(conversationId).execute({ action: "choose" })).hostBlocks?.[0]) as CommandCard;
    expect(blank.rows[0]).toMatchObject({ rowId: "choose", actions: [{ action: { kind: "develop-folder" } }] });
    // Showing a card starts nothing.
    expect((await call("GET", "/widget-dev/sessions")).body).toEqual({ sessions: [] });

    await call("POST", "/widget-dev/sessions", { root: elsewhere, conversationId });
    const folders = messageBlockSchema.parse((await toolFor(conversationId).execute({ action: "folders" })).hostBlocks?.[0]) as CommandCard;
    expect(folders.rows.map((row) => row.actions[0]?.action)).toEqual([{ kind: "develop-folder-forget", root: realpathSync.native(elsewhere) }]);
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

  it("removes a superseded snapshot that is held for a moment, as a file still open on Windows holds it", async () => {
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    const local = join(dir, "node", "package-cache", "local");
    const [first] = readdirSync(local);
    if (first === undefined) throw new Error("the first build left no snapshot");
    const firstPath = resolve(local, first);
    // On Windows a directory that is someone's working directory cannot be removed until they let go; elsewhere the
    // hold changes nothing. Not timed against the retries: one attempt without them meets the hold, the holder is let go
    // and has exited, and only then does the removal the runtime asked for run, so its outcome never depends on load.
    const hold = holdDirectory(firstPath);
    await hold.ready;
    let released: Promise<void> | undefined;
    let asked: fs.RmOptions | undefined;
    let held: string | undefined;
    removal.starting = async (path, options) => {
      if (path !== firstPath || released !== undefined) return;
      asked = options;
      held = await actualRm(path, { ...options, maxRetries: 0 }).then(
        () => undefined,
        (cause: unknown) => (cause as NodeJS.ErrnoException).code,
      );
      released = hold.release();
      await released;
    };
    try {
      // The second build supersedes the first, which stays as the generation a rollback returns to; the third prunes it.
      for (const text of ["second", "third"]) {
        writePackage(`<!doctype html><p>${text}</p>\n`);
        expect(session(await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`)).running?.generation).toBeGreaterThan(1);
      }
      expect(released).toBeDefined();
      // The removal retries a held file (the promise form; `rmSync` would not), for the budget the runtime names.
      expect(asked).toMatchObject(SNAPSHOT_REMOVAL);
      // Node waits `retryDelay` ms longer on each retry, so the options passed wait this long in all: at least a second.
      const retries = asked?.maxRetries ?? 0;
      const delay = asked?.retryDelay ?? 100;
      expect((delay * retries * (retries + 1)) / 2).toBeGreaterThanOrEqual(1_000);
      if (process.platform === "win32") expect(held).toMatch(/^(EBUSY|EPERM)$/);
      expect(existsSync(firstPath)).toBe(false);
      // Removed, so no longer on the session's list of snapshots to try again.
      const listed = readDevSessions(join(dir, "node"))[0]?.snapshots ?? [];
      expect(listed).toHaveLength(2);
      expect(listed.some((digest) => digest.endsWith(first))).toBe(false);
    } finally {
      removal.starting = undefined;
      await (released ?? hold.release());
    }
  });

  /** Start pruning the first build's snapshot and hold its removal until `finish` is called. */
  async function holdPrune(): Promise<{ firstPath: string; rebuilding: Promise<GatewayResponse>; finish: () => void; removed: () => boolean }> {
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    const local = join(dir, "node", "package-cache", "local");
    const [first] = readdirSync(local);
    if (first === undefined) throw new Error("the first build left no snapshot");
    const firstPath = resolve(local, first);
    let removing = (): void => undefined;
    const removingStarted = new Promise<void>((done) => {
      removing = done;
    });
    let finish = (): void => undefined;
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    let removed = false;
    removal.starting = async (path) => {
      if (path !== firstPath) return;
      removing();
      await gate;
      // Marked once the removal itself may run; `existsSync` says when it has.
      removed = true;
    };
    writePackage("<!doctype html><p>second</p>\n");
    await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    // The third build supersedes the second, so the first is pruned, and its removal waits on the gate.
    writePackage("<!doctype html><p>third</p>\n");
    const rebuilding = call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    await removingStarted;
    return { firstPath, rebuilding, finish, removed: () => removed };
  }

  it("waits on close for a superseded snapshot still being removed", async () => {
    const { firstPath, rebuilding, finish } = await holdPrune();
    let closed = false;
    const closing = Promise.resolve(services.widgetDev?.close()).then(() => {
      closed = true;
    });
    await new Promise((done) => setTimeout(done, 100));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(existsSync(firstPath)).toBe(false);
    expect((await rebuilding).status).toBe(200);
  });

  it("stops waiting on close after its bound, so a removal that does not end cannot hold a shutdown", async () => {
    await services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false, closeWaitMs: 200 });
    const { firstPath, rebuilding, finish, removed } = await holdPrune();
    const before = Date.now();
    await services.widgetDev.close();
    expect(Date.now() - before).toBeGreaterThanOrEqual(150);
    expect(removed()).toBe(false);
    expect(existsSync(firstPath)).toBe(true);
    // Let it end, so the folder is free before the test's own cleanup.
    finish();
    expect((await rebuilding).status).toBe(200);
    expect(existsSync(firstPath)).toBe(false);
  });

  it("starts no further removal once closing, so several held snapshots cannot outlast the close bound", async () => {
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    // A snapshot's removal fails for now, as a file held past its retries makes it fail, so it is left over to try again.
    const local = join(dir, "node", "package-cache", "local");
    const snapshots = new Set<string>();
    removal.starting = (path) => {
      if (snapshots.has(path)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };
    for (const text of ["second", "third"]) {
      for (const name of readdirSync(local)) snapshots.add(resolve(local, name));
      writePackage(`<!doctype html><p>${text}</p>\n`);
      expect((await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`)).status).toBe(200);
    }
    expect(readDevSessions(join(dir, "node"))[0]?.snapshots).toHaveLength(3);

    // The fourth build prunes two: the one left over and the one past the rollback. The first removal is held.
    const attempts: string[] = [];
    let removing = (): void => undefined;
    const removingStarted = new Promise<void>((done) => {
      removing = done;
    });
    let finish = (): void => undefined;
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    for (const name of readdirSync(local)) snapshots.add(resolve(local, name));
    removal.starting = async (path) => {
      // Only the snapshots: the build itself removes a staging folder of its own.
      if (!snapshots.has(path)) return;
      attempts.push(path);
      if (attempts.length > 1) return;
      removing();
      await gate;
    };
    writePackage("<!doctype html><p>fourth</p>\n");
    const rebuilding = call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    await removingStarted;
    const closing = services.widgetDev?.close();
    finish();
    await closing;
    expect((await rebuilding).status).toBe(200);
    // The removal in flight ended; the other was not started, and stays listed for the next prune.
    expect(attempts).toHaveLength(1);
    expect(readDevSessions(join(dir, "node"))[0]?.snapshots).toHaveLength(3);
  });

  it("keeps the newest build's snapshot when the node closes as the answer the session waited on comes in", async () => {
    askEveryInstall();
    const asked = session(await call("POST", "/widget-dev/sessions", { root }));
    const approvalId = asked.activation.state === "awaiting-approval" ? asked.activation.approvalId : "";
    const local = join(dir, "node", "package-cache", "local");
    const before = new Set(readdirSync(local));
    // The newest build is neither what runs nor what waits: only the session's engine names it.
    writePackage("<!doctype html><p>second</p>\n");
    const waiting = session(await call("POST", `/widget-dev/sessions/${asked.sessionId}/rebuild`));
    expect(waiting.activation).toMatchObject({ state: "awaiting-approval", generation: 1 });
    const newest = readdirSync(local).filter((name) => !before.has(name));
    expect(newest).toHaveLength(1);
    const row = services.runtime.db.prepare("SELECT operation_digest FROM approvals WHERE approval_id = ?").get(approvalId) as { operation_digest: string };
    expect((await call("POST", `/packages/approvals/${approvalId}/decision`, { decision: "granted", digest: row.operation_digest })).status).toBe(200);
    await services.widgetDev?.close();
    await new Promise((done) => setTimeout(done, 100));
    expect(existsSync(join(local, newest[0] ?? ""))).toBe(true);
  });

  it("ends every session, and resolves, on a close where a watcher fails to let go", async () => {
    const other = join(dir, "projects", "clock");
    writePackage("<!doctype html><p>clock</p>\n", [], other);
    expect((await call("POST", "/widget-dev/sessions", { root })).status).toBe(201);
    expect((await call("POST", "/widget-dev/sessions", { root: other })).status).toBe(201);
    engineClose.calls = 0;
    engineClose.throws = new Error("the watcher would not let go");
    await expect(Promise.resolve(services.widgetDev?.close())).resolves.toBeUndefined();
    expect(engineClose.calls).toBe(2);
  });

  it("watches nothing once closed, neither for a resume still going through the store nor for a late start", async () => {
    await services.widgetDev?.close();
    const at = new Date().toISOString();
    const folders = ["w0", "w1"].map((name) => join(dir, "projects", name));
    for (const folder of folders) mkdirSync(folder, { recursive: true });
    writeDevSessions(
      join(dir, "node"),
      folders.map((folder, index) => ({ sessionId: `wdev_${String(index)}`, root: folder, status: "live" as const, startedAt: at })),
    );
    const sessions = createWidgetDevSessions(() => services, { watch: false });
    services.widgetDev = sessions;
    // The first session is watched at once; the node closes while its first build is followed.
    const resuming = sessions.resume();
    await sessions.close();
    await resuming;
    // Only a watched session rebuilds; both stay live in the store, for the next boot to resume.
    for (const sessionId of ["wdev_0", "wdev_1"]) expect(await sessions.rebuild(sessionId)).toMatchObject({ ok: false, code: "SESSION_STOPPED" });
    expect(readDevSessions(join(dir, "node")).map((stored) => stored.status)).toEqual(["live", "live"]);

    expect(await sessions.start({ root })).toMatchObject({ ok: false, status: 503, code: "WIDGET_DEV_UNAVAILABLE" });
    expect(readDevSessions(join(dir, "node")).some((stored) => stored.root === root)).toBe(false);
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
    await removeTestDirectory(root);
    const rebuilt = await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    expect(rebuilt.status).toBe(200);
    expect(session(rebuilt)).toMatchObject({ status: "stopped", stopReason: "folder-gone", activation: { state: "active", generation: 1 } });
  });

  it("stops a watched session as folder-gone when its folder is deleted, though the platform may report nothing", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    await removeTestDirectory(root);
    // Bounded: the node looks for the folder at least once a second (`DEV_ENGINE_ROOT_CHECK_MS`), and on every change.
    const stopped = await eventually(started.sessionId, (view) => view.status === "stopped");
    expect(stopped).toMatchObject({ status: "stopped", stopReason: "folder-gone", activation: { state: "active", generation: 1 } });
  });

  it("keeps a watched session live, and builds the new folder, when its folder is deleted and made again before anything looks", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    // In one turn of the event loop: the path names a folder again, but not the one being watched. Synchronous on purpose,
    // so nothing looks between the delete and the new folder; no retries are asked for, since `rmSync` would not run them.
    rmSync(root, { recursive: true, force: true });
    writePackage("<!doctype html><p>a new folder</p>\n");
    const rebuilt = await eventually(started.sessionId, (view) => view.activation.state === "active" && view.activation.generation === 2);
    expect(rebuilt).toMatchObject({ status: "live", activation: { state: "active", generation: 2 } });

    // The new folder is the one watched: a save in it builds and runs.
    writePackage("<!doctype html><p>saved in the new folder</p>\n");
    const saved = await eventually(started.sessionId, (view) => view.activation.state === "active" && view.activation.generation === 3);
    expect(saved).toMatchObject({ status: "live", activation: { state: "active", generation: 3 } });
  });

  it("keeps a watched session live when another process deletes its folder and makes it again a moment later", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    // As `rmdir /s /q out && xcopy source out` in a terminal: another process, and a moment with no folder at the path.
    const source = join(dir, "source");
    writePackage("<!doctype html><p>made again by another process</p>\n", [], source);
    const script = [
      "const fs = require('node:fs');",
      "const [out, from] = process.argv.slice(1);",
      "fs.rmSync(out, { recursive: true, force: true });",
      "setTimeout(() => fs.cpSync(from, out, { recursive: true }), 400);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, root, source], { stdio: "ignore" });
    expect(await new Promise((done) => child.on("exit", done))).toBe(0);

    const rebuilt = await eventually(started.sessionId, (view) => view.status === "stopped" || (view.activation.state === "active" && view.activation.generation === 2));
    expect(rebuilt).toMatchObject({ status: "live", activation: { state: "active", generation: 2 } });
  });

  it("keeps a watched session live when a build runs while another process makes its folder again, and builds it once back", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    const source = join(dir, "source");
    writePackage("<!doctype html><p>made again by another process</p>\n", [], source);
    const script = [
      "const fs = require('node:fs');",
      "const [out, from] = process.argv.slice(1);",
      "fs.rmSync(out, { recursive: true, force: true });",
      "setTimeout(() => fs.cpSync(from, out, { recursive: true }), 800);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, root, source], { stdio: "ignore" });
    const exited = new Promise((done) => child.on("exit", done));

    // A rebuild asked for while no folder is at the path waits for it rather than failing on the missing files, and
    // answers with the one build made once it is back.
    const deadline = Date.now() + 5_000;
    while (existsSync(root) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
    expect(existsSync(root)).toBe(false);
    const during = await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    expect(during.status).toBe(200);
    expect(session(during)).toMatchObject({
      status: "live",
      lastBuild: { ok: true, trigger: "rebuild", generation: 2 },
      activation: { state: "active", generation: 2 },
    });
    expect(await exited).toBe(0);
  });

  it("stops a watched session as watch-failed when its folder cannot be looked at for the time bound, and keeps what runs", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20, rootUnreadableMs: 300 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    // The engine looks at the canonical path a start stores (on macOS, `/private/var/...` for a `/var/...` temp folder).
    statFailure.path = realpathSync.native(root);
    // Bounded: the node looks at the folder once a second, so the bound is passed on the second look at the latest.
    const stopped = await eventually(started.sessionId, (view) => view.status === "stopped");
    expect(stopped).toMatchObject({ status: "stopped", stopReason: "watch-failed", activation: { state: "active", generation: 1 } });
  });

  it("keeps a watched session live through a folder it cannot look at for a moment", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    // The engine looks at the canonical path a start stores (on macOS, `/private/var/...` for a `/var/...` temp folder).
    statFailure.path = realpathSync.native(root);
    const rebuilt = await call("POST", `/widget-dev/sessions/${started.sessionId}/rebuild`);
    expect(rebuilt.status).toBe(200);
    expect(session(rebuilt).status).toBe("live");
    statFailure.path = undefined;

    // Still watched: the next save builds and runs.
    writePackage("<!doctype html><p>second</p>\n");
    const next = await eventually(started.sessionId, (view) => view.activation.state === "active" && view.activation.generation === 2);
    expect(next).toMatchObject({ status: "live", activation: { state: "active", generation: 2 } });
  });

  it("stops a watched session as folder-gone when a folder above it is swapped for a link to another tree, and builds nothing there", async () => {
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: true, answerPollMs: 20 });
    const started = session(await call("POST", "/widget-dev/sessions", { root }));
    expect(started.status).toBe("live");

    // `projects/timer` now leads, through `projects`, to a tree the person never chose for this session.
    const elsewhere = join(dir, "elsewhere");
    writePackage("<!doctype html><p>elsewhere</p>\n", [], join(elsewhere, "timer"), { id: "com.example.elsewhere" });
    const projects = join(dir, "projects");
    rmSync(projects, { recursive: true, force: true });
    symlinkSync(elsewhere, projects, process.platform === "win32" ? "junction" : "dir");

    const stopped = await eventually(started.sessionId, (view) => view.status === "stopped");
    expect(stopped).toMatchObject({ status: "stopped", stopReason: "folder-gone", packageId: PACKAGE, activation: { state: "active", generation: 1 } });
  });

  it("says a folder that is there but cannot be read cannot be read, at a start and at a resume", async () => {
    // A start and a resume look at the path as given, before it is made canonical.
    statFailure.path = resolve(root);
    const refused = await call("POST", "/widget-dev/sessions", { root });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "ROOT_UNREADABLE" });
    expect((refused.body as { message: string }).message).toContain("cannot be read on this node (EPERM)");

    writeDevSessions(join(dir, "node"), [{ sessionId: "wdev_unreadable", root, status: "live" as const, startedAt: new Date().toISOString() }]);
    services.widgetDev?.close();
    services.widgetDev = createWidgetDevSessions(() => services, { watch: false });
    await services.widgetDev.resume();
    const views = ((await call("GET", "/widget-dev/sessions")).body as { sessions: WidgetDevSessionView[] }).sessions;
    expect(views.find((view) => view.sessionId === "wdev_unreadable")).toMatchObject({ status: "stopped", stopReason: "watch-failed" });
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
