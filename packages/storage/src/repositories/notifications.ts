import {
  type Instant,
  type Notice,
  type NoticeCategory,
  type NoticeSeverity,
  type NoticeSourceKind,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  redactSecrets,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, transaction } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Notifications — the notices in the person's inbox
 * ------------------------------------------------------------------ */

/**
 * How many *undismissed* notices a principal keeps.
 *
 * An inbox that grows without bound is an inbox nobody reads past the first screen, and a table that grows without
 * bound is a node that slows down for a reason nobody can see. Two hundred is several days of background work; the
 * result of each one is also in its conversation, which is the record that outlives this list. Dismissed notices
 * do not count against this cap — see `DISMISSED_RETENTION_MS` — so a busy inbox can never prune a dismissed
 * notice before its own window and make it reappear.
 */
export const MAX_NOTIFICATIONS = 200;

/**
 * How long a dismissed notice is kept, so a producer that repeats itself inside that window stays deduplicated.
 * This is the only rule that removes a dismissed notice; it is independent of `MAX_NOTIFICATIONS`.
 */
export const DISMISSED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface RecordNotificationInput {
  notificationId: string;
  principalId: string;
  sourceKind: NoticeSourceKind;
  category: NoticeCategory;
  severity: NoticeSeverity;
  title: string;
  body?: string;
  conversationId?: string;
  originNodeId?: string;
  /**
   * The producer's own name for this event: `background:<sessionId>`, `worker:<taskId>`, later
   * `update:<packageId>@<version>` or a peer's message id. The same key twice is one notice.
   */
  dedupKey: string;
  at: Instant;
}

interface NotificationRow {
  notification_id: string;
  source_kind: string;
  category: string;
  severity: string;
  title: string;
  body: string | null;
  conversation_id: string | null;
  origin_node_id: string | null;
  created_at: string;
  read_at: string | null;
}

/** Redacted and bounded here rather than at every producer: this is the one door text comes through. */
function clean(text: string, max: number): string {
  const redacted = redactSecrets(text).replace(/\s+/g, " ").trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}

/**
 * Write a notice, unless this producer already wrote this one.
 *
 * Idempotent on `(principalId, dedupKey)`: a second delivery of the same event — a resend, a retry, a check that
 * ran twice — returns the first notice and changes nothing, including its read or dismissed state. A notice the
 * person dismissed does not come back because its producer repeated itself. The key is normalised (bounded to the
 * column's 300 chars) once, up front, so the lookup and the write agree on the same string; looking one up
 * unsliced while the other stores it sliced is how a key longer than 300 chars turns a duplicate delivery into a
 * `UNIQUE constraint failed` instead of `created: false`.
 *
 * Pruning happens in the same transaction as the write, so the table is bounded by construction rather than by a
 * job somebody has to remember to schedule. Two independent rules apply:
 *
 *   - A dismissed notice is removed only once it is more than 30 days past dismissal. It never counts against the
 *     `MAX_NOTIFICATIONS` cap, so it cannot be pruned early just because the inbox stayed busy — which is what
 *     "a dismissed notice does not come back" depends on: a producer that repeats itself inside the window has to
 *     find the row still there to dedupe against.
 *   - The undismissed inbox is capped at `MAX_NOTIFICATIONS`, oldest by insertion (`rowid`) first. Ordering by
 *     insertion rather than by the caller-supplied `at` means the row this call just wrote is always the newest
 *     by that ordering and is never the one the same transaction deletes, even if its `at` is backdated behind
 *     existing rows.
 */
export function recordNotification(
  db: Database,
  input: RecordNotificationInput,
): { notificationId: string; created: boolean } {
  const dedupKey = input.dedupKey.slice(0, 300);
  return transaction(db, () => {
    const existing = oneRow<{ notification_id: string }>(
      db,
      "SELECT notification_id FROM notifications WHERE principal_id = ? AND dedup_key = ?",
      input.principalId,
      dedupKey,
    );
    if (existing !== undefined) return { notificationId: existing.notification_id, created: false };

    const title = clean(input.title, NOTICE_TITLE_MAX);
    const body = input.body === undefined ? "" : clean(input.body, NOTICE_BODY_MAX);
    db.prepare(
      `INSERT INTO notifications
         (notification_id, principal_id, source_kind, category, severity, title, body,
          conversation_id, origin_node_id, dedup_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.notificationId,
      input.principalId,
      input.sourceKind,
      input.category,
      input.severity,
      title === "" ? "(không có tiêu đề)" : title,
      body === "" ? null : body,
      input.conversationId ?? null,
      input.originNodeId ?? null,
      dedupKey,
      input.at,
    );

    const dismissedBefore = new Date(Date.parse(input.at) - DISMISSED_RETENTION_MS).toISOString();
    db.prepare("DELETE FROM notifications WHERE principal_id = ? AND dismissed_at IS NOT NULL AND dismissed_at < ?").run(
      input.principalId,
      dismissedBefore,
    );
    db.prepare(
      `DELETE FROM notifications WHERE principal_id = ? AND dismissed_at IS NULL AND notification_id NOT IN (
         SELECT notification_id FROM notifications WHERE principal_id = ? AND dismissed_at IS NULL
          ORDER BY rowid DESC LIMIT ?
       )`,
    ).run(input.principalId, input.principalId, MAX_NOTIFICATIONS);

    return { notificationId: input.notificationId, created: true };
  });
}

function noticeFromRow(row: NotificationRow): Notice {
  // SAFETY: every column below was written by `recordNotification` from the contract's own enums, and the route
  // that serves the list parses the response with `inboxResponseSchema` in the client.
  return {
    noticeId: row.notification_id,
    sourceKind: row.source_kind as Notice["sourceKind"],
    category: row.category as Notice["category"],
    severity: row.severity as Notice["severity"],
    title: row.title,
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    ...(row.origin_node_id === null ? {} : { originNodeId: row.origin_node_id }),
    createdAt: row.created_at as Instant,
    ...(row.read_at === null ? {} : { readAt: row.read_at as Instant }),
  };
}

/** The notices still in the inbox, newest first. Dismissed ones are gone from the list, not greyed out. */
export function listNotifications(db: Database, principalId: string, limit = 50): Notice[] {
  return allRows<NotificationRow>(
    db,
    `SELECT notification_id, source_kind, category, severity, title, body, conversation_id, origin_node_id,
            created_at, read_at
       FROM notifications
      WHERE principal_id = ? AND dismissed_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
    principalId,
    Math.max(1, Math.min(limit, MAX_NOTIFICATIONS)),
  ).map(noticeFromRow);
}

export function countUnreadNotifications(db: Database, principalId: string): number {
  const row = oneRow<{ unread: number }>(
    db,
    "SELECT COUNT(*) AS unread FROM notifications WHERE principal_id = ? AND dismissed_at IS NULL AND read_at IS NULL",
    principalId,
  );
  return Number(row?.unread ?? 0);
}

/**
 * Mark notices read.
 *
 * With ids, only those: the surface sends the ids it actually showed, so a notice that arrived while the panel was
 * open is not marked read without ever having been on screen. Without ids, every notice.
 */
export function markNotificationsRead(
  db: Database,
  input: { principalId: string; at: Instant; notificationIds?: readonly string[] },
): number {
  if (input.notificationIds === undefined) {
    return Number(
      db
        .prepare("UPDATE notifications SET read_at = ? WHERE principal_id = ? AND read_at IS NULL")
        .run(input.at, input.principalId).changes,
    );
  }
  if (input.notificationIds.length === 0) return 0;
  return transaction(db, () => {
    const statement = db.prepare(
      "UPDATE notifications SET read_at = ? WHERE principal_id = ? AND notification_id = ? AND read_at IS NULL",
    );
    let changed = 0;
    for (const id of input.notificationIds ?? []) {
      changed += Number(statement.run(input.at, input.principalId, id).changes);
    }
    return changed;
  });
}

/** Take a notice out of the inbox. Kept as a row for the retention window so its producer stays deduplicated. */
export function dismissNotification(
  db: Database,
  input: { principalId: string; notificationId: string; at: Instant },
): boolean {
  const result = db
    .prepare(
      `UPDATE notifications SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
        WHERE principal_id = ? AND notification_id = ? AND dismissed_at IS NULL`,
    )
    .run(input.at, input.at, input.principalId, input.notificationId);
  return Number(result.changes) > 0;
}
