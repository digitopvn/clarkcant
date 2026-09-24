import type { ChildProcess } from "node:child_process";

import type { CapabilityRef, Instant, TaskId } from "@clarkcant/contracts";
import {
  acquireLease,
  decideExecution,
  getCapability,
  readExecutionPolicy,
  recordEffectExecution,
  releaseLease,
  requestApproval,
  runDispatchedTask,
  type ConductorDeps,
} from "@clarkcant/core";
import { getTask } from "@clarkcant/storage";

import { containingRoot, ownedResources } from "./preflight.ts";
import { signalTree, stopTree } from "./process-tree.ts";
import { runWorkerProcess, type WorkerProcessResult } from "./worker-process.ts";
import type { WorkView } from "./work-supervisor.ts";

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
 * than fork-bombing itself the moment three tasks dispatch in the same second — and the queue is bounded
 * too, so a burst past it is refused in the conversation rather than held out of sight for ever.
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
  /**
   * The principal whose execution policy gates a dispatched task's effect.
   *
   * Optional, and its absence is deliberate rather than a default: a caller that does not supply it
   * gets the pre-existing behaviour (no gate here at all), which is what every test built before this
   * gate existed still exercises. A caller that wires this node for real (`bootstrap/runtime-bootstrap.ts`)
   * always supplies it, so the gate is live for every task this node actually dispatches to a user.
   */
  ownerPrincipalId?: () => string;
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
  /** How many tasks may wait for a worker. Past this a task is failed with a reason rather than queued. */
  maxQueued?: number;
  /** Where worker processes are written down, so a later boot can find one this process left behind. */
  journal?: {
    taskStarted(entry: { workId: string; conversationId: string; title: string; pid?: number }): void;
    taskEnded(workId: string, state: "done" | "failed" | "stopped"): void;
  };
  /** Ceiling passed to the worker process. Defaults to `runWorkerProcess`'s own default. */
  timeoutMs?: number;
  /** How long a lease on a capability is held before it is reclaimable. */
  leaseTtlMs?: number;
}

export interface TaskDispatcher {
  /** Queue one task for execution, honouring the concurrency cap. Never throws: failures settle the task instead. */
  dispatch(input: { taskId: string; capabilityRef: string; executionNodeId: string }): void;
  /**
   * Stops every worker currently running (the whole process group, SIGTERM then SIGKILL) and fails anything still
   * queued with a reason. Returns how many workers were stopped.
   */
  stopAll(): number;
  /** Stop one task's worker, or take it out of the queue. Answers whether there was one to stop. */
  stop(taskId: string): boolean;
  /** Running and queued tasks, as the node's work list shows them. */
  work(): WorkView[];
  runningCount(): number;
  queuedCount(): number;
  /** Refuse every dispatch from now on. Called once, when the node starts to close. */
  close(): void;
  /** SIGKILL every worker's group now, without the grace: for a node that exits before the grace runs out. */
  killAllNow(): void;
}

interface QueuedRun {
  taskId: string;
  capabilityRef: string;
  executionNodeId: string;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 10;
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

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
  const maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const runWorker = deps.runWorker ?? runWorkerProcess;

  const queue: (QueuedRun & { queuedAt: string })[] = [];
  const liveChildren = new Map<string, { taskId: string; child: ChildProcess }>();
  let closing = false;
  /** Tasks whose worker is running, by task id, with when it started — what `work()` lists. */
  const active = new Map<string, { startedAt: string }>();
  /** Tasks a person stopped, so the report says "stopped" rather than a worker failure nobody caused. */
  const stopping = new Set<string>();
  let running = 0;

  const journal = (write: (journal: NonNullable<TaskDispatcherDeps["journal"]>) => void): void => {
    if (deps.journal === undefined) return;
    try {
      write(deps.journal);
    } catch {
      // A journal that cannot write does not stop the task; it only means a later boot cannot report it.
    }
  };

  /** Fail a task that never got a worker, through the same state machine a finished run goes through. */
  const refuse = async (job: QueuedRun, refusal: string): Promise<void> => {
    const outcome = await runDispatchedTask(deps.conductor, {
      taskId: job.taskId,
      collectEvidence: async () => ({ kind: "exit-status", summary: refusal, verified: false }),
    });
    settle(job, outcome.outcome, refusal);
  };

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
    active.set(job.taskId, { startedAt: at() });
    try {
      await runAdmitted(job, task);
    } finally {
      active.delete(job.taskId);
      stopping.delete(job.taskId);
    }
  }

  async function runAdmitted(job: QueuedRun, task: NonNullable<ReturnType<typeof getTask>>): Promise<void> {
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

    /*
     * The execution-policy gate.
     *
     * A worker process has no database connection, so it cannot ask the same question the node's own
     * effects (a run_command, an install) already ask before they run — this is that question, asked
     * here, before a worker exists at all. A capability with no known `effectCategory` (not registered,
     * or `deps.ownerPrincipalId` not wired by this caller) is let through unchanged: this gate is additive
     * on top of the lease and root checks above, not a replacement admission system, and a descriptor
     * this node cannot read is not evidence of risk it can act on.
     */
    if (deps.ownerPrincipalId !== undefined) {
      const descriptor = getCapability(deps.conductor, job.capabilityRef as CapabilityRef, job.executionNodeId);
      if (descriptor !== undefined && descriptor.effectCategory !== "read") {
        const principalId = deps.ownerPrincipalId();
        const policy = readExecutionPolicy({ db: deps.conductor.db, now: at }, principalId);
        const operationDigest = `sha256:task-effect:${job.taskId}:${job.capabilityRef}`;
        const decision = decideExecution({
          policy,
          action: { kind: "effect", category: descriptor.effectCategory, operationDigest },
          // The task was created from the user's own request; dispatching the capability it needs is
          // not the agent deciding to do something on its own.
          explicitUserIntent: true,
        });

        const coordination = { db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId };
        if (decision.kind === "deny") {
          releaseLease(coordination, lease.lease.leaseId);
          const refusal = `refused: ${decision.reason}`;
          const outcome = await runDispatchedTask(deps.conductor, {
            taskId: job.taskId,
            collectEvidence: async () => ({ kind: "exit-status", summary: refusal, verified: false }),
          });
          settle(job, outcome.outcome, refusal);
          return;
        }
        if (decision.kind === "ask") {
          releaseLease(coordination, lease.lease.leaseId);
          const approval = requestApproval(coordination, {
            taskId: job.taskId,
            operationDigest,
            operationDescription: `run ${job.capabilityRef} for task ${job.taskId} (${descriptor.effectCategory})`,
            effectCategory: descriptor.effectCategory,
            ttlMs: DEFAULT_APPROVAL_TTL_MS,
          });
          const refusal = `capability ${job.capabilityRef} needs approval before it can run (${approval.approvalId}); the task was not run and can be retried once it is granted`;
          const outcome = await runDispatchedTask(deps.conductor, {
            taskId: job.taskId,
            collectEvidence: async () => ({ kind: "exit-status", summary: refusal, verified: false }),
          });
          settle(job, outcome.outcome, refusal);
          return;
        }
        recordEffectExecution(coordination, {
          principalId,
          mode: policy.mode,
          decision,
          category: descriptor.effectCategory,
          operationDigest,
          description: `dispatch ${job.capabilityRef} for task ${job.taskId}`,
        });
      }
    }

    /*
     * The wall-clock budget.
     *
     * `task.budget.maxWallClockMs` is a ceiling on this run, not on the queue wait before it, so the
     * timer is armed here rather than at admission. It does the same thing a person's `stop(taskId)`
     * does — `stopTree` on the live child — because that is the only way this dispatcher ever ends a
     * worker; the two are told apart at settle time by `wallClockExceeded` instead of `stopping`, so
     * the report says "the budget ran out" and never "you stopped this" for a thing nobody asked for.
     * Unref'd so an armed timer never keeps this process alive past the run it bounds, and cleared on
     * every settle path below so a run that finishes first does not leave a dangling timer that later
     * kills a since-reused `runId`.
     */
    const maxWallClockMs = task.budget?.maxWallClockMs;
    let wallClockExceeded = false;
    const wallClockTimer =
      maxWallClockMs === undefined
        ? undefined
        : setTimeout(() => {
            wallClockExceeded = true;
            const live = liveChildren.get(runId);
            if (live !== undefined) void stopTree(live.child);
          }, maxWallClockMs);
    wallClockTimer?.unref();
    const wallClockRefusal = (): string =>
      `the wall-clock budget of ${String(maxWallClockMs)} ms was exhausted before the worker finished; nothing it did was verified; raise the task's budget or re-run it`;

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
          liveChildren.set(runId, { taskId: job.taskId, child });
          journal((j) =>
            j.taskStarted({
              workId: job.taskId,
              conversationId: task.conversationId,
              title: task.goal,
              ...(child.pid === undefined ? {} : { pid: child.pid }),
            }),
          );
        },
      });

      if (wallClockExceeded) {
        journal((j) => j.taskEnded(job.taskId, "failed"));
        await refuse(job, wallClockRefusal());
        return;
      }

      if (stopping.has(job.taskId)) {
        journal((j) => j.taskEnded(job.taskId, "stopped"));
        const refusal = "stopped on request before the worker finished; nothing it did was verified";
        await refuse(job, refusal);
        return;
      }

      // Post-hoc token enforcement: the tokens are already spent by the time the worker's usage comes
      // back, so this is not a prevention, only an honest refusal to accept work that ran over budget —
      // reported as what it is rather than folded into a generic failure.
      const maxTokens = task.budget?.maxTokens;
      const tokensUsed = result.usage?.tokens;
      if (maxTokens !== undefined && tokensUsed !== undefined && tokensUsed > maxTokens) {
        journal((j) => j.taskEnded(job.taskId, "failed"));
        const refusal = `the token budget of ${String(maxTokens)} was exceeded (the worker used ${String(tokensUsed)}); the run already happened but is not accepted, and can be retried with a higher budget`;
        await refuse(job, refusal);
        return;
      }

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

      journal((j) => j.taskEnded(job.taskId, outcome.outcome === "succeeded" ? "done" : "failed"));
      settle(job, outcome.outcome, outcome.message);
    } catch (cause) {
      // A worker ended by a signal — a person's stop, the wall-clock budget, a crash — rejects rather than returning,
      // so this is the path most stops actually take. It settles the task through the state machine like every
      // other refusal: a message alone would leave the task `running` until the next boot called it uncertain.
      const stopped = stopping.has(job.taskId);
      journal((j) => j.taskEnded(job.taskId, wallClockExceeded ? "failed" : stopped ? "stopped" : "failed"));
      const refusal = wallClockExceeded
        ? wallClockRefusal()
        : stopped
          ? "stopped on request before the worker finished; nothing it did was verified"
          : `the worker could not run: ${cause instanceof Error ? cause.message : String(cause)}`;
      try {
        await refuse(job, refusal);
      } catch {
        settle(job, "failed", refusal);
      }
    } finally {
      if (wallClockTimer !== undefined) clearTimeout(wallClockTimer);
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
      const job = { taskId: input.taskId, capabilityRef: input.capabilityRef, executionNodeId: input.executionNodeId };
      if (closing) {
        void refuse(job, "this node is shutting down; the task was not run and can be retried once the node is back");
        return;
      }
      if (running >= maxConcurrent && queue.length >= maxQueued) {
        void refuse(
          job,
          `this node already has ${String(running)} task workers running and ${String(queue.length)} waiting, which is its limit; the task was not run and can be retried once one finishes`,
        );
        return;
      }
      queue.push({ ...job, queuedAt: at() });
      pump();
    },
    stopAll() {
      const stopped = liveChildren.size;
      for (const { taskId, child } of liveChildren.values()) {
        stopping.add(taskId);
        void stopTree(child);
      }
      // A queued task is failed with a reason rather than dropped: dropped, it would stay `dispatched` with nothing
      // behind it, which is the state this module exists to end.
      for (const job of queue.splice(0)) void refuse(job, "stopped before a worker was started for it");
      return stopped;
    },
    stop(taskId) {
      const queuedAt = queue.findIndex((job) => job.taskId === taskId);
      if (queuedAt >= 0) {
        const [job] = queue.splice(queuedAt, 1);
        if (job !== undefined) void refuse(job, "stopped before a worker was started for it");
        return true;
      }
      let found = false;
      for (const entry of liveChildren.values()) {
        if (entry.taskId !== taskId) continue;
        stopping.add(taskId);
        void stopTree(entry.child);
        found = true;
      }
      return found;
    },
    work() {
      const view = (taskId: string, state: "running" | "queued", startedAt: string, position?: number): WorkView => {
        const task = getTask(deps.conductor.db, taskId);
        return {
          workId: taskId,
          kind: "task",
          title: (task?.goal ?? taskId).slice(0, 200),
          state,
          ...(task === undefined ? {} : { conversationId: task.conversationId }),
          startedAt,
          ...(position === undefined ? {} : { position }),
        };
      };
      return [
        ...[...active.entries()].map(([taskId, entry]) => view(taskId, "running", entry.startedAt)),
        ...queue.map((job, index) => view(job.taskId, "queued", job.queuedAt, index + 1)),
      ];
    },
    runningCount: () => running,
    queuedCount: () => queue.length,
    close() {
      closing = true;
    },
    killAllNow() {
      for (const { child } of liveChildren.values()) {
        if (child.pid !== undefined) signalTree(child.pid, "SIGKILL", child);
      }
    },
  };
}
