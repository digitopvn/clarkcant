import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import {
  MAX_NOTIFICATIONS,
  countUnreadNotifications,
  dismissNotification,
  listNotifications,
  markNotificationsRead,
  recordNotification,
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
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function record(overrides: Partial<RecordNotificationInput> = {}): { notificationId: string; created: boolean } {
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

    expect(first).toEqual({ notificationId: "ntf_first", created: true });
    expect(second).toEqual({ notificationId: "ntf_first", created: false });
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
    expect(first).toEqual({ notificationId: "ntf_long_1", created: true });
    expect(second).toEqual({ notificationId: "ntf_long_1", created: false });
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
    expect(again).toEqual({ notificationId: "ntf_persistent", created: false });
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
    expect(backdated).toEqual({ notificationId: "ntf_backdated", created: true });
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
    let first: { notificationId: string; created: boolean } | undefined;
    let newest: { notificationId: string; created: boolean } | undefined;
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
