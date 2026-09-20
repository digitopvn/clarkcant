import type { CapabilityReadiness, CapabilityRef, Instant, RunRecord } from "@clarkcant/contracts";
import type { WorkerBriefEnvelope } from "@clarkcant/app-worker";
import { getCapability, type RegistryDeps, updateReadiness } from "@clarkcant/core";

import { runWorkerProcess, type WorkerProcessResult } from "./worker-process.ts";

/**
 * Loading the project-work pack, and recording what actually happened.
 *
 * The pack's capabilities are registered the moment a node boots. They used to stay `loaded: false`
 * for the life of the process, with the reason "the pack is declared but no worker has loaded it on
 * this node" — a sentence that was true only because nothing ever tried. This is the thing that
 * tries: one worker session with the pack's capabilities granted, and then the readiness written
 * from the record that came back rather than from the intention behind the attempt.
 *
 * The record is read, not summarised away. A run that demonstrated nothing is not a successful load
 * with a caveat; it is a run that demonstrated nothing, and the reason the interface shows says so
 * in the run's own words. `authenticated` and `authorized` are deliberately left where they were: a
 * worker session authenticates nobody and authorises nothing, and reporting otherwise is exactly the
 * collapse — "installed" read as "usable" — that the readiness split exists to prevent.
 *
 * The probe holds no lease, and its brief says so with a zero. It touches nothing of the user's:
 * it demonstrates that the pack runs on this node, not what it can read.
 */

export interface PackLoadOptions {
  deps: RegistryDeps;
  /** Every capability the pack declares. Each is granted to the probe and written from the record. */
  refs: readonly CapabilityRef[];
  /** Runs one worker session. Defaults to a real process; a test substitutes it. */
  run?: (brief: WorkerBriefEnvelope) => Promise<WorkerProcessResult>;
  at?: () => Instant;
  /** `fake` proves the wiring without a provider. `real` needs a model configured. */
  adapter?: "fake" | "real";
  timeoutMs?: number;
}

export interface PackLoadResult {
  /** False when the worker could not run at all. Then the readiness is left alone and the reason says why. */
  ran: boolean;
  record: RunRecord | undefined;
  readiness: CapabilityReadiness;
  /** Capabilities the worker refused to register even though the brief granted them. */
  withheldCapabilities: string[];
}

/** The probe's goal, said plainly, because it ends up in the run record and in a reason the UI can show. */
const PROBE_GOAL = "prove the project-work pack loads and can run on this node";

/**
 * What a worker run says about the pack.
 *
 * Read from the evidence rather than from the fact that a process exited. The three answers that
 * matter are all there: `verified` means the pack ran and something was demonstrated; `contradicted`
 * means it ran and the result disagreed with the claim, which is worse than silence; `not-verified`
 * is the worker's own word for a run that settled without demonstrating anything.
 */
export function readinessFromRun(
  record: RunRecord,
  previous: CapabilityReadiness,
  at: Instant,
): CapabilityReadiness {
  const verified = record.evidence.filter((item) => item.verdict === "verified");
  const contradicted = record.evidence.filter((item) => item.verdict === "contradicted");
  const healthy = verified.length > 0 && contradicted.length === 0;

  // Loading is not a claim about health, so the two are written separately. `loaded` says a worker
  // really did load the pack; `healthy` says a run demonstrated something with it.
  const base: CapabilityReadiness = { ...previous, installed: true, loaded: true, healthy, lastProbeAt: at };

  const contradiction = contradicted[0];
  if (contradiction !== undefined) {
    return {
      ...base,
      blockedReason: bounded(`the pack loaded, but a run contradicted itself: ${contradiction.summary}`),
    };
  }
  if (verified.length === 0) {
    const settled = record.evidence.find((item) => item.verdict === "not-verified");
    return {
      ...base,
      blockedReason: bounded(`the pack loaded, but the run demonstrated nothing: ${settled?.summary ?? "no evidence was recorded"}`),
    };
  }
  // Healthy, and still not usable, because nothing has authorised this node to run the pack for a
  // task. Saying that here is the difference between "not usable" and "not usable, and here is what
  // is missing".
  if (!previous.authenticated || !previous.authorized) {
    return { ...base, blockedReason: "the pack loaded and ran on this node; it has not been authorized for a task yet" };
  }
  return { ...base, blockedReason: undefined };
}

/**
 * Run the probe and write what it found.
 *
 * A worker that could not run at all — an unreadable brief, an adapter that is not available — is
 * reported rather than thrown, because the node has to keep booting. What it must not do is leave
 * the readiness claiming a load that never happened, so the failure is written as the reason and
 * `installed`/`loaded` stay false.
 */
export async function loadProjectWorkPack(options: PackLoadOptions): Promise<PackLoadResult> {
  const at = options.at ?? ((): Instant => new Date().toISOString() as Instant);
  const stamp = at();
  const first = options.refs[0];
  if (first === undefined) {
    throw new Error("loading the pack needs at least one capability to load it for");
  }

  const brief: WorkerBriefEnvelope = {
    runId: `run_pack_probe_${stamp.replace(/[^0-9]/g, "")}`,
    taskId: `task_pack_probe_${first}`,
    taskRevision: 0,
    // A probe holds no lease. Zero is the honest value: it is not claiming one it does not have.
    leaseEpoch: 0,
    goal: PROBE_GOAL,
    // Nothing of the user's is touched. An empty list is the point, not an oversight.
    projectRoots: [],
    allowedCapabilityRefs: [...options.refs],
  };

  let result: WorkerProcessResult;
  try {
    const run =
      options.run ??
      ((envelope: WorkerBriefEnvelope): Promise<WorkerProcessResult> =>
        runWorkerProcess({
          nodeId: options.deps.nodeId,
          brief: envelope,
          ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }));
    result = await run(brief);
  } catch (cause) {
    const reason = bounded(`the pack could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    const previous = readinessOf(options, first);
    const readiness: CapabilityReadiness = { ...previous, installed: false, loaded: false, healthy: false, blockedReason: reason };
    for (const ref of options.refs) {
      updateReadiness(options.deps, { ref, executionNodeId: options.deps.nodeId, change: readiness, at: stamp });
    }
    return { ran: false, record: undefined, readiness, withheldCapabilities: [] };
  }

  const readiness = readinessFromRun(result.record, readinessOf(options, first), stamp);
  for (const ref of options.refs) {
    updateReadiness(options.deps, { ref, executionNodeId: options.deps.nodeId, change: readiness, at: stamp });
  }
  return { ran: true, record: result.record, readiness, withheldCapabilities: result.withheldCapabilities };
}

/** What the registry already says about this capability, so a probe adds to it instead of replacing it. */
function readinessOf(options: PackLoadOptions, ref: CapabilityRef): CapabilityReadiness {
  return (
    getCapability(options.deps, ref, options.deps.nodeId)?.readiness ?? {
      installed: false,
      loaded: false,
      authenticated: false,
      authorized: false,
      healthy: false,
    }
  );
}

/** `blockedReason` is capped at 500 characters by the contract, and a record's summary can be long. */
function bounded(reason: string): string {
  return reason.length <= 500 ? reason : `${reason.slice(0, 497)}...`;
}
