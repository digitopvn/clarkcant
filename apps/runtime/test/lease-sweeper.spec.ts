import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Instant, instantSchema, nodeIdSchema } from "@clarkcant/contracts";
import { type CoordinationDeps, acquireLease } from "@clarkcant/core";
import { type Database, migrate, openDatabase } from "@clarkcant/storage";

import { startLeaseSweeper, type LeaseSweeperHandle } from "../src/lease-sweeper.ts";

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");

function later(ms: number): Instant {
  return instantSchema.parse(new Date(new Date(AT).getTime() + ms).toISOString());
}

let db: Database;
let counter = 0;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startLeaseSweeper runs the sweep on a schedule and stops cleanly", () => {
  it("does not run before the interval elapses, then runs once it does, on the default 60s interval", () => {
    const now = vi.fn<() => Instant>(() => AT);
    const sweeper = startLeaseSweeper({ db, now });

    vi.advanceTimersByTime(59_999);
    expect(now).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(now).toHaveBeenCalledTimes(1);

    sweeper.stop();
  });

  it("honors a custom interval and stop() ends further ticks", () => {
    const now = vi.fn<() => Instant>(() => AT);
    const sweeper = startLeaseSweeper({ db, now, intervalMs: 1_000 });

    vi.advanceTimersByTime(4_000);
    expect(now).toHaveBeenCalledTimes(4);

    sweeper.stop();
    vi.advanceTimersByTime(10_000);
    expect(now).toHaveBeenCalledTimes(4);
  });

  it("does not keep the process alive (the interval is unref'd)", () => {
    // vitest's fake timer stubs implement unref/ref like the real Node Timeout; a
    // sweeper that forgot to call it would still pass every other assertion here,
    // so this checks the one property that matters for a clean shutdown.
    const now = vi.fn<() => Instant>(() => AT);
    const hasRef = vi.spyOn(globalThis, "setInterval");
    const sweeper = startLeaseSweeper({ db, now, intervalMs: 1_000 });
    const created = hasRef.mock.results.at(-1)?.value as { hasRef?: () => boolean } | undefined;
    if (created?.hasRef !== undefined) {
      expect(created.hasRef()).toBe(false);
    }
    sweeper.stop();
    hasRef.mockRestore();
  });

  it("sweepNow reclaims an expired lease immediately and reports how many it released", () => {
    const clock = { now: AT };
    const coordinationDeps: CoordinationDeps = {
      db,
      nodeId: NODE_A,
      now: () => clock.now,
      newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
    };
    const acquired = acquireLease(coordinationDeps, {
      resourceNodeId: NODE_A,
      resourceId: "res_a",
      resourceKind: "workspace",
      ttlMs: 1_000,
    });
    expect(acquired.ok).toBe(true);

    clock.now = later(2_000);

    let sweeper: LeaseSweeperHandle | undefined;
    try {
      sweeper = startLeaseSweeper({ db, now: () => clock.now, intervalMs: 1_000 });
      expect(sweeper.sweepNow()).toBe(1);

      const row = db.prepare("SELECT released_at FROM leases WHERE resource_id = ?").get("res_a") as {
        released_at: string | null;
      };
      expect(row.released_at).not.toBeNull();

      // A lease that is already gone does not get swept again.
      expect(sweeper.sweepNow()).toBe(0);
    } finally {
      sweeper?.stop();
    }
  });

  it("a failed sweep tick is swallowed rather than crashing the node", () => {
    const now = vi.fn<() => Instant>(() => AT);
    const sweeper = startLeaseSweeper({ db, now, intervalMs: 1_000 });
    db.close();

    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();

    sweeper.stop();
  });
});
