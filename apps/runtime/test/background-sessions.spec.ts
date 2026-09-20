import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { createBackgroundSessions } from "../src/background-sessions.ts";

const at = (iso: string): Instant => iso as Instant;

describe("the work running behind the conversation", () => {
  it("counts what is running and keeps what finished", () => {
    const sessions = createBackgroundSessions();
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

  it("keeps the work on the node, so it outlives the request that asked for it", () => {
    /*
     * "The desktop closes while jobs on the server are running" is the case this answers. The work is a record here,
     * not a subscription held by whoever asked, so the window that asked going away cannot stop it - and nothing in
     * this registry is reachable from a client at all, which is what makes that true rather than merely likely.
     */
    const sessions = createBackgroundSessions();
    const started = sessions.start({ sessionId: "w1", title: "đọc tài liệu", at: at("2026-09-19T01:00:00.000Z") });

    // The request that asked for this has been answered and is gone; the session is still running here.
    expect(sessions.running()).toBe(1);
    expect(sessions.list()[0]).toEqual(started);

    // And it ends because the node says so, not because a client stopped listening.
    expect(sessions.finish({ sessionId: "w1", status: "done", at: at("2026-09-19T01:10:00.000Z") })?.status).toBe("done");
  });
});
