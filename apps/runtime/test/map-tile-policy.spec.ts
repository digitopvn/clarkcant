import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type Instant,
  MAP_TILE_POLICY_PREFERENCE,
  MAP_TILE_SECRET_CONSUMER,
  type MapTileProvider,
  type MessageBlock,
  isPersonOnlyRoute,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";

import {
  isMapTilePolicyPayload,
  mapTilePolicyDigest,
  mapTilePolicyStatus,
  runApprovedMapTilePolicy,
} from "../src/application/map-tile-policy.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { readMapTilePolicy } from "../src/map-tiles.ts";
import { createMapTilesTool } from "../src/map-tiles-tool.ts";
import { appendHostReply } from "../src/routes/conversations.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";

/**
 * The map tile policy, set and cleared from Settings and through Clark.
 *
 * One writer behind both. What differs is who decides: a click in Settings is the person; Clark naming a provider is a
 * host-owned card only a person's decision writes, and Clark turning tiles off follows the execution policy.
 */

const AT = "2026-10-03T08:00:00.000Z" as Instant;
const KEY = "map-key-that-must-not-escape";

const PROVIDER: MapTileProvider = {
  origin: "https://tiles.example",
  template: "/styles/basic/{z}/{x}/{y}.png",
  attribution: "© Example contributors",
  maxZoom: 17,
};

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-map-tile-policy-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => AT };
  const created = await request("POST", "/conversations", { title: "map tiles" });
  conversationId = (created.body as { conversationId: string }).conversationId;
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function request(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

const owner = (): string => services.runtime.identity.ownerPrincipalId;
const now = (): Instant => AT;

function policyNow(): unknown {
  return readMapTilePolicy({ db: services.runtime.db, now }, owner());
}

function setExecution(value: Record<string, unknown>): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now },
    { principalId: owner(), key: EXECUTION_POLICY_PREFERENCE_KEY, value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...value }, source: "user" },
  );
  if (!written.ok) throw new Error(written.message);
}

function tool() {
  return createMapTilesTool({
    deps: () => ({
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now,
      newId: services.conductor.newId,
      principalId: owner(),
    }),
    conversationId,
    channel: () => "chat",
  });
}

type Card = Extract<MessageBlock, { type: "approval-card" }>;

/** Show the tool's card in the conversation, the way a turn does, and answer it as the person would. */
async function decide(card: Card, decision: "granted" | "denied", digest = card.operationDigest): Promise<GatewayResponse> {
  appendHostReply(services, { conversationId, blocks: [card as MessageBlock], at: AT });
  return request("POST", `/conversations/${conversationId}/approvals/${card.approvalId}/decide`, { decision, digest });
}

function blocks(): MessageBlock[] {
  return buildTimeline(services, { conversationId, afterSequence: 0 }).messages.flatMap((message) => (message as { blocks: MessageBlock[] }).blocks);
}

describe("Settings", () => {
  it("sets and clears the policy through the person-only preference route, and the page view follows", async () => {
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "no-provider" });
    const set = await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: PROVIDER });
    expect(set.status).toBe(200);
    expect((await request("GET", "/map-tiles")).body).toEqual({
      provider: { origin: PROVIDER.origin, attribution: PROVIDER.attribution, maxZoom: PROVIDER.maxZoom },
    });
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: null })).status).toBe(200);
    expect(policyNow()).toBeNull();
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "no-provider" });
  });

  it("keeps the write, and its undo, person-only: machine surfaces refuse them", () => {
    expect(isPersonOnlyRoute("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`)).toBe(true);
    expect(isPersonOnlyRoute("POST", `/preferences/${MAP_TILE_POLICY_PREFERENCE}/undo`)).toBe(true);
  });

  it("stores the key as a node secret for maps:tiles, never answers it back, and reports only whether it is usable", async () => {
    const policy = { ...PROVIDER, credential: { secret: "map_tiles_key", header: "x-api-key" } };
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: policy })).status).toBe(200);
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "key-unavailable" });
    expect(mapTilePolicyStatus({ db: services.runtime.db, now }, owner())).toMatchObject({ keyUsable: false });

    const stored = await request("POST", "/credentials", {
      fields: [{ name: "map_tiles_key", value: KEY, kind: "api-key", consumer: MAP_TILE_SECRET_CONSUMER }],
    });
    expect(stored.status).toBe(201);
    expect(JSON.stringify(stored.body)).not.toContain(KEY);
    expect(mapTilePolicyStatus({ db: services.runtime.db, now }, owner())).toMatchObject({ keyUsable: true });
    const view = await request("GET", "/map-tiles");
    expect(view.body).toMatchObject({ provider: { origin: PROVIDER.origin } });
    const preferences = await request("GET", "/preferences");
    for (const answer of [view, preferences]) expect(JSON.stringify(answer.body)).not.toContain(KEY);
    const status = await tool().execute({ action: "status" });
    expect(status.text).toContain("đã được lưu");
    expect(status.text).not.toContain(KEY);
  });
});

describe("Clark", () => {
  it("never sets a provider by itself: it shows a host card, and only the person's grant writes the policy", async () => {
    // Autonomous, the default, would run a local change; naming a provider still goes to the person.
    const asked = await tool().execute({ action: "set", ...PROVIDER });
    expect(asked.text).toContain("Chưa có gì thay đổi");
    expect(policyNow()).toBeNull();
    const card = asked.hostCard as unknown as Card;
    expect(card).toMatchObject({ type: "approval-card", owner: "host", effectCategory: "external-write", decision: "pending" });
    expect(isMapTilePolicyPayload(card.payload ?? "")).toBe(true);
    expect(card.operationDigest).toBe(mapTilePolicyDigest(PROVIDER));
    expect(card.operationDescription).toContain(PROVIDER.origin);

    const granted = await decide(card, "granted");
    expect(granted.status).toBe(200);
    expect(policyNow()).toEqual(PROVIDER);
    expect((await request("GET", "/map-tiles")).body).toMatchObject({ provider: { origin: PROVIDER.origin } });
    expect(blocks().some((block) => block.type === "tool-activity" && block.name === "set_map_tiles")).toBe(true);
  });

  it("changes nothing when the person denies the card", async () => {
    const asked = await tool().execute({ action: "set", ...PROVIDER });
    const denied = await decide(asked.hostCard as unknown as Card, "denied");
    expect(denied.status).toBe(200);
    expect(policyNow()).toBeNull();
    expect(blocks().some((block) => block.type === "tool-activity" && block.label.includes("ô bản đồ"))).toBe(true);
  });

  it("cannot have its card decided from a machine surface", async () => {
    const asked = await tool().execute({ action: "set", ...PROVIDER });
    const card = asked.hostCard as unknown as Card;
    expect(isPersonOnlyRoute("POST", `/conversations/${conversationId}/approvals/${card.approvalId}/decide`)).toBe(true);
    expect(policyNow()).toBeNull();
  });

  it("writes only what the card showed", () => {
    const shown = JSON.stringify({ kind: "map-tile-policy", policy: PROVIDER, source: "agent" });
    const swapped = JSON.stringify({ kind: "map-tile-policy", policy: { ...PROVIDER, origin: "https://elsewhere.example" }, source: "agent" });
    const forged = runApprovedMapTilePolicy({ db: services.runtime.db, now }, {
      payload: swapped,
      expectedDigest: mapTilePolicyDigest(PROVIDER),
      approvalId: "appr_x",
      principalId: owner(),
    });
    expect(forged).toMatchObject({ ok: false, code: "APPROVAL_FORGED" });
    expect(policyNow()).toBeNull();
    const ok = runApprovedMapTilePolicy({ db: services.runtime.db, now }, {
      payload: shown,
      expectedDigest: mapTilePolicyDigest(PROVIDER),
      approvalId: "appr_y",
      principalId: owner(),
    });
    expect(ok).toMatchObject({ ok: true });
    expect(policyNow()).toEqual(PROVIDER);
  });

  it("refuses a policy the preference would refuse, before any card is shown", async () => {
    const refused = await tool().execute({ action: "set", ...PROVIDER, template: "//other.example/{z}/{x}/{y}.png" });
    expect(refused.hostCard).toBeUndefined();
    expect(refused.text).toContain("PREFERENCE_INVALID");
    const keyed = await tool().execute({ action: "set", ...PROVIDER, keySecret: "map_tiles_key" });
    expect(keyed.hostCard).toBeUndefined();
    expect(keyed.text).toContain("header or query");
  });

  it("is refused outright on a node that refuses every effect", async () => {
    setExecution({ prohibition: "all" });
    const refused = await tool().execute({ action: "set", ...PROVIDER });
    expect(refused.hostCard).toBeUndefined();
    expect(refused.text).toContain("POLICY_REFUSED");
  });

  it("turns tiles off by itself where the policy allows, and leaves a record of it", async () => {
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: PROVIDER })).status).toBe(200);
    const cleared = await tool().execute({ action: "clear" });
    expect(cleared.hostCard).toBeUndefined();
    expect(cleared.text).toContain("Đã tắt ô bản đồ");
    expect(policyNow()).toBeNull();
    const activity = await request("GET", "/activity");
    expect(JSON.stringify(activity.body)).toContain("Tắt ô bản đồ");
  });

  it("asks before turning tiles off when the policy asks every time", async () => {
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: PROVIDER })).status).toBe(200);
    setExecution({ mode: "ask" });
    const asked = await tool().execute({ action: "clear" });
    const card = asked.hostCard as unknown as Card;
    expect(card).toMatchObject({ type: "approval-card", effectCategory: "local-write" });
    expect(policyNow()).toEqual(PROVIDER);
    expect((await decide(card, "granted")).status).toBe(200);
    expect(policyNow()).toBeNull();
  });
});
