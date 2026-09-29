import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type PeerEnvelope } from "@clarkcant/contracts";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  allRows,
  closeDatabase,
  deadLetterOutbox,
  getPeer,
  markOutboxAcknowledged,
  migrate,
  openDatabase,
  recordPeerAdvertisement,
  upsertPeer,
} from "@clarkcant/storage";

import type { NodeIdentity } from "../src/node.ts";
import { type PeerTransportDeps, deliverPending } from "../src/peer-transport.ts";

/**
 * When a pairing is called stuck, and what a peer's refusal of a skip says about it.
 *
 * Driven against a scripted peer, so the one answer each test is about is the only thing that varies: a gap a later
 * acknowledgement already passed is not a gap, and a peer that refuses a skip as a kind it does not read takes no skips,
 * whatever it said before.
 */

let db: Database;
let now = "2026-09-30T04:00:00.000Z" as Instant;
const PEER = "node_b";

function queue(sequence: number): string {
  const messageId = `msg_${String(sequence)}`;
  const envelope: PeerEnvelope = {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: messageId,
    senderNodeId: "node_a",
    recipientNodeId: PEER,
    kind: "signal",
    sourceSequence: sequence,
    sentAt: now,
    payload: {},
  };
  sendEnvelope({ db, now: () => now }, envelope);
  return messageId;
}

/** A peer that answers every envelope by `answer`, and the kinds it was sent, in order. */
function transport(answer: (envelope: PeerEnvelope) => Response): { deps: PeerTransportDeps; sent: string[] } {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const envelope = JSON.parse(String(init?.body)) as PeerEnvelope;
    sent.push(envelope.kind);
    return answer(envelope);
  }) as typeof fetch;
  return {
    sent,
    deps: {
      db,
      // Only the local token is read, to derive the recipient's.
      identity: { nodeId: "node_a", localToken: "local-token" } as unknown as NodeIdentity,
      now: () => now,
      peerFor: (peerNodeId) => getPeer(db, peerNodeId),
      fetchImpl,
    },
  };
}

const answered = (status: number, body: Record<string, unknown>): Response => new Response(JSON.stringify(body), { status });

function outbox(): { message_id: string; kind: string; acknowledged_at: string | null; dead_lettered_at: string | null }[] {
  return allRows(
    db,
    "SELECT message_id, json_extract(document, '$.kind') AS kind, acknowledged_at, dead_lettered_at FROM outbox ORDER BY rowid",
  );
}

describe("a pairing called stuck", () => {
  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    migrate(db);
    now = "2026-09-30T04:00:00.000Z" as Instant;
    upsertPeer(db, {
      peerNodeId: PEER,
      endpoint: "http://127.0.0.1:1001",
      publicKey: "pub_b",
      fingerprint: "fp_b",
      tokenHash: "hash_b",
      pairedAt: now,
      trustedAt: now,
      revokedAt: null,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("is not called stuck over a message given up on that the peer got past", async () => {
    recordPeerAdvertisement(db, PEER, { features: ["notice"] });
    // 1 was given up on, yet the peer acknowledged 2 after it: whatever it was waiting for, it is not 1.
    deadLetterOutbox(db, queue(1), now, "given up on for the test");
    markOutboxAcknowledged(db, queue(2), now);
    queue(3);
    const { deps } = transport(() => answered(409, { code: "SEQUENCE_GAP", expected: 3, received: 3, features: ["notice"] }));

    const outcome = await deliverPending(deps);

    expect(outcome.refused.map((one) => one.reason)).toEqual(["the peer answered 409"]);
    expect(outcome.stuck).toBeUndefined();
  });

  it("stops sending skips to a peer that refuses one as a kind it does not read, and calls the pairing stuck", async () => {
    recordPeerAdvertisement(db, PEER, { features: ["notice", "skip"], label: "laptop" });
    deadLetterOutbox(db, queue(1), now, "given up on for the test");
    queue(2);
    // A build from before skips: it refuses the kind as a field it does not know, and a gap it cannot close.
    const { deps, sent } = transport((envelope) =>
      envelope.kind === "skip"
        ? answered(400, { code: "MISSING_FIELD", message: "unknown kind" })
        : answered(409, { code: "SEQUENCE_GAP", expected: 1, received: envelope.sourceSequence }),
    );

    const outcome = await deliverPending(deps);

    expect(sent).toEqual(["signal", "skip"]);
    expect(getPeer(db, PEER)).toMatchObject({ features: ["notice"], label: "laptop" });
    expect(outcome.stuck).toEqual([PEER]);
    // The skip is given up on at once: it would only be refused again. Nothing waited on it, so nothing is reported.
    expect(outbox().find((row) => row.kind === "skip")?.dead_lettered_at).not.toBeNull();
    expect(outcome.deadLettered).toBeUndefined();

    // Later passes send what is owed the old way, and queue no skip it would refuse.
    now = "2026-09-30T05:00:00.000Z" as Instant;
    const later = await deliverPending(deps);
    expect(sent).toEqual(["signal", "skip", "signal"]);
    expect(later.stuck).toEqual([PEER]);
    expect(outbox().filter((row) => row.kind === "skip")).toHaveLength(1);
  });

  it("keeps sending skips to a peer that refuses one only for what it says", async () => {
    recordPeerAdvertisement(db, PEER, { features: ["notice", "skip"] });
    deadLetterOutbox(db, queue(1), now, "given up on for the test");
    queue(2);
    const { deps } = transport((envelope) =>
      envelope.kind === "skip"
        ? answered(400, { code: "SKIP_INVALID", message: "bad skip" })
        : answered(409, { code: "SEQUENCE_GAP", expected: 1, received: envelope.sourceSequence, features: ["notice", "skip"] }),
    );

    const outcome = await deliverPending(deps);

    expect(getPeer(db, PEER)?.features).toEqual(["notice", "skip"]);
    expect(outbox().find((row) => row.kind === "skip")?.dead_lettered_at).toBeNull();
    expect(outcome.stuck).toBeUndefined();
  });
});
