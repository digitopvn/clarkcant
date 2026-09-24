import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type PeerEnvelope } from "@clarkcant/contracts";
import {
  MAX_OUTBOX_ATTEMPTS,
  closeDatabase,
  deadLetteredOutbox,
  migrate,
  openDatabase,
  type Database,
  type PeerRecord,
} from "@clarkcant/storage";

import type { NodeIdentity } from "../src/node.ts";
import { deliverPending, sendToPeer, type PeerTransportDeps } from "../src/peer-transport.ts";

/**
 * Failed delivery, backed off.
 *
 * `deliverPending` used to resend every pending row on every pass, at the same rate whether the peer
 * was healthy or had been unreachable for an hour. These tests drive it against a `fetchImpl` that
 * always fails, and check what actually changed: a failed send is scheduled rather than immediately
 * retried, and the message given up on after enough failures is reported in the outcome and readable
 * from the dead-letter listing rather than silently retried forever.
 */

let db: Database;
let now: Instant;

function tick(ms: number): void {
  now = new Date(Date.parse(now) + ms).toISOString() as Instant;
}

const PEER: PeerRecord = {
  peerNodeId: "node_b",
  endpoint: "http://127.0.0.1:9",
  publicKey: "pub",
  fingerprint: "fp",
  tokenHash: "hash",
  pairedAt: "2026-09-16T04:00:00.000Z" as Instant,
  trustedAt: "2026-09-16T04:00:00.000Z" as Instant,
  revokedAt: null,
};

function deps(fetchImpl: typeof fetch): PeerTransportDeps {
  return {
    db,
    // Only the two fields `deliverPending` actually reads (the recipient token derivation) matter here;
    // the rest of a real identity is irrelevant to a delivery test.
    identity: { nodeId: "node_a", localToken: "local-token" } as unknown as NodeIdentity,
    now: () => now,
    peerFor: () => PEER,
    fetchImpl,
  };
}

function envelope(messageId: string, sequence: number): PeerEnvelope {
  return {
    protocol: "agent.nodelink",
    version: 1,
    messageId,
    correlationId: "corr_1",
    senderNodeId: "node_a",
    recipientNodeId: "node_b",
    kind: "cancel.request",
    sourceSequence: sequence,
    sentAt: now,
    payload: { reason: "test" },
  };
}

async function failingFetch(): Promise<Response> {
  return new Response("nope", { status: 503 });
}

describe("deliverPending backoff", () => {
  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    migrate(db);
    now = "2026-09-16T04:00:00.000Z" as Instant;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("schedules a retry instead of resending immediately after a failed send", async () => {
    const transport = deps(failingFetch as unknown as typeof fetch);
    // `sendToPeer` queues the envelope and immediately attempts delivery once, so the first failure
    // (and its backoff) is already on record by the time it resolves.
    const sent = await sendToPeer(transport, envelope("msg_1", 1));
    expect(sent.attempted).toBe(1);
    expect(sent.acknowledged).toBe(0);
    expect(sent.refused).toHaveLength(1);
    expect(sent.deadLettered).toBeUndefined();

    // Immediately retrying finds nothing due yet.
    const immediateRetry = await deliverPending(transport);
    expect(immediateRetry.attempted).toBe(0);

    // Once the backoff window has passed, the message is due again.
    tick(6_000);
    const laterRetry = await deliverPending(transport);
    expect(laterRetry.attempted).toBe(1);
  });

  it("dead-letters a message after enough failed passes, and reports it in the outcome", async () => {
    const transport = deps(failingFetch as unknown as typeof fetch);
    // Attempt 1 of MAX_OUTBOX_ATTEMPTS happens inside sendToPeer itself.
    const sent = await sendToPeer(transport, envelope("msg_1", 1));
    expect(sent.attempted).toBe(1);

    // Each further tick clears whatever backoff the previous failure scheduled, so every explicit pass
    // below actually attempts delivery, reaching the ceiling on the last one.
    let lastOutcome = undefined as Awaited<ReturnType<typeof deliverPending>> | undefined;
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS - 1; i += 1) {
      tick(20 * 60_000);
      lastOutcome = await deliverPending(transport);
    }

    expect(lastOutcome?.deadLettered).toEqual([{ messageId: "msg_1", peerNodeId: "node_b" }]);

    // A dead-lettered message is not retried again, however long is waited.
    tick(24 * 60 * 60_000);
    const after = await deliverPending(transport);
    expect(after.attempted).toBe(0);

    const dead = deadLetteredOutbox(db);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.messageId).toBe("msg_1");
  });

  it("stops being retried once a later attempt succeeds, even though it once failed", async () => {
    let calls = 0;
    const flaky = (async (): Promise<Response> => {
      calls += 1;
      return calls === 1 ? new Response("nope", { status: 503 }) : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const transport = deps(flaky);
    // The first (and only failing) attempt happens inside sendToPeer.
    const sent = await sendToPeer(transport, envelope("msg_1", 1));
    expect(sent.acknowledged).toBe(0);

    tick(6_000);
    const succeeded = await deliverPending(transport);
    expect(succeeded.acknowledged).toBe(1);

    const stillPending = await deliverPending(transport);
    expect(stillPending.attempted).toBe(0);
  });
});
