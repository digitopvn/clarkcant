import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { dismissNotificationByKey, getNotification, recordNotification } from "../src/repositories/notifications.ts";
import { skipVersion, skippedVersionsOf, unskipVersion } from "../src/repositories/skipped-versions.ts";
import { claimWorkRunRetry, getWorkRun, recordWorkRun, releaseWorkRunRetry } from "../src/repositories/work-runs.ts";

/**
 * The rows behind a notice's operations: which versions a person skipped, which run was already tried again, and
 * taking one producer's notice out of the inbox once acting on it made it stale.
 */
const AT = "2026-09-30T01:00:00.000Z" as Instant;

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-notice-ops-storage-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("skipped versions", () => {
  const key = { principalId: "owner", subjectKind: "package" as const, name: "com.example.demo", version: "1.2.0" };

  it("remembers a skip once, per principal and per thing, and takes it back", () => {
    skipVersion(db, { ...key, at: AT });
    skipVersion(db, { ...key, at: AT });
    skipVersion(db, { ...key, subjectKind: "pi", at: AT });
    skipVersion(db, { ...key, principalId: "someone_else", version: "9.0.0", at: AT });
    expect(skippedVersionsOf(db, "owner", "package", "com.example.demo")).toEqual(["1.2.0"]);
    expect(skippedVersionsOf(db, "owner", "pi", "com.example.demo")).toEqual(["1.2.0"]);
    expect(skippedVersionsOf(db, "owner", "package", "com.example.other")).toEqual([]);

    expect(unskipVersion(db, key)).toBe(true);
    expect(unskipVersion(db, key)).toBe(false);
    expect(skippedVersionsOf(db, "owner", "package", "com.example.demo")).toEqual([]);
    expect(skippedVersionsOf(db, "someone_else", "package", "com.example.demo")).toEqual(["9.0.0"]);
  });
});

describe("a run tried again", () => {
  it("is claimed by exactly one retry, and a claim given back can be taken again", () => {
    recordWorkRun(db, {
      workId: "bg-1",
      nodeId: "node",
      kind: "background",
      conversationId: "conv",
      title: "đọc log",
      requestText: "đọc log",
      nodeBootId: "boot",
      state: "failed",
      effectful: false,
      attempt: 0,
      startedAt: AT,
    });
    expect(getWorkRun(db, "bg-1")?.retriedAs).toBeUndefined();
    expect(claimWorkRunRetry(db, "bg-1", "bg-2")).toBe(true);
    expect(claimWorkRunRetry(db, "bg-1", "bg-3")).toBe(false);
    expect(getWorkRun(db, "bg-1")?.retriedAs).toBe("bg-2");

    // Only the claim that was made is given back.
    releaseWorkRunRetry(db, "bg-1", "bg-3");
    expect(getWorkRun(db, "bg-1")?.retriedAs).toBe("bg-2");
    releaseWorkRunRetry(db, "bg-1", "bg-2");
    expect(getWorkRun(db, "bg-1")?.retriedAs).toBeUndefined();
    expect(claimWorkRunRetry(db, "bg-1", "bg-3")).toBe(true);
    expect(claimWorkRunRetry(db, "bg-missing", "bg-4")).toBe(false);
  });
});

describe("dismissing a notice by its producer's key", () => {
  it("dismisses the one notice with exactly that key, for that principal only", () => {
    const record = (notificationId: string, principalId: string, dedupKey: string) =>
      recordNotification(db, {
        notificationId,
        principalId,
        sourceKind: "background",
        category: "result",
        severity: "error",
        title: "Việc nền không xong",
        dedupKey,
        at: AT,
      });
    record("ntf_1", "owner", "background:bg-1");
    record("ntf_2", "owner", "background:bg-10");
    record("ntf_3", "someone_else", "background:bg-1");

    expect(dismissNotificationByKey(db, { principalId: "owner", dedupKey: "background:bg-1", at: AT })).toBe(true);
    expect(dismissNotificationByKey(db, { principalId: "owner", dedupKey: "background:bg-1", at: AT })).toBe(false);
    expect(getNotification(db, "owner", "ntf_1")?.dismissed).toBe(true);
    expect(getNotification(db, "owner", "ntf_2")?.dismissed).toBe(false);
    expect(getNotification(db, "someone_else", "ntf_3")?.dismissed).toBe(false);
  });
});
