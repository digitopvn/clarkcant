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
    expect(snoozeNotification(db, { principalId: "owner_1", notificationId: snoozed, until: at(HOUR) })).toBe(true);

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
  });

  it("is not marked read by 'mark all read' while it is snoozed, so it still comes back unread", () => {
    const { notificationId } = record();
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(HOUR) });
    expect(markNotificationsRead(db, { principalId: "owner_1", at: at(1_000) })).toBe(0);
    expect(countUnreadNotifications(db, "owner_1", at(HOUR + 1))).toBe(1);
  });

  it("brings a snoozed notice back early, unread, and answers truthfully when there is nothing to bring back", () => {
    const { notificationId } = record();
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: at(HOUR) });
    expect(unsnoozeNotification(db, { principalId: "owner_1", notificationId, at: at(60_000) })).toBe("unsnoozed");
    expect(listNotifications(db, "owner_1", 50, at(60_000)).map((notice) => notice.noticeId)).toEqual([notificationId]);
    expect(countUnreadNotifications(db, "owner_1", at(60_000))).toBe(1);
    expect(unsnoozeNotification(db, { principalId: "owner_1", notificationId, at: at(61_000) })).toBe("not-snoozed");
    expect(unsnoozeNotification(db, { principalId: "owner_2", notificationId, at: at(61_000) })).toBe("not-found");
  });

  it("belongs to its principal, and a dismissed notice cannot be snoozed", () => {
    const mine = record().notificationId;
    expect(snoozeNotification(db, { principalId: "owner_2", notificationId: mine, until: at(HOUR) })).toBe(false);
    dismissNotification(db, { principalId: "owner_1", notificationId: mine, at: T0 });
    expect(snoozeNotification(db, { principalId: "owner_1", notificationId: mine, until: at(HOUR) })).toBe(false);
  });

  it("is never the notice the cap evicts while it is snoozed", () => {
    const { notificationId } = record();
    snoozeNotification(db, { principalId: "owner_1", notificationId, until: "2099-01-01T00:00:00.000Z" as Instant });
    for (let index = 0; index < MAX_NOTIFICATIONS + 5; index += 1) record();
    expect(listSnoozedNotifications(db, "owner_1").map((notice) => notice.noticeId)).toEqual([notificationId]);
  });
});

describe("quieting a kind of notice", () => {
  const T0 = "2026-09-24T09:00:00.000Z" as Instant;

  it("writes later notices of the same kind read, so they are listed but not counted", () => {
    const first = record().notificationId;
    const suppression = suppressNoticeKind(db, { principalId: "owner_1", notificationId: first, suppressionId: "nsp_1", at: T0 });
    expect(suppression).toMatchObject({ suppressionId: "nsp_1", sourceKind: "background", category: "result", severity: "success" });
    expect(suppression?.scope).toBeUndefined();
    expect(suppression?.example).toBe("Việc nền đã xong");

    const quiet = record();
    expect(quiet.suppressed).toBe(true);
    expect(getNotification(db, "owner_1", quiet.notificationId)?.notice.readAt).toBeDefined();
    // The notice it was made from is left as it was: quieting is about what comes next.
    expect(getNotification(db, "owner_1", first)?.notice.readAt).toBeUndefined();
    expect(countUnreadNotifications(db, "owner_1")).toBe(1);
  });

  it("never quiets a different severity, and scopes a package to that package rather than every update", () => {
    const success = record().notificationId;
    suppressNoticeKind(db, { principalId: "owner_1", notificationId: success, suppressionId: "nsp_1", at: T0 });
    expect(record({ severity: "error" }).suppressed).toBe(false);

    const update = record({
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật: demo",
      subject: { kind: "package", packageId: "demo", version: "2.0.0" },
    }).notificationId;
    const scoped = suppressNoticeKind(db, { principalId: "owner_1", notificationId: update, suppressionId: "nsp_2", at: T0 });
    expect(scoped?.scope).toBe("package:demo");
    const packageUpdate = { sourceKind: "package", category: "update", severity: "info" } as const;
    expect(record({ ...packageUpdate, subject: { kind: "package", packageId: "demo", version: "3.0.0" } }).suppressed).toBe(true);
    expect(record({ ...packageUpdate, subject: { kind: "package", packageId: "other", version: "1.0.1" } }).suppressed).toBe(false);
  });

  it("is per principal, idempotent, and reversible", () => {
    const first = record().notificationId;
    const once = suppressNoticeKind(db, { principalId: "owner_1", notificationId: first, suppressionId: "nsp_1", at: T0 });
    const twice = suppressNoticeKind(db, { principalId: "owner_1", notificationId: first, suppressionId: "nsp_2", at: T0 });
    expect(twice?.suppressionId).toBe(once?.suppressionId);
    expect(listNoticeSuppressions(db, "owner_1")).toHaveLength(1);

    // Another principal's notice of the same kind is untouched, and they cannot remove this one's suppression.
    expect(record({ principalId: "owner_2" }).suppressed).toBe(false);
    expect(suppressNoticeKind(db, { principalId: "owner_2", notificationId: first, suppressionId: "nsp_3", at: T0 })).toBeUndefined();
    expect(removeNoticeSuppression(db, { principalId: "owner_2", suppressionId: "nsp_1" })).toBe(false);

    expect(removeNoticeSuppression(db, { principalId: "owner_1", suppressionId: "nsp_1" })).toBe(true);
    expect(record().suppressed).toBe(false);
    expect(findNoticeSuppression(db, "owner_1", { sourceKind: "background", category: "result", severity: "success" })).toBeUndefined();
  });
});
