import { beforeEach, describe, expect, it } from "vitest";

import { type Instant, instantSchema, nodeIdSchema } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";

import { acquireLease, mayActUnderLease, releaseLease, sweepExpiredLeases } from "../src/index.ts";

/**
 * Coverage for the gap `mayActUnderLease` closed only lazily: before this sweep
 * existed, a lease with nobody left to contend for its resource stayed "live" in
 * the `leases` table forever, even though its `expires_at` was long past. These
 * tests prove the sweep reclaims it proactively, and that the reclaim is the same
 * release `acquireLease`'s lazy path performs (a higher epoch on the next
 * acquire, and the old epoch fenced out by `mayActUnderLease`).
 */

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");

let counter = 0;

/** `clock.now` is mutable so a test can advance time past a lease's expiry without waiting. */
function makeDeps(clock: { now: Instant }) {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return {
    db,
    nodeId: NODE_A,
    now: () => clock.now,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

function later(ms: number): Instant {
  return instantSchema.parse(new Date(new Date(AT).getTime() + ms).toISOString());
}

let clock: { now: Instant };
let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  clock = { now: AT };
  deps = makeDeps(clock);
});

describe("sweepExpiredLeases reclaims dead leases without waiting for contention", () => {
  it("releases an expired lease and leaves a live one untouched", () => {
    const expiring = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "res_a",
      resourceKind: "workspace",
      ttlMs: 1_000,
    });
    const live = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "res_b",
      resourceKind: "workspace",
      ttlMs: 100_000,
    });
    expect(expiring.ok).toBe(true);
    expect(live.ok).toBe(true);

    clock.now = later(2_000);

    expect(sweepExpiredLeases(deps)).toBe(1);

    const expiringRow = deps.db
      .prepare("SELECT released_at FROM leases WHERE resource_id = ?")
      .get("res_a") as { released_at: string | null };
    expect(expiringRow.released_at).not.toBeNull();

    const liveRow = deps.db
      .prepare("SELECT released_at FROM leases WHERE resource_id = ?")
      .get("res_b") as { released_at: string | null };
    expect(liveRow.released_at).toBeNull();
  });

  it("returns 0 and changes nothing when no lease has expired", () => {
    acquireLease(deps, { resourceNodeId: NODE_A, resourceId: "res_c", resourceKind: "workspace", ttlMs: 60_000 });
    expect(sweepExpiredLeases(deps)).toBe(0);
  });

  it("does not re-release a lease that was already released explicitly", () => {
    const lease = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "res_d",
      resourceKind: "workspace",
      ttlMs: 1_000,
    });
    expect(lease.ok).toBe(true);
    if (lease.ok) expect(releaseLease(deps, lease.lease.leaseId)).toBe(true);

    clock.now = later(5_000);
    expect(sweepExpiredLeases(deps)).toBe(0);
  });

  it("a new acquire after sweeping gets a higher epoch, and mayActUnderLease fences the swept holder out", () => {
    const first = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "res_e",
      resourceKind: "workspace",
      ttlMs: 1_000,
    });
    expect(first.ok).toBe(true);
    const heldEpoch = first.ok ? first.lease.epoch : -1;

    clock.now = later(2_000);
    expect(sweepExpiredLeases(deps)).toBe(1);

    const second = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "res_e",
      resourceKind: "workspace",
      ttlMs: 60_000,
    });
    expect(second.ok).toBe(true);
    expect(second.ok && second.lease.epoch).toBe(heldEpoch + 1);

    const stale = mayActUnderLease(deps, { resourceNodeId: NODE_A, resourceId: "res_e", heldEpoch });
    expect(stale.allowed).toBe(false);
    expect(stale.allowed === false && stale.code).toBe("STALE_LEASE_EPOCH");

    const current = mayActUnderLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "res_e",
      heldEpoch: second.ok ? second.lease.epoch : -1,
    });
    expect(current.allowed).toBe(true);
  });
});
