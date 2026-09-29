import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import {
  dismissNotificationsByKeyPrefix,
  enqueueOutbox,
  listNotifications,
  markOutboxAcknowledged,
  markOutboxAttempt,
  markOutboxFailed,
  migrate,
  openDatabase,
  peerDeliveryState,
  recordNotification,
} from "../src/index.ts";

/**
 * Two small reads the inbox needs about other nodes: whether a peer is being reached, taken from the outbox's own retry
 * state rather than a second record of it, and taking a family of notices out of the inbox once what they said stopped
 * being so.
 */

const at = (minute: number): Instant => new Date(Date.UTC(2026, 8, 29, 8, minute)).toISOString() as Instant;

function freshDb() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return db;
}

function queue(db: ReturnType<typeof freshDb>, messageId: string, createdAt: Instant, peerNodeId = "node_b"): void {
  enqueueOutbox(db, { messageId, peerNodeId, correlationId: messageId, document: { messageId }, createdAt });
}

function fail(db: ReturnType<typeof freshDb>, messageId: string, when: Instant): void {
  markOutboxAttempt(db, messageId, when);
  markOutboxFailed(db, messageId, when, "connect ECONNREFUSED");
}

describe("how delivery to a peer is going", () => {
  it("is not failing while nothing is owed, or while what is owed has not been tried", () => {
    const db = freshDb();
    expect(peerDeliveryState(db, "node_b")).toEqual({ lastAcknowledgedAt: null, failingSince: null });
    queue(db, "msg_1", at(0));
    expect(peerDeliveryState(db, "node_b").failingSince).toBeNull();
  });

  it("is failing since the oldest message still retried, and stays so however often it is retried", () => {
    const db = freshDb();
    queue(db, "msg_1", at(0));
    queue(db, "msg_2", at(3));
    fail(db, "msg_1", at(1));
    fail(db, "msg_2", at(4));
    expect(peerDeliveryState(db, "node_b")).toEqual({ lastAcknowledgedAt: null, failingSince: at(0) });
    fail(db, "msg_1", at(9));
    expect(peerDeliveryState(db, "node_b").failingSince).toBe(at(0));
    // Another peer's failures are its own.
    expect(peerDeliveryState(db, "node_c").failingSince).toBeNull();
  });

  it("recovers on an acknowledgement, and a later failure starts no earlier than it", () => {
    const db = freshDb();
    queue(db, "msg_1", at(0));
    queue(db, "msg_2", at(1));
    fail(db, "msg_1", at(1));
    fail(db, "msg_2", at(1));
    markOutboxAcknowledged(db, "msg_1", at(5));
    // msg_2 last failed before the peer answered again, so it says nothing about now.
    expect(peerDeliveryState(db, "node_b")).toEqual({ lastAcknowledgedAt: at(5), failingSince: null });

    fail(db, "msg_2", at(7));
    expect(peerDeliveryState(db, "node_b")).toEqual({ lastAcknowledgedAt: at(5), failingSince: at(5) });
  });

  it("does not count a message given up on as failing now", () => {
    const db = freshDb();
    queue(db, "msg_1", at(0));
    for (let attempt = 0; attempt < 12; attempt += 1) markOutboxAttempt(db, "msg_1", at(1));
    expect(markOutboxFailed(db, "msg_1", at(1), "gone")).toEqual({ status: "dead-lettered" });
    expect(peerDeliveryState(db, "node_b").failingSince).toBeNull();
  });
});

describe("dismissing a family of notices by the start of their key", () => {
  function notice(db: ReturnType<typeof freshDb>, dedupKey: string, principalId = "owner_1"): void {
    recordNotification(db, {
      notificationId: `ntf_${dedupKey}_${principalId}`,
      principalId,
      sourceKind: "system",
      category: "alert",
      severity: "warning",
      title: dedupKey,
      dedupKey,
      at: at(0),
    });
  }

  it("dismisses the family only, for that principal only, keeping the one still true", () => {
    const db = freshDb();
    notice(db, "delegation-status:task_1:waiting_approval:1");
    notice(db, "delegation-status:task_1:waiting_approval:3");
    notice(db, "delegation-status:task_12:waiting_approval:1");
    notice(db, "delegation-status:task_1:waiting_approval:1", "owner_2");

    const dismissed = dismissNotificationsByKeyPrefix(db, {
      principalId: "owner_1",
      dedupKeyPrefix: "delegation-status:task_1:",
      at: at(1),
      except: "delegation-status:task_1:waiting_approval:3",
    });

    expect(dismissed).toBe(1);
    expect(listNotifications(db, "owner_1").map((row) => row.title).sort()).toEqual([
      "delegation-status:task_12:waiting_approval:1",
      "delegation-status:task_1:waiting_approval:3",
    ]);
    expect(listNotifications(db, "owner_2")).toHaveLength(1);
    // Nothing is left to dismiss a second time, and an empty prefix never matches everything.
    expect(dismissNotificationsByKeyPrefix(db, { principalId: "owner_1", dedupKeyPrefix: "delegation-status:task_1:w", at: at(2) })).toBe(1);
    expect(dismissNotificationsByKeyPrefix(db, { principalId: "owner_1", dedupKeyPrefix: "", at: at(2) })).toBe(0);
    expect(listNotifications(db, "owner_1").map((row) => row.title)).toEqual(["delegation-status:task_12:waiting_approval:1"]);
  });

  it("matches the key as text, so a wildcard character in it widens nothing", () => {
    const db = freshDb();
    notice(db, "peer-offline:node_b:never");
    notice(db, "peer-offline:nodeXb:never");
    expect(dismissNotificationsByKeyPrefix(db, { principalId: "owner_1", dedupKeyPrefix: "peer-offline:node_b:", at: at(1) })).toBe(1);
    expect(listNotifications(db, "owner_1").map((row) => row.title)).toEqual(["peer-offline:nodeXb:never"]);
  });
});
