import {
  type Instant,
  type Notice,
  type NoticeCategory,
  type NoticeSeverity,
  type NoticeSourceKind,
  type NoticeSubject,
  type NoticeSuppression,
  type NoticeSuppressionKey,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  noticeKindQuietable,
  noticeSubjectSchema,
  noticeSuppressionKey,
  noticeSuppressionScopeLabel,
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

/**
 * How long after a dismissal it can still be undone.
 *
 * The surface offers Undo for a few seconds; the node accepts it for longer, so a slow round trip or a person who
 * pressed it at the last moment is not refused. Past this, the dismissal is a decision, and the notice stays gone.
 */
export const DISMISS_UNDO_WINDOW_MS = 5 * 60_000;

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
  /** What the notice is about. Stored as the pointer only; what can be done with it is worked out when it is read. */
  subject?: NoticeSubject;
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
  subject: string | null;
  snoozed_until: string | null;
}

const NOTIFICATION_COLUMNS = `notification_id, source_kind, category, severity, title, body, conversation_id, origin_node_id,
            created_at, read_at, subject, snoozed_until`;

/** SQL: the notice is not snoozed until a time still ahead of the bound instant. */
const NOT_SNOOZED = "(snoozed_until IS NULL OR snoozed_until <= ?)";

/**
 * SQL: the notice came back from a snooze, at or before the bound instant, and has not been read since. Snoozing leaves
 * `read_at` as it was, so taking a snooze back restores exactly the earlier state; a snooze that runs its course is
 * what makes the notice unread, and that is read off the two times here rather than written by anything that runs then.
 */
const RETURNED_UNREAD = "(snoozed_until IS NOT NULL AND snoozed_until <= ? AND read_at IS NOT NULL AND read_at < snoozed_until)";

/** SQL: unread as the person sees it, at the bound instant. */
const UNREAD = `(read_at IS NULL OR ${RETURNED_UNREAD})`;

/** The node's clock, for callers that read the inbox without one of their own. */
function currentInstant(): Instant {
  return new Date().toISOString() as Instant;
}

/** Redacted and bounded here rather than at every producer: this is the one door text comes through. */
function clean(text: string, max: number): string {
  const redacted = redactSecrets(text).replace(/\s+/g, " ").trim();
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}

/**
 * A subject's `label` is text a person reads in the list of quieted kinds, taken from what they typed (an automation's
 * summary) or from outside (a repository name), so it goes through the same door as the title. Bounded rather than
 * refused: an automation summary may run longer than a label, and refusing it would lose the notice, not just the label.
 */
function cleanSubjectLabel(subject: NoticeSubject): NoticeSubject {
  if (subject.kind !== "automation" && subject.kind !== "signal-source") return subject;
  const label = clean(subject.label, NOTICE_TITLE_MAX);
  return { ...subject, label: label === "" ? "(không có tên)" : label };
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
): { notificationId: string; created: boolean; suppressed: boolean } {
  const dedupKey = input.dedupKey.slice(0, 300);
  return transaction(db, () => {
    const existing = oneRow<{ notification_id: string }>(
      db,
      "SELECT notification_id FROM notifications WHERE principal_id = ? AND dedup_key = ?",
      input.principalId,
      dedupKey,
    );
    if (existing !== undefined) return { notificationId: existing.notification_id, created: false, suppressed: false };

    // Parsed before the suppression lookup reads it, so a subject of an unknown kind is refused before anything else.
    const subject = input.subject === undefined ? undefined : noticeSubjectSchema.parse(cleanSubjectLabel(input.subject));
    // A kind the person asked not to be notified about is still written down — the record is not theirs to lose by
    // muting it — but read already, which is what keeps it out of the count and out of any notification. A kind too
    // wide to quiet never matches, whatever is stored.
    const kind = { ...input, ...(subject === undefined ? {} : { subject }) };
    const suppressed =
      noticeKindQuietable(kind) && findNoticeSuppression(db, input.principalId, noticeSuppressionKey(kind)) !== undefined;
    const title = clean(input.title, NOTICE_TITLE_MAX);
    const body = input.body === undefined ? "" : clean(input.body, NOTICE_BODY_MAX);
    db.prepare(
      `INSERT INTO notifications
         (notification_id, principal_id, source_kind, category, severity, title, body,
          conversation_id, origin_node_id, dedup_key, created_at, read_at, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      suppressed ? input.at : null,
      subject === undefined ? null : JSON.stringify(subject),
    );

    const dismissedBefore = new Date(Date.parse(input.at) - DISMISSED_RETENTION_MS).toISOString();
    db.prepare("DELETE FROM notifications WHERE principal_id = ? AND dismissed_at IS NOT NULL AND dismissed_at < ?").run(
      input.principalId,
      dismissedBefore,
    );
    // A notice snoozed until a time still ahead is never the one evicted: the person put it aside to come back to, and
    // losing it silently would break exactly that promise. Snoozes are a person's own actions, so the rows this keeps
    // past the cap are bounded by what somebody chose to set aside.
    db.prepare(
      `DELETE FROM notifications WHERE principal_id = ? AND dismissed_at IS NULL
          AND (snoozed_until IS NULL OR snoozed_until <= ?)
          AND notification_id NOT IN (
            SELECT notification_id FROM notifications WHERE principal_id = ? AND dismissed_at IS NULL
             ORDER BY rowid DESC LIMIT ?
          )`,
    ).run(input.principalId, input.at, input.principalId, MAX_NOTIFICATIONS);

    return { notificationId: input.notificationId, created: true, suppressed };
  });
}

/** A stored subject, read back only if it is still one this version knows; anything else is as if there were none. */
function subjectFromColumn(column: string | null): NoticeSubject | undefined {
  if (column === null) return undefined;
  try {
    const parsed = noticeSubjectSchema.safeParse(JSON.parse(column));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function noticeFromRow(row: NotificationRow, now: Instant): Notice {
  const subject = subjectFromColumn(row.subject);
  const snoozed = row.snoozed_until !== null && row.snoozed_until > now;
  // Back from a snooze and not read since: unread, whatever it was when it was put aside (see `RETURNED_UNREAD`).
  const returnedUnread =
    row.snoozed_until !== null && row.snoozed_until <= now && row.read_at !== null && row.read_at < row.snoozed_until;
  const readAt = row.read_at === null || returnedUnread ? undefined : (row.read_at as Instant);
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
    ...(readAt === undefined ? {} : { readAt }),
    ...(subject === undefined ? {} : { subject }),
    ...(snoozed && row.snoozed_until !== null ? { snoozedUntil: row.snoozed_until as Instant } : {}),
  };
}

/**
 * The notices still in the inbox, newest first. Dismissed ones are gone from the list, not greyed out; snoozed ones are
 * gone until `now` reaches the time they were snoozed to, and then come back sorted by that time, so a notice put aside
 * yesterday returns at the top rather than a day down the list.
 */
export function listNotifications(db: Database, principalId: string, limit = 50, now: Instant = currentInstant()): Notice[] {
  return allRows<NotificationRow>(
    db,
    `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
      WHERE principal_id = ? AND dismissed_at IS NULL AND ${NOT_SNOOZED}
      ORDER BY COALESCE(snoozed_until, created_at) DESC, rowid DESC
      LIMIT ?`,
    principalId,
    now,
    Math.max(1, Math.min(limit, MAX_NOTIFICATIONS)),
  ).map((row) => noticeFromRow(row, now));
}

/** The notices snoozed until a time still ahead of `now`, soonest back first, each with that time. */
export function listSnoozedNotifications(db: Database, principalId: string, now: Instant = currentInstant()): Notice[] {
  return allRows<NotificationRow>(
    db,
    `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
      WHERE principal_id = ? AND dismissed_at IS NULL AND snoozed_until > ?
      ORDER BY snoozed_until ASC, rowid ASC
      LIMIT ?`,
    principalId,
    now,
    MAX_NOTIFICATIONS,
  ).map((row) => noticeFromRow(row, now));
}

/**
 * One notice of this principal, whether or not it is still in the list.
 *
 * `dismissed` says which: a message that pointed at a notice still describes what it pointed at after the notice was
 * dismissed, while a new reference to it is refused.
 */
export function getNotification(
  db: Database,
  principalId: string,
  notificationId: string,
  now: Instant = currentInstant(),
): { notice: Notice; dismissed: boolean } | undefined {
  const row = oneRow<NotificationRow & { dismissed_at: string | null }>(
    db,
    `SELECT ${NOTIFICATION_COLUMNS}, dismissed_at FROM notifications WHERE principal_id = ? AND notification_id = ?`,
    principalId,
    notificationId,
  );
  return row === undefined ? undefined : { notice: noticeFromRow(row, now), dismissed: row.dismissed_at !== null };
}

/** Unread notices in the list. A snoozed notice is not counted until it is back, which is when it is unread again. */
export function countUnreadNotifications(db: Database, principalId: string, now: Instant = currentInstant()): number {
  const row = oneRow<{ unread: number }>(
    db,
    `SELECT COUNT(*) AS unread FROM notifications
      WHERE principal_id = ? AND dismissed_at IS NULL AND ${UNREAD} AND ${NOT_SNOOZED}`,
    principalId,
    now,
    now,
  );
  return Number(row?.unread ?? 0);
}

/**
 * Mark notices read.
 *
 * With ids, only those: the surface sends the ids it actually showed, so a notice that arrived while the panel was
 * open is not marked read without ever having been on screen. Without ids, every notice in the list — not one that is
 * snoozed, which has to come back unread.
 */
export function markNotificationsRead(
  db: Database,
  input: { principalId: string; at: Instant; notificationIds?: readonly string[] },
): number {
  if (input.notificationIds === undefined) {
    return Number(
      db
        .prepare(`UPDATE notifications SET read_at = ? WHERE principal_id = ? AND ${UNREAD} AND ${NOT_SNOOZED}`)
        .run(input.at, input.principalId, input.at, input.at).changes,
    );
  }
  if (input.notificationIds.length === 0) return 0;
  return transaction(db, () => {
    const statement = db.prepare(
      `UPDATE notifications SET read_at = ? WHERE principal_id = ? AND notification_id = ? AND ${UNREAD}`,
    );
    let changed = 0;
    for (const id of input.notificationIds ?? []) {
      changed += Number(statement.run(input.at, input.principalId, id, input.at).changes);
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
      `UPDATE notifications SET dismissed_at = ?, read_at = CASE WHEN ${UNREAD} THEN ? ELSE read_at END
        WHERE principal_id = ? AND notification_id = ? AND dismissed_at IS NULL`,
    )
    .run(input.at, input.at, input.at, input.principalId, input.notificationId);
  return Number(result.changes) > 0;
}

/**
 * Mark notices unread again: attention state only, so a notice already dismissed is not touched — marking it unread
 * must not bring it back.
 */
export function markNotificationsUnread(
  db: Database,
  input: { principalId: string; notificationIds: readonly string[] },
): number {
  if (input.notificationIds.length === 0) return 0;
  return transaction(db, () => {
    const statement = db.prepare(
      `UPDATE notifications SET read_at = NULL
        WHERE principal_id = ? AND notification_id = ? AND dismissed_at IS NULL AND read_at IS NOT NULL`,
    );
    let changed = 0;
    for (const id of input.notificationIds) changed += Number(statement.run(input.principalId, id).changes);
    return changed;
  });
}

/**
 * Undo a dismissal, while it is recent enough to be an undo (`DISMISS_UNDO_WINDOW_MS`).
 *
 * The notice comes back as it was dismissed, read: dismissing marked it read, and the person has seen it. Refused
 * once the window has passed, so an old dismissal cannot be reversed by replaying the request later.
 */
export function restoreNotification(
  db: Database,
  input: { principalId: string; notificationId: string; at: Instant },
): "restored" | "not-dismissed" | "expired" | "not-found" {
  return transaction(db, () => {
    const row = oneRow<{ dismissed_at: string | null }>(
      db,
      "SELECT dismissed_at FROM notifications WHERE principal_id = ? AND notification_id = ?",
      input.principalId,
      input.notificationId,
    );
    if (row === undefined) return "not-found";
    if (row.dismissed_at === null) return "not-dismissed";
    if (Date.parse(input.at) - Date.parse(row.dismissed_at) > DISMISS_UNDO_WINDOW_MS) return "expired";
    db.prepare("UPDATE notifications SET dismissed_at = NULL WHERE principal_id = ? AND notification_id = ?").run(
      input.principalId,
      input.notificationId,
    );
    return "restored";
  });
}

/**
 * Put one notice aside until `until`. It leaves the list and the unread count now, and comes back unread then, at the
 * top. Its read state is left as it is, so taking the snooze back (`unsnoozeNotification`) restores exactly what the
 * person had; a snooze that runs its course reads as unread from the times alone (`RETURNED_UNREAD`), with nothing
 * running when it ends. A notice that is itself back from an earlier snooze and still unread is written unread here,
 * so snoozing it again and taking that back does not turn it read. Snoozing again moves the time. `until` is compared
 * as text with other instants, so the caller passes it in the node's own `toISOString()` form, ahead of `at` and
 * within `NOTICE_SNOOZE_MAX_MS`.
 */
export function snoozeNotification(
  db: Database,
  input: { principalId: string; notificationId: string; until: Instant; at: Instant },
): boolean {
  const result = db
    .prepare(
      `UPDATE notifications SET snoozed_until = ?, read_at = CASE WHEN ${RETURNED_UNREAD} THEN NULL ELSE read_at END
        WHERE principal_id = ? AND notification_id = ? AND dismissed_at IS NULL`,
    )
    .run(input.until, input.at, input.principalId, input.notificationId);
  return Number(result.changes) > 0;
}

/**
 * Take a snooze back: the notice returns to the list as it was when it was snoozed — read or unread, in its old place.
 * "not-snoozed" for one already back — from a second press, or because its time came — which is what was asked for.
 */
export function unsnoozeNotification(
  db: Database,
  input: { principalId: string; notificationId: string; at: Instant },
): "unsnoozed" | "not-snoozed" | "not-found" {
  return transaction(db, () => {
    const row = oneRow<{ snoozed_until: string | null }>(
      db,
      "SELECT snoozed_until FROM notifications WHERE principal_id = ? AND notification_id = ? AND dismissed_at IS NULL",
      input.principalId,
      input.notificationId,
    );
    if (row === undefined) return "not-found";
    if (row.snoozed_until === null || row.snoozed_until <= input.at) return "not-snoozed";
    db.prepare("UPDATE notifications SET snoozed_until = NULL WHERE principal_id = ? AND notification_id = ?").run(
      input.principalId,
      input.notificationId,
    );
    return "unsnoozed";
  });
}

/* ------------------------------------------------------------------ *
 * Suppressions — "stop notifying me about this kind"
 * ------------------------------------------------------------------ */

interface SuppressionRow {
  suppression_id: string;
  source_kind: string;
  category: string;
  severity: string;
  scope: string;
  scope_label: string | null;
  example_title: string;
  created_at: string;
}

const SUPPRESSION_COLUMNS = "suppression_id, source_kind, category, severity, scope, scope_label, example_title, created_at";

function suppressionFromRow(row: SuppressionRow): NoticeSuppression {
  // SAFETY: every column was written by `suppressNoticeKind` from a stored notice's own enum columns.
  return {
    suppressionId: row.suppression_id,
    sourceKind: row.source_kind as NoticeSuppression["sourceKind"],
    category: row.category as NoticeSuppression["category"],
    severity: row.severity as NoticeSuppression["severity"],
    ...(row.scope === "" ? {} : { scope: row.scope }),
    ...(row.scope_label === null ? {} : { scopeLabel: row.scope_label }),
    example: row.example_title,
    createdAt: row.created_at as Instant,
  };
}

/** The suppression this principal set for exactly this kind of notice, if any. */
export function findNoticeSuppression(db: Database, principalId: string, key: NoticeSuppressionKey): NoticeSuppression | undefined {
  const row = oneRow<SuppressionRow>(
    db,
    `SELECT ${SUPPRESSION_COLUMNS} FROM notification_suppressions
      WHERE principal_id = ? AND source_kind = ? AND category = ? AND severity = ? AND scope = ?`,
    principalId,
    key.sourceKind,
    key.category,
    key.severity,
    key.scope ?? "",
  );
  return row === undefined ? undefined : suppressionFromRow(row);
}

export function listNoticeSuppressions(db: Database, principalId: string): NoticeSuppression[] {
  return allRows<SuppressionRow>(
    db,
    `SELECT ${SUPPRESSION_COLUMNS} FROM notification_suppressions WHERE principal_id = ? ORDER BY created_at DESC, rowid DESC`,
    principalId,
  ).map(suppressionFromRow);
}

/**
 * Stop notifying this principal about notices of the same kind as this one (`noticeSuppressionKey`), from now on.
 *
 * Only future notices are affected: the ones already in the list keep their read state, because quieting a kind is
 * about interruptions still to come, not about what the person has or has not looked at. Setting it twice returns the
 * first. "not-found" when the notice is not this principal's or no longer in the inbox; "too-broad" when its kind has
 * no scope narrow enough to quiet (`noticeKindQuietable`), so nothing is stored.
 */
export function suppressNoticeKind(
  db: Database,
  input: { principalId: string; notificationId: string; suppressionId: string; at: Instant },
): { suppression: NoticeSuppression } | "not-found" | "too-broad" {
  return transaction(db, () => {
    const stored = getNotification(db, input.principalId, input.notificationId, input.at);
    if (stored === undefined || stored.dismissed) return "not-found";
    if (!noticeKindQuietable(stored.notice)) return "too-broad";
    const key = noticeSuppressionKey(stored.notice);
    const existing = findNoticeSuppression(db, input.principalId, key);
    if (existing !== undefined) return { suppression: existing };
    db.prepare(
      `INSERT INTO notification_suppressions
         (suppression_id, principal_id, source_kind, category, severity, scope, scope_label, example_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.suppressionId,
      input.principalId,
      key.sourceKind,
      key.category,
      key.severity,
      key.scope ?? "",
      noticeSuppressionScopeLabel(stored.notice) ?? null,
      stored.notice.title,
      input.at,
    );
    const created = findNoticeSuppression(db, input.principalId, key);
    if (created === undefined) throw new Error("a suppression just written could not be read back");
    return { suppression: created };
  });
}

/** Notify about this kind again. Only this principal's; true when there was one to remove. */
export function removeNoticeSuppression(db: Database, input: { principalId: string; suppressionId: string }): boolean {
  const result = db
    .prepare("DELETE FROM notification_suppressions WHERE principal_id = ? AND suppression_id = ?")
    .run(input.principalId, input.suppressionId);
  return Number(result.changes) > 0;
}