import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type PeerEnvelope } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  type PeerRecord,
  allRows,
  closeDatabase,
  getPeer,
  migrate,
  openDatabase,
  upsertPeer,
} from "@clarkcant/storage";

import type { NodeIdentity } from "../src/node.ts";
import { PEER_ANSWER_MAX_BYTES, type PeerTransportDeps, deliverPending } from "../src/peer-transport.ts";

/**
 * What a peer answers with, read within bounds.
 *
 * A confirmed peer is trusted to be who it is, not to behave: one that is broken or hostile can answer a delivery with
 * an endless body, or start one and stop sending. Either used to hold the whole delivery pass — every other peer's
 * messages, and the outage check that runs after it — or fill this node's memory. These tests drive `deliverPending`
 * against such answers and check that the pass ends, that the other peer is still delivered to, and that the message the
 * misbehaving peer did take is not sent again.
 */

let db: Database;
const now = "2026-09-30T04:00:00.000Z" as Instant;

function peer(peerNodeId: string, port: number): PeerRecord {
  return {
    peerNodeId,
    endpoint: `http://127.0.0.1:${String(port)}`,
    publicKey: `pub_${peerNodeId}`,
    fingerprint: `fp_${peerNodeId}`,
    tokenHash: `hash_${peerNodeId}`,
    pairedAt: now,
    trustedAt: now,
    revokedAt: null,
  };
}

const BAD = peer("node_bad", 1001);
const GOOD = peer("node_good", 1002);

function queue(recipient: PeerRecord, messageId: string): void {
  const envelope: PeerEnvelope = {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: messageId,
    senderNodeId: "node_a",
    recipientNodeId: recipient.peerNodeId,
    kind: "notice",
    sourceSequence: 1,
    sentAt: now,
    payload: { notice: { key: messageId, category: "message", severity: "info", title: "Xin chào" } },
  };
  sendEnvelope({ db, now: () => now }, envelope);
}

/** The answer a well-behaved peer gives: it took the notice, and says what it takes. */
function goodAnswer(): Response {
  return new Response(JSON.stringify({ status: "processed", response: { status: "recorded", outcome: { accepted: true } }, features: ["notice"], label: "good" }), {
    status: 200,
  });
}

function transport(badAnswer: (init: RequestInit | undefined) => Promise<Response>, timeoutMs = 200): PeerTransportDeps {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    String(url).includes(":1001/") ? badAnswer(init) : goodAnswer()) as typeof fetch;
  return {
    db,
    // Only the local token is read, to derive the recipient's.
    identity: { nodeId: "node_a", localToken: "local-token" } as unknown as NodeIdentity,
    now: () => now,
    peerFor: (peerNodeId) => [BAD, GOOD].find((known) => known.peerNodeId === peerNodeId),
    fetchImpl,
    timeoutMs,
  };
}

function rows(): { message_id: string; acknowledged_at: string | null; last_error: string | null }[] {
  return allRows(db, "SELECT message_id, acknowledged_at, last_error FROM outbox ORDER BY rowid");
}

describe("a peer's answer", () => {
  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    migrate(db);
    upsertPeer(db, BAD);
    upsertPeer(db, GOOD);
    // The misbehaving peer's message goes first, so it is the one that would hold everything behind it.
    queue(BAD, "msg_bad");
    queue(GOOD, "msg_good");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("is read no further than a few kilobytes, however much the peer sends", async () => {
    let sent = 0;
    // Nothing is produced until it is read, so what was produced is what was read.
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
      },
      { highWaterMark: 0 },
    );
    const outcome = await deliverPending(transport(() => Promise.resolve(new Response(endless, { status: 200 }))));

    expect(outcome).toMatchObject({ attempted: 2, acknowledged: 2, refused: [] });
    // It stopped reading just past the bound, rather than reading on.
    expect(sent).toBeLessThanOrEqual(PEER_ANSWER_MAX_BYTES + 2 * 64 * 1024);
    // The peer answered 200, so it has the message: acknowledged, not sent again. What it said is not recorded.
    expect(rows().map((row) => row.acknowledged_at !== null)).toEqual([true, true]);
    expect(getPeer(db, BAD.peerNodeId)).not.toHaveProperty("features");
    expect(getPeer(db, GOOD.peerNodeId)).toMatchObject({ features: ["notice"], label: "good" });
  });

  it("is not read at all when it declares itself too long", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(16));
        },
      },
      { highWaterMark: 0 },
    );
    const declared = new Response(body, { status: 200, headers: { "content-length": String(PEER_ANSWER_MAX_BYTES * 1024) } });
    const outcome = await deliverPending(transport(() => Promise.resolve(declared)));
    expect(outcome.acknowledged).toBe(2);
    expect(pulled).toBe(false);
  });

  it("ends at the deadline when the peer stops sending half-way, and the pass goes on to the next peer", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"processed","features":["no'));
        // ...and nothing more, ever.
      },
    });
    const started = Date.now();
    const outcome = await deliverPending(transport(() => Promise.resolve(new Response(stalled, { status: 200 }))));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ attempted: 2, acknowledged: 2 });
    expect(getPeer(db, BAD.peerNodeId)).not.toHaveProperty("features");
    expect(getPeer(db, GOOD.peerNodeId)).toMatchObject({ features: ["notice"] });
  });

  it("ends at the deadline when the peer never answers at all, and counts that as a failed delivery", async () => {
    const silent = (init: RequestInit | undefined): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
      });
    const started = Date.now();
    const outcome = await deliverPending(transport(silent));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toMatchObject({ attempted: 2, acknowledged: 1 });
    expect(outcome.refused.map((refusal) => refusal.messageId)).toEqual(["msg_bad"]);
    const [bad, good] = rows();
    // Still owed, and retried later like any delivery that got no answer.
    expect(bad).toMatchObject({ message_id: "msg_bad", acknowledged_at: null });
    expect(bad?.last_error).not.toBeNull();
    expect(good?.acknowledged_at).not.toBeNull();
  });

  it("tells the sender a notice was acknowledged and not taken, with the peer's code and its words as data", async () => {
    const refused = new Response(
      JSON.stringify({
        status: "processed",
        response: { status: "recorded", outcome: { accepted: false, code: "RATE_LIMITED", reason: "too many\u0007notices‮ now" } },
        features: ["notice"],
      }),
      { status: 200 },
    );
    const outcome = await deliverPending(transport(() => Promise.resolve(refused)));
    expect(outcome.acknowledged).toBe(2);
    expect(outcome.turnedDown).toEqual([
      expect.objectContaining({ messageId: "msg_bad", peerNodeId: BAD.peerNodeId, code: "RATE_LIMITED", reason: "too many notices now" }),
    ]);
    expect(rows()[0]).toMatchObject({ last_error: "the peer did not take it: too many notices now" });
    expect(rows()[0]?.acknowledged_at).not.toBeNull();
    // A code that is not a code is not passed on.
    const odd = new Response(JSON.stringify({ response: { outcome: { accepted: false, code: "<b>hi</b>", reason: "no" } } }), { status: 200 });
    queue(BAD, "msg_bad_2");
    const second = await deliverPending(transport(() => Promise.resolve(odd)));
    expect(second.turnedDown?.[0]).not.toHaveProperty("code");
  });
});
