import type { ChildProcess } from "node:child_process";

import type { Instant, TaskId } from "@clarkcant/contracts";
import { acquireLease, releaseLease, runDispatchedTask, type ConductorDeps } from "@clarkcant/core";
import { getTask } from "@clarkcant/storage";

import { containingRoot, ownedResources } from "./preflight.ts";
import { runWorkerProcess, type WorkerProcessResult } from "./worker-process.ts";

/**
 * The dispatch vertical slice.
 *
 * The conductor decides a task is ready to run and hands it here through `ConductorDeps.runTask`.
 * This is the thing that was missing: a worker actually loading the capability and doing the work,
 * rather than the task sitting in `dispatched` forever with nothing behind it.
 *
 * One run is: a lease on the capability so two runs of the same capability on this node cannot
 * stomp on each other, a worker process bounded by a deadline and an output ceiling, confinement of
 * the roots it may touch to what this node owns, and the resulting evidence settling the task
 * through the same state machine every other path uses — success only through verification.
 *
 * Concurrency is bounded. A node with `maxConcurrent` workers already running queues the rest rather
 * than fork-bombing itself the moment three tasks dispatch in the same second.
 */

export interface TaskDispatcherDeps {
  conductor: ConductorDeps;
  /** The roots granted to the worker for this run, read fresh at dispatch time. */
  projectRoots: () => readonly string[];
  /**
   * Every folder this node owns — workspace roots, the node's own data directory, and the directory the
   * operator launched it from. `projectRoots` is checked against this set before a worker ever starts:
   * a root that is not owned is refused rather than handed to a child process, the same containment
   * rule the guarded command path applies. Kept separate from `projectRoots` so the two can disagree in
   * a test, which is the only way "refused" is distinguishable from "trivially true".
   */
  ownedRoots: () => readonly string[];
  /** Reported once a run settles, so the conversation can say what happened without the caller asking. */
  onSettled: (input: {
    taskId: string;
    conversationId: string;
    outcome: "succeeded" | "failed" | "uncertain" | "cancelled";
    message: string;
  }) => void;
  at?: () => Instant;
  /** Injected so a test can substitute a fake worker without spawning a real process. */
  runWorker?: (options: Parameters<typeof runWorkerProcess>[0]) => Promise<WorkerProcessResult>;
  maxConcurrent?: number;
  /** Ceiling passed to the worker process. Defaults to `runWorkerProcess`'s own default. */
  timeoutMs?: number;
  /** How long a lease on a capability is held before it is reclaimable. */
  leaseTtlMs?: number;
}

export interface TaskDispatcher {
  /** Queue one task for execution, honouring the concurrency cap. Never throws: failures settle the task instead. */
  dispatch(input: { taskId: string; capabilityRef: string; executionNodeId: string }): void;
  /** Kills every worker currently running, and drops anything still queued. Returns how many were stopped. */
  stopAll(): number;
  runningCount(): number;
  queuedCount(): number;
}

interface QueuedRun {
  taskId: string;
  capabilityRef: string;
  executionNodeId: string;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/**
 * `runDispatchedTask` only knows five evidence kinds. A worker tool can prove things this narrower
 * set does not name — a screenshot, a log excerpt — and those are still real evidence, so they are
 * folded into the closest of the five rather than dropped; `absent` narrows to the same bucket the
 * task-service uses for "nothing was demonstrated".
 */
function narrowEvidenceKind(
  kind: string,
): "exit-status" | "file-diff" | "api-receipt" | "read-after-write" | "test-output" {
  switch (kind) {
    case "file-diff":
    case "api-receipt":
    case "read-after-write":
    case "test-output":
      return kind;
    default:
      return "exit-status";
  }
}

/**
 * Build the dispatcher for one node.
 *
 * A closure rather than a class, matching every other seam in this app: the state it owns — the
 * queue and the live children — has no reason to be reachable from outside the functions below.
 */
export function createTaskDispatcher(deps: TaskDispatcherDeps): TaskDispatcher {
  const at = deps.at ?? ((): Instant => new Date().toISOString() as Instant);
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const runWorker = deps.runWorker ?? runWorkerProcess;

  const queue: QueuedRun[] = [];
  const liveChildren = new Map<string, ChildProcess>();
  let running = 0;

  const pump = (): void => {
    while (running < maxConcurrent) {
      const next = queue.shift();
      if (next === undefined) return;
      running += 1;
      void runOne(next).finally(() => {
        running -= 1;
        pump();
      });
    }
  };

  async function runOne(job: QueuedRun): Promise<void> {
    const task = getTask(deps.conductor.db, job.taskId);
    if (task === undefined) return;

    const runId = deps.conductor.newId("run");
    const lease = acquireLease(
      { db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId },
      {
        resourceNodeId: job.executionNodeId,
        resourceId: job.capabilityRef,
        resourceKind: "capability",
        holderTaskId: job.taskId as TaskId,
        ttlMs: leaseTtlMs,
      },
    );

    if (!lease.ok) {
      // A busy capability still moves the task through the ordinary state machine rather than being
      // reported out of band: `collectEvidence` returning a not-verified summary is exactly the "the
      // run produced nothing" case that machine already knows how to fail, and the refusal reason is
      // reported to the conversation with the words this dispatcher actually used, not the generic
      // gate message.
      const held = lease.code === "LEASE_HELD" ? `held by another run until ${lease.expiresAt}` : lease.message;
      const refusal = `capability ${job.capabilityRef} is busy on this node (${held}); the task was not run and can be retried`;
      const outcome = await runDispatchedTask(deps.conductor, {
        taskId: job.taskId,
        collectEvidence: async () => ({ kind: "exit-status", summary: refusal, verified: false }),
      });
      settle(job, outcome.outcome, refusal);
      return;
    }

    const roots = [...deps.projectRoots()];
    const owned = ownedResources(deps.ownedRoots());
    const outsideOwnership = roots.find((root) => containingRoot(owned, root) === undefined);
    if (outsideOwnership !== undefined) {
      releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
      const refusal = `refused: ${outsideOwnership} is not a root this node owns, so the worker was never started`;
      const outcome = await runDispatchedTask(deps.conductor, {
        taskId: job.taskId,
        collectEvidence: async () => ({ kind: "exit-status", summary: refusal, verified: false }),
      });
      settle(job, outcome.outcome, refusal);
      return;
    }

    try {
      const result = await runWorker({
        nodeId: job.executionNodeId,
        brief: {
          runId,
          taskId: job.taskId,
          taskRevision: task.revision,
          leaseEpoch: lease.lease.epoch,
          goal: task.goal,
          projectRoots: roots,
          allowedCapabilityRefs: [job.capabilityRef],
        },
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        onChild: (child) => {
          liveChildren.set(runId, child);
        },
      });

      const outcome = await runDispatchedTask(deps.conductor, {
        taskId: job.taskId,
        collectEvidence: async () => {
          // The primary piece of evidence is what settles the task; a worker that produced several
          // reports the first, because that is the one `runDispatchedTask`'s single-evidence contract
          // can carry today. Every piece is still on the run record itself for anyone reading it back.
          const first = result.record.evidence[0];
          if (first === undefined) return undefined;
          return { kind: narrowEvidenceKind(first.kind), summary: first.summary, verified: first.verdict === "verified" };
        },
      });

      settle(job, outcome.outcome, outcome.message);
    } catch (cause) {
      settle(job, "failed", `the worker could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      liveChildren.delete(runId);
      releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
    }
  }

  function settle(
    job: QueuedRun,
    outcome: "succeeded" | "failed" | "uncertain" | "cancelled",
    message: string,
  ): void {
    const task = getTask(deps.conductor.db, job.taskId);
    if (task === undefined) return;
    deps.onSettled({ taskId: job.taskId, conversationId: task.conversationId, outcome, message });
  }

  return {
    dispatch(input) {
      queue.push({ taskId: input.taskId, capabilityRef: input.capabilityRef, executionNodeId: input.executionNodeId });
      pump();
    },
    stopAll() {
      const stopped = liveChildren.size;
      for (const child of liveChildren.values()) child.kill("SIGKILL");
      liveChildren.clear();
      queue.length = 0;
      return stopped;
    },
    runningCount: () => running,
    queuedCount: () => queue.length,
  };
}
