import { type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { Instant, PeerEnvelope } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import { allRows, getGrant, nextOutboundSequence, peerDeliveryState, pendingOutbox, revokeGrant } from "@clarkcant/storage";

import { PEER_OFFLINE_NOTICE_AFTER_MS, reconcilePeerOutages } from "../src/peer-outage.ts";
import { startPeerDelivery } from "../src/peer-signals.ts";
import { createNodeServer } from "../src/server.ts";
import { type LiveNode, call, identityOf, liveNodes, pair, tokenFor } from "./live-nodes.ts";

/**
 * One Clark telling another's owner something, through the other's inbox.
 *
 * Two real nodes, paired the way a person pairs them, with real HTTP between them. What the tests are careful about is
 * that a notice is words under the sender's name and nothing more: it lands once however often it is sent, it needs the
 * two owners to be working together through a live grant, it cannot bring an action with it, and a node that cannot
 * reach its peer says so once per outage instead of going silent.
 */

const nodes = liveNodes();
const restarted: Server[] = [];

afterEach(async () => {
  for (const server of restarted.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await nodes.stopAll();
});

/** A node with its delivery pass running on a clock the test can move, checking for unreachable peers after each pass. */
async function startClark(label: string): Promise<LiveNode & { skip: (ms: number) => void; clock: () => Instant }> {
  let skew = 0;
  const clock = (): Instant => new Date(Date.now() + skew).toISOString() as Instant;
  const node = await nodes.start(label, (services) => {
    services.peerDelivery = startPeerDelivery(
      { db: services.runtime.db, identity: services.runtime.identity, now: clock },
      { intervalMs: 3_600_000, log: () => undefined, afterPass: () => reconcilePeerOutages(services, clock()) },
    );
  });
  return {
    ...node,
    clock,
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

/** A grant from one node's owner to the other: what says the two owners work together. */
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
function queueRaw(from: LiveNode, to: LiveNode, kind: PeerEnvelope["kind"], payload: Record<string, unknown>): void {
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
      sourceSequence: nextOutboundSequence(from.services.runtime.db, identityOf(to).nodeId),
      sentAt: at,
      payload,
    },
  );
  from.services.peerDelivery?.kick();
}

/** What the receiver answered each notice envelope with, as its NodeLink inbox recorded it. */
function answersOn(node: LiveNode): Record<string, unknown>[] {
  return allRows<{ response: string }>(node.services.runtime.db, "SELECT response FROM inbox WHERE kind = 'notice' ORDER BY rowid").map(
    (row) => JSON.parse(row.response) as Record<string, unknown>,
  );
}

describe("a paired Clark's notice", () => {
  it("is recorded once in the other node's inbox, under the sender's name, however often it is sent", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await grantBetween(a, b);
    const body = { id: "build-812", title: "Build hỏng trên máy bàn", body: "main đỏ\u0007từ 9 giờ", category: "alert", severity: "warning" };

    expect((await call(a, `/peers/${identityOf(b).nodeId}/notices`, { body, token: a.token })).status).toBe(202);
    await waitUntil(() => fromPeer(b).length === 1 && pendingOutbox(a.services.runtime.db).length === 0, "the notice on B");

    // The same envelope again, as a retry after a lost acknowledgement: answered from B's NodeLink inbox.
    const [sent] = allRows<{ document: string }>(a.services.runtime.db, "SELECT document FROM outbox ORDER BY rowid")
      .map((row) => JSON.parse(row.document) as PeerEnvelope)
      .filter((envelope) => envelope.kind === "notice");
    const replay = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify(sent),
    });
    expect(((await replay.json()) as { status: string }).status).toBe("duplicate");

    // The same notice under new envelopes: B keys it by the sender and the sender's own key, so it is still one row.
    for (let again = 0; again < 3; again += 1) {
      expect((await call(a, `/peers/${identityOf(b).nodeId}/notices`, { body, token: a.token })).status).toBe(202);
    }
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0 && answersOn(b).length === 4, "the resends");
    expect(answersOn(b).map((answer) => answer["duplicate"])).toEqual([false, true, true, true]);

    expect(fromPeer(b)).toEqual([
      {
        title: "Build hỏng trên máy bàn",
        // Its words as data: the control character is gone, nothing else is changed.
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

    // A grant in either direction ties the two: B can tell A too, under the grant A wrote.
    expect(
      (await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body: { id: "battery", title: "Pin laptop còn 5%" }, token: b.token })).status,
    ).toBe(202);
    await waitUntil(() => fromPeer(a).length === 1, "B's notice on A");
    expect(fromPeer(a)[0]).toMatchObject({ title: "Pin laptop còn 5%", source_kind: "peer", origin_node_id: identityOf(b).nodeId });
  });

  it("is refused from a node no live grant ties to this one, and is not queued for one", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    const stranger = await startClark("stranger");
    await pair(a, b);
    const peerB = identityOf(b).nodeId;

    // Paired but working together on nothing: A's own gateway will not queue it.
    const unqueued = await call(a, `/peers/${peerB}/notices`, { body: { id: "1", title: "Xin chào" }, token: a.token });
    expect(unqueued).toMatchObject({ status: 409, body: { code: "NO_LIVE_GRANT" } });
    expect(pendingOutbox(a.services.runtime.db)).toEqual([]);

    // And B refuses one that reaches it anyway, saying why, and records nothing.
    queueRaw(a, b, "notice", { notice: { key: "1", category: "message", severity: "info", title: "Xin chào" } });
    await waitUntil(() => answersOn(b).length === 1, "B's answer");
    expect(answersOn(b)[0]).toEqual({ accepted: false, reason: "this node holds no live grant with that peer, so it takes no notices from it" });

    // Under a grant it is taken; once that grant is withdrawn, it is refused again.
    const grantId = await grantBetween(a, b);
    queueRaw(a, b, "notice", { notice: { key: "2", category: "message", severity: "info", title: "Có grant" } });
    await waitUntil(() => answersOn(b).length === 2, "B's second answer");
    expect(answersOn(b)[1]).toMatchObject({ accepted: true, duplicate: false });
    revokeGrant(b.services.runtime.db, grantId, new Date().toISOString() as Instant);
    queueRaw(a, b, "notice", { notice: { key: "3", category: "message", severity: "info", title: "Grant đã rút" } });
    await waitUntil(() => answersOn(b).length === 3, "B's third answer");
    expect(answersOn(b)[2]).toMatchObject({ accepted: false });

    // A notice that tries to bring an action, or to point at something of B's, is refused whole.
    revokeGrant(a.services.runtime.db, grantId, new Date().toISOString() as Instant);
    await grantBetween(b, a);
    queueRaw(a, b, "notice", {
      notice: { key: "4", category: "message", severity: "info", title: "Bấm vào đây", actions: [{ id: "open", placement: "primary" }] },
    });
    queueRaw(a, b, "notice", {
      notice: { key: "5", category: "message", severity: "info", title: "Việc của bạn", subject: { kind: "task", taskId: "task_1" } },
    });
    await waitUntil(() => answersOn(b).length === 5, "B's answers to the forged notices");
    expect(answersOn(b).slice(3)).toEqual([
      { accepted: false, reason: "the notice is not one this node can read" },
      { accepted: false, reason: "the notice is not one this node can read" },
    ]);
    expect(fromPeer(b).map((row) => row.title)).toEqual(["Có grant"]);

    // Not queued for a node never paired, nor when it is not a notice, nor without this node's own token.
    expect((await call(a, `/peers/${identityOf(stranger).nodeId}/notices`, { body: { id: "1", title: "x" }, token: a.token })).body).toMatchObject({
      code: "PEER_UNKNOWN",
    });
    for (const body of [{ title: "no id" }, { id: "1" }, { id: "1", title: "x", severity: "panic" }, { id: "1", title: "x".repeat(121) }]) {
      expect((await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body, token: b.token })).status).toBe(400);
    }
    expect((await call(b, `/peers/${identityOf(a).nodeId}/notices`, { body: { id: "1", title: "x" } })).status).toBe(401);
    expect(pendingOutbox(b.services.runtime.db)).toEqual([]);
  });
});

interface OutboxRow {
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
    "SELECT attempts, created_at, last_attempt_at, next_attempt_at, last_error, acknowledged_at FROM outbox ORDER BY rowid",
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
    reconcilePeerOutages(a.services, a.clock());
    a.skip(5 * 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => failed(0, 3), "another failed attempt", explain);
    expect(offline()).toHaveLength(1);
    // Keyed by the last time B took something from A: one outage, one key.
    const lastTaken = peerDeliveryState(a.services.runtime.db, peerB).lastAcknowledgedAt;
    expect(offline()[0]).toMatchObject({
      title: "Không gửi được tới thiết bị khác",
      source_kind: "system",
      subject: JSON.stringify({ kind: "peer", nodeId: peerB }),
      dedup_key: `peer-offline:${peerB}:${lastTaken ?? "never"}`,
      dismissed_at: null,
    });
    expect(offline()[0]?.body).toMatch(new RegExp(`^Không gửi được tới thiết bị ${peerB} từ lúc \\d{2}:\\d{2} ngày `));
    expect(offline()[0]?.body).toContain("vẫn nằm trong hàng đợi");

    // B is back: the message goes, and the notice with it.
    const server = createNodeServer({ services: b.services, origin: "http://127.0.0.1", onWarning: () => undefined });
    restarted.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    a.skip(5 * 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0 && offline()[0]?.dismissed_at !== null, "the recovery", explain);

    // A second outage, after B answered, is a second notice; the first stays closed.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restarted.splice(0);
    await signal("2");
    await waitUntil(() => failed(1, 1), "the second outage's first failure", explain);
    a.skip(PEER_OFFLINE_NOTICE_AFTER_MS + 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => offline().length === 2, "the second outage notice", explain);
    expect(offline().map((row) => row.dismissed_at === null)).toEqual([false, true]);
    expect(offline()[1]?.dedup_key).not.toBe(offline()[0]?.dedup_key);
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
    reconcilePeerOutages(a.services, a.clock());
    expect(noticesOn(a, `peer-offline:${peerB}:`)).toHaveLength(1);

    expect((await call(a, `/peers/${peerB}/revoke`, { token: a.token })).status).toBe(200);
    reconcilePeerOutages(a.services, a.clock());
    expect(noticesOn(a, `peer-offline:${peerB}:`).map((row) => row.dismissed_at === null)).toEqual([false]);
  });
});
