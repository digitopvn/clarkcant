import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type Instant,
  MAP_TILE_POLICY_PREFERENCE,
  MAP_TILE_SECRET_NAME,
  type MapTileProvider,
  type MessageBlock,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";
import { getSecretMetadata } from "@clarkcant/storage";

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
 * One writer behind both. A click in Settings is the person; Clark setting or clearing the policy is an effect the
 * execution policy decides like any other. What keeps the person's key from a provider Clark names is the key itself:
 * the host's own `maps:tiles`, entered only in Settings and bound to the origin it was entered for.
 *
 * That the machine surfaces refuse the person-only routes here is proven over the real relay and MCP endpoint, in
 * `open-interfaces.spec.ts`.
 */

const AT = "2026-10-03T08:00:00.000Z" as Instant;
const KEY = "map-key-that-must-not-escape";
const GITHUB = "github-token-that-must-stay-put";

const PROVIDER: MapTileProvider = {
  origin: "https://tiles.example",
  template: "/styles/basic/{z}/{x}/{y}.png",
  attribution: "© Example contributors",
  maxZoom: 17,
};
const KEYED: MapTileProvider = { ...PROVIDER, credential: { secret: MAP_TILE_SECRET_NAME, header: "x-api-key" } };

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

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, ...headers },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

const owner = (): string => services.runtime.identity.ownerPrincipalId;
const now = (): Instant => AT;

function policyNow(): unknown {
  return readMapTilePolicy({ db: services.runtime.db, now }, owner());
}

/** Who last wrote the policy, as the preference records it. */
function policySource(): string | undefined {
  const row = services.runtime.db
    .prepare("SELECT source FROM preferences WHERE principal_id = ? AND key = ?")
    .get(owner(), MAP_TILE_POLICY_PREFERENCE) as { source: string } | undefined;
  return row?.source;
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
async function decide(card: Card, decision: "granted" | "denied"): Promise<GatewayResponse> {
  appendHostReply(services, { conversationId, blocks: [card as MessageBlock], at: AT });
  return request("POST", `/conversations/${conversationId}/approvals/${card.approvalId}/decide`, { decision, digest: card.operationDigest });
}

function blocks(): MessageBlock[] {
  return buildTimeline(services, { conversationId }).messages.flatMap((message) => (message as { blocks: MessageBlock[] }).blocks);
}

async function enterKey(origin: string): Promise<GatewayResponse> {
  return request("PUT", "/map-tiles/key", { origin, value: KEY });
}

describe("Settings", () => {
  it("sets and clears the policy through the person-only preference route, and records it as the person's", async () => {
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "no-provider" });
    const set = await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: PROVIDER });
    expect(set.status).toBe(200);
    expect(policySource()).toBe("user");
    expect((await request("GET", "/map-tiles")).body).toEqual({
      provider: { origin: PROVIDER.origin, attribution: PROVIDER.attribution, maxZoom: PROVIDER.maxZoom },
    });
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: null })).status).toBe(200);
    expect(policyNow()).toBeNull();
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "no-provider" });
  });

  it("binds the key to the origin it was entered for, never answers it back, and reports where it goes", async () => {
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: KEYED })).status).toBe(200);
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "key-unavailable" });
    expect(mapTilePolicyStatus({ db: services.runtime.db, now }, owner())).toMatchObject({ keyUsable: false, savedKey: null });

    const stored = await enterKey(PROVIDER.origin);
    expect(stored).toMatchObject({ status: 200, body: { key: { origin: PROVIDER.origin } } });
    expect(JSON.stringify(stored.body)).not.toContain(KEY);
    expect(getSecretMetadata(services.runtime.db, owner(), MAP_TILE_SECRET_NAME)?.allowedConsumers).toEqual([`maps:tiles@${PROVIDER.origin}`]);
    expect(mapTilePolicyStatus({ db: services.runtime.db, now }, owner())).toMatchObject({ keyUsable: true, savedKey: { origin: PROVIDER.origin } });
    const view = await request("GET", "/map-tiles");
    expect(view.body).toMatchObject({ provider: { origin: PROVIDER.origin } });
    const key = await request("GET", "/map-tiles/key");
    expect(key.body).toEqual({ key: { origin: PROVIDER.origin } });
    const preferences = await request("GET", "/preferences");
    for (const answer of [view, key, preferences]) expect(JSON.stringify(answer.body)).not.toContain(KEY);
    const status = await tool().execute({ action: "status" });
    expect(status.text).toContain(`khóa đã lưu được gửi tới ${PROVIDER.origin}`);
    expect(status.text).not.toContain(KEY);

    expect((await request("DELETE", "/map-tiles/key")).status).toBe(200);
    expect((await request("GET", "/map-tiles/key")).body).toEqual({ key: null });
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "key-unavailable" });
  });

  it("refuses the key through the generic credential form, so nothing but Settings binds it", async () => {
    for (const field of [
      { name: MAP_TILE_SECRET_NAME, value: KEY, kind: "api-key", consumer: "maps:tiles@https://evil.example" },
      { name: "other_key", value: KEY, kind: "api-key", consumer: "maps:tiles@https://evil.example" },
      { name: "other_key", value: KEY, kind: "api-key", consumer: "maps:tiles" },
    ]) {
      const refused = await request("POST", "/credentials", { fields: [field] });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(refused.body)).toContain("MAP_TILE_KEY_IN_SETTINGS");
    }
    expect((await request("GET", "/map-tiles/key")).body).toEqual({ key: null });
  });
});

describe("Clark", () => {
  it("sets a provider by itself in Autonomous mode, with an activity record, Clark as its author and an Undo", async () => {
    const done = await tool().execute({ action: "set", ...PROVIDER });
    expect(done.hostCard).toBeUndefined();
    expect(done.text).toContain(`Đã bật ô bản đồ từ ${PROVIDER.origin}`);
    expect(done.text).toContain("Hoàn tác");
    expect(policyNow()).toEqual(PROVIDER);
    expect(policySource()).toBe("agent");
    expect(JSON.stringify((await request("GET", "/activity")).body)).toContain(`Clark: Bật ô bản đồ từ ${PROVIDER.origin}`);

    const undone = await request("POST", `/preferences/${MAP_TILE_POLICY_PREFERENCE}/undo`, {});
    expect(undone.status).toBe(200);
    expect(policyNow()).toBeNull();
  });

  it("turns tiles off by itself in Autonomous mode, and records it", async () => {
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: PROVIDER })).status).toBe(200);
    const cleared = await tool().execute({ action: "clear" });
    expect(cleared.hostCard).toBeUndefined();
    expect(cleared.text).toContain("Đã tắt ô bản đồ");
    expect(policyNow()).toBeNull();
    expect(policySource()).toBe("agent");
    expect(JSON.stringify((await request("GET", "/activity")).body)).toContain("Tắt ô bản đồ");
  });

  it("cannot move the key: a provider it sets at another origin runs without it, and says so", async () => {
    expect((await enterKey(PROVIDER.origin)).status).toBe(200);
    const elsewhere = "https://elsewhere.example";
    const done = await tool().execute({ action: "set", ...PROVIDER, origin: elsewhere, keyHeader: "x-api-key" });
    expect(done.text).toContain(`khóa đã lưu dành cho ${PROVIDER.origin} nên không được gửi tới đó`);
    expect(done.text).toContain("nhập lại khóa");
    expect(policyNow()).toEqual({ ...KEYED, origin: elsewhere });
    expect((await request("GET", "/map-tiles")).body).toEqual({ provider: null, offline: "key-origin-mismatch" });
    // The key is still bound where the person entered it.
    expect((await request("GET", "/map-tiles/key")).body).toEqual({ key: { origin: PROVIDER.origin } });
    expect(await request("GET", "/map-tiles/1/0/0")).toMatchObject({ status: 503, body: { code: "MAP_TILE_KEY_UNAVAILABLE", offline: "key-origin-mismatch" } });
  });

  it("asks in Ask mode, says on the card where the key goes, and writes only on the person's grant", async () => {
    expect((await enterKey("https://other.example")).status).toBe(200);
    setExecution({ mode: "ask" });
    const asked = await tool().execute({ action: "set", ...PROVIDER, keyHeader: "x-api-key" });
    expect(asked.text).toContain("Chưa có gì thay đổi");
    expect(policyNow()).toBeNull();
    const card = asked.hostCard as unknown as Card;
    expect(card).toMatchObject({ type: "approval-card", owner: "host", effectCategory: "external-write", decision: "pending" });
    expect(isMapTilePolicyPayload(card.payload ?? "")).toBe(true);
    expect(card.operationDigest).toBe(mapTilePolicyDigest(KEYED));
    expect(card.operationDescription).toContain(PROVIDER.origin);
    expect(card.operationDescription).toContain(`được nhập cho https://other.example nên KHÔNG được gửi tới ${PROVIDER.origin}`);

    const granted = await decide(card, "granted");
    expect(granted.status).toBe(200);
    expect(policyNow()).toEqual(KEYED);
    expect(policySource()).toBe("agent");
    expect(blocks().some((block) => block.type === "tool-activity" && block.name === "set_map_tiles")).toBe(true);
  });

  it("changes nothing when the person denies the card", async () => {
    setExecution({ mode: "ask" });
    const asked = await tool().execute({ action: "set", ...PROVIDER });
    const denied = await decide(asked.hostCard as unknown as Card, "denied");
    expect(denied.status).toBe(200);
    expect(policyNow()).toBeNull();
  });

  it("writes only what the card showed, and not after the person refused every effect", () => {
    const shown = JSON.stringify({ kind: "map-tile-policy", policy: PROVIDER, source: "agent" });
    const swapped = JSON.stringify({ kind: "map-tile-policy", policy: { ...PROVIDER, origin: "https://elsewhere.example" }, source: "agent" });
    const approve = (payload: string, approvalId: string) =>
      runApprovedMapTilePolicy({ db: services.runtime.db, now }, { payload, expectedDigest: mapTilePolicyDigest(PROVIDER), approvalId, principalId: owner() });
    expect(approve(swapped, "appr_x")).toMatchObject({ ok: false, code: "APPROVAL_FORGED" });
    expect(policyNow()).toBeNull();
    setExecution({ prohibition: "all" });
    expect(approve(shown, "appr_y")).toMatchObject({ ok: false, code: "POLICY_REFUSED" });
    expect(policyNow()).toBeNull();
    setExecution({});
    expect(approve(shown, "appr_z")).toMatchObject({ ok: true });
    expect(policyNow()).toEqual(PROVIDER);
  });

  it("refuses a policy the preference would refuse, before anything is written or shown", async () => {
    const refused = await tool().execute({ action: "set", ...PROVIDER, template: "//other.example/{z}/{x}/{y}.png" });
    expect(refused.hostCard).toBeUndefined();
    expect(refused.text).toContain("PREFERENCE_INVALID");
    const withKey = await tool().execute({ action: "set", ...PROVIDER, template: "/{z}/{x}/{y}.png?api_key=abc" });
    expect(withKey.text).toContain("PREFERENCE_INVALID");
    expect(policyNow()).toBeNull();
  });

  it("is refused outright on a node that refuses every effect", async () => {
    setExecution({ prohibition: "all" });
    const refused = await tool().execute({ action: "set", ...PROVIDER });
    expect(refused.hostCard).toBeUndefined();
    expect(refused.text).toContain("POLICY_REFUSED");
    expect(policyNow()).toBeNull();
  });
});

describe("in the owner's language", () => {
  /** Any letter only Vietnamese writes. */
  const VIETNAMESE_LETTER = /[ăâđêôơưạảãàáậầấẩẫặằắẳẵẹẻẽèéệềếểễịỉĩìíọỏõòóộồốổỗợờớởỡụủũùúựừứửữỵỷỹỳýĐ]/iu;

  function chooseEnglish(): void {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now },
      { principalId: owner(), key: "experience.language", value: "en", source: "user" },
    );
    if (!written.ok) throw new Error(written.message);
  }

  it("words the card, its receipt and the activity record in English when the owner chose English", async () => {
    chooseEnglish();
    expect((await enterKey("https://other.example")).status).toBe(200);
    setExecution({ mode: "ask" });
    const card = (await tool().execute({ action: "set", ...PROVIDER, keyHeader: "x-api-key" })).hostCard as unknown as Card;
    expect(card.operationDescription).toBe(
      `Turn on map tiles from ${PROVIDER.origin} (${PROVIDER.attribution}, max zoom 17; the saved key was entered for ` +
        `https://other.example, so it is NOT sent to ${PROVIDER.origin}: this provider runs without a key — the map uses only ` +
        "its offline base — until the person enters the key again in Settings → Extensions → Map tiles)",
    );

    expect((await decide(card, "granted")).status).toBe(200);
    const receipt = blocks().find((block) => block.type === "tool-activity" && block.name === "set_map_tiles");
    const label = receipt?.type === "tool-activity" ? receipt.label : undefined;
    expect(label).toBe(
      `Set the tile provider to ${PROVIDER.origin}, but the saved key is for https://other.example, so it is not sent there: ` +
        "the map uses only its offline base until the person enters the key again in Settings → Extensions → Map tiles",
    );
    expect(label).not.toMatch(VIETNAMESE_LETTER);
  });

  it("records turning tiles off in English when the owner chose English", async () => {
    chooseEnglish();
    expect((await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: PROVIDER })).status).toBe(200);
    await tool().execute({ action: "clear" });
    expect(JSON.stringify((await request("GET", "/activity")).body)).toContain("Clark: Turn map tiles off: the map uses only its offline base");
  });
});

describe("a policy naming another secret", () => {
  it("is refused on every path, and the secret it names is left untouched", async () => {
    const stored = await request("POST", "/credentials", { fields: [{ name: "github_token", value: GITHUB, kind: "token", consumer: "command:gh" }] });
    expect(stored.status).toBe(201);
    const before = getSecretMetadata(services.runtime.db, owner(), "github_token");
    const stealing = { ...PROVIDER, origin: "https://evil.example", credential: { secret: "github_token", header: "authorization" } };

    const viaSettings = await request("PUT", `/preferences/${MAP_TILE_POLICY_PREFERENCE}`, { value: stealing });
    expect(viaSettings.status).toBe(400);
    // A card's payload naming it is not a tile policy at all.
    const viaCard = runApprovedMapTilePolicy(
      { db: services.runtime.db, now },
      { payload: JSON.stringify({ kind: "map-tile-policy", policy: stealing, source: "agent" }), expectedDigest: "", approvalId: "appr_steal", principalId: owner() },
    );
    expect(viaCard).toMatchObject({ ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE" });
    const viaWrite = writeRegisteredPreference({ db: services.runtime.db, now }, { principalId: owner(), key: MAP_TILE_POLICY_PREFERENCE, value: stealing });
    expect(viaWrite).toMatchObject({ ok: false, code: "PREFERENCE_INVALID" });

    expect(policyNow()).toBeNull();
    expect(getSecretMetadata(services.runtime.db, owner(), "github_token")).toEqual(before);
    expect(before?.allowedConsumers).toEqual(["command:gh"]);
  });
});

