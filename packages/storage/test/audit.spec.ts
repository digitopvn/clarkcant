import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { appendAuditEvent, listAuditEvents } from "../src/audit.ts";
import { openDatabase, type Database } from "../src/db.ts";
import { currentSchemaVersion, migrate } from "../src/migrate.ts";

/**
 * The audit trail.
 *
 * Two properties make it worth having: it survives the process that wrote it, and it says what happened without
 * becoming a second copy of everything else. The durability test reopens the same file rather than trusting the
 * connection that wrote the row — a trail that only exists in the process that produced it is not a trail.
 */
let dir: string;
let path: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-audit-"));
  path = join(dir, "node.sqlite");
  db = openDatabase({ path });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function append(overrides: Partial<Parameters<typeof appendAuditEvent>[1]> = {}): void {
  appendAuditEvent(db, {
    auditId: `audit_${Math.random().toString(36).slice(2, 8)}`,
    principalId: "owner_1",
    kind: "command",
    summary: "chạy `pnpm build` trong /work",
    outcome: "done",
    at: "2026-09-19T10:00:00.000Z" as Instant,
    ...overrides,
  });
}

describe("what is written down", () => {
  it("applies the migration that adds the table", () => {
    // 22: this branch's two migrations were renumbered when main took 18, and main's pairing migration then took
    // 21 rather than the 19 this branch already uses; migration 22 (backfilling `grantedCapabilities` onto a
    // pre-existing package generation) is the next one after that, and 23 records the lifecycle an uninstall
    // replaced; 24 adds the inbox's notices. The schema version is the count of migrations that have run.
    expect(currentSchemaVersion(db)).toBe(24);
  });

  it("reads back newest first, with the fields it was given", () => {
    append({ auditId: "audit_old", at: "2026-09-19T10:00:00.000Z" as Instant, outcome: "done" });
    append({ auditId: "audit_new", at: "2026-09-19T10:05:00.000Z" as Instant, outcome: "failed", ref: "run_9" });

    const events = listAuditEvents(db, "owner_1");
    expect(events.map((event) => event.auditId)).toEqual(["audit_new", "audit_old"]);
    expect(events[0]).toMatchObject({ outcome: "failed", ref: "run_9", kind: "command" });
  });

  it("survives the process that wrote it", () => {
    append({ auditId: "audit_1" });
    db.close();

    // The same file, a new connection: a trail that only lives in memory is not one.
    db = openDatabase({ path });
    migrate(db);
    expect(listAuditEvents(db, "owner_1").map((event) => event.auditId)).toEqual(["audit_1"]);
  });

  it("keeps principals apart", () => {
    append();
    expect(listAuditEvents(db, "someone_else")).toEqual([]);
  });

  it("bounds a summary rather than storing a document", () => {
    append({ summary: "x".repeat(900) });
    expect(listAuditEvents(db, "owner_1")[0]?.summary.length).toBe(500);
  });

  it("bounds the read as well, so a long trail cannot be asked for by accident", () => {
    for (let index = 0; index < 5; index += 1) append({ auditId: `audit_${index}` });
    expect(listAuditEvents(db, "owner_1", { limit: 2 })).toHaveLength(2);
    expect(listAuditEvents(db, "owner_1", { limit: 10_000 })).toHaveLength(5);
  });

  it("records every kind of effect the contract names", () => {
    for (const kind of ["command", "secret-use", "approval", "stop", "interaction"] as const) {
      append({ auditId: `audit_${kind}`, kind });
    }
    const kinds = listAuditEvents(db, "owner_1").map((event) => event.kind);
    expect(new Set(kinds)).toEqual(new Set(["command", "secret-use", "approval", "stop", "interaction"]));
  });
});
