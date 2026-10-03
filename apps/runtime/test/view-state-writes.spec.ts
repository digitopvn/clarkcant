import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Instant, MEDIA_PLAYBACK_WRITE_INTERVAL_MS } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf, viewStateRecordKey } from "@clarkcant/core";
import { insertLocalImage } from "@clarkcant/storage";

import { invokeWidgetAction, writeWidgetViewState } from "../src/application/widget-actions.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
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
      const written = writeWidgetViewState(services, request(videoId, { status: "playing", position: tick * 3, duration: 600 }));
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
      const outcome = writeWidgetViewState(services, request(videoId, { status: "playing", position: write * 3, duration: 3_600 }));
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

  it("answers a retry of the latest write with its outcome, and refuses its id reused with other input", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const first = writeWidgetViewState(services, request(videoId, { status: "playing", position: 3, duration: 60 }, "inv_same"));
    const again = writeWidgetViewState(services, request(videoId, { status: "playing", position: 3, duration: 60 }, "inv_same"));
    expect(first).toMatchObject({ ok: true, body: { duplicate: false, stateRevision: 1 } });
    expect(again).toMatchObject({ ok: true, body: { duplicate: true, stateRevision: 1 } });
    const reused = writeWidgetViewState(services, request(videoId, { status: "paused", position: 4, duration: 60 }, "inv_same"));
    expect(reused).toMatchObject({ ok: false, code: "INVOCATION_KEY_REUSED" });
    expect(liveStateOf(services.conductor, videoId)?.body).toEqual({ status: "playing", position: 3, duration: 60 });
  });

  it("holds the write to the same gate: input, revision, digest and owner", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    expect(writeWidgetViewState(services, request(videoId, { status: "playing", position: 61, duration: 60 }))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(writeWidgetViewState(services, { ...request(videoId, { status: "paused", position: 1, duration: 60 }), expectedRevision: 99 })).toMatchObject({
      ok: false,
      code: "REVISION_MISMATCH",
      status: 409,
    });
    expect(writeWidgetViewState(services, { ...request(videoId, { status: "paused", position: 1, duration: 60 }), expectedBindingDigest: "sha256:other" })).toMatchObject({
      ok: false,
      code: "BINDING_STALE",
    });
    expect(writeWidgetViewState(services, { ...request(videoId, { status: "paused", position: 1, duration: 60 }), principalId: "prin_someone_else" })).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
      status: 403,
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
    const refused = writeWidgetViewState(services, request(galleryId, { selectedIndex: 0 }));
    expect(refused).toMatchObject({ ok: false, code: "UNSUPPORTED_ACTION" });
    expect(liveStateOf(services.conductor, galleryId)).toBeUndefined();
  });
});

describe("the action route's view-state variant", () => {
  it("answers with the state alone, no timeline, at the revision the page holds", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const target = request(videoId, { status: "paused", position: 12, duration: 60 });
    const response = await post(videoId, { ...target, conversationId: undefined, principalId: undefined, variant: "view-state" });
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

  it("refuses a variant it does not know rather than reading it as the ordinary call", async () => {
    const videoId = await place("canvas.video@1", { videoRef: "video-ref", alt: "A film" });
    const target = request(videoId, { status: "paused", position: 12, duration: 60 });
    const response = await post(videoId, { ...target, conversationId: undefined, principalId: undefined, variant: "light" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("INVALID_SCHEMA");
    expect(liveStateOf(services.conductor, videoId)).toBeUndefined();
  });
});
