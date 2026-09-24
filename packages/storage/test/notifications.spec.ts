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

  it("redacts secret-shaped text and bounds the length before anything is stored", () => {
    record({ title: "Lỗi với Bearer abcdefghijklmnop1234", body: `${"x ".repeat(400)}token_supersecretvalue123` });
    const [notice] = listNotifications(db, "owner_1");
    expect(notice?.title).not.toContain("abcdefghijklmnop1234");
    expect(notice?.title).toContain("[redacted]");
    expect(notice?.body?.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(notice)).not.toContain("supersecretvalue");
  });

  it("keeps at most the bound, dropping the oldest", () => {
    for (let index = 0; index < MAX_NOTIFICATIONS + 5; index += 1) record();
    const notices = listNotifications(db, "owner_1", MAX_NOTIFICATIONS + 50);
    expect(notices).toHaveLength(MAX_NOTIFICATIONS);
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
});
