import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import {
  WorkAbort,
  backgroundDeadlineFromEnv,
  createWorkSupervisor,
  normalizeBackgroundLimit,
  type WorkJournal,
  type WorkSource,
  type WorkView,
} from "../src/work-supervisor.ts";

const AT = "2026-09-24T07:00:00.000Z" as Instant;

/** A run that stays open until it is released or aborted, and says which happened. */
function heldRun(): {
  run: (signal: AbortSignal) => Promise<void>;
  release: () => void;
  aborted: () => unknown;
} {
  let release: () => void = () => undefined;
  let reason: unknown;
  return {
    run: (signal) =>
      new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => {
          reason = signal.reason;
          reject(signal.reason as Error);
        });
      }),
    release: () => release(),
    aborted: () => reason,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function submit(
  supervisor: ReturnType<typeof createWorkSupervisor>,
  conversationId: string,
  run: (signal: AbortSignal) => Promise<void>,
) {
  return supervisor.submitBackground({ conversationId, title: `work for ${conversationId}`, requestText: "do it", run });
}

describe("the work supervisor admits background work against a per-node limit", () => {
  it("runs up to the limit and queues the rest, then starts a queued run when a place frees", async () => {
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => 1 });
    const first = heldRun();
    const second = heldRun();

    const a = submit(supervisor, "conv-a", first.run);
    const b = submit(supervisor, "conv-a", second.run);

    expect(a).toMatchObject({ accepted: true, state: "running" });
    expect(b).toMatchObject({ accepted: true, state: "queued", position: 1 });
    expect(supervisor.background()).toMatchObject({ running: 1, queued: 1 });

    first.release();
    await flush();

    expect(supervisor.background()).toMatchObject({ running: 1, queued: 0 });
    second.release();
    await flush();
    expect(supervisor.background()).toMatchObject({ running: 0, queued: 0 });
  });

  it("keeps two runs in the same conversation apart, so stopping one leaves the other", async () => {
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => 3 });
    const first = heldRun();
    const second = heldRun();
    const a = submit(supervisor, "conv-a", first.run);
    const b = submit(supervisor, "conv-a", second.run);
    if (!a.accepted || !b.accepted) throw new Error("both should be admitted");

    expect(supervisor.cancel(a.workId)).toBe("stopped");
    await flush();

    expect(first.aborted()).toBeInstanceOf(WorkAbort);
    expect(second.aborted()).toBeUndefined();
    const states = Object.fromEntries(supervisor.list({ includeFinished: true }).map((view) => [view.workId, view.state]));
    expect(states[a.workId]).toBe("stopped");
    expect(states[b.workId]).toBe("running");
  });

  it("refuses in words when the queue is full, and names what is running", () => {
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => 1, queueLimit: 1 });
    submit(supervisor, "conv-a", heldRun().run);
    submit(supervisor, "conv-a", heldRun().run);

    const refused = submit(supervisor, "conv-a", heldRun().run);

    expect(refused.accepted).toBe(false);
    if (refused.accepted) return;
    expect(refused.reason).toBe("queue-full");
    expect(refused.message).toContain("chưa được bắt đầu");
    expect(refused.running).toHaveLength(1);
  });

  it("dequeues a queued run without ever starting it", async () => {
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => 1 });
    submit(supervisor, "conv-a", heldRun().run);
    let started = false;
    const queued = submit(supervisor, "conv-a", async () => {
      started = true;
    });
    if (!queued.accepted) throw new Error("should be queued");

    expect(supervisor.cancel(queued.workId)).toBe("dequeued");
    await flush();

    expect(started).toBe(false);
    expect(supervisor.cancel(queued.workId)).toBe("already-ended");
    expect(supervisor.cancel("no-such-work")).toBe("unknown");
  });

  it("aborts a run that overruns its deadline and records it as failed rather than stopped", async () => {
    const supervisor = createWorkSupervisor({ now: () => AT, deadlineMs: 10 });
    const held = heldRun();
    const started = submit(supervisor, "conv-a", held.run);
    if (!started.accepted) throw new Error("should run");

    await new Promise((resolve) => setTimeout(resolve, 40));
    await flush();

    expect((held.aborted() as WorkAbort).cause_).toBe("deadline");
    const view = supervisor.list({ includeFinished: true }).find((entry) => entry.workId === started.workId);
    expect(view?.state).toBe("failed");
  });

  it("drains on shutdown: open runs are aborted as interrupted and the wait is bounded", async () => {
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => 1 });
    const running = heldRun();
    const a = submit(supervisor, "conv-a", running.run);
    const b = submit(supervisor, "conv-b", heldRun().run);
    if (!a.accepted || !b.accepted) throw new Error("both admitted");

    await supervisor.drain(200);

    expect((running.aborted() as WorkAbort).cause_).toBe("shutdown");
    const states = Object.fromEntries(supervisor.list({ includeFinished: true }).map((view) => [view.workId, view.state]));
    expect(states[a.workId]).toBe("interrupted");
    expect(states[b.workId]).toBe("interrupted");
  });

  it("reads the limit at every admission, so a lower limit applies to the next request only", async () => {
    let limit = 3;
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => limit });
    submit(supervisor, "conv-a", heldRun().run);
    submit(supervisor, "conv-a", heldRun().run);
    limit = 1;

    const third = submit(supervisor, "conv-a", heldRun().run);

    expect(third).toMatchObject({ accepted: true, state: "queued" });
    expect(supervisor.background().running).toBe(2);
  });

  it("journals a run from queued to its end", async () => {
    const moves: string[] = [];
    const journal: WorkJournal = {
      opened: (entry) => moves.push(`opened:${entry.state}:${String(entry.effectful)}`),
      moved: (_workId, state) => moves.push(state),
    };
    const supervisor = createWorkSupervisor({ now: () => AT, journal });
    const held = heldRun();
    submit(supervisor, "conv-a", held.run);
    held.release();
    await flush();

    expect(moves).toEqual(["opened:queued:false", "running", "done"]);
  });
});

describe("the work supervisor lists and stops every kind of work through one path", () => {
  function source(kind: WorkSource["kind"], views: WorkView[], stopped: string[]): WorkSource {
    return {
      kind,
      list: () => views,
      cancel: (workId) => {
        if (!views.some((view) => view.workId === workId)) return false;
        stopped.push(workId);
        return true;
      },
    };
  }

  it("lists registered sources beside background work and stops through the source that owns the id", () => {
    const supervisor = createWorkSupervisor({ now: () => AT });
    const stopped: string[] = [];
    supervisor.addSource(
      source("command", [{ workId: "cmd-1", kind: "command", title: "sleep 60", state: "running", conversationId: "conv-a", startedAt: AT }], stopped),
    );
    submit(supervisor, "conv-b", heldRun().run);

    expect(supervisor.list().map((view) => view.kind).sort()).toEqual(["background", "command"]);
    expect(supervisor.list({ conversationId: "conv-a" }).map((view) => view.workId)).toEqual(["cmd-1"]);
    expect(supervisor.cancel("cmd-1")).toBe("stopped");
    expect(stopped).toEqual(["cmd-1"]);
  });

  it("stops everything a conversation started, and nothing another conversation did", () => {
    const supervisor = createWorkSupervisor({ now: () => AT });
    const stopped: string[] = [];
    supervisor.addSource(
      source(
        "command",
        [
          { workId: "cmd-a", kind: "command", title: "a", state: "running", conversationId: "conv-a", startedAt: AT },
          { workId: "cmd-b", kind: "command", title: "b", state: "running", conversationId: "conv-b", startedAt: AT },
        ],
        stopped,
      ),
    );
    const other = heldRun();
    submit(supervisor, "conv-a", heldRun().run);
    submit(supervisor, "conv-b", other.run);

    expect(supervisor.cancelConversation("conv-a")).toBe(2);
    expect(stopped).toEqual(["cmd-a"]);
    expect(other.aborted()).toBeUndefined();
  });

  it("unregisters a source", () => {
    const supervisor = createWorkSupervisor({ now: () => AT });
    const remove = supervisor.addSource(
      source("task", [{ workId: "task-1", kind: "task", title: "t", state: "running", startedAt: AT }], []),
    );
    remove();
    expect(supervisor.list()).toEqual([]);
  });
});

describe("the supervisor's settings", () => {
  it("accepts only the offered limits and falls back to the default for anything else", () => {
    expect(normalizeBackgroundLimit(1)).toBe(1);
    expect(normalizeBackgroundLimit(5)).toBe(5);
    expect(normalizeBackgroundLimit(4)).toBe(3);
    expect(normalizeBackgroundLimit("5")).toBe(3);
    expect(normalizeBackgroundLimit(undefined)).toBe(3);
  });

  it("reads the deadline from the environment, ignoring a value that is not a positive number", () => {
    expect(backgroundDeadlineFromEnv({ CC_BACKGROUND_MAX_MS: "60000" })).toBe(60_000);
    expect(backgroundDeadlineFromEnv({ CC_BACKGROUND_MAX_MS: "-1" })).toBe(20 * 60_000);
    expect(backgroundDeadlineFromEnv({ CC_BACKGROUND_MAX_MS: "soon" })).toBe(20 * 60_000);
    expect(backgroundDeadlineFromEnv({})).toBe(20 * 60_000);
  });
});
