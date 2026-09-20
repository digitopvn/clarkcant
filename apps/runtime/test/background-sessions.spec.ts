import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import {
  FINISHED_RETENTION_MS,
  MAX_FINISHED_ENTRIES,
  createBackgroundSessions,
} from "../src/background-sessions.ts";

const at = (iso: string): Instant => iso as Instant;

describe("the work running behind the conversation", () => {
  it("counts what is running and keeps what finished", () => {
    // The clock is injected because what this file now keeps is a question about time: with the real one, the entries
    // below would be a day old and the retention would have dropped them before the assertions ran.
    const now = () => at("2026-09-19T01:02:30.000Z");
    const sessions = createBackgroundSessions({ now });
    sessions.start({ sessionId: "w1", title: "đọc log", at: at("2026-09-19T01:00:00.000Z") });
    sessions.start({ sessionId: "w2", title: "kiểm thử", at: at("2026-09-19T01:01:00.000Z") });
    expect(sessions.running()).toBe(2);

    sessions.finish({ sessionId: "w1", status: "done", at: at("2026-09-19T01:02:00.000Z") });
    expect(sessions.running()).toBe(1);
    // Kept rather than removed: a count that drops to zero the moment work finishes says nothing about whether it
    // succeeded, and a background failure is the thing a person needs to see without asking.
    expect(sessions.list()).toHaveLength(2);
    expect(sessions.list().find((entry) => entry.sessionId === "w1")).toMatchObject({
      status: "done",
      endedAt: at("2026-09-19T01:02:00.000Z"),
    });
  });

  it("drops a finished entry once nothing can be waiting for it", () => {
    const started = Date.parse("2026-09-19T01:00:00.000Z");
    let now = at(new Date(started).toISOString());
    const sessions = createBackgroundSessions({ now: () => now });
    sessions.start({ sessionId: "w1", title: "đọc log", at: now });
    sessions.finish({ sessionId: "w1", status: "done", at: now });
    expect(sessions.list()).toHaveLength(1);

    // Just inside the window: still there, which is the point of keeping it at all.
    now = at(new Date(started + FINISHED_RETENTION_MS - 1_000).toISOString());
    expect(sessions.list()).toHaveLength(1);

    // Past it: gone, so a header cannot go on saying something about work that ended ten minutes ago.
    now = at(new Date(started + FINISHED_RETENTION_MS + 1_000).toISOString());
    expect(sessions.list()).toEqual([]);
    expect(sessions.running()).toBe(0);
  });

  it("keeps a running entry however old it is, because that is what the count is for", () => {
    const started = Date.parse("2026-09-19T01:00:00.000Z");
    let now = at(new Date(started).toISOString());
    const sessions = createBackgroundSessions({ now: () => now });
    sessions.start({ sessionId: "w1", title: "chạy mãi", at: now });

    now = at(new Date(started + 8 * 60 * 60_000).toISOString());
    expect(sessions.running()).toBe(1);
    expect(sessions.list()).toHaveLength(1);
  });

  it("caps the finished list without dropping anything still running", () => {
    const started = Date.parse("2026-09-19T01:00:00.000Z");
    let elapsed = 0;
    const now = (): Instant => at(new Date(started + elapsed).toISOString());
    const sessions = createBackgroundSessions({ now });
    // The one that never ends, started first so it is the oldest entry in the store.
    sessions.start({ sessionId: "alive", title: "đang chạy", at: now() });

    for (let index = 0; index < MAX_FINISHED_ENTRIES + 3; index += 1) {
      elapsed += 1_000;
      const sessionId = `w${index}`;
      sessions.start({ sessionId, title: "việc", at: now() });
      sessions.finish({ sessionId, status: "done", at: now() });
    }

    const listed = sessions.list();
    expect(listed.filter((entry) => entry.status !== "running")).toHaveLength(MAX_FINISHED_ENTRIES);
    // The bound is on finished work only: a count that quietly forgot a running worker would be worse than a long list.
    expect(listed.some((entry) => entry.sessionId === "alive")).toBe(true);
    expect(sessions.running()).toBe(1);
  });

  it("lists the newest first, because that is the one being waited for", () => {
    const sessions = createBackgroundSessions();
    sessions.start({ sessionId: "old", title: "việc cũ", at: at("2026-09-19T01:00:00.000Z") });
    sessions.start({ sessionId: "new", title: "việc mới", at: at("2026-09-19T01:05:00.000Z") });
    expect(sessions.list().map((entry) => entry.sessionId)).toEqual(["new", "old"]);
  });

  it("names an untitled session rather than listing a blank", () => {
    const sessions = createBackgroundSessions();
    expect(sessions.start({ sessionId: "w1", title: "   ", at: at("2026-09-19T01:00:00.000Z") }).title).toBe("Việc nền");
  });

  it("says nothing about a session it never started", () => {
    // A finish for an unknown id is not an error to raise: the list is the node's memory of its own work, and a
    // report about work it never had is not something to invent an entry for.
    const sessions = createBackgroundSessions();
    expect(sessions.finish({ sessionId: "ghost", status: "failed", at: at("2026-09-19T01:00:00.000Z") })).toBeUndefined();
    expect(sessions.list()).toEqual([]);
  });
});
