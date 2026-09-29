import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import {
  MAX_NOTIFICATIONS,
  MAX_NOTIFICATIONS_PER_ORIGIN,
  countRecentInbox,
  dismissNotificationsByKeyPrefix,
  enqueueOutbox,
  getPeer,
  listNotifications,
  markOutboxAcknowledged,
  markOutboxAttempt,
  markOutboxFailed,
  migrate,
  openDatabase,
  peerDeliveryState,
  recordInbox,
  recordNotification,
  recordPeerAdvertisement,
  upsertPeer,
} from "../src/index.ts";

/**
 * What the inbox needs to know about other nodes: whether a peer is being reached, taken from the outbox's own retry
 * state rather than a second record of it; what a peer says about itself; how much a peer sent lately and how much of
 * the inbox it may hold; and taking a family of notices out of the inbox once what they said stopped being so.
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
    expect(peerDeliveryState(db, "node_b")).toEqual({ lastAcknowledgedAt: null, failingSince: null, lastError: null, givenUpSince: null });
    queue(db, "msg_1", at(0));
    expect(peerDeliveryState(db, "node_b").failingSince).toBeNull();
  });

  it("is failing since the oldest message still retried, and stays so however often it is retried", () => {
    const db = freshDb();
    queue(db, "msg_1", at(0));
    queue(db, "msg_2", at(3));
    fail(db, "msg_1", at(1));
    fail(db, "msg_2", at(4));
    expect(peerDeliveryState(db, "node_b")).toEqual({
      lastAcknowledgedAt: null,
      failingSince: at(0),
      lastError: "connect ECONNREFUSED",
      givenUpSince: null,
    });
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
    expect(peerDeliveryState(db, "node_b")).toEqual({ lastAcknowledgedAt: at(5), failingSince: null, lastError: null, givenUpSince: null });

    fail(db, "msg_2", at(7));
    expect(peerDeliveryState(db, "node_b")).toMatchObject({ lastAcknowledgedAt: at(5), failingSince: at(5) });
  });

  it("names the reason of the latest failed attempt, so a peer that answered and refused is told apart", () => {
    const db = freshDb();
    queue(db, "msg_1", at(0));
    queue(db, "msg_2", at(1));
    fail(db, "msg_1", at(2));
    markOutboxAttempt(db, "msg_2", at(3));
    markOutboxFailed(db, "msg_2", at(3), "the peer answered 401");
    expect(peerDeliveryState(db, "node_b").lastError).toBe("the peer answered 401");
    fail(db, "msg_1", at(4));
    expect(peerDeliveryState(db, "node_b").lastError).toBe("connect ECONNREFUSED");
  });

  it("does not count a message given up on as failing now, and says it was given up on once nothing else is owed", () => {
    const db = freshDb();
    const giveUp = (messageId: string, when: Instant): void => {
      for (let attempt = 0; attempt < 12; attempt += 1) markOutboxAttempt(db, messageId, when);
      expect(markOutboxFailed(db, messageId, when, "the peer answered 409")).toEqual({ status: "dead-lettered" });
    };
    queue(db, "msg_1", at(0));
    queue(db, "msg_2", at(2));
    giveUp("msg_1", at(30));
    // msg_2 is still owed and not yet tried: neither failing nor given up.
    expect(peerDeliveryState(db, "node_b")).toMatchObject({ failingSince: null, givenUpSince: null });

    giveUp("msg_2", at(40));
    expect(peerDeliveryState(db, "node_b")).toEqual({
      lastAcknowledgedAt: null,
      failingSince: null,
      lastError: "the peer answered 409",
      givenUpSince: at(0),
    });

    // A message given up on before the peer last answered is history, not an outage.
    queue(db, "msg_3", at(41));
    markOutboxAcknowledged(db, "msg_3", at(45));
    expect(peerDeliveryState(db, "node_b")).toMatchObject({ lastAcknowledgedAt: at(45), givenUpSince: null });
    queue(db, "msg_4", at(46));
    giveUp("msg_4", at(50));
    expect(peerDeliveryState(db, "node_b").givenUpSince).toBe(at(46));
  });
});

describe("what a peer says about itself", () => {
  it("is stored only through the contract's readers, and a label is replaced only by a readable one", () => {
    const db = freshDb();
    upsertPeer(db, {
      peerNodeId: "node_b",
      endpoint: "http://127.0.0.1:1",
      publicKey: "key",
      fingerprint: "fp",
      tokenHash: "hash",
      pairedAt: at(0),
      trustedAt: at(0),
      revokedAt: null,
    });
    // Paired by a build from before features: nothing advertised, and nothing added to the record.
    expect(getPeer(db, "node_b")).not.toHaveProperty("features");
    expect(getPeer(db, "node_b")).not.toHaveProperty("label");

    recordPeerAdvertisement(db, "node_b", { features: ["notice", "teleport"], label: "  Máy‮ bàn​ " });
    expect(getPeer(db, "node_b")).toMatchObject({ features: ["notice"], label: "Máy bàn" });

    // An answer without a name keeps the last one; one without features says the peer takes none now.
    recordPeerAdvertisement(db, "node_b", { features: undefined, label: "​" });
    expect(getPeer(db, "node_b")).toMatchObject({ label: "Máy bàn" });
    expect(getPeer(db, "node_b")).not.toHaveProperty("features");

    // Re-pairing does not wipe what the peer said: upsert leaves the two columns alone.
    recordPeerAdvertisement(db, "node_b", { features: ["notice"] });
    upsertPeer(db, { ...(getPeer(db, "node_b") ?? ({} as never)), endpoint: "http://127.0.0.1:2" });
    expect(getPeer(db, "node_b")).toMatchObject({ features: ["notice"], label: "Máy bàn", endpoint: "http://127.0.0.1:2" });
  });
});

describe("a peer's recent envelopes", () => {
  it("are counted per peer and kind, strictly after the moment given", () => {
    const db = freshDb();
    const deliver = (messageId: string, peerNodeId: string, kind: string, receivedAt: Instant, sequence: number): void => {
      recordInbox(db, {
        dedupKey: `${peerNodeId}:${String(sequence)}:${messageId}`,
        peerNodeId,
        sourceSequence: sequence,
        messageId,
        kind,
        document: { messageId } as never,
        responseJson: "{}",
        receivedAt,
      });
    };
    deliver("msg_1", "node_b", "notice", at(0), 1);
    deliver("msg_2", "node_b", "notice", at(1), 2);
    deliver("msg_3", "node_b", "signal", at(1), 3);
    deliver("msg_4", "node_c", "notice", at(1), 1);
    expect(countRecentInbox(db, { peerNodeId: "node_b", kind: "notice", since: at(0) })).toBe(1);
    expect(countRecentInbox(db, { peerNodeId: "node_b", kind: "notice", since: at(-1) })).toBe(2);
    expect(countRecentInbox(db, { peerNodeId: "node_d", kind: "notice", since: at(-1) })).toBe(0);
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

  it("reads the family as a range of the dedup index, bounded on both sides, not the whole inbox", () => {
    const db = freshDb();
    notice(db, "peer-offline:node_b:never:unreachable");
    notice(db, "peer-offline:node_b;");
    notice(db, "peer-offline:node_b");
    expect(dismissNotificationsByKeyPrefix(db, { principalId: "owner_1", dedupKeyPrefix: "peer-offline:node_b:", at: at(1) })).toBe(1);
    expect(listNotifications(db, "owner_1").map((row) => row.title).sort()).toEqual(["peer-offline:node_b", "peer-offline:node_b;"]);
    // A prefix ending in a character past the basic plane is bounded too.
    notice(db, "k\u{1F600}x");
    notice(db, "k\u{1F601}");
    expect(dismissNotificationsByKeyPrefix(db, { principalId: "owner_1", dedupKeyPrefix: "k\u{1F600}", at: at(1) })).toBe(1);
    expect(listNotifications(db, "owner_1").map((row) => row.title)).toContain("k\u{1F601}");

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN UPDATE notifications SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
          WHERE principal_id = ? AND dedup_key >= ? AND dedup_key < ? AND dismissed_at IS NULL AND (? IS NULL OR dedup_key <> ?)`,
      )
      .all(at(1), at(1), "owner_1", "a:", "a;", null, null) as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toMatch(/idx_notifications_dedup \(principal_id=\? AND dedup_key>\? AND dedup_key<\?\)/);
  });
});

describe("a paired node's share of the inbox", () => {
  it("is its own: however much one peer sends, this node's notices and another peer's stay", () => {
    const db = freshDb();
    const write = (dedupKey: string, originNodeId?: string): void => {
      recordNotification(db, {
        notificationId: `ntf_${dedupKey}`,
        principalId: "owner_1",
        sourceKind: originNodeId === undefined ? "worker" : "peer",
        category: "message",
        severity: "info",
        title: dedupKey,
        ...(originNodeId === undefined ? {} : { originNodeId }),
        dedupKey,
        at: at(0),
      });
    };
    write("worker:task_local");
    write("peer:node_c:hello", "node_c");
    for (let index = 0; index < MAX_NOTIFICATIONS + 1; index += 1) write(`peer:node_b:${String(index)}`, "node_b");

    const titles = listNotifications(db, "owner_1", MAX_NOTIFICATIONS + 50).map((row) => row.title);
    expect(titles).toContain("worker:task_local");
    expect(titles).toContain("peer:node_c:hello");
    const fromB = titles.filter((title) => title.startsWith("peer:node_b:"));
    expect(fromB).toHaveLength(MAX_NOTIFICATIONS_PER_ORIGIN);
    // The newest of that peer's stay; its oldest go first.
    expect(fromB).toContain(`peer:node_b:${String(MAX_NOTIFICATIONS)}`);
    expect(fromB).not.toContain("peer:node_b:0");
  });
});
