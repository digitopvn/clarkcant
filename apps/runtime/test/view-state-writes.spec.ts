import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Instant, MEDIA_PLAYBACK_WRITE_INTERVAL_MS, VIEW_STATE_SEQUENCE_MAX_LEAD_MS } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf, viewStateRecordKey } from "@clarkcant/core";
import { insertLocalImage } from "@clarkcant/storage";

import { invokeWidgetAction, writeWidgetViewState } from "../src/application/widget-actions.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { conversationUiContext } from "../src/widget-semantic.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";

/**
 * The state-only write a host-held player sends while it plays (#380).
 *
 * A playing video writes where it is at most every three seconds, which is still about 1,200 writes an hour. The claims
 * are counted, not assumed: how many times the conversation timeline is built, how many history snapshots are marked
 * superseded, and how many invocation records are kept, across an hour of simulated play.
 */

const counts = vi.hoisted(() => ({ timelines: 0 }));
vi.mock("../src/services.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services.ts")>();
  return {
    ...original,
    buildTimeline: (...args: Parameters<typeof original.buildTimeline>) => {
      counts.timelines += 1;
      return original.buildTimeline(...args);
    },
  };
});

const AT = "2026-10-03T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_view_state";
const HOUR_OF_WRITES = (60 * 60 * 1000) / MEDIA_PLAYBACK_WRITE_INTERVAL_MS;

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let counter = 0;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

async function place(definitionId: string, props: Record<string, unknown>): Promise<string> {
  const view = buildViewCatalog(services.conductor).find((candidate) => candidate.id === definitionId);
  if (view === undefined) throw new Error(`${definitionId} is not registered`);
  const block = await view.build({
    props,
    caption: "",
    at: AT,
    principal: { principalId: owner() as never, kind: "user", nodeId: services.runtime.identity.nodeId as never },
    messageId: `msg_${String(++counter)}`,
    conversationId: CONVERSATION,
  });
  if (block.type !== "surface" || typeof block.snapshot.instanceId !== "string") throw new Error(`${definitionId} did not produce a live widget`);
  return block.snapshot.instanceId;
}

function request(instanceId: string, input: Record<string, unknown>, invocationId = `inv_${String(++counter)}`) {
  const instance = getInstance(services.conductor, instanceId);
  const actionBindingId = instance?.actionBindingIds[0] ?? "";
  return {
    conversationId: CONVERSATION,
    principalId: owner(),
    instanceId,
    actionBindingId,
    expectedRevision: instance?.revision ?? 0,
    expectedBindingDigest: getActionBinding(services.conductor, actionBindingId)?.bindingDigest ?? "",
    input,
    invocationId,
  };
}

/** A state-only write: the same request with the player's write sequence, which grows with every write unless given. */
let sequence = 0;
function stateRequest(instanceId: string, input: Record<string, unknown>, invocationId?: string, at = ++sequence) {
  return { ...request(instanceId, input, invocationId), sequence: at };
}

function count(sql: string, ...params: string[]): number {
  return (services.runtime.db.prepare(sql).get(...params) as { n: number }).n;
}

function staleSnapshots(instanceId: string): number {
  return count("SELECT COUNT(*) AS n FROM widget_snapshots WHERE instance_id = ? AND stale = 1", instanceId);
}

function invocationRows(instanceId: string): number {
  return count("SELECT COUNT(*) AS n FROM action_invocations WHERE instance_id = ?", instanceId);
}

async function post(instanceId: string, body: Record<string, unknown>): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method: "POST",
    path: `/conversations/${CONVERSATION}/widgets/${instanceId}/actions`,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify({ instanceId, ...body }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-view-state-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => AT };
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
  counts.timelines = 0;
  sequence = 0;
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("continuous playback through the state-only write", () => {
  it("builds no timeline and marks no snapshot superseded, while an ordinary view write does both", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A short film" });
    const revision = getInstance(services.conductor, videoId)?.revision;
    expect(count("SELECT COUNT(*) AS n FROM widget_snapshots WHERE instance_id = ?", videoId)).toBe(1);

    for (let tick = 0; tick < 100; tick += 1) {
      const written = writeWidgetViewState(services, stateRequest(videoId, { status: "playing", position: tick * 3, duration: 600 }));
      expect(written.ok).toBe(true);
    }
    expect(counts.timelines).toBe(0);
    expect(staleSnapshots(videoId)).toBe(0);
    // The page's next write is made at the revision it already holds.
    expect(getInstance(services.conductor, videoId)?.revision).toBe(revision);
    expect(liveStateOf(services.conductor, videoId)).toMatchObject({ revision: 100, body: { status: "playing", position: 297, duration: 600 } });

    // The same write as an ordinary action: the page is rebuilt and the history is labelled as superseded.
    const ordinary = await invokeWidgetAction(services, request(videoId, { status: "paused", position: 300, duration: 600 }));
    expect(ordinary.ok).toBe(true);
    expect(counts.timelines).toBe(1);
    expect(staleSnapshots(videoId)).toBe(1);
  });

  it("keeps one invocation record for an hour of play, and leaves an ordinary action's records as they were", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A long film" });
    const ordinary = await invokeWidgetAction(services, request(videoId, { status: "paused", position: 0, duration: 3_600 }, "inv_ordinary"));
    expect(ordinary.ok).toBe(true);
    const ordinaryOutcome = count("SELECT COUNT(*) AS n FROM action_invocations WHERE invocation_id = 'inv_ordinary'");
    expect(ordinaryOutcome).toBe(1);

    expect(HOUR_OF_WRITES).toBe(1_200);
    for (let write = 0; write < HOUR_OF_WRITES; write += 1) {
      const outcome = writeWidgetViewState(services, stateRequest(videoId, { status: "playing", position: write * 3, duration: 3_600 }));
      if (!outcome.ok) throw new Error(outcome.message);
    }
    // One row for the ordinary write, one for the whole hour of play.
    expect(invocationRows(videoId)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM action_invocations WHERE invocation_id = 'inv_ordinary'")).toBe(1);
    const bindingId = getInstance(services.conductor, videoId)?.actionBindingIds[0] ?? "";
    const latest = services.runtime.db
      .prepare("SELECT outcome FROM action_invocations WHERE invocation_id = ?")
      .get(viewStateRecordKey(bindingId)) as { outcome: string };
    expect(JSON.parse(latest.outcome)).toMatchObject({ stateOnly: true, result: { state: { position: 3_597 } } });
    expect(counts.timelines).toBe(1);
  });

  it("answers a retry of the latest write with the state and revision the node holds now, and refuses its id reused with other input", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const latest = stateRequest(videoId, { status: "playing", position: 3, duration: 60 }, "inv_same", 1);
    const first = writeWidgetViewState(services, latest);
    expect(first).toMatchObject({ ok: true, body: { duplicate: false, stateRevision: 1 } });
    // An ordinary action moves the revision after the write; the retry answers at the revision the instance is at now.
    const ordinary = await invokeWidgetAction(services, request(videoId, { status: "paused", position: 5, duration: 60 }));
    expect(ordinary.ok).toBe(true);
    const revisionNow = getInstance(services.conductor, videoId)?.revision;
    const again = writeWidgetViewState(services, latest);
    expect(again).toMatchObject({
      ok: true,
      body: { duplicate: true, revision: revisionNow, stateRevision: 2, state: { status: "paused", position: 5, duration: 60 } },
    });
    const reused = writeWidgetViewState(services, { ...latest, input: { status: "paused", position: 4, duration: 60 } });
    expect(reused).toMatchObject({ ok: false, code: "INVOCATION_KEY_REUSED" });
    expect(liveStateOf(services.conductor, videoId)?.body).toEqual({ status: "paused", position: 5, duration: 60 });
  });

  it("holds the write to the same gate: input, revision, digest, owner and the write sequence", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    expect(writeWidgetViewState(services, stateRequest(videoId, { status: "playing", position: 61, duration: 60 }))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(writeWidgetViewState(services, { ...stateRequest(videoId, { status: "paused", position: 1, duration: 60 }), expectedRevision: 99 })).toMatchObject({
      ok: false,
      code: "REVISION_MISMATCH",
      status: 409,
    });
    expect(writeWidgetViewState(services, { ...stateRequest(videoId, { status: "paused", position: 1, duration: 60 }), expectedBindingDigest: "sha256:other" })).toMatchObject({
      ok: false,
      code: "BINDING_STALE",
    });
    expect(writeWidgetViewState(services, { ...stateRequest(videoId, { status: "paused", position: 1, duration: 60 }), principalId: "prin_someone_else" })).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
      status: 403,
    });
    // No sequence, a sequence that is not a positive integer, or one far past the node's clock.
    expect(writeWidgetViewState(services, request(videoId, { status: "paused", position: 1, duration: 60 }))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(writeWidgetViewState(services, stateRequest(videoId, { status: "paused", position: 1, duration: 60 }, undefined, 1.5))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(writeWidgetViewState(services, stateRequest(videoId, { status: "paused", position: 1, duration: 60 }, undefined, Date.now() + 2 * VIEW_STATE_SEQUENCE_MAX_LEAD_MS))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(liveStateOf(services.conductor, videoId)).toBeUndefined();
    expect(invocationRows(videoId)).toBe(0);
  });

  it("is taken only for a player's playback state: a gallery's selection stays an ordinary view action", async () => {
    insertLocalImage(services.runtime.db, {
      imageId: "image_view_state",
      ownerPrincipalId: owner(),
      nodeId: services.runtime.identity.nodeId,
      artifactId: "art_image_view_state",
      mimeType: "image/png",
      byteSize: 68,
      width: 640,
      height: 480,
      digest: "sha256:view-state-image",
      altText: "A leaf",
      blobPath: "unused-view-state-blob",
      createdAt: AT,
    } as never);
    const galleryId = await place("canvas.gallery@1", { imageRefs: ["image_view_state"], alts: ["A leaf"] });
    const refused = writeWidgetViewState(services, stateRequest(galleryId, { selectedIndex: 0 }));
    expect(refused).toMatchObject({ ok: false, code: "UNSUPPORTED_ACTION" });
    expect(liveStateOf(services.conductor, galleryId)).toBeUndefined();
  });
});

describe("the order of a player's writes", () => {
  it("keeps the leaving write when the seek and the write in flight before it arrive after it", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    // Stamped in the order the player made them: a tick in flight, a seek waiting, then the page leaving.
    const tick = stateRequest(videoId, { status: "playing", position: 100, duration: 600 }, "inv_tick", 1_000);
    const seek = stateRequest(videoId, { status: "playing", position: 240, duration: 600 }, "inv_seek", 1_001);
    const leave = stateRequest(videoId, { status: "paused", position: 241, duration: 600 }, "inv_leave", 1_002);

    // The keepalive request reaches the node first; the slow tick and the seek come after it.
    expect(writeWidgetViewState(services, leave)).toMatchObject({ ok: true, body: { duplicate: false } });
    expect(writeWidgetViewState(services, tick)).toMatchObject({ ok: true, body: { duplicate: true, stale: true, state: { status: "paused", position: 241 } } });
    expect(writeWidgetViewState(services, seek)).toMatchObject({ ok: true, body: { duplicate: true, stale: true, state: { status: "paused", position: 241 } } });
    expect(liveStateOf(services.conductor, videoId)).toMatchObject({ revision: 1, body: { status: "paused", position: 241, duration: 600 } });
  });

  it("does not roll the state back for a replayed older id or an older sequence under a new id", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const older = stateRequest(videoId, { status: "playing", position: 30, duration: 600 }, "inv_older", 2_000);
    writeWidgetViewState(services, older);
    writeWidgetViewState(services, stateRequest(videoId, { status: "paused", position: 90, duration: 600 }, "inv_newer", 2_001));

    expect(writeWidgetViewState(services, older)).toMatchObject({ ok: true, body: { duplicate: true, stale: true, stateRevision: 2 } });
    expect(writeWidgetViewState(services, stateRequest(videoId, { status: "playing", position: 10, duration: 600 }, "inv_other", 2_001))).toMatchObject({
      ok: true,
      body: { stale: true },
    });
    expect(liveStateOf(services.conductor, videoId)).toMatchObject({ revision: 2, body: { status: "paused", position: 90 } });
  });
});

describe("the node's state-only record and other actions' ledger rows", () => {
  it("leaves an effectful row stored under the player's record key as it was, and writes nothing", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const bindingId = getInstance(services.conductor, videoId)?.actionBindingIds[0] ?? "";
    const key = viewStateRecordKey(bindingId);
    // A row the reserved prefix now keeps out, written as an effectful invoke action records itself.
    const effectful = JSON.stringify({ digest: "sha256:effect", result: { kind: "approval-required", approvalId: "appr_1" } });
    services.runtime.db
      .prepare("INSERT INTO action_invocations (invocation_id, action_binding_id, instance_id, outcome, recorded_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, "act_effect", videoId, effectful, AT);

    const write = writeWidgetViewState(services, stateRequest(videoId, { status: "paused", position: 12, duration: 60 }));
    expect(write).toMatchObject({ ok: false, code: "INVOCATION_KEY_REUSED", status: 409 });
    const row = services.runtime.db.prepare("SELECT action_binding_id, outcome FROM action_invocations WHERE invocation_id = ?").get(key) as {
      action_binding_id: string;
      outcome: string;
    };
    expect(row).toEqual({ action_binding_id: "act_effect", outcome: effectful });
    expect(liveStateOf(services.conductor, videoId)).toBeUndefined();
  });

  it("refuses a client id in the node's record space on the ordinary and the state-only path", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const bindingId = getInstance(services.conductor, videoId)?.actionBindingIds[0] ?? "";
    const reserved = viewStateRecordKey(bindingId);
    expect(await invokeWidgetAction(services, request(videoId, { status: "paused", position: 1, duration: 60 }, reserved))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
      status: 400,
    });
    expect(writeWidgetViewState(services, stateRequest(videoId, { status: "paused", position: 1, duration: 60 }, reserved))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    const target = request(videoId, { status: "paused", position: 1, duration: 60 }, reserved);
    const response = await post(videoId, { ...target, conversationId: undefined, principalId: undefined });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("INVALID_SCHEMA");
    expect(invocationRows(videoId)).toBe(0);
  });
});

describe("the action route's view-state variant", () => {
  it("answers with the state alone, no timeline, at the revision the page holds", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const target = request(videoId, { status: "paused", position: 12, duration: 60 });
    const response = await post(videoId, { ...target, conversationId: undefined, principalId: undefined, variant: "view-state", sequence: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      variant: "view-state",
      duplicate: false,
      instanceId: videoId,
      revision: target.expectedRevision,
      stateRevision: 1,
      state: { status: "paused", position: 12, duration: 60 },
    });
    expect(counts.timelines).toBe(0);
  });

  it("changes what the next turn reads about the player", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const send = (position: number, at: number) =>
      post(videoId, {
        ...request(videoId, { status: "paused", position, duration: 60 }),
        conversationId: undefined,
        principalId: undefined,
        variant: "view-state",
        sequence: at,
      });
    const playerIn = () => conversationUiContext(services.conductor, CONVERSATION).find((entry) => entry.doc.instanceId === videoId)?.doc;

    expect((await send(12, 1)).status).toBe(200);
    expect(playerIn()?.values).toMatchObject({ status: "paused", position: 12 });
    expect((await send(40, 2)).status).toBe(200);
    expect(playerIn()?.values).toMatchObject({ status: "paused", position: 40 });
  });

  it("refuses a body outside the contract: an unknown variant, a variant without its sequence, a sequence without the variant", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const target = { ...request(videoId, { status: "paused", position: 12, duration: 60 }), conversationId: undefined, principalId: undefined };
    for (const body of [
      { ...target, variant: "light", sequence: 1 },
      { ...target, variant: "view-state" },
      { ...target, sequence: 1 },
      { ...target, variant: "view-state", sequence: 1, extra: true },
    ]) {
      const response = await post(videoId, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(response.body)).toContain("INVALID_SCHEMA");
    }
    expect(liveStateOf(services.conductor, videoId)).toBeUndefined();
  });
});
