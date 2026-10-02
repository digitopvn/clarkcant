import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityRef, EGRESS_ERROR_CODES, type ServiceConnectionRequirement } from "@clarkcant/contracts";
import { getCapability } from "@clarkcant/core";
import { McpServerRequestError } from "@clarkcant/mcp-adapters";
import { type Database, getPackageConnection, migrate, openDatabase, packageConnectionTokens } from "@clarkcant/storage";

import { type CapabilityInvokeDeps, invokeCapability } from "../src/application/capability-invoke.ts";
import { type ConnectionAuditEvent, createPackageConnectionBroker, type PackageConnectionBroker } from "../src/package-connections.ts";
import { type EgressAuditEvent, egressRequestHandler } from "../src/service-egress.ts";
import { createServiceHost, type ServiceHost, type ServiceLauncher } from "../src/service-host.ts";
import { startFakeConnector } from "../../../examples/reference-apps/connected-app/dev/fake-connector.mjs";

/**
 * A package's account connection on the node, against the reference app's fake connector (a test fixture with real
 * PKCE, state, scope grants, refresh rotation and revocation on loopback).
 *
 * What is under test is the node's side: the broker that connects, refreshes and revokes and never lets a token out;
 * the egress path that adds the token to the service's request itself; and the service host's readiness, per capability,
 * which turns every change in the connection into "ready" or "not ready, because …" at once.
 */

const PRINCIPAL = "prin_owner";
const NODE = "node_a";
const PACKAGE = "com.clarkcant.reference.connected-app";
const GENERATION = `${PACKAGE}@1.0.0:code_1`;
const LIST = `${PACKAGE}.list-tasks@1` as CapabilityRef;
const UPDATE = `${PACKAGE}.update-task@1` as CapabilityRef;
const REFERENCE = fileURLToPath(new URL("../../../examples/reference-apps/connected-app/", import.meta.url));
const REDIRECT = `http://127.0.0.1:4100/connections/callback/${encodeURIComponent(PACKAGE)}`;

type Connector = Awaited<ReturnType<typeof startFakeConnector>>;

let dir: string;
let db: Database;
let connector: Connector;
let clock: number;
let counter: number;
let audit: ConnectionAuditEvent[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-connections-"));
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  connector = await startFakeConnector();
  clock = Date.UTC(2026, 9, 2, 9, 0, 0);
  counter = 0;
  audit = [];
});

afterEach(async () => {
  await connector.close();
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The reference package's connection, pointed at the fake connector's real port. */
function requirement(overrides: Partial<ServiceConnectionRequirement> = {}): ServiceConnectionRequirement {
  const manifest = JSON.parse(readFileSync(join(REFERENCE, "clarkcant.json"), "utf8").replaceAll("http://127.0.0.1:8880", connector.origin)) as {
    facets: { kind: string; connection?: ServiceConnectionRequirement }[];
  };
  const declared = manifest.facets.find((facet) => facet.kind === "tools")?.connection;
  if (declared === undefined) throw new Error("the reference app declares a connection");
  return { ...declared, ...overrides };
}

function broker(options: { allowPrivateNetwork?: boolean; fetch?: typeof fetch } = {}): PackageConnectionBroker {
  return createPackageConnectionBroker({
    db,
    principalId: PRINCIPAL,
    newId: (prefix) => `${prefix}_${String(++counter)}`,
    now: () => clock,
    allowPrivateNetwork: options.allowPrivateNetwork ?? true,
    audit: (event) => audit.push(event),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** A fetch that lets a test step in when the node asks the provider to renew a token. */
function onRefresh(step: (forward: () => Promise<Response>) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const forward = () => fetch(input, init);
    return body.includes("grant_type=refresh_token") ? await step(forward) : await forward();
  };
}

/** Start an authorization, follow the provider's consent as the system browser would, and complete it. */
async function connect(nodeBroker: PackageConnectionBroker, connection = requirement()) {
  const started = nodeBroker.start({ packageId: PACKAGE, connection, redirectUri: REDIRECT });
  if (!started.ok) throw new Error(started.message);
  const consent = await fetch(started.authorizationUrl, { redirect: "manual" });
  const back = new URL(consent.headers.get("location") ?? "");
  const query = Object.fromEntries(back.searchParams.entries());
  return { query, result: await nodeBroker.complete(PACKAGE, query) };
}

function tokens(): { accessToken?: string; refreshToken?: string } {
  const stored = getPackageConnection(db, PRINCIPAL, PACKAGE);
  return stored === undefined ? {} : packageConnectionTokens(db, stored.connectionRef);
}

describe("connecting a package to an account", () => {
  it("asks for PKCE with a single-use state, keeps the tokens on the node, and reports only status", async () => {
    const nodeBroker = broker();
    const connection = requirement();
    const started = nodeBroker.start({ packageId: PACKAGE, connection, redirectUri: REDIRECT });
    if (!started.ok) throw new Error(started.message);
    const url = new URL(started.authorizationUrl);
    expect(url.origin).toBe(connector.origin);
    expect(Object.fromEntries(url.searchParams.entries())).toMatchObject({
      response_type: "code",
      client_id: "connected-app-dev",
      redirect_uri: REDIRECT,
      scope: "tasks.read tasks.write",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const consent = await fetch(started.authorizationUrl, { redirect: "manual" });
    const query = Object.fromEntries(new URL(consent.headers.get("location") ?? "").searchParams.entries());
    const result = await nodeBroker.complete(PACKAGE, query);
    expect(result).toMatchObject({ ok: true, packageId: PACKAGE, status: { state: "connected", missingScopes: [] } });
    expect(tokens().accessToken).toMatch(/^fake-access-/);
    expect(tokens().refreshToken).toMatch(/^fake-refresh-/);

    // The state was used: the same redirect again completes nothing.
    expect(await nodeBroker.complete(PACKAGE, query)).toMatchObject({ ok: false });
    // Nothing a person, a widget or the trail sees holds a code or a token.
    const seen = JSON.stringify([result, nodeBroker.status(PACKAGE, connection), audit]);
    for (const secret of connector.secrets()) expect(seen).not.toContain(secret);
  });

  it("refuses a redirect carrying a state it never issued, before the code goes anywhere", async () => {
    const nodeBroker = broker();
    const outcome = await nodeBroker.complete(PACKAGE, { state: "forged", code: "fake-code-x" });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome).not.toHaveProperty("packageId");
    expect(getPackageConnection(db, PRINCIPAL, PACKAGE)).toBeUndefined();
  });

  it("sends no code to the token endpoint when the answer comes back to another package's callback", async () => {
    let exchanged = 0;
    const nodeBroker = broker({
      fetch: async (input, init) => {
        if (typeof init?.body === "string" && init.body.includes("grant_type=authorization_code")) exchanged += 1;
        return await fetch(input, init);
      },
    });
    const started = nodeBroker.start({ packageId: PACKAGE, connection: requirement(), redirectUri: REDIRECT });
    if (!started.ok) throw new Error(started.message);
    const consent = await fetch(started.authorizationUrl, { redirect: "manual" });
    const query = Object.fromEntries(new URL(consent.headers.get("location") ?? "").searchParams.entries());
    expect(await nodeBroker.complete("com.example.other", query)).toMatchObject({ ok: false, packageId: PACKAGE });
    expect(exchanged).toBe(0);
    expect(getPackageConnection(db, PRINCIPAL, PACKAGE)).toBeUndefined();
  });

  it("names the scope a partial grant left out, and only capabilities needing it are not ready", async () => {
    connector.setMode({ grantScopes: ["tasks.read"] });
    const nodeBroker = broker();
    const { result } = await connect(nodeBroker);
    expect(result).toMatchObject({ ok: true, status: { state: "partial", grantedScopes: ["tasks.read"], missingScopes: ["tasks.write"] } });
    expect(nodeBroker.problem(PACKAGE, requirement(), ["tasks.read"])).toBeUndefined();
    expect(nodeBroker.problem(PACKAGE, requirement(), ["tasks.write"])).toBe(
      "the Fake Tasks (test fixture) account did not grant tasks.write; reconnect it in Settings and allow it",
    );
  });

  it("keeps nothing when the person denies, or when the account does not answer the probe", async () => {
    connector.setMode({ denyWith: "access_denied" });
    const denied = await connect(broker());
    expect(denied.result).toMatchObject({ ok: false, packageId: PACKAGE });
    expect(denied.result.ok ? "" : denied.result.message).toContain("access_denied");
    connector.setMode({ denyWith: null });

    const probeless = await connect(broker(), requirement({ probe: { url: `${connector.origin}/api/nowhere` } }));
    expect(probeless.result.ok ? "" : probeless.result.message).toContain("checking the account failed (it answered 404)");
    expect(getPackageConnection(db, PRINCIPAL, PACKAGE)).toBeUndefined();
  });

  it("does not send a person to a loopback provider unless the node allows private addresses", () => {
    const outcome = broker({ allowPrivateNetwork: false }).start({ packageId: PACKAGE, connection: requirement(), redirectUri: REDIRECT });
    expect(outcome).toMatchObject({ ok: false, code: "ENDPOINT_REFUSED" });
  });
});

describe("a connection over time", () => {
  it("renews a token about to lapse before it is used", async () => {
    const nodeBroker = broker();
    await connect(nodeBroker);
    const first = tokens().accessToken;
    clock += 3_600_000;
    const credential = await nodeBroker.credential(PACKAGE, requirement());
    expect(credential.ok).toBe(true);
    expect(credential.ok ? credential.token : "").not.toBe(first);
    expect(nodeBroker.status(PACKAGE, requirement()).state).toBe("connected");
  });

  it("reads expired, with the reason, when the provider will not renew it", async () => {
    const nodeBroker = broker();
    await connect(nodeBroker);
    connector.setMode({ refreshFails: true });
    clock += 3_600_000;
    const credential = await nodeBroker.credential(PACKAGE, requirement());
    expect(credential).toEqual({ ok: false, reason: "the Fake Tasks (test fixture) connection expired; reconnect it in Settings" });
    expect(nodeBroker.status(PACKAGE, requirement())).toMatchObject({ state: "expired" });
    expect(tokens()).toEqual({});
  });

  it("reads revoked after the provider refuses the token and the refresh, and keeps no token", async () => {
    const nodeBroker = broker();
    await connect(nodeBroker);
    connector.revokeAll();
    await nodeBroker.rejected(PACKAGE, requirement(), String(tokens().accessToken));
    expect(nodeBroker.status(PACKAGE, requirement())).toMatchObject({ state: "revoked", reason: "the provider no longer accepts the connection" });
    expect(nodeBroker.problem(PACKAGE, requirement(), ["tasks.read"])).toBe(
      "the Fake Tasks (test fixture) connection was revoked; reconnect it in Settings",
    );
    expect(tokens()).toEqual({});
  });

  it("revokes at the provider and on the node at once when the person revokes it", async () => {
    const nodeBroker = broker();
    await connect(nodeBroker);
    const access = tokens().accessToken;
    const status = await nodeBroker.revoke(PACKAGE, requirement());
    expect(status).toMatchObject({ state: "revoked", reason: "you revoked it in Settings" });
    expect((await fetch(`${connector.origin}/api/me`, { headers: { authorization: `Bearer ${String(access)}` } })).status).toBe(401);

    // Reconnecting brings it back.
    const again = await connect(nodeBroker);
    expect(again.result).toMatchObject({ ok: true, status: { state: "connected" } });
  });

  it("forgets the connection with its package", async () => {
    const nodeBroker = broker();
    await connect(nodeBroker);
    await nodeBroker.forget(PACKAGE, requirement());
    expect(getPackageConnection(db, PRINCIPAL, PACKAGE)).toBeUndefined();
    expect(nodeBroker.status(PACKAGE, requirement()).state).toBe("not-connected");
  });

  it("lets no authorization started before an uninstall finish into a connection afterwards", async () => {
    const nodeBroker = broker();
    const started = nodeBroker.start({ packageId: PACKAGE, connection: requirement(), redirectUri: REDIRECT });
    if (!started.ok) throw new Error(started.message);
    const consent = await fetch(started.authorizationUrl, { redirect: "manual" });
    const query = Object.fromEntries(new URL(consent.headers.get("location") ?? "").searchParams.entries());
    await nodeBroker.forget(PACKAGE, requirement());
    expect(await nodeBroker.complete(PACKAGE, query)).toMatchObject({ ok: false });
    expect(getPackageConnection(db, PRINCIPAL, PACKAGE)).toBeUndefined();
  });

  it("ends the connection, sending nothing anywhere, when a new version points its tokens elsewhere", async () => {
    let sent = 0;
    const nodeBroker = broker({
      fetch: async (input, init) => {
        if (new URL(input instanceof Request ? input.url : String(input)).hostname === "tokens.example.net") sent += 1;
        return await fetch(input, init);
      },
    });
    await connect(nodeBroker);
    const moved = requirement();
    const elsewhere = {
      ...moved,
      authorization: { ...moved.authorization, tokenEndpoint: "https://tokens.example.net/token", revocationEndpoint: "https://tokens.example.net/revoke" },
    };
    clock += 3_600_000;
    expect(await nodeBroker.credential(PACKAGE, elsewhere)).toEqual({
      ok: false,
      reason: "the Fake Tasks (test fixture) connection was revoked; reconnect it in Settings",
    });
    expect(nodeBroker.status(PACKAGE, elsewhere)).toMatchObject({
      state: "revoked",
      reason: "this version of the package changed where the Fake Tasks (test fixture) connection goes; connect it again in Settings",
    });
    await nodeBroker.revoke(PACKAGE, elsewhere);
    await nodeBroker.forget(PACKAGE, elsewhere);
    expect(sent).toBe(0);
    expect(tokens()).toEqual({});
  });

  it("does not bring a connection back when a renewal in flight finishes after the person revoked it", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const renewing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const nodeBroker = broker({
      fetch: onRefresh(async (forward) => {
        entered();
        await held;
        return await forward();
      }),
    });
    await connect(nodeBroker);
    clock += 3_600_000;
    const credential = nodeBroker.credential(PACKAGE, requirement());
    await renewing;
    const revoked = nodeBroker.revoke(PACKAGE, requirement());
    release();
    await credential;
    expect(await revoked).toMatchObject({ state: "revoked", reason: "you revoked it in Settings" });
    expect(nodeBroker.status(PACKAGE, requirement()).state).toBe("revoked");
    expect(tokens()).toEqual({});
  });

  it("ignores a 401 to a token the connection no longer uses", async () => {
    const nodeBroker = broker();
    await connect(nodeBroker);
    connector.revokeAll();
    await nodeBroker.rejected(PACKAGE, requirement(), "fake-access-from-before");
    expect(nodeBroker.status(PACKAGE, requirement()).state).toBe("connected");
  });

  it("keeps the connection when the provider is only busy renewing it", async () => {
    const nodeBroker = broker({ fetch: onRefresh(async () => new Response("slow down", { status: 429 })) });
    await connect(nodeBroker);
    clock += 3_600_000;
    await nodeBroker.credential(PACKAGE, requirement());
    expect(nodeBroker.status(PACKAGE, requirement()).state).toBe("connected");
    expect(tokens().refreshToken).toMatch(/^fake-refresh-/);
  });

  it("keeps a partial grant partial when a renewal does not repeat the scopes", async () => {
    connector.setMode({ grantScopes: ["tasks.read"] });
    const nodeBroker = broker({
      fetch: onRefresh(async (forward) => {
        const answer = (await (await forward()).json()) as Record<string, unknown>;
        const { scope: _scope, ...withoutScope } = answer;
        return Response.json(withoutScope);
      }),
    });
    await connect(nodeBroker);
    clock += 3_600_000;
    const credential = await nodeBroker.credential(PACKAGE, requirement());
    expect(credential.ok).toBe(true);
    expect(nodeBroker.status(PACKAGE, requirement())).toMatchObject({ state: "partial", grantedScopes: ["tasks.read"], missingScopes: ["tasks.write"] });
  });
});

describe("egress to a connection's endpoints", () => {
  let server: Server;
  let origin: string;
  let seen: { url: string; headers: IncomingHttpHeaders }[];
  let status: number;

  beforeEach(async () => {
    seen = [];
    status = 200;
    server = createServer((request, response) => {
      seen.push({ url: request.url ?? "", headers: request.headers });
      const echoed = String(request.headers.authorization ?? "");
      response.writeHead(status, { "content-type": "application/json", "x-echo": echoed });
      response.end(JSON.stringify({ youSent: echoed }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const TOKEN = "fake-access-egress-test-0123456789";

  function handler(options: { credential?: () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>; rejected?: () => Promise<void> } = {}) {
    const events: EgressAuditEvent[] = [];
    const handle = egressRequestHandler({
      packageId: PACKAGE,
      connection: {
        provider: "fake.tasks",
        endpoints: [origin],
        credential: options.credential ?? (async () => ({ ok: true, token: TOKEN })),
        ...(options.rejected === undefined ? {} : { rejected: options.rejected }),
      },
      secrets: { headersFor: () => ({ ok: false, code: "NOT_FOUND" }) as never },
      secretProblem: () => undefined,
      inCall: () => ({ signal: new AbortController().signal, effects: ["read"] }),
      allowPrivateNetwork: true,
      audit: (event) => events.push(event),
    });
    return { handle, events };
  }

  const request = (url: string, headers: Record<string, string> = {}) => ({
    method: "clarkcant/egress.fetch",
    params: { version: 1, url, headers },
    signal: new AbortController().signal,
  });

  it("adds the token itself, drops one the service tried to send, and returns nothing holding it", async () => {
    const { handle, events } = handler();
    const answer = await handle(request(`${origin}/api/tasks`, { authorization: "Bearer the-service-made-this-up" }));
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(answer.headers["x-echo"]).toBe("[redacted]");
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(Buffer.from(answer.body.data, "base64").toString("utf8")).not.toContain(TOKEN);
    expect(events).toEqual([{ packageId: PACKAGE, method: "GET", origin, connection: "fake.tasks", outcome: "done", status: 200 }]);
  });

  it("refuses an origin that is not one of the connection's endpoints, before anything is sent", async () => {
    const { handle } = handler();
    const error = await handle(request("http://localhost:1/api/tasks")).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpServerRequestError);
    expect((error as McpServerRequestError).code).toBe(EGRESS_ERROR_CODES.originNotDeclared);
    expect(seen).toEqual([]);
  });

  it("sends nothing when the connection is not usable, and says why", async () => {
    const { handle } = handler({ credential: async () => ({ ok: false, reason: "the Fake Tasks connection was revoked; reconnect it in Settings" }) });
    const error = (await handle(request(`${origin}/api/tasks`)).catch((cause: unknown) => cause)) as McpServerRequestError;
    expect(error.code).toBe(EGRESS_ERROR_CODES.credentialUnavailable);
    expect(error.message).toContain("revoked");
    expect(seen).toEqual([]);
  });

  it("tells the broker about a 401 once, and does not send the request again", async () => {
    status = 401;
    let rejected = 0;
    const { handle } = handler({
      rejected: async () => {
        rejected += 1;
      },
    });
    const answer = await handle(request(`${origin}/api/tasks`));
    expect(answer.status).toBe(401);
    expect(rejected).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe("a connected package's service on the node", () => {
  let host: ServiceHost | undefined;

  afterEach(async () => {
    await host?.stopAll();
    host = undefined;
  });

  /** The reference app's own service as a plain process, its manifest pointed at the fake connector. */
  function startHost(nodeBroker: PackageConnectionBroker): ServiceHost {
    const root = join(dir, "package");
    cpSync(REFERENCE, root, { recursive: true });
    const manifestPath = join(root, "clarkcant.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replaceAll("http://127.0.0.1:8880", connector.origin));
    const at = new Date(clock).toISOString();
    const generation = {
      generationId: GENERATION,
      packageId: PACKAGE,
      version: "1.0.0",
      digest: "sha256:connected-app",
      nodeId: NODE,
      codeGeneration: "code_1",
      activatedAt: at,
      uiOnlyFacets: [],
      grantedCapabilities: [],
    };
    db.prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(GENERATION, PACKAGE, "1.0.0", generation.digest, NODE, "code_1", at, JSON.stringify(generation));
    const launcher: ServiceLauncher = (spec) => ({ command: process.execPath, args: [fileURLToPath(pathToFileURL(join(spec.packageRoot, spec.entry)))] });
    host = createServiceHost({
      registry: { db, nodeId: NODE },
      dataDir: dir,
      engine: async () => ({ available: true, engine: "docker", version: "test" }),
      packageRoot: () => root,
      launcher,
      log: () => undefined,
      egress: { secrets: { headersFor: () => ({ ok: false, code: "NOT_FOUND" }) as never }, secretProblem: () => undefined, allowPrivateNetwork: true },
      connections: nodeBroker,
      timings: { restartBaseMs: 20, pingIntervalMs: 60_000 },
    });
    return host;
  }

  async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = read();
      if (value !== undefined && value !== false) return value;
      if (Date.now() - started > 15_000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const readiness = (ref: CapabilityRef) => getCapability({ db, nodeId: NODE }, ref, NODE)?.readiness;
  const deps = (): CapabilityInvokeDeps => ({ db, nodeId: NODE, principalId: PRINCIPAL, newId: (prefix) => `${prefix}_${String(++counter)}`, serviceHost: host });

  it("is not ready until connected, then reads and writes through the node, per capability", async () => {
    const nodeBroker = broker();
    const serviceHost = startHost(nodeBroker);
    await serviceHost.reconcile();
    await until(() => readiness(LIST)?.loaded, "the service to load");
    expect(readiness(LIST)).toMatchObject({ authenticated: false, blockedReason: "Fake Tasks (test fixture) is not connected; connect it in Settings" });
    expect(await invokeCapability(deps(), { ref: LIST, args: {}, source: "agent" })).toMatchObject({ kind: "refused", code: "CAPABILITY_NOT_AUTHENTICATED" });

    connector.setMode({ grantScopes: ["tasks.read"] });
    await connect(nodeBroker);
    serviceHost.refreshAuthentication?.(PACKAGE);
    expect(readiness(LIST)).toMatchObject({ authenticated: true });
    expect(readiness(LIST)?.blockedReason).toBeUndefined();
    expect(readiness(UPDATE)).toMatchObject({ authenticated: false });
    expect(readiness(UPDATE)?.blockedReason).toContain("did not grant tasks.write");

    const listed = await invokeCapability(deps(), { ref: LIST, args: {}, source: "voice" });
    expect(listed).toMatchObject({ kind: "done" });
    expect(listed.kind === "done" ? JSON.parse(listed.output).tasks : []).toHaveLength(3);

    connector.setMode({ grantScopes: null });
    await connect(nodeBroker);
    serviceHost.refreshAuthentication?.(PACKAGE);
    const renamed = await invokeCapability(deps(), { ref: UPDATE, args: { id: "task-1", title: "Đã đổi tên" }, source: "widget" });
    expect(renamed).toMatchObject({ kind: "done" });
    expect(connector.stats().writes).toBe(1);

    // Revoked: both capabilities not ready at once, with the reason; nothing reaches the provider.
    await nodeBroker.revoke(PACKAGE, requirement());
    serviceHost.refreshAuthentication?.(PACKAGE);
    expect(readiness(LIST)?.blockedReason).toBe("the Fake Tasks (test fixture) connection was revoked; reconnect it in Settings");
    expect(readiness(UPDATE)).toMatchObject({ authenticated: false });
    expect(await invokeCapability(deps(), { ref: UPDATE, args: { id: "task-1", title: "x" }, source: "agent" })).toMatchObject({ kind: "refused" });
    expect(connector.stats().writes).toBe(1);

    // Every effect was recorded, whichever surface asked, and no token is anywhere in the node's events.
    const events = JSON.stringify(db.prepare("SELECT * FROM events").all());
    for (const secret of connector.secrets()) expect(events).not.toContain(secret);
  });

  it("marks the connection revoked when the provider refuses it mid-call, without retrying the call", async () => {
    const nodeBroker = broker();
    const serviceHost = startHost(nodeBroker);
    await serviceHost.reconcile();
    await until(() => readiness(LIST)?.loaded, "the service to load");
    await connect(nodeBroker);
    serviceHost.refreshAuthentication?.(PACKAGE);

    connector.revokeAll();
    const refused = await invokeCapability(deps(), { ref: LIST, args: {}, source: "agent" });
    expect(refused).toMatchObject({ kind: "refused" });
    expect(nodeBroker.status(PACKAGE, requirement()).state).toBe("revoked");
    expect(readiness(LIST)?.blockedReason).toContain("revoked");
  });
});
