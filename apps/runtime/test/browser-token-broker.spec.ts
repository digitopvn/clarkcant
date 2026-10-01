import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Instant, WidgetDefinition } from "@clarkcant/contracts";
import { createInstance } from "@clarkcant/core";
import type { BrowserTokenAdapter, BrowserTokenSupport } from "@clarkcant/integration-sdk";
import { appendAuditEvent, listAuditEvents } from "@clarkcant/storage";

import { type BrowserTokenAuditEvent, createBrowserTokenBroker } from "../src/browser-token-broker.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createBrowserTokenFixture } from "../src/test-support/fixture-browser-tokens.ts";

/**
 * The browser-token broker, and the route a widget frame's host chrome asks it through.
 *
 * Every token here is a random value generated in this file; nothing could be mistaken for a provider's.
 */

const SUPPORT: BrowserTokenSupport = {
  provider: "example.maps",
  scoped: true,
  maxTtlSeconds: 600,
  scopes: ["tiles:read", "geocode:read"],
  revocation: "revocable",
};
const DECLARED = [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draw the map" }];
const SESSION = "frame-session-0123456789";

interface FakeProvider {
  adapter: BrowserTokenAdapter;
  minted: { token: string; tokenId: string; ttlSeconds: number }[];
  revoked: string[];
}

function fakeProvider(overrides: Partial<BrowserTokenSupport> = {}, options: { lifetime?: (asked: number) => number } = {}): FakeProvider {
  const minted: FakeProvider["minted"] = [];
  const revoked: string[] = [];
  return {
    minted,
    revoked,
    adapter: {
      support: { ...SUPPORT, ...overrides },
      issue: async ({ ttlSeconds }) => {
        const entry = { token: `fake-${randomBytes(16).toString("hex")}`, tokenId: `tok_${String(minted.length + 1)}`, ttlSeconds };
        minted.push(entry);
        return { token: entry.token, tokenId: entry.tokenId, expiresInSeconds: options.lifetime?.(ttlSeconds) ?? ttlSeconds };
      },
      revoke: async (tokenId) => {
        revoked.push(tokenId);
      },
    },
  };
}

describe("the browser-token broker", () => {
  const AT = Date.parse("2026-10-01T06:00:00.000Z");
  let audit: BrowserTokenAuditEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    audit = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const issue = (broker: ReturnType<typeof createBrowserTokenBroker>, overrides: { session?: string; instanceId?: string; packageId?: string; ttlSeconds?: number; scopes?: string[] } = {}) =>
    broker.issue({
      packageId: overrides.packageId ?? "com.example.maps",
      instanceId: overrides.instanceId ?? "wi_1",
      session: overrides.session ?? SESSION,
      declared: DECLARED,
      request: {
        provider: "example.maps",
        scopes: overrides.scopes ?? ["tiles:read"],
        ...(overrides.ttlSeconds === undefined ? {} : { ttlSeconds: overrides.ttlSeconds }),
      },
    });

  it("issues a token bound to the instance and frame session, and keeps everything about it but the value", async () => {
    const provider = fakeProvider();
    const broker = createBrowserTokenBroker({ adapters: [provider.adapter], audit: (event) => audit.push(event) });
    const outcome = await issue(broker, { ttlSeconds: 120 });

    expect(outcome).toEqual({
      ok: true,
      grant: { provider: "example.maps", token: provider.minted[0]?.token, scopes: ["tiles:read"], expiresAt: "2026-10-01T06:02:00.000Z" },
    });
    expect(broker.held()).toEqual([
      { provider: "example.maps", packageId: "com.example.maps", instanceId: "wi_1", session: SESSION, tokenId: "tok_1", expiresAt: "2026-10-01T06:02:00.000Z" },
    ]);
    expect(audit).toEqual([
      { provider: "example.maps", packageId: "com.example.maps", instanceId: "wi_1", outcome: "issued", expiresAt: "2026-10-01T06:02:00.000Z" },
    ]);
    const value = provider.minted[0]?.token ?? "missing";
    expect(JSON.stringify(broker.held())).not.toContain(value);
    expect(JSON.stringify(audit)).not.toContain(value);
  });

  it("refuses an unscoped provider and an undeclared scope without asking the provider for anything", async () => {
    const unscoped = fakeProvider({ scoped: false });
    const broker = createBrowserTokenBroker({ adapters: [unscoped.adapter], audit: (event) => audit.push(event) });
    expect(await issue(broker)).toMatchObject({ ok: false, code: "TOKEN_PROVIDER_UNSCOPED" });
    expect(await issue(broker, { scopes: ["geocode:read"] })).toMatchObject({ ok: false, code: "TOKEN_SCOPE_NOT_DECLARED" });
    expect(unscoped.minted).toEqual([]);
    expect(audit.map((event) => event.code)).toEqual(["TOKEN_PROVIDER_UNSCOPED", "TOKEN_SCOPE_NOT_DECLARED"]);

    const none = createBrowserTokenBroker({});
    expect(await issue(none)).toMatchObject({ ok: false, code: "TOKEN_PROVIDER_UNAVAILABLE" });
  });

  it("forgets a token at its expiry, and revokes at the lifetime asked one the provider gave longer", async () => {
    const exact = fakeProvider();
    const broker = createBrowserTokenBroker({ adapters: [exact.adapter], audit: (event) => audit.push(event) });
    await issue(broker, { ttlSeconds: 60 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(broker.held()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(broker.held()).toEqual([]);
    expect(exact.revoked).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ outcome: "expired" });

    const generous = fakeProvider({}, { lifetime: () => 3_600 });
    const held = createBrowserTokenBroker({ adapters: [generous.adapter], audit: (event) => audit.push(event) });
    const outcome = await issue(held, { ttlSeconds: 60 });
    // A minute after the first token lapsed, plus the minute asked: not the hour the provider gave.
    expect(outcome).toMatchObject({ ok: true, grant: { expiresAt: "2026-10-01T06:02:00.000Z" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generous.revoked).toEqual(["tok_1"]);
    expect(held.held()).toEqual([]);
  });

  it("refuses a longer-lived token it could not revoke, and never hands its value out", async () => {
    const stubborn = fakeProvider({ revocation: "expiry-only" }, { lifetime: () => 3_600 });
    const broker = createBrowserTokenBroker({ adapters: [stubborn.adapter] });
    const outcome = await issue(broker, { ttlSeconds: 60 });
    expect(outcome).toMatchObject({ ok: false, code: "TOKEN_ISSUE_FAILED" });
    expect(JSON.stringify(outcome)).not.toContain(stubborn.minted[0]?.token ?? "missing");
    expect(broker.held()).toEqual([]);
  });

  it("revokes a frame's tokens when it closes, and refuses that session afterwards", async () => {
    const provider = fakeProvider();
    const broker = createBrowserTokenBroker({ adapters: [provider.adapter], audit: (event) => audit.push(event) });
    await issue(broker);
    await issue(broker, { session: "another-frame-session-01" });
    expect(await broker.endSession("wi_1", SESSION)).toBe(1);
    expect(provider.revoked).toEqual(["tok_1"]);
    expect(broker.held().map((entry) => entry.session)).toEqual(["another-frame-session-01"]);
    expect(await issue(broker)).toMatchObject({ ok: false, code: "TOKEN_SESSION_ENDED" });
    // The same session id under another instance is another frame.
    expect(await issue(broker, { instanceId: "wi_2" })).toMatchObject({ ok: true });
  });

  it("withdraws a token minted for a frame that closed while the provider was minting it", async () => {
    let release: () => void = () => undefined;
    const provider = fakeProvider();
    const slow: BrowserTokenAdapter = {
      ...provider.adapter,
      issue: async (input) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return await provider.adapter.issue(input);
      },
    };
    const broker = createBrowserTokenBroker({ adapters: [slow] });
    const pending = issue(broker);
    await vi.advanceTimersByTimeAsync(0);
    await broker.endSession("wi_1", SESSION);
    release();
    expect(await pending).toMatchObject({ ok: false, code: "TOKEN_SESSION_ENDED" });
    expect(provider.revoked).toEqual(["tok_1"]);
    expect(broker.held()).toEqual([]);
  });

  it("revokes every token a package's instances hold when the package goes", async () => {
    const provider = fakeProvider();
    const broker = createBrowserTokenBroker({ adapters: [provider.adapter] });
    await issue(broker, { instanceId: "wi_1" });
    await issue(broker, { instanceId: "wi_2" });
    await issue(broker, { instanceId: "wi_3", packageId: "com.example.other" });
    expect(await broker.endPackage("com.example.maps")).toBe(2);
    expect(provider.revoked.sort()).toEqual(["tok_1", "tok_2"]);
    expect(broker.held().map((entry) => entry.instanceId)).toEqual(["wi_3"]);
  });

  it("answers a provider failure with a fixed sentence rather than what the provider said", async () => {
    const leaky: BrowserTokenAdapter = {
      support: SUPPORT,
      issue: () => Promise.reject(new Error("upstream said: account key sk-live-should-not-travel")),
    };
    const broker = createBrowserTokenBroker({ adapters: [leaky] });
    const outcome = await issue(broker);
    expect(outcome).toEqual({ ok: false, code: "TOKEN_ISSUE_FAILED", message: "example.maps did not issue a token; try again later" });
  });
});

const AT = "2026-10-01T06:00:00.000Z";
const PACKAGE = "com.example.maps";
const WIDGET_ID = "com.example.maps.view@1";
const VERSION = "1.0.0";
const DEFINITION: WidgetDefinition = {
  id: WIDGET_ID,
  version: VERSION,
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "A map.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A map",
  requestedCapabilities: [],
};

describe("the browser-token route", () => {
  let dir: string;
  let services: NodeServices;
  let deps: GatewayDeps;
  let previousIndex: string | undefined;
  let instanceId: string;
  let fixture: ReturnType<typeof createBrowserTokenFixture>;

  function writePackage(root: string): void {
    mkdirSync(join(root, "widgets", "view"), { recursive: true });
    writeFileSync(join(root, "widgets", "view", "index.html"), "<!doctype html><div id=root></div>\n");
    writeFileSync(join(root, "widgets", "view", "widget.json"), JSON.stringify(DEFINITION));
    writeFileSync(
      join(root, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: PACKAGE,
        version: VERSION,
        displayName: "Maps",
        description: "A map.",
        hostApi: { min: 1, max: 1 },
        facets: [
          {
            kind: "ui",
            id: WIDGET_ID,
            entry: "widgets/view/index.html",
            definition: "widgets/view/widget.json",
            isolation: "isolated-ui",
            browserTokens: {
              version: 1,
              providers: [
                { provider: "fixture.maps", scopes: ["tiles:read"], purpose: "Draw the map tiles" },
                { provider: "fixture.unscoped", scopes: ["everything"], purpose: "Show what an unscoped provider is answered" },
              ],
            },
          },
        ],
        requestedCapabilities: [],
        permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
        platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
        publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
      }),
    );
  }

  function recordInstall(): void {
    const nodeId = services.runtime.identity.nodeId;
    const generation = {
      generationId: `${PACKAGE}@${VERSION}:code_1`,
      packageId: PACKAGE,
      version: VERSION,
      digest: `sha256:maps-${VERSION}`,
      nodeId,
      codeGeneration: "code_1",
      activatedAt: AT,
      uiOnlyFacets: ["ui"],
      grantedCapabilities: [],
    };
    services.runtime.db
      .prepare(
        `INSERT INTO package_generations
           (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(generation.generationId, PACKAGE, VERSION, generation.digest, nodeId, "code_1", AT, JSON.stringify(generation));
  }

  const send = (method: "POST" | "DELETE" | "GET", path: string, body?: unknown): Promise<GatewayResponse> =>
    handleRequest(deps, {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  const ask = (request: unknown, session = SESSION, instance = instanceId) =>
    send("POST", `/conversations/conv_1/widgets/${instance}/browser-tokens`, { session, request });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-browser-tokens-"));
    const root = join(dir, "maps");
    writePackage(root);
    const indexPath = join(dir, "directory.json");
    writeFileSync(
      indexPath,
      JSON.stringify([
        {
          packageId: PACKAGE,
          version: VERSION,
          displayName: "Maps",
          description: "A map.",
          source: { kind: "local", path: root },
          publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
          preview: {},
          facets: ["ui"],
          isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
          platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
          hostApi: { min: 1, max: 1 },
          permissionsSummary: [],
          riskTier: "isolated-ui",
          sizeBytes: 1024,
          digest: `sha256:maps-${VERSION}`,
        },
      ]),
    );
    previousIndex = process.env["CC_DIRECTORY_INDEX"];
    process.env["CC_DIRECTORY_INDEX"] = indexPath;
    services = bootNodeServices({ dataDir: dir, label: "browser token route test node" });
    fixture = createBrowserTokenFixture();
    const audit = (event: BrowserTokenAuditEvent): void =>
      appendAuditEvent(services.runtime.db, {
        auditId: services.conductor.newId("audit"),
        principalId: services.runtime.identity.ownerPrincipalId,
        nodeId: services.runtime.identity.nodeId,
        at: new Date().toISOString() as Instant,
        kind: "browser-token",
        summary: `${event.provider} token ${event.outcome} for ${event.instanceId}`,
        outcome: event.outcome === "refused" ? "refused" : "done",
        ref: event.instanceId,
      });
    services.browserTokens = createBrowserTokenBroker({ adapters: fixture.adapters, audit });
    deps = { services, now: () => new Date().toISOString() as never };
    services.runtime.db
      .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
      .run("conv_1", services.runtime.identity.nodeId, AT, AT);
    recordInstall();
    instanceId = createInstance(services.conductor, {
      definition: DEFINITION,
      packageDigest: `sha256:maps-${VERSION}`,
      ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
      props: {},
    }).instanceId;
    services.runtime.db
      .prepare(
        "INSERT INTO pins(pin_id,conversation_id,instance_id,display_mode,position,refresh_policy,created_at) VALUES ('pin_maps','conv_1',?,'expanded',0,'manual',?)",
      )
      .run(instanceId, AT);
  });

  afterEach(async () => {
    await services.browserTokens?.close();
    if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
    else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tells host chrome which providers the frame may ask, so tokens@1 is offered only there", async () => {
    const live = await send("GET", `/conversations/conv_1/widgets/${instanceId}/live`);
    expect(live.body).toMatchObject({ frame: { browserTokens: ["fixture.maps", "fixture.unscoped"] } });
  });

  it("gives the frame a token its package declared, and ends it when the frame closes", async () => {
    const answer = await ask({ provider: "fixture.maps", scopes: ["tiles:read"], ttlSeconds: 120 });
    expect(answer.status).toBe(200);
    const token = (answer.body as { token: { token: string; provider: string; scopes: string[] } }).token;
    expect(token).toMatchObject({ provider: "fixture.maps", scopes: ["tiles:read"] });
    expect(token.token).toBe(fixture.issued()[0]?.token);

    const ended = await send("DELETE", `/conversations/conv_1/widgets/${instanceId}/browser-tokens/${SESSION}`);
    expect(ended).toMatchObject({ status: 200, body: { ended: true, revoked: 1 } });
    expect(fixture.issued()[0]?.revoked).toBe(true);
    expect((await ask({ provider: "fixture.maps", scopes: ["tiles:read"] })).body).toMatchObject({ code: "TOKEN_SESSION_ENDED" });

    // Recorded by provider and instance; the value is nowhere in what the node keeps.
    const kept = JSON.stringify(listAuditEvents(services.runtime.db, services.runtime.identity.ownerPrincipalId));
    expect(kept).toContain("fixture.maps token issued");
    expect(kept).not.toContain(token.token);
  });

  it("refuses what the package did not declare, an unscoped provider, and a request broader than the provider mints", async () => {
    expect(await ask({ provider: "fixture.maps", scopes: ["geocode:read"] })).toMatchObject({
      status: 403,
      body: { code: "TOKEN_SCOPE_NOT_DECLARED" },
    });
    expect(await ask({ provider: "other.maps", scopes: ["tiles:read"] })).toMatchObject({ status: 403, body: { code: "TOKEN_PROVIDER_NOT_DECLARED" } });
    expect(await ask({ provider: "fixture.unscoped", scopes: ["everything"] })).toMatchObject({
      status: 422,
      body: { code: "TOKEN_PROVIDER_UNSCOPED" },
    });
    expect(await ask({ provider: "fixture.maps", scopes: ["tiles:read"], ttlSeconds: 900 })).toMatchObject({
      status: 422,
      body: { code: "TOKEN_TTL_TOO_LONG" },
    });
    expect(fixture.issued()).toEqual([]);
  });

  it("gives nothing to an instance outside the conversation, or whose package is not running", async () => {
    expect((await send("POST", `/conversations/conv_other/widgets/${instanceId}/browser-tokens`, { session: SESSION, request: { provider: "fixture.maps", scopes: ["tiles:read"] } })).status).toBe(404);
    services.runtime.db.prepare("DELETE FROM package_generations").run();
    expect(await ask({ provider: "fixture.maps", scopes: ["tiles:read"] })).toMatchObject({ status: 409, body: { code: "TOKEN_PACKAGE_NOT_ACTIVE" } });
    expect(fixture.issued()).toEqual([]);
  });

  it("withdraws the tokens a package's frames hold when the person uninstalls it", async () => {
    expect((await ask({ provider: "fixture.maps", scopes: ["tiles:read"] })).status).toBe(200);
    const uninstalled = await send("POST", `/packages/${PACKAGE}/uninstall`);
    expect(uninstalled.status).toBe(200);
    await vi.waitFor(() => expect(fixture.issued()[0]?.revoked).toBe(true));
    expect(services.browserTokens?.held()).toEqual([]);
    expect(await ask({ provider: "fixture.maps", scopes: ["tiles:read"] }, "a-later-frame-session-01")).toMatchObject({
      status: 409,
      body: { code: "TOKEN_PACKAGE_NOT_ACTIVE" },
    });
  });

  it("refuses a malformed request before anything is asked", async () => {
    expect((await ask({ provider: "fixture.maps", scopes: ["tiles:read"] }, "short")).status).toBe(400);
    expect((await ask({ provider: "fixture.maps", scopes: [] })).status).toBe(400);
    expect((await send("DELETE", `/conversations/conv_1/widgets/${instanceId}/browser-tokens/bad`)).status).toBe(400);
  });

  it("lists what the fixture minted only on a node that loaded it", async () => {
    expect((await send("GET", "/browser-token-fixture/issued")).status).toBe(404);
    services.browserTokenFixture = fixture;
    expect(await send("GET", "/browser-token-fixture/issued")).toMatchObject({ status: 200, body: { issued: [] } });
  });
});
