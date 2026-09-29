import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import {
  DISMISS_UNDO_WINDOW_MS,
  MAX_NOTIFICATIONS,
  countUnreadNotifications,
  dismissNotification,
  dismissNotificationByKey,
  findNoticeSuppression,
  getNotification,
  listNoticeSuppressions,
  listNotifications,
  listSnoozedNotifications,
  markNotificationsRead,
  markNotificationsUnread,
  recordNotification,
  removeNoticeSuppression,
  restoreNotification,
  snoozeNotification,
  suppressNoticeKind,
  unsnoozeNotification,
  type RecordNotificationInput,
} from "../src/repositories/notifications.ts";

/**
 * The inbox's notices.
 *
 * The properties worth a test are the ones a producer relies on without checking: that saying the same thing twice
 * is saying it once, that the table cannot grow without bound, and that what comes out is safe to put on a screen.
 */
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-notifications-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let counter = 0;
type Recorded = ReturnType<typeof recordNotification>;
function record(overrides: Partial<RecordNotificationInput> = {}): Recorded {
  counter += 1;
  return recordNotification(db, {
    notificationId: `ntf_${counter}`,
    principalId: "owner_1",
    sourceKind: "background",
    category: "result",
    severity: "success",
    title: "Việc nền đã xong",
    body: "Tóm tắt báo cáo tuần",
    conversationId: "conv_1",
    dedupKey: `background:bg_${counter}`,
    at: new Date(Date.UTC(2026, 8, 24, 7, 0, counter)).toISOString() as Instant,
    ...overrides,
  });
}

describe("recording a notice", () => {
  it("reads back newest first, unread, with the pointer to its conversation", () => {
    record({ title: "cũ" });
    record({ title: "mới" });
    const notices = listNotifications(db, "owner_1");
    expect(notices.map((notice) => notice.title)).toEqual(["mới", "cũ"]);
    expect(notices[0]?.conversationId).toBe("conv_1");
    expect(notices[0]?.readAt).toBeUndefined();
    expect(countUnreadNotifications(db, "owner_1")).toBe(2);
  });

  it("is idempotent on the producer's dedup key, and keeps the first notice's state", () => {
    const first = record({ dedupKey: "worker:task_1", notificationId: "ntf_first" });
    markNotificationsRead(db, { principalId: "owner_1", at: "2026-09-24T08:00:00.000Z" as Instant });
    const second = record({ dedupKey: "worker:task_1", notificationId: "ntf_second", title: "khác" });

    expect(first).toEqual({ notificationId: "ntf_first", created: true, suppressed: false });
    expect(second).toEqual({ notificationId: "ntf_first", created: false, suppressed: false });
    const notices = listNotifications(db, "owner_1");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.readAt).toBe("2026-09-24T08:00:00.000Z");
  });

  it("does not bring back a dismissed notice when its producer repeats itself", () => {
    record({ dedupKey: "update:pkg@1.2.0", notificationId: "ntf_update" });
    expect(dismissNotification(db, { principalId: "owner_1", notificationId: "ntf_update", at: "2026-09-24T08:00:00.000Z" as Instant })).toBe(true);
    record({ dedupKey: "update:pkg@1.2.0" });
    expect(listNotifications(db, "owner_1")).toEqual([]);
  });

  it("normalises a dedup key longer than the column's 300 chars before both the lookup and the write", () => {
    // Before the fix: the INSERT sliced the key to 300 chars but the SELECT looked it up unsliced, so this
    // second call found no existing row, tried to insert the same sliced key again, and threw
    // `UNIQUE constraint failed` instead of returning `created: false`.
    const longKey = `worker:${"a".repeat(400)}`;
    const first = record({ dedupKey: longKey, notificationId: "ntf_long_1" });
    const second = record({ dedupKey: longKey, notificationId: "ntf_long_2" });
    expect(first).toEqual({ notificationId: "ntf_long_1", created: true, suppressed: false });
    expect(second).toEqual({ notificationId: "ntf_long_1", created: false, suppressed: false });
    expect(listNotifications(db, "owner_1")).toHaveLength(1);
  });

  it("keeps a dismissed notice past the undismissed cap, so its producer still dedupes against it", () => {
    // Before the fix: the cap counted dismissed rows too and ordered by the caller-supplied `at`, so this
    // dismissed (oldest) row was deleted once 200 newer notices existed, and re-recording its dedup key
    // created a fresh row instead of returning `created: false`.
    const dismissed = record({ dedupKey: "update:pkg@9.9.9", notificationId: "ntf_persistent" });
    expect(
      dismissNotification(db, { principalId: "owner_1", notificationId: dismissed.notificationId, at: "2026-09-24T08:00:00.000Z" as Instant }),
    ).toBe(true);
    for (let index = 0; index < MAX_NOTIFICATIONS + 20; index += 1) record();

    const again = record({ dedupKey: "update:pkg@9.9.9" });
    expect(again).toEqual({ notificationId: "ntf_persistent", created: false, suppressed: false });
    expect(listNotifications(db, "owner_1").some((notice) => notice.noticeId === "ntf_persistent")).toBe(false);
  });

  it("keeps a newly written notice even when its caller-supplied `at` is older than existing ones", () => {
    // Before the fix: pruning ordered by `at` rather than insertion order, so a notice backdated behind 200
    // existing ones was deleted in the same transaction that wrote it, while the call still reported
    // `created: true`.
    for (let index = 0; index < MAX_NOTIFICATIONS; index += 1) record();
    const backdated = record({
      dedupKey: "worker:backdated",
      notificationId: "ntf_backdated",
      at: new Date(Date.UTC(2020, 0, 1)).toISOString() as Instant,
    });
    expect(backdated).toEqual({ notificationId: "ntf_backdated", created: true, suppressed: false });
    const notices = listNotifications(db, "owner_1", MAX_NOTIFICATIONS + 50);
    expect(notices.some((notice) => notice.noticeId === "ntf_backdated")).toBe(true);
  });

  it("redacts a secret-shaped title", () => {
    record({ title: "Lỗi với Bearer abcdefghijklmnop1234" });
    const [notice] = listNotifications(db, "owner_1");
    expect(notice?.title).not.toContain("abcdefghijklmnop1234");
    expect(notice?.title).toContain("[redacted]");
  });

  it("redacts a secret-shaped body even when nothing needs truncating first", () => {
    // The token sits at the very start of a short body: if redaction only appeared to run because the
    // secret had already been sliced off by the 500-char bound, this would still pass without redacting.
    record({ body: "token_supersecretvalue123 finished without incident" });
    const [notice] = listNotifications(db, "owner_1");
    expect(notice?.body).toContain("[redacted]");
    expect(notice?.body).not.toContain("supersecretvalue");
  });

  it("bounds a long, secret-free body to the contract's max length", () => {
    record({ body: "x ".repeat(400) });
    const [notice] = listNotifications(db, "owner_1");
    expect(notice?.body?.length).toBeLessThanOrEqual(500);
    expect(notice?.body?.length).toBeGreaterThan(0);
  });

  it("keeps at most the bound, dropping the oldest", () => {
    let first: Recorded | undefined;
    let newest: Recorded | undefined;
    for (let index = 0; index < MAX_NOTIFICATIONS + 5; index += 1) {
      const result = record();
      first ??= result;
      newest = result;
    }
    const notices = listNotifications(db, "owner_1", MAX_NOTIFICATIONS + 50);
    expect(notices).toHaveLength(MAX_NOTIFICATIONS);
    expect(notices.some((notice) => notice.noticeId === newest?.notificationId)).toBe(true);
    expect(notices.some((notice) => notice.noticeId === first?.notificationId)).toBe(false);
  });
});

describe("reading and dismissing", () => {
  it("marks only the ids it was given, so a notice never on screen stays unread", () => {
    const shown = record();
    record();
    expect(
      markNotificationsRead(db, {
        principalId: "owner_1",
        notificationIds: [shown.notificationId],
        at: "2026-09-24T08:00:00.000Z" as Instant,
      }),
    ).toBe(1);
    expect(countUnreadNotifications(db, "owner_1")).toBe(1);
  });

  it("is scoped to its principal", () => {
    const mine = record();
    record({ principalId: "owner_2" });
    expect(listNotifications(db, "owner_2")).toHaveLength(1);
    expect(dismissNotification(db, { principalId: "owner_2", notificationId: mine.notificationId, at: "2026-09-24T08:00:00.000Z" as Instant })).toBe(false);
    expect(listNotifications(db, "owner_1")).toHaveLength(1);
  });

  it("markNotificationsRead with explicit ids never marks another principal's rows", () => {
    const theirs = record({ principalId: "owner_2" });
    const changed = markNotificationsRead(db, {
      principalId: "owner_1",
      notificationIds: [theirs.notificationId],
      at: "2026-09-24T08:00:00.000Z" as Instant,
    });
    expect(changed).toBe(0);
    expect(listNotifications(db, "owner_2")[0]?.readAt).toBeUndefined();
  });

  it("markNotificationsRead without ids marks only the caller's own principal", () => {
    record({ principalId: "owner_2" });
    markNotificationsRead(db, { principalId: "owner_1", at: "2026-09-24T08:00:00.000Z" as Instant });
    expect(countUnreadNotifications(db, "owner_2")).toBe(1);
  });

  it("countUnreadNotifications counts only the given principal's notices", () => {
    record({ principalId: "owner_1" });
    record({ principalId: "owner_1" });
    record({ principalId: "owner_2" });
    expect(countUnreadNotifications(db, "owner_1")).toBe(2);
    expect(countUnreadNotifications(db, "owner_2")).toBe(1);
  });

  it("the same dedup key under two principals produces two independent notices", () => {
    const a = record({ principalId: "owner_1", dedupKey: "worker:shared" });
    const b = record({ principalId: "owner_2", dedupKey: "worker:shared" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.notificationId).not.toBe(b.notificationId);
  });

  it("dismisses by a producer's exact key, never a key it only prefixes, and keeps the row to dedupe against", () => {
    record({ dedupKey: "worker:task_1", notificationId: "ntf_task_1" });
    record({ dedupKey: "worker:task_12", notificationId: "ntf_task_12" });
    const at = "2026-09-24T08:00:00.000Z" as Instant;

    expect(dismissNotificationByKey(db, { principalId: "owner_2", dedupKey: "worker:task_1", at })).toBe(false);
    expect(dismissNotificationByKey(db, { principalId: "owner_1", dedupKey: "worker:task_1", at })).toBe(true);
    expect(dismissNotificationByKey(db, { principalId: "owner_1", dedupKey: "worker:task_1", at })).toBe(false);

    expect(listNotifications(db, "owner_1").map((notice) => notice.noticeId)).toEqual(["ntf_task_12"]);
    expect(record({ dedupKey: "worker:task_1" })).toEqual({ notificationId: "ntf_task_1", created: false, suppressed: false });
  });
});

describe("subjects, unread and undo", () => {
  const later = (from: string, ms: number): Instant => new Date(Date.parse(from) + ms).toISOString() as Instant;

  it("keeps what a notice is about, and reads a notice without one as before", () => {
    record({ subject: { kind: "task", taskId: "task_7", conversationId: "conv_1" } });
    record();
    const [plain, about] = listNotifications(db, "owner_1");
    expect(about?.subject).toEqual({ kind: "task", taskId: "task_7", conversationId: "conv_1" });
    expect(plain?.subject).toBeUndefined();
  });

  it("refuses a subject that is not one of the known kinds before anything is written", () => {
    expect(() => record({ subject: { kind: "command", command: "deploy production" } as never })).toThrow();
    expect(listNotifications(db, "owner_1")).toHaveLength(0);
  });

  it("drops a stored subject this version cannot read instead of failing the whole list", () => {
    const { notificationId } = record();
    db.prepare("UPDATE notifications SET subject = ? WHERE notification_id = ?").run('{"kind":"from-the-future"}', notificationId);
    expect(listNotifications(db, "owner_1")[0]?.subject).toBeUndefined();
  });

  it("marks read notices unread again, and only this principal's undismissed ones", () => {
    const first = record().notificationId;
    const second = record().notificationId;
    const other = record({ principalId: "owner_2" }).notificationId;
    const at = new Date(Date.UTC(2026, 8, 24, 8)).toISOString() as Instant;
    markNotificationsRead(db, { principalId: "owner_1", at });
    markNotificationsRead(db, { principalId: "owner_2", at });
    dismissNotification(db, { principalId: "owner_1", notificationId: second, at });

    expect(markNotificationsUnread(db, { principalId: "owner_1", notificationIds: [first, second, other] })).toBe(1);
    expect(countUnreadNotifications(db, "owner_1")).toBe(1);
    expect(countUnreadNotifications(db, "owner_2")).toBe(0);
    // Marking a dismissed notice unread does not bring it back.
    expect(listNotifications(db, "owner_1").map((notice) => notice.noticeId)).toEqual([first]);
  });

  it("undoes a recent dismissal and brings the notice back read", () => {
    const { notificationId } = record();
    const at = new Date(Date.UTC(2026, 8, 24, 8)).toISOString();
    dismissNotification(db, { principalId: "owner_1", notificationId, at: at as Instant });

    expect(restoreNotification(db, { principalId: "owner_1", notificationId, at: later(at, 5_000) })).toBe("restored");
    const [back] = listNotifications(db, "owner_1");
    expect(back?.noticeId).toBe(notificationId);
    expect(back?.readAt).toBe(at);
    expect(restoreNotification(db, { principalId: "owner_1", notificationId, at: later(at, 6_000) })).toBe("not-dismissed");
  });

  it("refuses to undo a dismissal older than the window, and another principal's", () => {
    const { notificationId } = record();
    const at = new Date(Date.UTC(2026, 8, 24, 8)).toISOString();
    dismissNotification(db, { principalId: "owner_1", notificationId, at: at as Instant });

    expect(restoreNotification(db, { principalId: "owner_2", notificationId, at: later(at, 1_000) })).toBe("not-found");
    expect(restoreNotification(db, { principalId: "owner_1", notificationId, at: later(at, DISMISS_UNDO_WINDOW_MS + 1) })).toBe(
      "expired",
    );
    expect(listNotifications(db, "owner_1")).toHaveLength(0);
    expect(getNotification(db, "owner_1", notificationId)?.dismissed).toBe(true);
    expect(getNotification(db, "owner_2", notificationId)).toBeUndefined();
  });
});

describe("snoozing", () => {
  const T0 = "2026-09-24T09:00:00.000Z" as Instant;
  const at = (ms: number): Instant => new Date(Date.parse(T0) + ms).toISOString() as Instant;
  const HOUR = 60 * 60_000;

  it("takes a notice out of the list and the count until its time, then brings it back unread at the top", () => {
    const snoozed = record().notificationId;
    const other = record().notificationId;
    markNotificationsRead(db, { principalId: "owner_1", at: T0 });
    expect(snoozeNotification(db, { principalId: "owner_1", notificationId: snoozed, until: at(HOUR), at: at(0) })).toBe(true);

    // Snoozed: gone from the list and the count, listed on its own with the time it comes back.
    expect(listNotifications(db, "owner_1", 50, at(1_000)).map((notice) => notice.noticeId)).toEqual([other]);
    expect(countUnreadNotifications(db, "owner_1", at(1_000))).toBe(0);
    const aside = listSnoozedNotifications(db, "owner_1", at(1_000));
    expect(aside.map((notice) => notice.noticeId)).toEqual([snoozed]);
    expect(aside[0]?.snoozedUntil).toBe(at(HOUR));

    // Back once its time has passed, with nothing having run: unread, counted, first in the list, no longer "snoozed".
    const back = listNotifications(db, "owner_1", 50, at(HOUR));
    expect(back.map((notice) => notice.noticeId)).toEqual([snoozed, other]);
    expect(back[0]?.readAt).toBeUndefined();
    expect(back[0]?.snoozedUntil).toBeUndefined();
    expect(countUnreadNotifications(db, "owner_1", at(HOUR))).toBe(1);
    expect(listSnoozedNotifications(db, "owner_1", at(HOUR))).toEqual([]);
    expect(getNotification(db, "owner_1", snoozed, at(HOUR))?.notice.readAt).toBeUndefined();

    // Once read again, it stays read: coming back unread happens once per snooze, not on every read after it.
    expect(markNotificationsRead(db, { principalId: "owner_1", at: at(HOUR + 1_000) })).toBe(1);
    expect(countUnreadNotifications(db, "owner_1", at(HOUR + 2_000))).toBe(0);
    expect(listNotifications(db, "owner_1", 50, at(HOUR + 2_000))[0]?.readAt).toBe(at(HOUR + 1_000));
  });

  it("is not marked read by 'mark all read' while it is snoozed, so it still comes back unread", () => {
    const { notificationId } = record();
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(HOUR), at: at(0) });
    expect(markNotificationsRead(db, { principalId: "owner_1", at: at(1_000) })).toBe(0);
    expect(countUnreadNotifications(db, "owner_1", at(HOUR + 1))).toBe(1);
  });

  it("taken back early, returns exactly as it was — a read notice stays read, in its old place", () => {
    const older = record().notificationId;
    const newer = record().notificationId;
    markNotificationsRead(db, { principalId: "owner_1", at: T0, notificationIds: [older] });
    snoozeNotification(db, { principalId: "owner_1", notificationId: older, until: at(HOUR), at: at(0) });
    expect(unsnoozeNotification(db, { principalId: "owner_1", notificationId: older, at: at(60_000) })).toBe("unsnoozed");

    const list = listNotifications(db, "owner_1", 50, at(60_000));
    expect(list.map((notice) => notice.noticeId)).toEqual([newer, older]);
    expect(list[1]?.readAt).toBe(T0);
    expect(countUnreadNotifications(db, "owner_1", at(60_000))).toBe(1);
    // And past the time it had been snoozed to, nothing brings it back unread: the snooze was taken back.
    expect(countUnreadNotifications(db, "owner_1", at(2 * HOUR))).toBe(1);

    expect(unsnoozeNotification(db, { principalId: "owner_1", notificationId: older, at: at(61_000) })).toBe("not-snoozed");
    expect(unsnoozeNotification(db, { principalId: "owner_2", notificationId: older, at: at(61_000) })).toBe("not-found");
  });

  it("taken back early, an unread notice stays unread", () => {
    const { notificationId } = record();
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(HOUR), at: at(0) });
    unsnoozeNotification(db, { principalId: "owner_1", notificationId, at: at(60_000) });
    expect(countUnreadNotifications(db, "owner_1", at(60_000))).toBe(1);
  });

  it("snoozed again after coming back, and taken back, is still the unread notice it had come back as", () => {
    const { notificationId } = record();
    markNotificationsRead(db, { principalId: "owner_1", at: T0 });
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(HOUR), at: at(0) });
    // Back and unread at HOUR, snoozed again before being read, then that snooze taken back.
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(3 * HOUR), at: at(2 * HOUR) });
    unsnoozeNotification(db, { principalId: "owner_1", notificationId, at: at(2 * HOUR + 1_000) });
    expect(countUnreadNotifications(db, "owner_1", at(2 * HOUR + 2_000))).toBe(1);
  });

  it("a dismissal of a notice back from a snooze marks it read, so Undo brings it back read", () => {
    const { notificationId } = record();
    markNotificationsRead(db, { principalId: "owner_1", at: T0 });
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(HOUR), at: at(0) });
    dismissNotification(db, { principalId: "owner_1", notificationId, at: at(HOUR + 1_000) });
    restoreNotification(db, { principalId: "owner_1", notificationId, at: at(HOUR + 2_000) });
    expect(countUnreadNotifications(db, "owner_1", at(HOUR + 3_000))).toBe(0);
  });

  it("belongs to its principal, and a dismissed notice cannot be snoozed", () => {
    const mine = record().notificationId;
    expect(snoozeNotification(db, { principalId: "owner_2", notificationId: mine, until: at(HOUR), at: at(0) })).toBe(false);
    dismissNotification(db, { principalId: "owner_1", notificationId: mine, at: T0 });
    expect(snoozeNotification(db, { principalId: "owner_1", notificationId: mine, until: at(HOUR), at: at(0) })).toBe(false);
  });

  it("is never the notice the cap evicts while it is snoozed", () => {
    const { notificationId } = record();
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: "2099-01-01T00:00:00.000Z" as Instant, at: T0 });
    for (let index = 0; index < MAX_NOTIFICATIONS + 5; index += 1) record();
    expect(listSnoozedNotifications(db, "owner_1").map((notice) => notice.noticeId)).toEqual([notificationId]);
  });
});

describe("quieting a kind of notice", () => {
  const T0 = "2026-09-24T09:00:00.000Z" as Instant;

  /** The suppression made from this notice, failing the test when there is none. */
  function quiet(notificationId: string, suppressionId: string) {
    const outcome = suppressNoticeKind(db, { principalId: "owner_1", notificationId, suppressionId, at: T0 });
    if (typeof outcome === "string") throw new Error(`expected a suppression, got ${outcome}`);
    return outcome.suppression;
  }

  it("writes later notices of the same kind read, so they are listed but not counted", () => {
    const first = record().notificationId;
    const suppression = quiet(first, "nsp_1");
    expect(suppression).toMatchObject({ suppressionId: "nsp_1", sourceKind: "background", category: "result", severity: "success" });
    expect(suppression.scope).toBeUndefined();
    expect(suppression.scopeLabel).toBeUndefined();
    expect(suppression.example).toBe("Việc nền đã xong");

    const later = record();
    expect(later.suppressed).toBe(true);
    expect(getNotification(db, "owner_1", later.notificationId)?.notice.readAt).toBeDefined();
    // The notice it was made from is left as it was: quieting is about what comes next.
    expect(getNotification(db, "owner_1", first)?.notice.readAt).toBeUndefined();
    expect(countUnreadNotifications(db, "owner_1")).toBe(1);
  });

  it("never quiets a different severity, and scopes a package to that package rather than every update", () => {
    const success = record().notificationId;
    quiet(success, "nsp_1");
    expect(record({ severity: "error" }).suppressed).toBe(false);

    const update = record({
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật: demo",
      subject: { kind: "package", packageId: "demo", version: "2.0.0" },
    }).notificationId;
    const scoped = quiet(update, "nsp_2");
    expect(scoped.scope).toBe("package:demo");
    expect(scoped.scopeLabel).toBe("demo");
    const packageUpdate = { sourceKind: "package", category: "update", severity: "info" } as const;
    expect(record({ ...packageUpdate, subject: { kind: "package", packageId: "demo", version: "3.0.0" } }).suppressed).toBe(true);
    expect(record({ ...packageUpdate, subject: { kind: "package", packageId: "other", version: "1.0.1" } }).suppressed).toBe(false);
  });

  it("is per principal, idempotent, and reversible", () => {
    const first = record().notificationId;
    const once = quiet(first, "nsp_1");
    const twice = quiet(first, "nsp_2");
    expect(twice.suppressionId).toBe(once.suppressionId);
    expect(listNoticeSuppressions(db, "owner_1")).toHaveLength(1);

    // Another principal's notice of the same kind is untouched, and they cannot remove this one's suppression.
    expect(record({ principalId: "owner_2" }).suppressed).toBe(false);
    expect(suppressNoticeKind(db, { principalId: "owner_2", notificationId: first, suppressionId: "nsp_3", at: T0 })).toBe("not-found");
    expect(removeNoticeSuppression(db, { principalId: "owner_2", suppressionId: "nsp_1" })).toBe(false);

    expect(removeNoticeSuppression(db, { principalId: "owner_1", suppressionId: "nsp_1" })).toBe(true);
    expect(record().suppressed).toBe(false);
    expect(findNoticeSuppression(db, "owner_1", { sourceKind: "background", category: "result", severity: "success" })).toBeUndefined();
  });

  describe("automations and signal sources", () => {
    const warning = { sourceKind: "automation", category: "alert", severity: "warning" } as const;
    const started = { sourceKind: "automation", category: "message", severity: "info" } as const;
    const automation = (intentId: string, label: string, taskId?: string) =>
      ({ kind: "automation", intentId, label, conversationId: "conv_1", ...(taskId === undefined ? {} : { taskId }) }) as const;
    const repository = (name: string) => ({ kind: "signal-source", sourceKey: `github:${name}`, label: name, conversationId: "conv_1" }) as const;

    it("quieting one automation leaves another automation's warnings and every reminder as loud as before", () => {
      const a = record({ ...warning, title: "Việc tự động đang chờ", subject: automation("int_a", "Dọn repo A", "task_1") }).notificationId;
      const suppression = quiet(a, "nsp_a");
      expect(suppression).toMatchObject({ scope: "automation:int_a", scopeLabel: "Dọn repo A" });

      expect(record({ ...warning, subject: automation("int_a", "Dọn repo A", "task_2") }).suppressed).toBe(true);
      expect(record({ ...warning, subject: automation("int_b", "Báo cáo tuần", "task_3") }).suppressed).toBe(false);
      // A reminder is an automation message with no automation scope: nothing quieted above reaches it.
      expect(record({ ...started, title: "Họp lúc 3 giờ", subject: { kind: "conversation", conversationId: "conv_1" } }).suppressed).toBe(false);
      expect(record({ ...started, title: "Họp lúc 3 giờ" }).suppressed).toBe(false);
    });

    it("quieting that an automation started never quiets its own reminders", () => {
      const run = record({ ...started, title: "Dọn repo A", subject: automation("int_a", "Dọn repo A", "task_1") }).notificationId;
      quiet(run, "nsp_a");
      expect(record({ ...started, title: "Dọn repo A", subject: { kind: "conversation", conversationId: "conv_1" } }).suppressed).toBe(false);
    });

    it("quieting one repository's polling failures leaves another repository's as loud as before", () => {
      const x = record({ ...warning, title: "Chưa theo dõi được acme/x", subject: repository("acme/x") }).notificationId;
      expect(quiet(x, "nsp_x")).toMatchObject({ scope: "source:github:acme/x", scopeLabel: "acme/x" });
      expect(record({ ...warning, subject: repository("acme/x") }).suppressed).toBe(true);
      expect(record({ ...warning, subject: repository("acme/y") }).suppressed).toBe(false);
    });

    it("refuses to quiet an automation or system notice that names nothing narrower than its source, and stores nothing", () => {
      const reminder = record({ ...started, title: "Họp lúc 3 giờ", subject: { kind: "conversation", conversationId: "conv_1" } }).notificationId;
      const delegated = record({ ...started, title: "Việc một node khác giao" }).notificationId;
      const expiry = record({ sourceKind: "system", category: "alert", severity: "warning", title: "Sắp hết hạn" }).notificationId;
      for (const notificationId of [reminder, delegated, expiry]) {
        expect(suppressNoticeKind(db, { principalId: "owner_1", notificationId, suppressionId: `nsp_${notificationId}`, at: T0 })).toBe("too-broad");
      }
      expect(listNoticeSuppressions(db, "owner_1")).toEqual([]);
    });

    it("never scopes another node's automation notice to that node alone, so its reminders cannot be quieted with it", () => {
      const remoteReminder = record({ ...started, title: "Họp lúc 3 giờ", originNodeId: "node_b" }).notificationId;
      expect(suppressNoticeKind(db, { principalId: "owner_1", notificationId: remoteReminder, suppressionId: "nsp_r", at: T0 })).toBe("too-broad");
      // Its automation still scopes it, and another node's background work is still scoped to that node.
      const remoteRun = record({ ...started, originNodeId: "node_b", subject: automation("int_c", "Sao lưu", "task_9") }).notificationId;
      expect(quiet(remoteRun, "nsp_c").scope).toBe("automation:int_c");
      const remoteWork = record({ originNodeId: "node_b" }).notificationId;
      expect(quiet(remoteWork, "nsp_w").scope).toBe("peer:node_b");
    });

    it("bounds and redacts a label rather than losing the notice for it", () => {
      // An automation's summary may be longer than a label, and a label is shown as-is in the list of quieted kinds.
      // Ordinary words, so the length is what bounds it: one unbroken run of 32+ letters is secret-shaped and redacted.
      const long = `Dọn   repo\n${"và sửa lỗi ".repeat(30)}`;
      const { notificationId, created } = record({ ...warning, subject: automation("int_long", long) });
      expect(created).toBe(true);
      const subject = getNotification(db, "owner_1", notificationId)?.notice.subject;
      const label = subject?.kind === "automation" ? subject.label : "";
      expect(label.length).toBe(120);
      expect(label.startsWith("Dọn repo và sửa lỗi")).toBe(true);
      expect(label.endsWith("…")).toBe(true);
      expect(quiet(notificationId, "nsp_long").scopeLabel).toBe(label);

      const secret = record({ ...warning, subject: repository(`acme/x ghp_${"b".repeat(36)}`) }).notificationId;
      const stored = getNotification(db, "owner_1", secret)?.notice.subject;
      expect(stored?.kind === "signal-source" ? stored.label : "").toBe("acme/x [redacted]");
    });
  });
});
