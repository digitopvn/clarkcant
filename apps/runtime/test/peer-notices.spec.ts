import { type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { type Instant, type PeerEnvelope, grantSchema } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  allRows,
  createConversation,
  deadLetterOutbox,
  getGrant,
  getPeer,
  nextOutboundSequence,
  peerDeliveryState,
  pendingOutbox,
  putPeerAllowance,
  recordNotification,
  revokeGrant,
  revokePeerAllowance,
  upsertTask,
} from "@clarkcant/storage";

import { PEER_NOTICES_PER_MINUTE, tellNoticeTurnedDown } from "../src/peer-notices.ts";
import { PEER_OFFLINE_NOTICE_AFTER_MS, type PeerOutageWatch, watchPeerOutages } from "../src/peer-outage.ts";
import { startPeerDelivery } from "../src/peer-signals.ts";
import { deliverPending } from "../src/peer-transport.ts";
import { createNodeServer } from "../src/server.ts";
import { type LiveNode, call, identityOf, liveNodes, pair, tokenFor } from "./live-nodes.ts";

/**
 * One Clark telling another's owner something, through the other's inbox.
 *
 * Two real nodes, paired the way a person pairs them, with real HTTP between them. What the tests are careful about is
 * that a notice is words under the sender's name and nothing more: it lands once however often it is sent, it is taken
 * only when the receiving node's own owner chose to work with the sender, it is sent only to a node that said it takes
 * notices, one peer cannot flood the inbox with it, it cannot bring an action with it, and a node that cannot deliver
 * to its peer says so once per outage — in words that match what is actually wrong — instead of going silent.
 */

const nodes = liveNodes();
const restarted: Server[] = [];

afterEach(async () => {
  for (const server of restarted.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await nodes.stopAll();
});

type Clark = LiveNode & { skip: (ms: number) => void; clock: () => Instant; watch: PeerOutageWatch };

/** A node with its delivery pass running on a clock the test can move, checking for unreachable peers after each pass. */
async function startClark(label: string): Promise<Clark> {
  let skew = 0;
  const clock = (): Instant => new Date(Date.now() + skew).toISOString() as Instant;
  let watch: PeerOutageWatch | undefined;
  const node = await nodes.start(label, (services) => {
    const outages = watchPeerOutages(services, clock());
    watch = outages;
    services.peerDelivery = startPeerDelivery(
      { db: services.runtime.db, identity: services.runtime.identity, now: clock },
      {
        intervalMs: 3_600_000,
        log: () => undefined,
        onTurnedDown: (turned) => tellNoticeTurnedDown(services, turned, clock()),
        afterPass: () => outages.reconcile(clock()),
      },
    );
  });
  if (watch === undefined) throw new Error("the node started without its outage watch");
  return {
    ...node,
    clock,
    watch,
    skip: (ms) => {
      skew += ms;
    },
  };
}

async function waitUntil(condition: () => boolean, what: string, explain?: () => unknown): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${explain === undefined ? "" : ` ${JSON.stringify(explain())}`}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A grant from one node's owner to the other: that owner's decision to work with the other node. */
async function grantBetween(from: LiveNode, to: LiveNode): Promise<string> {
  const grantId = `grant_${identityOf(from).nodeId}_${identityOf(to).nodeId}`.slice(0, 120);
  const written = await call(from, "/grants", {
    body: {
      grantId,
      ownerPrincipalId: identityOf(from).ownerPrincipalId,
      senderNodeId: identityOf(from).nodeId,
      receiverNodeId: identityOf(to).nodeId,
      capabilityRefs: [],
      resources: [],
      allowedDataClasses: ["public", "internal"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDelegationDepth: 0,
    },
    token: from.token,
  });
  expect(written.status).toBe(201);
  await waitUntil(() => getGrant(to.services.runtime.db, grantId) !== undefined, "the grant to reach the peer");
  return grantId;
}

/** The node's owner allows a peer's work here, written the way `allow_peer_tasks` writes it. */
function allowPeer(owner: LiveNode, peer: LiveNode): void {
  const at = new Date().toISOString() as Instant;
  putPeerAllowance(owner.services.runtime.db, {
    peerNodeId: identityOf(peer).nodeId,
    ownerPrincipalId: identityOf(owner).ownerPrincipalId,
    conversationId: "conv_allowance",
    grant: grantSchema.parse({
      grantId: "grant_allowance",
      ownerPrincipalId: identityOf(owner).ownerPrincipalId,
      senderNodeId: identityOf(peer).nodeId,
      receiverNodeId: identityOf(owner).nodeId,
      capabilityRefs: [],
      resources: [],
      allowedDataClasses: ["public"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDelegationDepth: 0,
    }),
    at,
  });
}

/** Deliver something from one node to the other and wait until the sender has read the answer: how it learns features. */
async function introduce(from: LiveNode, to: LiveNode, id = "hello"): Promise<void> {
  const sent = await call(from, `/peers/${identityOf(to).nodeId}/signals`, { body: { id, topic: "hello" }, token: from.token });
  expect(sent.status).toBe(202);
  await waitUntil(() => (getPeer(from.services.runtime.db, identityOf(to).nodeId)?.features ?? []).includes("notice"), "the peer's features");
}

interface NoticeRow {
  title: string;
  body: string | null;
  source_kind: string;
  origin_node_id: string | null;
  conversation_id: string | null;
  subject: string | null;
  dedup_key: string;
  dismissed_at: string | null;
}

function noticesOn(node: LiveNode, dedupKeyPrefix = ""): NoticeRow[] {
  return allRows<NoticeRow>(
    node.services.runtime.db,
    `SELECT title, body, source_kind, origin_node_id, conversation_id, subject, dedup_key, dismissed_at
       FROM notifications WHERE substr(dedup_key, 1, ?) = ? ORDER BY rowid`,
    dedupKeyPrefix.length,
    dedupKeyPrefix,
  );
}

function fromPeer(node: LiveNode): NoticeRow[] {
  return noticesOn(node).filter((row) => row.origin_node_id !== null);
}

/** Queue an envelope on a node as if its own checks had passed, to see what the receiver does with it. */
function queueRaw(from: LiveNode, to: LiveNode, kind: PeerEnvelope["kind"], payload: Record<string, unknown>, taskId?: string): void {
  const at = new Date().toISOString() as Instant;
  const messageId = from.services.conductor.newId("msg");
  sendEnvelope(
    { db: from.services.runtime.db, now: () => at },
    {
      protocol: "agent.nodelink",
      version: 1,
      messageId,
      correlationId: messageId,
      senderNodeId: identityOf(from).nodeId,
      recipientNodeId: identityOf(to).nodeId,
      kind,
      ...(taskId === undefined ? {} : { taskId }),
      sourceSequence: nextOutboundSequence(from.services.runtime.db, identityOf(to).nodeId),
      sentAt: at,
      payload,
    },
  );
  from.services.peerDelivery?.kick();
}

function rawNotice(key: string, title = `Tin ${key}`): Record<string, unknown> {
  return { notice: { key, category: "message", severity: "info", title } };
}

/** What the receiver answered each notice envelope with, as its NodeLink inbox recorded it. */
function answersOn(node: LiveNode): Record<string, unknown>[] {
  return allRows<{ response: string }>(node.services.runtime.db, "SELECT response FROM inbox WHERE kind = 'notice' ORDER BY rowid").map(
    (row) => JSON.parse(row.response) as Record<string, unknown>,
  );
}

/** Notice envelopes a node still owes: once empty, every answer was final for the sender. */
function owedNotices(node: LiveNode): PeerEnvelope[] {
  return (pendingOutbox(node.services.runtime.db) as PeerEnvelope[]).filter((envelope) => envelope.kind === "notice");
}

const NOT_CHOSEN = {
  accepted: false,
  code: "PEER_NOT_ALLOWED",
  reason: "this node's owner has not chosen to work with that peer (no grant to it, no allowance for it), so it takes no notices from it",
};
const UNREADABLE = { accepted: false, code: "NOTICE_UNREADABLE", reason: "the notice is not one this node can read" };

/** What a node told its own owner about its notices a peer did not take, one per peer and reason. */
function turnedDownOn(node: LiveNode): NoticeRow[] {
  return noticesOn(node, "peer-notice-refused:");
}

describe("a paired Clark's notice", () => {
  it("is recorded once in the other node's inbox, under the sender's name, however often it is sent", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    // B's owner works with A: that is what admits A's notices on B.
    await grantBetween(b, a);
    await introduce(a, b);
    const body = {
      id: "build-812",
      title: "Build hỏng trên máy bàn",
      body: "main đỏ\u0007từ 9 giờ‮​",
      category: "alert",
      severity: "warning",
    };

    expect((await call(a, `/peers/${identityOf(b).nodeId}/notices`, { body, token: a.token })).status).toBe(202);
    await waitUntil(() => fromPeer(b).length === 1 && owedNotices(a).length === 0, "the notice on B");

    // The same envelope again, as a retry after a lost acknowledgement: answered from B's NodeLink inbox.
    const [sent] = allRows<{ document: string }>(a.services.runtime.db, "SELECT document FROM outbox ORDER BY rowid")
      .map((row) => JSON.parse(row.document) as PeerEnvelope)
      .filter((envelope) => envelope.kind === "notice");
    const replay = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify(sent),
    });
    const replayed = (await replay.json()) as { status: string; features: unknown; label: unknown };
    // Every acknowledgement says what B takes and what it calls itself.
    expect(replayed).toMatchObject({ status: "duplicate", features: ["notice"], label: "laptop" });

    // The same notice under new envelopes: B keys it by the sender and the sender's own key, so it is still one row.
    for (let again = 0; again < 3; again += 1) {
      expect((await call(a, `/peers/${identityOf(b).nodeId}/notices`, { body, token: a.token })).status).toBe(202);
    }
    await waitUntil(() => owedNotices(a).length === 0 && answersOn(b).length === 4, "the resends");
    expect(answersOn(b).map((answer) => answer["duplicate"])).toEqual([false, true, true, true]);

    expect(fromPeer(b)).toEqual([
      {
        title: "Build hỏng trên máy bàn",
        // Its words as data: the control character is a space, the bidi override and zero-width space are gone.
        body: "main đỏ từ 9 giờ",
        source_kind: "peer",
        origin_node_id: identityOf(a).nodeId,
        conversation_id: null,
        subject: JSON.stringify({ kind: "peer", nodeId: identityOf(a).nodeId }),
        dedup_key: `peer:${identityOf(a).nodeId}:build-812`,
        dismissed_at: null,
      },
    ]);
    // What B's owner can do with it is B's to say: the inbox offers B's own actions, and no conversation to open.
    const inbox = await call(b, "/inbox", { method: "GET", token: b.token });
    const shown = (inbox.body["notices"] as { originNodeId?: string; actions?: { id: string }[] }[]).filter(
      (row) => row.originNodeId === identityOf(a).nodeId,
    );
    expect(shown).toHaveLength(1);
    expect((shown[0]?.actions ?? []).map((action) => action.id)).not.toContain("open");

    // The grant B wrote is B's owner's decision, not A's: A takes nothing from B under it. (B learned that A takes
    // notices from A's answer to that grant.)
    await waitUntil(() => (getPeer(b.services.runtime.db, identityOf(a).nodeId)?.features ?? []).includes("notice"), "A's features on B");
    expect(
      (await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body: { id: "battery", title: "Pin laptop còn 5%" }, token: b.token })).status,
    ).toBe(202);
    await waitUntil(() => answersOn(a).length === 1 && owedNotices(b).length === 0, "A's answer to B");
    expect(answersOn(a)).toEqual([NOT_CHOSEN]);
    expect(fromPeer(a)).toEqual([]);
    // B's route had already said "queued", so B's owner hears it here: what did not arrive, why, and what to do.
    await waitUntil(() => turnedDownOn(b).length === 1, "B to hear A did not take it");
    expect(turnedDownOn(b)[0]).toMatchObject({
      title: "Thiết bị khác không nhận thông báo",
      source_kind: "system",
      origin_node_id: null,
      subject: JSON.stringify({ kind: "peer", nodeId: identityOf(a).nodeId }),
      dedup_key: `peer-notice-refused:${identityOf(a).nodeId}:PEER_NOT_ALLOWED`,
      dismissed_at: null,
    });
    const told = turnedDownOn(b)[0]?.body ?? "";
    expect(told).toContain("Thiết bị desk đã nhận nhưng không ghi thông báo “Pin laptop còn 5%”");
    expect(told).toContain("chưa cho phép làm việc với Clark này");
    expect(told).toContain("sẽ không gửi lại");
    expect(told).toContain("allow_peer_tasks");
    // The row it went out in says so too, and stays acknowledged: nothing retries it.
    const refusedRow = allRows<{ last_error: string | null; acknowledged_at: string | null; document: string }>(
      b.services.runtime.db,
      "SELECT last_error, acknowledged_at, document FROM outbox",
    ).find((row) => (JSON.parse(row.document) as PeerEnvelope).kind === "notice");
    expect(refusedRow?.acknowledged_at).not.toBeNull();
    expect(refusedRow?.last_error).toBe(`the peer did not take it: ${NOT_CHOSEN.reason}`);

    // Once A's owner writes one of their own, A takes it.
    await grantBetween(a, b);
    expect(
      (await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body: { id: "battery-2", title: "Pin laptop còn 4%" }, token: b.token })).status,
    ).toBe(202);
    await waitUntil(() => fromPeer(a).length === 1, "B's notice on A");
    expect(fromPeer(a)[0]).toMatchObject({ title: "Pin laptop còn 4%", source_kind: "peer", origin_node_id: identityOf(b).nodeId });
  });

  it("is taken only under a decision of the receiving node's owner, and is refused whole when it brings anything else", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    const stranger = await startClark("stranger");
    await pair(a, b);

    // Working together on nothing: B refuses it, saying why, and records nothing; the refusal is final for A.
    queueRaw(a, b, "notice", rawNotice("1", "Xin chào"));
    await waitUntil(() => answersOn(b).length === 1 && owedNotices(a).length === 0, "B's answer");
    expect(answersOn(b)[0]).toEqual(NOT_CHOSEN);

    // A grant A wrote is A's decision alone: still refused.
    const fromA = await grantBetween(a, b);
    queueRaw(a, b, "notice", rawNotice("2", "Grant của A"));
    await waitUntil(() => answersOn(b).length === 2, "B's second answer");
    expect(answersOn(b)[1]).toEqual(NOT_CHOSEN);
    revokeGrant(a.services.runtime.db, fromA, new Date().toISOString() as Instant);
    revokeGrant(b.services.runtime.db, fromA, new Date().toISOString() as Instant);

    // B's owner allowing A's work here admits it; withdrawing the allowance refuses it again.
    allowPeer(b, a);
    queueRaw(a, b, "notice", rawNotice("3", "Có allowance"));
    await waitUntil(() => answersOn(b).length === 3, "B's third answer");
    expect(answersOn(b)[2]).toMatchObject({ accepted: true, duplicate: false });
    revokePeerAllowance(b.services.runtime.db, identityOf(a).nodeId, new Date().toISOString() as Instant);
    queueRaw(a, b, "notice", rawNotice("4", "Allowance đã rút"));
    await waitUntil(() => answersOn(b).length === 4, "B's fourth answer");
    expect(answersOn(b)[3]).toEqual(NOT_CHOSEN);

    // So does a grant B's owner wrote to A, until it is withdrawn.
    const fromB = await grantBetween(b, a);
    queueRaw(a, b, "notice", rawNotice("5", "Grant của B"));
    await waitUntil(() => answersOn(b).length === 5, "B's fifth answer");
    expect(answersOn(b)[4]).toMatchObject({ accepted: true });

    // A notice that tries to bring an action, or to point at something of B's, is refused whole.
    queueRaw(a, b, "notice", {
      notice: { key: "6", category: "message", severity: "info", title: "Bấm vào đây", actions: [{ id: "open", placement: "primary" }] },
    });
    queueRaw(a, b, "notice", {
      notice: { key: "7", category: "message", severity: "info", title: "Việc của bạn", subject: { kind: "task", taskId: "task_1" } },
    });
    await waitUntil(() => answersOn(b).length === 7, "B's answers to the forged notices");
    expect(answersOn(b).slice(5)).toEqual([UNREADABLE, UNREADABLE]);
    revokeGrant(b.services.runtime.db, fromB, new Date().toISOString() as Instant);
    queueRaw(a, b, "notice", rawNotice("8", "Grant của B đã rút"));
    await waitUntil(() => answersOn(b).length === 8 && owedNotices(a).length === 0, "B's last answer");
    expect(answersOn(b)[7]).toEqual(NOT_CHOSEN);
    expect(fromPeer(b).map((row) => row.title)).toEqual(["Có allowance", "Grant của B"]);
    // A's owner heard it once per reason, not once per refusal: four refused as not allowed, two as unreadable.
    await waitUntil(() => turnedDownOn(a).length === 2, "A to hear what B did not take");
    expect(turnedDownOn(a).map((row) => row.dedup_key)).toEqual([
      `peer-notice-refused:${identityOf(b).nodeId}:PEER_NOT_ALLOWED`,
      `peer-notice-refused:${identityOf(b).nodeId}:NOTICE_UNREADABLE`,
    ]);
    expect(turnedDownOn(a)[1]?.body).toContain("cập nhật ClarkCant trên cả hai máy");

    // Not queued for a node never paired, nor when it is not a notice, nor without this node's own token.
    expect((await call(a, `/peers/${identityOf(stranger).nodeId}/notices`, { body: { id: "1", title: "x" }, token: a.token })).body).toMatchObject({
      code: "PEER_UNKNOWN",
    });
    for (const body of [{ title: "no id" }, { id: "1" }, { id: "1", title: "x", severity: "panic" }, { id: "1", title: "x".repeat(121) }]) {
      expect((await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body, token: b.token })).status).toBe(400);
    }
    expect((await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body: { id: "1", title: "x" } })).status).toBe(401);
    expect(owedNotices(b)).toEqual([]);
  });

  it("is sent only to a node that said it takes notices, which a node paired before learns from the next answer", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await grantBetween(b, a);
    const peerB = identityOf(b).nodeId;
    // Paired, but B has never answered anything A sent it: A does not know B takes notices.
    expect(getPeer(a.services.runtime.db, peerB)).not.toHaveProperty("features");
    const refused = await call(a, `/peers/${peerB}/notices`, { body: { id: "1", title: "Xin chào" }, token: a.token });
    expect(refused).toMatchObject({ status: 409, body: { code: "NOTICES_UNSUPPORTED" } });
    // It says how to change that: any delivery refreshes what A knows, and an old build needs updating.
    expect(String(refused.body["message"])).toContain("has not said it takes notices");
    expect(String(refused.body["message"])).toContain(`send it something first (a signal, POST /peers/${peerB}/signals)`);
    expect(String(refused.body["message"])).toContain("update it there");
    expect(owedNotices(a)).toEqual([]);

    // Anything A delivers is answered with what B takes and what it calls itself.
    await introduce(a, b);
    expect(getPeer(a.services.runtime.db, peerB)).toMatchObject({ features: ["notice"], label: "laptop" });
    expect((await call(a, `/peers/${peerB}/notices`, { body: { id: "2", title: "Xin chào" }, token: a.token })).status).toBe(202);
    await waitUntil(() => fromPeer(b).length === 1 && pendingOutbox(a.services.runtime.db).length === 0, "the notice on B");

    // An answer from a build without features says B takes none now, and keeps the name it gave.
    a.services.peerDelivery?.stop();
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "old", topic: "hello" }, token: a.token })).status).toBe(202);
    const outcome = await deliverPending({
      db: a.services.runtime.db,
      identity: identityOf(a),
      now: a.clock,
      peerFor: (peerNodeId) => getPeer(a.services.runtime.db, peerNodeId),
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ status: "recorded", response: {} }), { status: 200 })),
    });
    expect(outcome.acknowledged).toBe(1);
    expect(getPeer(a.services.runtime.db, peerB)).not.toHaveProperty("features");
    expect(getPeer(a.services.runtime.db, peerB)).toMatchObject({ label: "laptop" });
    expect((await call(a, `/peers/${peerB}/notices`, { body: { id: "3", title: "Xin chào" }, token: a.token })).status).toBe(409);
  });

  it("holds one peer to its rate and to its own share of the inbox, and a refusal past the rate is final", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await grantBetween(b, a);
    recordNotification(b.services.runtime.db, {
      notificationId: "ntf_local",
      principalId: identityOf(b).ownerPrincipalId,
      sourceKind: "worker",
      category: "result",
      severity: "success",
      title: "Việc của máy này",
      dedupKey: "worker:task_local",
      at: new Date().toISOString() as Instant,
    });

    for (let index = 0; index <= PEER_NOTICES_PER_MINUTE; index += 1) queueRaw(a, b, "notice", rawNotice(String(index)));
    await waitUntil(() => answersOn(b).length === PEER_NOTICES_PER_MINUTE + 1 && owedNotices(a).length === 0, "B's answers");
    const answers = answersOn(b);
    expect(answers.slice(0, PEER_NOTICES_PER_MINUTE).every((answer) => answer["accepted"] === true)).toBe(true);
    expect(answers[PEER_NOTICES_PER_MINUTE]).toEqual({
      accepted: false,
      code: "RATE_LIMITED",
      reason: `this node takes at most ${String(PEER_NOTICES_PER_MINUTE)} notices a minute from one peer; this one came past that and was not recorded`,
    });
    await waitUntil(() => turnedDownOn(a).length === 1, "A to hear B took no more");
    expect(turnedDownOn(a)[0]?.body).toContain("Hãy đợi một phút rồi gửi lại");

    // A minute later it is taken again.
    b.services.runtime.db.prepare("UPDATE inbox SET received_at = ? WHERE kind = 'notice'").run(new Date(Date.now() - 120_000).toISOString());
    queueRaw(a, b, "notice", rawNotice("late"));
    await waitUntil(() => answersOn(b).length === PEER_NOTICES_PER_MINUTE + 2, "B's answer a minute later");
    expect(answersOn(b)[PEER_NOTICES_PER_MINUTE + 1]).toMatchObject({ accepted: true });

    // Thirty-one taken, twenty kept: A's newest, and B's own notice is untouched.
    const kept = noticesOn(b).filter((row) => row.dismissed_at === null);
    expect(kept.filter((row) => row.origin_node_id === identityOf(a).nodeId)).toHaveLength(20);
    expect(kept.map((row) => row.dedup_key)).toContain("worker:task_local");
    expect(kept.map((row) => row.dedup_key)).toContain(`peer:${identityOf(a).nodeId}:late`);
    expect(kept.map((row) => row.dedup_key)).not.toContain(`peer:${identityOf(a).nodeId}:0`);
  });

  it("points at a conversation only of a task this node handed to that very peer", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await grantBetween(a, b);
    const at = new Date().toISOString() as Instant;
    const task = (taskId: string, conversationId: string, executionNodeId: string): void => {
      createConversation(a.services.runtime.db, { conversationId, homeNodeId: identityOf(a).nodeId, at });
      upsertTask(a.services.runtime.db, {
        taskId,
        conversationId,
        homeNodeId: identityOf(a).nodeId,
        executionNodeId,
        state: "running",
        revision: 1,
        goal: "việc thử",
        createdAt: at,
        updatedAt: at,
      });
    };
    task("task_handed", "conv_handed", identityOf(b).nodeId);
    task("task_elsewhere", "conv_elsewhere", "node_000000000000000000000000");
    task("task_local", "conv_local", identityOf(a).nodeId);

    queueRaw(b, a, "notice", rawNotice("handed"), "task_handed");
    queueRaw(b, a, "notice", rawNotice("elsewhere"), "task_elsewhere");
    queueRaw(b, a, "notice", rawNotice("local"), "task_local");
    queueRaw(b, a, "notice", rawNotice("unknown"), "task_unknown");
    await waitUntil(() => fromPeer(a).length === 4, "B's notices on A");
    expect(Object.fromEntries(fromPeer(a).map((row) => [row.dedup_key.split(":").at(-1), row.conversation_id]))).toEqual({
      handed: "conv_handed",
      elsewhere: null,
      local: null,
      unknown: null,
    });
  });
});

interface OutboxRow {
  message_id: string;
  attempts: number;
  created_at: string;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  acknowledged_at: string | null;
}

function outboxOf(node: LiveNode): OutboxRow[] {
  return allRows<OutboxRow>(
    node.services.runtime.db,
    "SELECT message_id, attempts, created_at, last_attempt_at, next_attempt_at, last_error, acknowledged_at FROM outbox ORDER BY rowid",
  );
}

/**
 * How many attempts each message has had once the last of them is over: an attempt is recorded before the request goes
 * out and its failure after, so a row counts only once its retry is scheduled past its latest attempt.
 */
function failedAttempts(node: LiveNode): (number | undefined)[] {
  return outboxOf(node).map((row) =>
    row.last_error !== null && row.next_attempt_at !== null && row.last_attempt_at !== null && row.next_attempt_at > row.last_attempt_at
      ? row.attempts
      : undefined,
  );
}

describe("a paired node that cannot be reached", () => {
  it("is told once per outage, after a while, and the notice goes when the node answers again", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;
    // Pairing told A what B calls itself; forget it, so the first notice shows what A falls back to.
    a.services.runtime.db.prepare("UPDATE peers SET label = NULL WHERE peer_node_id = ?").run(peerB);
    const port = Number(new URL(b.base).port);
    const offline = (): NoticeRow[] => noticesOn(a, `peer-offline:${peerB}:`);
    const signal = async (id: string): Promise<void> => {
      expect((await call(a, `/peers/${peerB}/signals`, { body: { id, topic: "build.failed" }, token: a.token })).status).toBe(202);
    };
    const failed = (index: number, attempts: number): boolean => failedAttempts(a)[index] === attempts;
    const explain = (): unknown => ({ outbox: outboxOf(a), state: peerDeliveryState(a.services.runtime.db, peerB), notices: noticesOn(a), at: a.clock() });

    await b.stop();
    await signal("1");
    await waitUntil(() => failed(0, 1), "the first failed attempt", explain);
    // A blip is not an outage.
    expect(offline()).toEqual([]);

    // Still failing past the threshold: said once, however often the node looks again.
    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => failed(0, 2) && offline().length === 1, "the outage notice", explain);
    a.watch.reconcile(a.clock());
    a.skip(5 * 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => failed(0, 3), "another failed attempt", explain);
    expect(offline()).toHaveLength(1);
    // Keyed by the last time B took something from A, then by what is wrong and when in the outage: one outage, one key.
    const lastTaken = peerDeliveryState(a.services.runtime.db, peerB).lastAcknowledgedAt;
    expect(offline()[0]).toMatchObject({
      title: "Không gửi được tới thiết bị khác",
      source_kind: "system",
      subject: JSON.stringify({ kind: "peer", nodeId: peerB }),
      dedup_key: `peer-offline:${peerB}:${lastTaken ?? "never"}:0:unreachable`,
      dismissed_at: null,
    });
    // A knows no name for B, so it shows B's node id.
    expect(offline()[0]?.body).toMatch(new RegExp(`^Không gửi được tới thiết bị ${peerB} từ lúc \\d{2}:\\d{2} ngày .*không trả lời`));
    expect(offline()[0]?.body).toContain("vẫn nằm trong hàng đợi");

    // B is back: the message goes, and the notice with it.
    const server = createNodeServer({ services: b.services, origin: "http://127.0.0.1", onWarning: () => undefined });
    restarted.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    a.skip(5 * 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0 && offline()[0]?.dismissed_at !== null, "the recovery", explain);

    // A second outage, after B answered, is a second notice; the first stays closed. B's answer gave it a name.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restarted.splice(0);
    await signal("2");
    await waitUntil(() => failed(1, 1), "the second outage's first failure", explain);
    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => offline().length === 2, "the second outage notice", explain);
    expect(offline().map((row) => row.dismissed_at === null)).toEqual([false, true]);
    expect(offline()[1]?.dedup_key).not.toBe(offline()[0]?.dedup_key);
    expect(offline()[1]?.body).toMatch(/^Không gửi được tới thiết bị laptop từ lúc/);
  });

  it("says a node that answers but refuses is refusing, not unreachable, and does not ask for it to be turned on", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;
    // B's owner revoked the pairing on B: B still answers A, with a refusal.
    expect((await call(b, `/peers/${identityOf(a).nodeId}/revoke`, { token: b.token })).status).toBe(200);
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token })).status).toBe(202);
    await waitUntil(() => failedAttempts(a)[0] === 1, "the refused attempt", () => outboxOf(a));
    expect(outboxOf(a)[0]?.last_error).toBe("the peer answered 401");

    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    a.watch.reconcile(a.clock());
    const [notice, ...rest] = noticesOn(a, `peer-offline:${peerB}:`);
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ title: "Thiết bị khác từ chối nhận", dedup_key: `peer-offline:${peerB}:never:0:refused` });
    expect(notice?.body).toContain("vẫn trả lời nhưng từ chối");
    expect(notice?.body).toContain("(mã 401)");
    expect(notice?.body).not.toContain("bật nó lên");
    expect(notice?.body).not.toContain("không trả lời");
  });

  it("says so, without promising a retry, once everything owed was given up on", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;
    const offline = (): NoticeRow[] => noticesOn(a, `peer-offline:${peerB}:`);
    await b.stop();
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token })).status).toBe(202);
    await waitUntil(() => failedAttempts(a)[0] === 1, "the failed attempt", () => outboxOf(a));
    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    a.watch.reconcile(a.clock());
    expect(offline().map((row) => row.title)).toEqual(["Không gửi được tới thiết bị khác"]);

    // The outbox gave the message up, as it does after its last retry.
    deadLetterOutbox(a.services.runtime.db, String(outboxOf(a)[0]?.message_id), a.clock(), "connect ECONNREFUSED");
    a.watch.reconcile(a.clock());
    expect(offline().map((row) => [row.title, row.dismissed_at === null])).toEqual([
      ["Không gửi được tới thiết bị khác", false],
      ["Đã ngừng gửi tới thiết bị khác", true],
    ]);
    const givenUp = offline()[1]?.body ?? "";
    expect(givenUp).toContain("sẽ không được gửi lại");
    expect(givenUp).not.toContain("thử lại tự động");
    expect(givenUp).not.toContain("hàng đợi");
    // What to do about it: resend what is still needed, and where the tasks it concerned were settled.
    expect(givenUp).toContain("hãy gửi lại những gì còn cần");
    expect(givenUp).toContain("được chốt trong hội thoại");
    // Said once, however often the node looks again.
    a.watch.reconcile(a.clock());
    expect(offline()).toHaveLength(2);

    // Something new fails to go while B is still down: unreachable again, said again rather than lost in the first
    // notice's dismissed row.
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "2", topic: "build.failed" }, token: a.token })).status).toBe(202);
    await waitUntil(() => failedAttempts(a)[1] === 1, "the new message's failed attempt", () => outboxOf(a));
    a.watch.reconcile(a.clock());
    expect(offline().map((row) => [row.title, row.dismissed_at === null])).toEqual([
      ["Không gửi được tới thiết bị khác", false],
      ["Đã ngừng gửi tới thiết bị khác", false],
      ["Không gửi được tới thiết bị khác", true],
    ]);
    expect(offline().map((row) => row.dedup_key.split(":").slice(-2).join(":"))).toEqual(["0:unreachable", "1:given-up", "2:unreachable"]);
  });

  it("keeps one notice showing per outage as what is wrong changes, and says a situation again when it comes back", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;
    const offline = (): NoticeRow[] => noticesOn(a, `peer-offline:${peerB}:`);
    const showing = (): string[] => offline().filter((row) => row.dismissed_at === null).map((row) => row.title);
    // Delivery is held so the test says how each attempt failed, the way the transport records it.
    a.services.peerDelivery?.stop();
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token })).status).toBe(202);
    const failWith = (error: string): void => {
      a.services.runtime.db
        .prepare("UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE acknowledged_at IS NULL")
        .run(a.clock(), error);
      a.watch.reconcile(a.clock());
    };

    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    failWith("connect ECONNREFUSED 127.0.0.1:1");
    expect(showing()).toEqual(["Không gửi được tới thiết bị khác"]);
    failWith("the peer answered 401");
    expect(showing()).toEqual(["Thiết bị khác từ chối nhận"]);
    failWith("connect ECONNREFUSED 127.0.0.1:1");
    expect(showing()).toEqual(["Không gửi được tới thiết bị khác"]);
    failWith("the peer answered 401");
    expect(showing()).toEqual(["Thiết bị khác từ chối nhận"]);
    expect(offline()).toHaveLength(4);

    // A node that answers with an error of its own is on: it is not asked to be turned on.
    failWith("the peer answered 503");
    expect(showing()).toEqual(["Thiết bị khác báo lỗi khi nhận"]);
    const erroring = offline().at(-1)?.body ?? "";
    expect(erroring).toContain("báo lỗi khi nhận");
    expect(erroring).toContain("(mã 503)");
    expect(erroring).not.toContain("bật nó lên");
    expect(erroring).not.toContain("không trả lời");

    // The same situation again is the same notice, so one the person dismissed stays dismissed.
    a.services.runtime.db.prepare("UPDATE notifications SET dismissed_at = ? WHERE dismissed_at IS NULL AND dedup_key LIKE 'peer-offline:%'").run(a.clock());
    failWith("the peer answered 500");
    expect(showing()).toEqual([]);
    expect(offline()).toHaveLength(5);
  });

  it("counts an outage only over time this node watched, after a restart or a wake from sleep", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;
    const offline = (): NoticeRow[] => noticesOn(a, `peer-offline:${peerB}:`);
    await b.stop();
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token })).status).toBe(202);
    await waitUntil(() => failedAttempts(a)[0] === 1, "the failed attempt", () => outboxOf(a));
    // The message has been owed for two hours, most of which this node did not see.
    const twoHoursAgo = new Date(Date.parse(a.clock()) - 2 * 3_600_000).toISOString() as Instant;
    a.services.runtime.db.prepare("UPDATE outbox SET created_at = ?").run(twoHoursAgo);

    // A machine that slept through them says nothing on waking...
    const slept = watchPeerOutages(a.services, twoHoursAgo);
    slept.woke(a.clock());
    slept.reconcile(a.clock());
    expect(offline()).toEqual([]);
    // ...nor does a node that just started...
    const watchedFrom = a.clock();
    const started = watchPeerOutages(a.services, watchedFrom);
    started.reconcile(a.clock());
    expect(offline()).toEqual([]);
    // ...until it has watched delivery fail for long enough itself, and then it says it has failed at least since it
    // began watching, which is all it knows — with the node's zone, so the time is not read in another one.
    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    started.reconcile(a.clock());
    expect(offline()).toHaveLength(1);
    const time = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(watchedFrom));
    expect(offline()[0]?.body).toMatch(new RegExp(`ít nhất từ lúc ${time} ngày \\d{2}/\\d{2}/\\d{4} \\(GMT[^)]*\\)`));
  });

  it("notices a wake from sleep when its timer fires far later than it should", async () => {
    const a = await startClark("desk");
    let skew = 0;
    const woke: Instant[] = [];
    const delivery = startPeerDelivery(
      { db: a.services.runtime.db, identity: identityOf(a), now: () => new Date(Date.now() + skew).toISOString() as Instant },
      { intervalMs: 50, log: () => undefined, onWake: (at) => woke.push(at) },
    );
    try {
      skew = 3_600_000;
      const jumped = Date.now() + skew;
      await waitUntil(() => woke.some((at) => Date.parse(at) >= jumped), "the wake to be noticed");
    } finally {
      delivery.stop();
    }
  });

  it("says nothing about a node that was revoked, and takes back what it said", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;
    await b.stop();
    expect((await call(a, `/peers/${peerB}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token })).status).toBe(202);
    await waitUntil(() => failedAttempts(a)[0] === 1, "the failed attempt", () => outboxOf(a));
    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    a.watch.reconcile(a.clock());
    expect(noticesOn(a, `peer-offline:${peerB}:`)).toHaveLength(1);

    expect((await call(a, `/peers/${peerB}/revoke`, { token: a.token })).status).toBe(200);
    a.watch.reconcile(a.clock());
    expect(noticesOn(a, `peer-offline:${peerB}:`).map((row) => row.dismissed_at === null)).toEqual([false]);
  });
});
