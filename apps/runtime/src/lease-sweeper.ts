import type { Instant } from "@clarkcant/contracts";
import { type CoordinationDeps, sweepExpiredLeases } from "@clarkcant/core";
import type { Database } from "@clarkcant/storage";

/**
 * Background reclaim for expired resource leases.
 *
 * `mayActUnderLease` fences a stale holder out the moment anything asks, and
 * `acquireLease` reclaims a dead lease lazily the moment a new caller contends
 * for the same resource — but until either happens, a resource nobody is
 * currently contending for keeps reporting as live to a direct reader of the
 * `leases` table (a UI panel, a diagnostics view). This runs the same sweep on
 * a timer so "live" stays honest without needing new contention to trigger it.
 */

const DEFAULT_INTERVAL_MS = 60_000;

export interface LeaseSweeperInput {
  db: Database;
  /**
   * Not used by the sweep itself — expired leases are reclaimed across the whole
   * table, not scoped to one node — but `CoordinationDeps` carries it for every
   * coordination caller, so it is accepted here rather than reimplementing that
   * interface's shape. Defaults to the empty string when omitted.
   */
  nodeId?: string;
  now: () => Instant;
  /** Sweep interval in milliseconds. Defaults to 60_000. */
  intervalMs?: number;
}

export interface LeaseSweeperHandle {
  stop(): void;
  /** Run the sweep immediately, outside the timer, and return the count released. */
  sweepNow(): number;
}

export function startLeaseSweeper(input: LeaseSweeperInput): LeaseSweeperHandle {
  const deps: CoordinationDeps = {
    db: input.db,
    nodeId: input.nodeId ?? "",
    now: input.now,
    // sweepExpiredLeases never allocates an id; CoordinationDeps still requires
    // the field, so this stub only satisfies the type and is never invoked.
    newId: (prefix: string) => prefix,
  };

  const sweepNow = (): number => sweepExpiredLeases(deps);

  const timer = setInterval(() => {
    try {
      sweepNow();
    } catch {
      // Best effort: a failed sweep (e.g. the db closed mid-tick during shutdown)
      // is simply retried on the next tick rather than crashing the node.
    }
  }, input.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Never keeps the process alive on its own; a graceful shutdown should not
  // have to know this timer exists in order to exit.
  timer.unref();

  return {
    stop: () => clearInterval(timer),
    sweepNow,
  };
}
