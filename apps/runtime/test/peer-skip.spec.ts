import { afterEach, describe, expect, it } from "vitest";

import { type Instant, type PeerEnvelope, type PeerSkipLost, NOTICE_BODY_MAX } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  MAX_OUTBOX_ATTEMPTS,
  allRows,
  createConversation,
  deadLetterOutbox,
  getPeer,
  getTask,
  nextOutboundSequence,
  upsertTask,
} from "@clarkcant/storage";

import { settleUndeliveredTasks } from "../src/delegation-handlers.ts";
import { watchPeerOutages } from "../src/peer-outage.ts";
import { peerLostNotice, tellSkipped, tellStuck } from "../src/peer-skip.ts";
import { startPeerDelivery } from "../src/peer-signals.ts";
import { type DeadLetter, deliverPending } from "../src/peer-transport.ts";
import { handlePeerUplinkRoutes } from "../src/routes/peers.ts";
import { type LiveNode, call, identityOf, liveNodes, pair, tokenFor } from "./live-nodes.ts";

/**
 * A message one Clark gave up on, and everything it sent that peer after it.
 *
 * NodeLink sequences every envelope to a peer and the peer refuses anything past a gap, so one message given up on used
 * to leave every later one refused for good. Two real nodes, paired the way a person pairs them, with real HTTP between
 * them: what the tests are careful about is that what follows the lost message is delivered, that nothing the peer was
 * owed is skipped, that each owner is told once what was lost, that both sides audit it, that a lost result settles the
 * task that waited for it, and that a peer too old to take a skip keeps today's behaviour and its pairing is called stuck.
 */

const nodes = liveNodes();

afterEach(async () => {
  await nodes.stopAll();
});

type Clark = LiveNode & { skip: (ms: number) => void; clock: () => Instant };

/** A node with its delivery pass on a clock the test can move, telling its owner about skips the way the runtime does. */
async function startClark(label: string, fetchImpl?: typeof fetch): Promise<Clark> {
  let skew = 0;
  const clock = (): Instant => new Date(Date.now() + skew).toISOString() as Instant;
  const node = await nodes.start(label, (services) => {
    const outages = watchPeerOutages(services, clock());
    services.peerDelivery = startPeerDelivery(
      { db: services.runtime.db, identity: services.runtime.identity, now: clock, ...(fetchImpl === undefined ? {} : { fetchImpl }) },
      {
        intervalMs: 3_600_000,
        log: () => undefined,
        onSkipped: (report) => tellSkipped(services, report, clock()),
        onStuck: (peerNodeId) => tellStuck(services, peerNodeId, clock()),
        afterPass: () => outages.reconcile(clock()),
      },
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

/** Deliver a signal and wait until the sender has read the answer: how it learns what the peer takes. */
async function introduce(from: LiveNode, to: LiveNode): Promise<void> {
  expect((await call(from, `/peers/${identityOf(to).nodeId}/signals`, { body: { id: "hello", topic: "hello" }, token: from.token })).status).toBe(202);
  await waitUntil(() => (getPeer(from.services.runtime.db, identityOf(to).nodeId)?.features ?? []).includes("notice"), "the peer's features");
}

/** Queue an envelope as if this node's own checks had passed: here, one the peer will refuse every time. */
function queueRaw(from: LiveNode, to: LiveNode, kind: PeerEnvelope["kind"], payload: Record<string, unknown>, taskId?: string): string {
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
  return messageId;
}

/** A signal as `POST /peers/{nodeId}/signals` queues it, for `queueRaw`. */
function signalPayload(from: LiveNode, id: string): Record<string, unknown> {
  const at = new Date().toISOString();
  return { signal: { source: { kind: "local", sourceId: identityOf(from).nodeId }, topic: "build.failed", payload: {}, occurredAt: at, dedupeKey: id } };
}

async function signal(from: LiveNode, to: LiveNode, id: string): Promise<void> {
  expect((await call(from, `/peers/${identityOf(to).nodeId}/signals`, { body: { id, topic: "build.failed" }, token: from.token })).status).toBe(202);
}

interface OutboxRow {
  message_id: string;
  kind: string;
  sequence: number;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  acknowledged_at: string | null;
  dead_lettered_at: string | null;
}

function outboxOf(node: LiveNode): OutboxRow[] {
  return allRows<OutboxRow>(
    node.services.runtime.db,
    `SELECT message_id, json_extract(document, '$.kind') AS kind, json_extract(document, '$.sourceSequence') AS sequence, attempts,
            last_attempt_at, next_attempt_at, last_error, acknowledged_at, dead_lettered_at
       FROM outbox ORDER BY rowid`,
  );
}

const rowOf = (node: LiveNode, messageId: string): OutboxRow | undefined => outboxOf(node).find((row) => row.message_id === messageId);

/** Whether a message's attempt number `attempts` is over: its failure is recorded after the attempt that preceded it. */
function failedTimes(node: LiveNode, messageId: string, attempts: number): boolean {
  const row = rowOf(node, messageId);
  if (row === undefined || row.attempts !== attempts || row.last_error === null) return false;
  return row.dead_lettered_at !== null || (row.next_attempt_at !== null && row.last_attempt_at !== null && row.next_attempt_at > row.last_attempt_at);
}

/**
 * Retry one refused message until it is given up on, moving the sender's clock past each backoff. Messages named in
 * `alongside` are tried in the same passes: the clock moves only once each of them has failed that attempt too, since a
 * failure recorded after the clock moved is backed off from the moved clock and would not be due on the next pass.
 */
async function giveUpOn(node: Clark, messageId: string, explain: () => unknown, alongside: readonly string[] = []): Promise<void> {
  const failedAll = (attempt: number): boolean => [messageId, ...alongside].every((id) => failedTimes(node, id, attempt));
  await waitUntil(() => failedAll(1), "the first refusal", explain);
  for (let attempt = 2; attempt <= MAX_OUTBOX_ATTEMPTS; attempt += 1) {
    node.skip(16 * 60_000);
    node.services.peerDelivery?.kick();
    await waitUntil(() => failedAll(attempt), `attempt ${String(attempt)}`, explain);
  }
  expect(rowOf(node, messageId)?.dead_lettered_at).not.toBeNull();
}

interface NoticeRow {
  title: string;
  body: string | null;
  severity: string;
  dedup_key: string;
  dismissed_at: string | null;
}

function noticesOn(node: LiveNode, prefix: string): NoticeRow[] {
  return allRows<NoticeRow>(
    node.services.runtime.db,
    "SELECT title, body, severity, dedup_key, dismissed_at FROM notifications WHERE substr(dedup_key, 1, ?) = ? ORDER BY rowid",
    prefix.length,
    prefix,
  );
}

function peerAudit(node: LiveNode): { summary: string; outcome: string; ref: string | null }[] {
  return allRows(node.services.runtime.db, "SELECT summary, outcome, ref FROM audit_log WHERE kind = 'peer' ORDER BY rowid");
}

/** Envelopes of one kind the node took from its peer, in the order it took them. */
function received(node: LiveNode, kind: string): { message_id: string; source_sequence: number }[] {
  return allRows(node.services.runtime.db, "SELECT message_id, source_sequence FROM inbox WHERE kind = ? ORDER BY rowid", kind);
}

describe("a message given up on, to a peer that takes skips", () => {
  it("is skipped, so what follows is delivered, and each owner is told once, with the skip audited on both sides", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    const peerA = identityOf(a).nodeId;
    const peerB = identityOf(b).nodeId;
    expect(getPeer(a.services.runtime.db, peerB)?.features).toContain("skip");

    // N: a notice without its notice, which B refuses every time. N+1 and N+2: signals B would take.
    const lost = queueRaw(a, b, "notice", {}, "task_lost");
    await signal(a, b, "after-1");
    await signal(a, b, "after-2");
    const explain = (): unknown => ({ outbox: outboxOf(a), inbox: received(b, "signal") });
    await giveUpOn(a, lost, explain);

    // Given up on N, A skipped it, and N+1 and N+2 went after it, in order.
    await waitUntil(() => outboxOf(a).every((row) => row.acknowledged_at !== null || row.dead_lettered_at !== null), "the rest delivered", explain);
    const skip = outboxOf(a).find((row) => row.kind === "skip");
    const lostSequence = rowOf(a, lost)?.sequence;
    expect(skip).toMatchObject({ sequence: lostSequence });
    expect(skip?.acknowledged_at).not.toBeNull();
    expect(received(b, "signal").map((row) => row.source_sequence)).toEqual([1, Number(lostSequence) + 1, Number(lostSequence) + 2]);
    // What waited behind N was never charged for N's refusals.
    expect(outboxOf(a).filter((row) => row.kind === "signal").map((row) => row.attempts)).toEqual([1, 1, 1]);

    // Audited on both sides, as given up on.
    expect(peerAudit(a)).toEqual([
      {
        summary: `gave up on 1 message(s) to ${peerB} (notice); the peer skipped sequences ${String(lostSequence)}-${String(lostSequence)}`,
        outcome: "failed",
        ref: skip?.message_id,
      },
    ]);
    expect(peerAudit(b)).toEqual([
      {
        summary: `${peerA} gave up on 1 message(s) to this node (notice) and skipped sequences ${String(lostSequence)}-${String(lostSequence)}`,
        outcome: "failed",
        ref: skip?.message_id,
      },
    ]);

    // Each owner is told once: what was lost and for which task, that what followed is kept, and what to do.
    const told = noticesOn(a, `peer-lost:${peerB}:out:`);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: "Một tin gửi tới thiết bị khác đã bị bỏ", severity: "warning", dismissed_at: null });
    expect(told[0]?.body).toContain("gửi tới thiết bị laptop");
    expect(told[0]?.body).toContain("thông báo (việc task_lost)");
    expect(told[0]?.body).toContain("những tin gửi sau vẫn được giữ và gửi tiếp theo thứ tự");
    const heard = noticesOn(b, `peer-lost:${peerA}:in:`);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ title: "Một tin từ thiết bị khác đã bị mất", severity: "warning" });
    expect(heard[0]?.body).toContain("Thiết bị desk báo đã bỏ một tin gửi tới máy này");
    expect(heard[0]?.body).toContain("những tin khác từ thiết bị đó vẫn được nhận bình thường");
    expect(noticesOn(a, "peer-stuck:")).toEqual([]);

    // Later passes, and a replay of the skip, tell nobody again and skip nothing more.
    a.skip(60 * 60_000);
    a.services.peerDelivery?.kick();
    await signal(a, b, "after-3");
    await waitUntil(() => received(b, "signal").length === 4, "a later signal", explain);
    const replay = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify(
        allRows<{ document: string }>(a.services.runtime.db, "SELECT document FROM outbox WHERE message_id = ?", skip?.message_id).map((row) =>
          JSON.parse(row.document),
        )[0],
      ),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { status: string }).status).toBe("duplicate");
    expect(noticesOn(a, "peer-lost:")).toHaveLength(1);
    expect(noticesOn(b, "peer-lost:")).toHaveLength(1);
    expect(peerAudit(a)).toHaveLength(1);
    expect(peerAudit(b)).toHaveLength(1);
    expect(outboxOf(a).filter((row) => row.kind === "skip")).toHaveLength(1);
  });

  it("settles, as uncertain, the task whose result was lost on its way back", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(b, a);
    const at = new Date().toISOString() as Instant;
    // A handed task_handed to B; B's result for it is the message given up on.
    createConversation(a.services.runtime.db, { conversationId: "conv_handed", homeNodeId: identityOf(a).nodeId, at });
    upsertTask(a.services.runtime.db, {
      taskId: "task_handed",
      conversationId: "conv_handed",
      homeNodeId: identityOf(a).nodeId,
      executionNodeId: identityOf(b).nodeId,
      state: "running",
      revision: 1,
      goal: "việc thử",
      createdAt: at,
      updatedAt: at,
    });

    const lost = queueRaw(b, a, "result", { outcome: "succeeded" }, "task_handed");
    await signal(b, a, "after-1");
    await giveUpOn(b, lost, () => outboxOf(b));
    await waitUntil(() => getTask(a.services.runtime.db, "task_handed")?.state === "uncertain", "the task to settle", () => outboxOf(b));
    await waitUntil(() => received(a, "signal").length === 2, "what followed the lost result", () => outboxOf(b));

    const heard = noticesOn(a, `peer-lost:${identityOf(b).nodeId}:in:`);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.body).toContain("kết quả của việc được giao (việc task_handed)");
    expect(heard[0]?.body).toContain("được chốt là chưa rõ");
    expect(peerAudit(a)[0]?.summary).toContain("settled as uncertain: task_handed");
    // Said in the task's own conversation, too.
    const said = allRows<{ document: string }>(a.services.runtime.db, "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence", "conv_handed")
      .map((row) => row.document)
      .join("\n");
    expect(said).toContain("Chưa rõ kết quả (task task_handed)");
    expect(said).toContain("bị mất trên đường gửi về sau nhiều lần thử");
    expect(noticesOn(b, `peer-lost:${identityOf(a).nodeId}:out:`)).toHaveLength(1);
  });

  it("does not skip what arrived after all: a stale skip is acknowledged and changes nothing", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    const at = new Date().toISOString();
    const stale = {
      protocol: "agent.nodelink",
      version: 1,
      messageId: "skip_stale",
      correlationId: "skip_stale",
      senderNodeId: identityOf(a).nodeId,
      recipientNodeId: identityOf(b).nodeId,
      kind: "skip",
      sourceSequence: 1,
      sentAt: at,
      payload: { skip: { through: 1, lost: [{ sequence: 1, messageId: "msg_hello", kind: "signal" }] } },
    };
    const answer = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify(stale),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      status: "stale",
      response: { status: "stale", outcome: { accepted: false, code: "SKIP_STALE" } },
      features: ["notice", "skip"],
    });
    expect(received(b, "skip")).toEqual([]);
    expect(peerAudit(b)).toEqual([]);
    expect(noticesOn(b, "peer-lost:")).toEqual([]);

    // A skip reaching past its own slot is refused whole: it would move B past messages A has not sent.
    const reaching = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify({
        ...stale,
        messageId: "skip_far",
        sourceSequence: 2,
        payload: { skip: { through: 9, lost: [{ sequence: 9, messageId: "msg_9", kind: "signal" }] } },
      }),
    });
    expect(reaching.status).toBe(400);
    await signal(a, b, "next");
    await waitUntil(() => received(b, "signal").length === 2, "the next signal, at the sequence B still expects");
  });

  it("charges what waits behind an unreachable peer as tried, so what waits on it is settled on the same schedule", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    a.services.peerDelivery?.stop();
    await signal(a, b, "one");
    await signal(a, b, "two");
    const outcome = await deliverPending({
      db: a.services.runtime.db,
      identity: identityOf(a),
      now: a.clock,
      peerFor: (peerNodeId) => getPeer(a.services.runtime.db, peerNodeId),
      fetchImpl: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    // One dial, and both messages counted as failed by it.
    expect(outcome.attempted).toBe(1);
    expect(outcome.refused.map((one) => one.reason)).toEqual(["connect ECONNREFUSED", "connect ECONNREFUSED"]);
    expect(outboxOf(a).slice(1).map((row) => [row.attempts, row.last_error])).toEqual([
      [1, "connect ECONNREFUSED"],
      [1, "connect ECONNREFUSED"],
    ]);
  });

  it("gives up on a hand-over queued behind an unreachable peer on its own schedule, even while the one ahead waits out its backoff, and settles it as not run", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    a.services.peerDelivery?.stop();
    const dialled: string[] = [];
    const letters: DeadLetter[] = [];
    const pass = async (): Promise<void> => {
      const outcome = await deliverPending({
        db: a.services.runtime.db,
        identity: identityOf(a),
        now: a.clock,
        peerFor: (peerNodeId) => getPeer(a.services.runtime.db, peerNodeId),
        fetchImpl: (_url, init) => {
          dialled.push(String(init?.body));
          return Promise.reject(new Error("connect ECONNREFUSED"));
        },
      });
      letters.push(...(outcome.deadLettered ?? []));
    };
    const STEP_MS = 5_000;

    // B goes dark. The head has failed for a while: its backoff is at the cap when the hand-over is queued.
    const head = queueRaw(a, b, "signal", signalPayload(a, "head"));
    for (let steps = 0; (rowOf(a, head)?.attempts ?? 0) < 9; steps += 1) {
      if (steps > 2_000) throw new Error(`the head never reached 9 attempts: ${JSON.stringify(rowOf(a, head))}`);
      await pass();
      a.skip(STEP_MS);
    }

    const at = a.clock();
    createConversation(a.services.runtime.db, { conversationId: "conv_waiting", homeNodeId: identityOf(a).nodeId, at });
    upsertTask(a.services.runtime.db, {
      taskId: "task_waiting",
      conversationId: "conv_waiting",
      homeNodeId: identityOf(a).nodeId,
      executionNodeId: identityOf(b).nodeId,
      state: "running",
      revision: 1,
      goal: "việc thử",
      createdAt: at,
      updatedAt: at,
    });
    const handOver = queueRaw(a, b, "delegate", { goal: "việc thử" }, "task_waiting");
    const queuedAt = Date.parse(a.clock());
    // Checked on every step, across many passes, most of which dial nothing: the head is waiting out its backoff.
    while (rowOf(a, handOver)?.dead_lettered_at === null) {
      if (Date.parse(a.clock()) - queuedAt > 3 * 3_600_000) throw new Error(`never given up on: ${JSON.stringify(rowOf(a, handOver))}`);
      await pass();
      a.skip(STEP_MS);
    }

    // Given up on no later than it would have been had it been sent itself: twelve tries, 5 s doubling to a 15 min cap.
    const givenUpAt = Date.parse(rowOf(a, handOver)?.dead_lettered_at ?? "");
    expect(givenUpAt - queuedAt).toBeLessThanOrEqual((3_975 + 5) * 1_000);
    expect(rowOf(a, handOver)).toMatchObject({ attempts: MAX_OUTBOX_ATTEMPTS, last_attempt_at: null });
    // Never sent: it only waited behind messages that could not reach B.
    expect(dialled.some((body) => body.includes(handOver))).toBe(false);
    const letter = letters.find((one) => one.messageId === handOver);
    expect(letter).toMatchObject({ kind: "delegate", taskId: "task_waiting", refusedByPeer: false, neverSent: true });

    // It never left this node, so it did not run on B: the task failed, rather than being called uncertain.
    if (letter !== undefined) settleUndeliveredTasks(a.services, a.clock)(letter);
    expect(getTask(a.services.runtime.db, "task_waiting")?.state).toBe("failed");
  });

  it("sends every skip a long run of given-up messages needs before what the gap refuses is sent again", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    a.services.peerDelivery?.stop();
    // More given up on than one skip can list.
    const at = a.clock();
    for (let index = 0; index < 120; index += 1) {
      deadLetterOutbox(a.services.runtime.db, queueRaw(a, b, "signal", signalPayload(a, `lost-${String(index)}`)), at, "given up on for the test");
    }
    const next = queueRaw(a, b, "signal", signalPayload(a, "next"));
    const outcome = await deliverPending({
      db: a.services.runtime.db,
      identity: identityOf(a),
      now: a.clock,
      peerFor: (peerNodeId) => getPeer(a.services.runtime.db, peerNodeId),
    });

    const skips = outboxOf(a).filter((row) => row.kind === "skip");
    expect(skips.map((row) => row.acknowledged_at !== null)).toEqual([true, true, true]);
    expect(outcome.skipped?.map((report) => report.lost.length)).toEqual([50, 50, 20]);
    // Refused once for the gap, then sent once it was closed: not resent, and not charged, between the skips.
    expect(rowOf(a, next)).toMatchObject({ attempts: 2 });
    expect(rowOf(a, next)?.acknowledged_at).not.toBeNull();
    expect(received(b, "signal").at(-1)?.message_id).toBe(next);
  });

  it("tells and audits a skip only once it has read the peer's answer, so a crash or a lost answer cannot lose either", async () => {
    let cutAnswer = true;
    // The first skip reaches B, and B takes it, but its answer never arrives whole.
    const cutting: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!cutAnswer || !String(init?.body).includes('"kind":"skip"')) return response;
      cutAnswer = false;
      await response.text();
      const broken = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(broken, { status: 200, headers: { "content-type": "application/json" } });
    };
    const a = await startClark("desk", cutting);
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    const peerB = identityOf(b).nodeId;
    const lost = queueRaw(a, b, "notice", {}, "task_lost");
    await signal(a, b, "after-1");
    const explain = (): unknown => ({ outbox: outboxOf(a), inbox: received(b, "skip") });
    await giveUpOn(a, lost, explain);

    await waitUntil(() => !cutAnswer && received(b, "skip").length === 1, "the skip to reach B", explain);
    await waitUntil(
      () => {
        const row = outboxOf(a).find((one) => one.kind === "skip");
        return row !== undefined && row.last_error !== null;
      },
      "the unread answer",
      explain,
    );
    const skip = outboxOf(a).find((row) => row.kind === "skip");
    // Not acknowledged on an answer it could not read, and nothing told or audited on it.
    expect(skip?.acknowledged_at).toBeNull();
    expect(noticesOn(a, `peer-lost:${peerB}:out:`)).toEqual([]);
    expect(peerAudit(a)).toEqual([]);

    // Sent again, B answers from its inbox, and only now is it acknowledged, told and audited: once.
    a.skip(60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => rowOf(a, skip?.message_id ?? "")?.acknowledged_at !== null, "the skip acknowledged", explain);
    await waitUntil(() => received(b, "signal").length === 2, "what followed", explain);
    expect(noticesOn(a, `peer-lost:${peerB}:out:`)).toHaveLength(1);
    expect(peerAudit(a).map((row) => row.ref)).toEqual([skip?.message_id]);
    expect(received(b, "skip")).toHaveLength(1);
  });
});

describe("the receiving side of a skip", () => {
  it("is refused unread, and recorded nowhere, by a node that takes no skips", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    const at = new Date().toISOString() as Instant;
    const response = handlePeerUplinkRoutes({
      pairing: {
        db: b.services.runtime.db,
        identity: b.services.runtime.identity,
        now: () => at,
        newId: (prefix) => `${prefix}_test`,
      },
      runtime: { dataDir: b.services.runtime.dataDir },
      request: {
        method: "POST",
        path: "/peers/messages",
        query: {},
        headers: { authorization: `Bearer ${tokenFor(a, b)}`, "content-type": "application/json" },
        body: JSON.stringify({
          protocol: "agent.nodelink",
          version: 1,
          messageId: "skip_unwanted",
          correlationId: "skip_unwanted",
          senderNodeId: identityOf(a).nodeId,
          recipientNodeId: identityOf(b).nodeId,
          kind: "skip",
          sourceSequence: 1,
          sentAt: at,
          payload: { skip: { through: 1, lost: [{ sequence: 1, messageId: "msg_1", kind: "signal" }] } },
        }),
      },
    });
    expect(response).toMatchObject({ status: 400, body: { code: "UNSUPPORTED_KIND" } });
    expect(received(b, "skip")).toEqual([]);
    expect(peerAudit(b)).toEqual([]);
  });

  it("tells its owner about at most 30 skips a minute from one peer, and still takes and audits the rest", async () => {
    const a = await startClark("desk");
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    const at = new Date().toISOString();
    for (let sequence = 2; sequence <= 32; sequence += 1) {
      const answer = await fetch(`${b.base}/peers/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
        body: JSON.stringify({
          protocol: "agent.nodelink",
          version: 1,
          messageId: `skip_${String(sequence)}`,
          correlationId: `skip_${String(sequence)}`,
          senderNodeId: identityOf(a).nodeId,
          recipientNodeId: identityOf(b).nodeId,
          kind: "skip",
          sourceSequence: sequence,
          sentAt: at,
          payload: { skip: { through: sequence, lost: [{ sequence, messageId: `msg_${String(sequence)}`, kind: "signal" }] } },
        }),
      });
      expect(answer.status).toBe(200);
    }
    expect(received(b, "skip")).toHaveLength(31);
    expect(peerAudit(b)).toHaveLength(31);
    expect(noticesOn(b, `peer-lost:${identityOf(a).nodeId}:in:`)).toHaveLength(30);
  });
});

describe("what the owner is told about messages given up on", () => {
  const taskIds = ["a", "b", "c", "d", "e"].map((letter) => `task_${letter.repeat(24)}`);
  const at = "2026-09-30T04:00:00.000Z" as Instant;
  const longest = "l".repeat(64);

  it("puts what failed, what was kept and what happens next first, and fits the list of what was lost after it", () => {
    const lost: PeerSkipLost[] = (["delegate", "result", "approval.response", "input.response", "cancel.request"] as const).map((kind, index) => ({
      sequence: index + 1,
      messageId: `msg_${String(index)}`,
      kind,
      taskId: taskIds[index] ?? "",
    }));
    const out = peerLostNotice({ side: "out", peerNodeId: "node_b", label: longest, through: 5, lost, at }).body ?? "";
    expect(taskIds.every((id) => id.length === 29)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
    expect(out.endsWith(".")).toBe(true);
    expect(out).toContain("Đã báo cho thiết bị đó; những tin gửi sau vẫn được giữ và gửi tiếp theo thứ tự.");
    expect(out).toContain("Việc giao đi hoặc lệnh dừng bị mất đã được chốt trong hội thoại của việc đó.");
    expect(out).toContain("Thiết bị đó chốt việc có kết quả bị mất là chưa rõ.");
    expect(out).toContain("Câu hỏi, câu trả lời hay việc duyệt bị mất sẽ không gửi lại; bên chờ sẽ chờ tới khi hết hạn.");
    expect(out).toContain("Nếu vẫn cần, hãy gửi lại. Đã bỏ: ");
    expect(out.indexOf("Nếu vẫn cần")).toBeLessThan(out.indexOf("Đã bỏ: "));

    const heard = peerLostNotice({ side: "in", peerNodeId: "node_a", label: longest, through: 5, lost, settled: [taskIds[1] ?? ""], at }).body ?? "";
    expect(heard.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
    expect(heard).toContain("những tin khác từ thiết bị đó vẫn được nhận bình thường.");
    expect(heard).toContain("Việc có kết quả bị mất được chốt là chưa rõ trong hội thoại của việc đó.");
    expect(heard).toContain("Câu hỏi, câu trả lời hay việc duyệt bị mất sẽ không gửi lại; bên chờ sẽ chờ tới khi hết hạn.");
  });

  it("says a task was settled only when a hand-over or a stop was lost", () => {
    const lost: PeerSkipLost[] = [
      { sequence: 1, messageId: "msg_1", kind: "status", taskId: taskIds[0] ?? "" },
      { sequence: 2, messageId: "msg_2", kind: "signal" },
    ];
    const out = peerLostNotice({ side: "out", peerNodeId: "node_b", through: 2, lost, at }).body ?? "";
    expect(out).not.toContain("được chốt");
    expect(out).toContain("Không việc nào phải chốt lại vì các tin này.");
    expect(out).toContain(`cập nhật trạng thái của việc (việc ${taskIds[0] ?? ""}); tín hiệu.`);
  });
});

/** A peer's answers as a build from before skips gives them, while `old()` says so: `skip` is never among its features. */
function asOldBuild(old: () => boolean = () => true): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!old()) return response;
    const text = await response.text();
    let body = text;
    try {
      const fields = JSON.parse(text) as Record<string, unknown>;
      if (Array.isArray(fields["features"])) fields["features"] = fields["features"].filter((feature) => feature !== "skip");
      body = JSON.stringify(fields);
    } catch {
      // Not JSON: passed on as it came.
    }
    return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
  };
}

describe("a message given up on, to a peer too old to take a skip", () => {
  it("keeps today's behaviour, sends no skip, and tells the owner once that the pairing is stuck until that device updates", async () => {
    const a = await startClark("desk", asOldBuild());
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    const peerB = identityOf(b).nodeId;
    expect(getPeer(a.services.runtime.db, peerB)?.features).toEqual(["notice"]);

    // Queued together, before the pass the first one starts: both are tried on every pass from the first.
    const lost = queueRaw(a, b, "notice", {});
    const after = queueRaw(a, b, "signal", signalPayload(a, "after-1"));
    const explain = (): unknown => ({ outbox: outboxOf(a), notices: noticesOn(a, "peer-") });
    await waitUntil(() => failedTimes(a, lost, 1), "the first refusal", explain);
    // B refuses what follows for the gap, as before; nothing was given up on yet, so nothing is stuck yet.
    await waitUntil(() => outboxOf(a).at(-1)?.last_error === "the peer answered 409", "the gap refusal", explain);
    expect(noticesOn(a, "peer-stuck:")).toEqual([]);

    await giveUpOn(a, lost, explain, [after]);
    await waitUntil(() => noticesOn(a, "peer-stuck:").length === 1, "the stuck notice", explain);
    // Still refused there, and more passes say nothing new.
    a.skip(60 * 60_000);
    a.services.peerDelivery?.kick();
    await waitUntil(() => (rowOf(a, outboxOf(a).at(-1)?.message_id ?? "")?.attempts ?? 0) >= MAX_OUTBOX_ATTEMPTS, "another pass", explain);

    expect(outboxOf(a).filter((row) => row.kind === "skip")).toEqual([]);
    expect(received(b, "signal")).toHaveLength(1);
    const [stuck, ...rest] = noticesOn(a, "peer-stuck:");
    expect(rest).toEqual([]);
    expect(stuck).toMatchObject({ title: "Ghép cặp với thiết bị khác đang bị kẹt", severity: "error", dismissed_at: null });
    expect(stuck?.body).toContain("thiết bị laptop");
    expect(stuck?.body).toContain("Hãy cập nhật ClarkCant trên thiết bị đó");
    // What is known, and no more: that device has not said it can skip a lost message.
    expect(stuck?.body).toContain("thiết bị đó chưa cho biết nó bỏ qua được tin đã mất");
    expect(stuck?.body).not.toContain("bản cũ");
    expect(noticesOn(a, "peer-lost:")).toEqual([]);
    expect(peerAudit(a)).toEqual([]);
    expect(peerAudit(b)).toEqual([]);
  });

  it("frees itself once that device is updated: its next refusal says it takes skips, and what was lost is skipped", async () => {
    let updated = false;
    const a = await startClark("desk", asOldBuild(() => !updated));
    const b = await startClark("laptop");
    await pair(a, b);
    await introduce(a, b);
    const peerB = identityOf(b).nodeId;
    // Queued together, before the pass the first one starts: both are tried on every pass from the first.
    const lost = queueRaw(a, b, "notice", {});
    const after = queueRaw(a, b, "signal", signalPayload(a, "after-1"));
    const explain = (): unknown => ({ outbox: outboxOf(a), notices: noticesOn(a, "peer-") });
    await giveUpOn(a, lost, explain, [after]);
    await waitUntil(() => noticesOn(a, "peer-stuck:").length === 1, "the stuck notice", explain);
    // What followed was refused for the gap as often as the lost one was refused, and given up on with it.
    expect(outboxOf(a).map((row) => row.dead_lettered_at !== null)).toEqual([false, true, true]);

    // B is updated. The next message is refused for the gap, and that refusal says B takes skips now.
    updated = true;
    await signal(a, b, "after-update");
    await waitUntil(() => received(b, "signal").length === 2, "the message after the update", explain);
    expect(getPeer(a.services.runtime.db, peerB)?.features).toContain("skip");
    const skip = outboxOf(a).find((row) => row.kind === "skip");
    expect(skip?.acknowledged_at).not.toBeNull();
    // Both given-up messages, the refused notice and the signal behind it, are named once on each side.
    const told = noticesOn(a, `peer-lost:${peerB}:out:`);
    expect(told.map((row) => row.title)).toEqual(["2 tin gửi tới thiết bị khác đã bị bỏ"]);
    expect(told[0]?.body).toContain("thông báo; tín hiệu");
    expect(noticesOn(b, `peer-lost:${identityOf(a).nodeId}:in:`).map((row) => row.title)).toEqual(["2 tin từ thiết bị khác đã bị mất"]);
    // B took something again, so the pairing is no longer stuck, and the notice that said so goes.
    await waitUntil(() => noticesOn(a, "peer-stuck:")[0]?.dismissed_at !== null, "the stuck notice to go", explain);
  });
});