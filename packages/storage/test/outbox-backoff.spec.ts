import { describe, expect, it } from "vitest";

import { instantSchema } from "@clarkcant/contracts";

import {
  MAX_OUTBOX_ATTEMPTS,
  deadLetteredOutbox,
  enqueueOutbox,
  markOutboxAcknowledged,
  markOutboxAttempt,
  markOutboxFailed,
  migrate,
  nextOutboundSequence,
  openDatabase,
  pendingOutbox,
} from "../src/index.ts";

/**
 * Backoff and dead-lettering on the outbox.
 *
 * Before this, a failed delivery only incremented `attempts` and the next pass resent it immediately —
 * a peer that is down would be dialled on every pass at the same rate as a healthy one, forever. These
 * tests are about the schedule that replaces that: a widening delay per failure, a ceiling on how long
 * that delay grows, and a point past which this node stops trying automatically and marks the message
 * dead rather than resending it forever.
 */

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");

function freshDb() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return db;
}

function enqueue(db: ReturnType<typeof freshDb>, overrides: Partial<Parameters<typeof enqueueOutbox>[1]> = {}) {
  enqueueOutbox(db, {
    messageId: "msg_1",
    peerNodeId: "node_b",
    correlationId: "corr_1",
    document: { hello: "world" },
    createdAt: AT,
    ...overrides,
  });
}

describe("outbox backoff", () => {
  it("schedules the next attempt with a doubling delay from a failure", () => {
    const db = freshDb();
    enqueue(db);
    markOutboxAttempt(db, "msg_1", AT);

    const first = markOutboxFailed(db, "msg_1", AT, "the peer answered 503");
    expect(first.status).toBe("scheduled");
    if (first.status !== "scheduled") throw new Error("expected scheduled");
    // Base 5s after the first failed attempt.
    expect(Date.parse(first.nextAttemptAt) - Date.parse(AT)).toBe(5_000);

    markOutboxAttempt(db, "msg_1", AT);
    const second = markOutboxFailed(db, "msg_1", AT, "the peer answered 503");
    if (second.status !== "scheduled") throw new Error("expected scheduled");
    // Doubled after the second failed attempt.
    expect(Date.parse(second.nextAttemptAt) - Date.parse(AT)).toBe(10_000);
  });

  it("caps the delay at 15 minutes no matter how many attempts have failed", () => {
    const db = freshDb();
    enqueue(db);
    // Drive attempts up without dead-lettering, so the schedule alone is what is being checked.
    // 5s * 2^(9-1) = 1280s, past the 900s (15 minute) cap; 9 stays below MAX_OUTBOX_ATTEMPTS.
    for (let i = 0; i < 9; i += 1) markOutboxAttempt(db, "msg_1", AT);

    const outcome = markOutboxFailed(db, "msg_1", AT, "still down");
    if (outcome.status !== "scheduled") throw new Error("expected scheduled");
    expect(Date.parse(outcome.nextAttemptAt) - Date.parse(AT)).toBe(15 * 60_000);
  });

  it("dead-letters instead of scheduling once attempts reach the ceiling", () => {
    const db = freshDb();
    enqueue(db);
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i += 1) markOutboxAttempt(db, "msg_1", AT);

    const outcome = markOutboxFailed(db, "msg_1", AT, "the peer has never once answered");
    expect(outcome).toEqual({ status: "dead-lettered" });

    const dead = deadLetteredOutbox(db);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.messageId).toBe("msg_1");
    expect(dead[0]?.peerNodeId).toBe("node_b");
    expect(dead[0]?.lastError).toBe("the peer has never once answered");
  });

  it("truncates an oversized error rather than storing it unbounded", () => {
    const db = freshDb();
    enqueue(db);
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i += 1) markOutboxAttempt(db, "msg_1", AT);

    markOutboxFailed(db, "msg_1", AT, "x".repeat(10_000));

    const dead = deadLetteredOutbox(db);
    expect(dead[0]?.lastError).toHaveLength(500);
  });

  it("pendingOutbox skips a dead-lettered row even when no time is given", () => {
    const db = freshDb();
    enqueue(db);
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i += 1) markOutboxAttempt(db, "msg_1", AT);
    markOutboxFailed(db, "msg_1", AT, "gone for good");

    expect(pendingOutbox(db)).toEqual([]);
    expect(pendingOutbox(db, "node_b")).toEqual([]);
  });

  it("pendingOutbox skips a row scheduled for the future, and returns it once due", () => {
    const db = freshDb();
    enqueue(db);
    markOutboxAttempt(db, "msg_1", AT);
    markOutboxFailed(db, "msg_1", AT, "not yet");

    const before = instantSchema.parse(new Date(Date.parse(AT) + 1_000).toISOString());
    expect(pendingOutbox(db, undefined, before)).toEqual([]);

    const after = instantSchema.parse(new Date(Date.parse(AT) + 5_000).toISOString());
    expect(pendingOutbox(db, undefined, after)).toEqual([{ hello: "world" }]);
  });

  it("pendingOutbox with no now argument ignores scheduling and returns every row still owed", () => {
    const db = freshDb();
    enqueue(db);
    markOutboxAttempt(db, "msg_1", AT);
    markOutboxFailed(db, "msg_1", AT, "not yet");

    expect(pendingOutbox(db)).toEqual([{ hello: "world" }]);
  });

  it("an acknowledged row is never returned regardless of its schedule", () => {
    const db = freshDb();
    enqueue(db);
    markOutboxAcknowledged(db, "msg_1", AT);

    expect(pendingOutbox(db, undefined, AT)).toEqual([]);
  });

  it("derives the next outbound sequence for a peer from what has already been queued for it", () => {
    const db = freshDb();
    expect(nextOutboundSequence(db, "node_b")).toBe(1);

    enqueueOutbox(db, {
      messageId: "msg_1",
      peerNodeId: "node_b",
      correlationId: "corr_1",
      document: { sourceSequence: 1 },
      createdAt: AT,
    });
    expect(nextOutboundSequence(db, "node_b")).toBe(2);

    enqueueOutbox(db, {
      messageId: "msg_2",
      peerNodeId: "node_b",
      correlationId: "corr_1",
      document: { sourceSequence: 2 },
      createdAt: AT,
    });
    expect(nextOutboundSequence(db, "node_b")).toBe(3);

    // Acknowledging the earlier message does not roll the counter back: rows are never deleted, and the
    // sequence this node already committed to using stays used.
    markOutboxAcknowledged(db, "msg_1", AT);
    expect(nextOutboundSequence(db, "node_b")).toBe(3);

    // A different peer has its own independent stream.
    expect(nextOutboundSequence(db, "node_c")).toBe(1);
  });
});
