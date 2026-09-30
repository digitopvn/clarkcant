import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import type {
  ApprovalId,
  CapabilityDescriptor,
  CapabilityRef,
  EffectCategory,
  Instant,
  Principal,
  TaskId,
} from "@clarkcant/contracts";
import { isTerminal } from "@clarkcant/contracts";
import {
  acquireLease,
  applyTaskEvent,
  approvalAuthorizes,
  cancelTask,
  decideApproval,
  decideExecution,
  executionIntentOf,
  getCapability,
  readExecutionPolicy,
  recordEffectExecution,
  releaseLease,
  requestApproval,
  runDispatchedTask,
  type CancelTaskResult,
  type ConductorDeps,
  type CoordinationDeps,
  type TaskServiceDeps,
  type PolicyDecision,
} from "@clarkcant/core";
import {
  ensureManagedWorktree,
  removeEmptyTaskFolder,
  removeManagedWorktree,
  workerCapabilitiesFor,
  type ManagedWorktree,
} from "@clarkcant/project-work";
import { getTask, oneRow, type Database } from "@clarkcant/storage";

import type { CommandToolDeps } from "./node-tools.ts";
import { containingRoot, ownedResources } from "./preflight.ts";
import { signalTree, stopTree } from "./process-tree.ts";
import { stopCommandsForTask } from "./run-command.ts";
import {
  BROWSER_CAPABILITY,
  type TaskBrowserAdmission,
  type TaskBrowserBroker,
  type TaskBrowserHost,
  browserGoalUrls,
  browserTaskApprovalText,
  browserTaskOrigins,
  createTaskBrowserBroker,
  hasUserinfo,
  sameSites,
  parseTaskBrowserRequest,
  taskProfileDir,
} from "./task-browser.ts";
import { createWorkerCommandBroker, parseWorkerCommandRequest } from "./worker-command-broker.ts";
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

/** A file a task's worker wrote: where, the SHA-256 (hex) of what it wrote, and its name in the folder it wrote it in. */
export interface TaskOutputFile {
  path: string;
  sha256: string;
  /** Relative to the root it was written under, with `/` between folders. */
  name: string;
}

/**
 * The files a worker reported writing that lie inside a folder the task was given to write, each named as it is in
 * that folder. One reported anywhere else is left out: the worker's report is not trusted to reach past the task's
 * folders, so nothing outside them is ever named, read or offered on from here.
 */
export function grantedOutputs(
  reported: readonly { path: string; sha256: string }[],
  roots: readonly string[],
): TaskOutputFile[] {
  return reported.flatMap((file) => {
    const name = outputName(file.path, roots);
    return name === undefined ? [] : [{ ...file, name }];
  });
}

/**
 * The name a written file has in the folder the task was given, so a person told about it recognises it without
 * learning where that folder is on this machine; nothing when no such folder holds it. Compared against each root as
 * given and as the filesystem resolves it, since the worker reports the resolved path.
 */
function outputName(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const candidates = [root];
    try {
      candidates.push(realpathSync.native(root));
    } catch {
      // A root that no longer resolves is compared as given.
    }
    for (const candidate of candidates) {
      const inside = relative(candidate, path);
      if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) return inside.split(sep).join("/");
    }
  }
  return undefined;
}

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
  /**
   * Reported once a run settles, so the conversation can say what happened without the caller asking.
   *
   * `outputs` are the files a worker that finished wrote, still where it wrote them: this is called before a task's
   * worktree is taken away, and anything that reads them has to do so before it returns.
   */
  onSettled: (input: {
    taskId: string;
    conversationId: string;
    outcome: "succeeded" | "failed" | "uncertain" | "cancelled";
    message: string;
    outputs?: readonly TaskOutputFile[];
  }) => void;
  /**
   * Reported when the gate parks a dispatched run waiting for approval, instead of settling it.
   *
   * Deliberately not folded into `onSettled`: the task has not reached any of `onSettled`'s four
   * outcomes yet (it is parked in `waiting_approval`, honestly, not failed), and reusing the same
   * `worker:<taskId>` dedup key a caller typically keys its notice on would silently swallow the
   * real settlement notice this run eventually produces once the approval is decided.
   */
  onWaitingApproval?: (input: {
    taskId: string;
    conversationId: string;
    approvalId: string;
    message: string;
    /** Only the effect waiting for a decision, without what the owner is told about deciding it. */
    effect: string;
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
  /**
   * Where the node keeps the worktrees it makes for tasks that change a repository, under its own data directory.
   * Absent means this node makes none, and a task that names a repository is refused rather than run in place.
   */
  worktreesDir?: () => string;
  /**
   * The command path's dependencies, when a worker may ask the host to run commands. Absent means the worker is given
   * no way to run one. Read at dispatch, like everything else here, so the policy in force is the one that decides.
   */
  commandDeps?: () => CommandToolDeps | undefined;
  /**
   * The managed browser, for a task dispatched to the browser capability. Absent means this node gives no task a
   * browser, and such a task is refused before its worker starts. The worker never drives it: its `use_browser` requests
   * come back over its channel and are answered by a broker built here for the run, which writes each consequential
   * click into the task's effect ledger.
   */
  browser?: () => TaskBrowserHost | undefined;
  /**
   * Reported when a finished task's worktree could not be taken away, which is what happens when it holds changes
   * nobody committed: those exist nowhere else, so they are kept and the person is told where.
   */
  onWorktreeKept?: (input: { taskId: string; conversationId: string; path: string; branch: string }) => void;
}

/** What a run may touch, decided from the task before a worker exists. */
type RootPlan =
  | { ok: true; read: string[]; write: string[]; repositories: string[]; scoped: boolean }
  | { ok: false; refusal: string };

export interface TaskDispatcher {
  /**
   * Queue one task for execution, honouring the concurrency cap. Never throws: failures settle the task
   * instead. Returns whether the task was actually queued - `false` when this node refused it outright
   * (closing, or already at its queue limit), which a caller must not report as accepted.
   */
  dispatch(input: {
    taskId: string;
    capabilityRef: string;
    executionNodeId: string;
    authorizedByApprovalId?: string;
  }): boolean;
  /**
   * Stops every worker currently running (the whole process group, SIGTERM then SIGKILL) and fails anything still
   * queued with a reason. Returns how many workers were stopped.
   */
  stopAll(): number;
  /**
   * Stop one task's worker, or take it out of the queue. Answers whether there was one to stop. A task admitted whose
   * worker has not started yet is marked, so the worker is stopped the moment it exists rather than left to run.
   */
  stop(taskId: string): boolean;
  /** Whether this dispatcher holds the task, queued or admitted: its stop is then this dispatcher's to confirm. */
  holds(taskId: string): boolean;
  /**
   * Whether a run of the task has yet to report: queued, or admitted and its settlement not written yet. Narrower than
   * `holds`, which stays true while the dispatcher tidies up after the report (taking worktrees away): a person's answer
   * to one of the task's effects is left to the run's report only while that report is still to come.
   */
  reportPending(taskId: string): boolean;
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
  /**
   * The approval a caller already decided for this exact digest, carried with the one re-dispatch it
   * unblocks. Set only by `decideTaskApprovalForNode` on a grant. It lets the gate below accept that one
   * decision without re-checking its deadline - the person decided this moments ago, and the queue is what
   * stands between the decision and the run it authorized, not a second waiting period - while still going
   * through every other check the gate applies, deny included.
   */
  authorizedByApprovalId?: string;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 10;
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

/** Plain-language Vietnamese for an effect category, used when a capability has no summary of its own. */
const EFFECT_CATEGORY_LABEL_VI: Record<EffectCategory, string> = {
  read: "đọc dữ liệu",
  "local-write": "thay đổi tệp trên máy này",
  "external-write": "gửi thay đổi ra ngoài máy này",
  destructive: "thực hiện một thao tác không thể hoàn tác",
  financial: "thực hiện một giao dịch tài chính",
  communication: "gửi một liên lạc (email, tin nhắn, ...)",
  "media-capture": "ghi âm hoặc quay hình",
};

/**
 * What a task needs approval for, in words a person reads rather than an internal reference.
 *
 * Never a capability ref, an approval id or a digest - those stay in the approval's own structured fields
 * (`taskId`, `operationDigest`) for the inbox and `read_inbox` to carry, not in the sentence a person or the
 * expiry sweep shows about it.
 */
function describeCapabilityEffectVi(descriptor: CapabilityDescriptor): string {
  const summary = descriptor.summary.trim();
  if (summary.length > 0) return summary;
  return `một thao tác ${EFFECT_CATEGORY_LABEL_VI[descriptor.effectCategory]}`;
}

/**
 * Whether a grant already covers this exact operation, so the gate may execute instead of asking again.
 *
 * Checked only when the policy itself said `ask` - this never overrides a `deny` (the caller checks that
 * first) and never widens what a grant was for (`operationDigest` is matched exactly, same as
 * `approvalAuthorizes` always required). Two sources, in order: the approval this specific queued job was
 * authorized with, accepted once without re-checking its own deadline; failing that, any other granted
 * approval for the same digest that is still within its deadline.
 */
function authorizingGrant(
  db: Database,
  coordination: CoordinationDeps,
  job: Pick<QueuedRun, "taskId" | "authorizedByApprovalId">,
  operationDigest: string,
): boolean {
  if (job.authorizedByApprovalId !== undefined) {
    const carried = oneRow<{ decision: string; operation_digest: string }>(
      db,
      `SELECT decision, operation_digest FROM approvals WHERE approval_id = ? AND task_id = ?`,
      job.authorizedByApprovalId,
      job.taskId,
    );
    if (carried?.decision === "granted" && carried.operation_digest === operationDigest) return true;
  }

  const priorGrant = oneRow<{ approval_id: string }>(
    db,
    `SELECT approval_id FROM approvals WHERE task_id = ? AND operation_digest = ? AND decision = 'granted'
       ORDER BY decided_at DESC LIMIT 1`,
    job.taskId,
    operationDigest,
  );
  if (priorGrant === undefined) return false;
  return approvalAuthorizes(coordination, priorGrant.approval_id as ApprovalId, operationDigest).authorized;
}

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
 * The one piece of a run's evidence that settles its task.
 *
 * `runDispatchedTask` carries a single piece, and which one is not a detail: a worker that edited a file, ran the tests
 * and saw them fail has a verified edit first and the failure after it, and reporting the first would call that run
 * done. So anything short of verified wins — a failed command, a refusal, a run stopped by its budget — and the first
 * of those is what the person is told. A run with nothing but verified steps is reported by its last one, which is
 * where it ended up: the pull request it opened rather than the file it read on the way. Every piece is still on the
 * run record for anyone reading it back.
 */
export function settlingEvidence<T extends { verdict: string }>(evidence: readonly T[]): T | undefined {
  return evidence.find((piece) => piece.verdict !== "verified") ?? evidence.at(-1);
}

/**
 * Build the dispatcher for one node.
 *
 * A closure rather than a class, matching every other seam in this app: the state it owns — the
 * queue and the live children — has no reason to be reachable from outside the functions below.
 */
/**
 * Ask a task to stop, and stop the worker this node runs for it.
 *
 * The one stop for a person on this node and for the peer that handed the task over. A task this dispatcher holds is
 * not confirmed stopped here: its worker is ended, and the run's own settle confirms the stop or says what it finished.
 */
export function stopTask(coordination: TaskServiceDeps, dispatcher: TaskDispatcher | undefined, taskId: string): CancelTaskResult {
  const held = dispatcher?.holds(taskId) === true;
  const outcome = cancelTask(coordination, taskId, { executingHere: held });
  if (outcome.ok && outcome.changed && held) dispatcher?.stop(taskId);
  return outcome;
}

export function createTaskDispatcher(deps: TaskDispatcherDeps): TaskDispatcher {
  const at = deps.at ?? ((): Instant => new Date().toISOString() as Instant);
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const runWorker = deps.runWorker ?? runWorkerProcess;

  const queue: (QueuedRun & { queuedAt: string })[] = [];
  const liveChildren = new Map<string, { taskId: string; child: ChildProcess }>();
  /** The browser each running browser task was given, so a stop refuses its next action as it ends its worker. */
  const browsers = new Map<string, TaskBrowserBroker>();
  /** Everything a stop ends besides the worker: the commands it asked for, and its browser. */
  const stopEffectsOf = (taskId: string): void => {
    stopCommandsForTask(taskId);
    browsers.get(taskId)?.stop();
  };
  let closing = false;
  /** Tasks whose worker is running, by task id, with when it started — what `work()` lists. */
  const active = new Map<string, { startedAt: string }>();
  /** Tasks a person stopped, so the report says "stopped" rather than a worker failure nobody caused. */
  const stopping = new Set<string>();
  /** Admitted tasks whose run has reported: the settlement is written, though the run may still be tidying up. */
  const reported = new Set<string>();
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
    if (task === undefined || isTerminal(task.state)) return;
    // Asked to stop while it waited for a slot: it never gets a worker, and the stop is confirmed by the refusal.
    if (task.state === "cancel_requested") {
      await refuse(job, "stopped before a worker was started for it");
      return;
    }
    reported.delete(job.taskId);
    active.set(job.taskId, { startedAt: at() });
    try {
      await runAdmitted(job, task);
    } finally {
      active.delete(job.taskId);
      reported.delete(job.taskId);
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

    /*
     * A browser task is let onto exactly the sites the tool that created it checked against the person's own words and
     * stored on the task (`origin.sites`), and nothing is read back out of the goal's text to widen them. It must have
     * been started by a person in the conversation, and its goal must still read as those same sites and carry no
     * disguised address: a task that fails any of this was not made by that tool, or was changed since, and is refused
     * before the policy is asked about it or a worker exists.
     */
    const browsing = job.capabilityRef === BROWSER_CAPABILITY;
    let browserSites: readonly string[] = [];
    if (browsing) {
      const origin = task.origin;
      const sites = origin?.kind === "interactive" ? (origin.sites ?? []) : [];
      const refusal =
        origin?.kind !== "interactive"
          ? "a browser task acts only for a person who asked for it in the conversation, and this one was not started that way"
          : sites.length === 0
            ? "the task carries no checked list of sites, so there is no site it could be allowed onto"
            : browserGoalUrls(task.goal).some(hasUserinfo) || !sameSites(browserTaskOrigins(task.goal), sites)
              ? "the sites the task was checked for are not the sites its goal names"
              : undefined;
      if (refusal !== undefined) {
        releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
        await refuse(job, `refused: ${refusal}; the worker was never started`);
        return;
      }
      browserSites = sites;
    }

    const plan = planRoots(task);
    if (!plan.ok) {
      releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
      await refuse(job, plan.refusal);
      return;
    }
    const intent = executionIntentOf(task.origin);
    /** How the gate below let a browser task on; undefined when it never decided, which a browser task is refused for. */
    let admission: TaskBrowserAdmission | undefined;

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
        const coordination = { db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId };

        /*
         * The policy decides first, every time. A stored grant is only ever a reason to skip *asking again*
         * for the same operation - it must never be a reason to skip a node-wide prohibition or a deny rule,
         * which is what asking `decideExecution` after looking for a grant used to do: a grant recorded
         * before the user tightened their policy would still wave a later run through it. Calling it here,
         * unconditionally, is what makes `deny` win over any grant this task ever collected.
         */
        const policyDecision: PolicyDecision = decideExecution({
          policy,
          action: { kind: "effect", category: descriptor.effectCategory, operationDigest },
          // Whose intent the task carries out, from why it was created: a person asking in the conversation, an
          // automation acting for the effects it was given, or the node's own work, which nobody asked for.
          intent,
        });

        if (policyDecision.kind === "deny") {
          releaseLease(coordination, lease.lease.leaseId);
          const refusal = `refused: ${policyDecision.reason}`;
          const outcome = await runDispatchedTask(deps.conductor, {
            taskId: job.taskId,
            collectEvidence: async () => ({ kind: "exit-status", summary: refusal, verified: false }),
          });
          settle(job, outcome.outcome, refusal);
          return;
        }

        /*
         * A re-dispatch of this same task after its approval was granted must not ask again — the person
         * already decided this exact operation, and asking a second time would be the node ignoring its own
         * record. Only consulted when the policy itself would otherwise ask: a grant authorizes skipping the
         * question, never skipping the `deny` above.
         *
         * Two sources of authorization, checked in order:
         *  1. the approval `decideTaskApprovalForNode` carried with this specific queued job, accepted once
         *     without re-checking its own deadline - the person decided this moments ago, and queue lag must
         *     not turn their grant back into a question;
         *  2. any other granted approval for this exact digest, still within its own deadline - the ordinary
         *     "a repeat run of a pinned widget" case.
         */
        const decision: PolicyDecision =
          policyDecision.kind === "ask" && authorizingGrant(deps.conductor.db, coordination, job, operationDigest)
            ? { kind: "execute", reason: "an approval already granted this exact operation", audit: true }
            : policyDecision;

        if (decision.kind === "ask") {
          releaseLease(coordination, lease.lease.leaseId);
          // A browser task is approved for its sites and its request, so the person is shown both.
          const effectDescription = browsing
            ? browserTaskApprovalText(browserSites, task.goal)
            : describeCapabilityEffectVi(descriptor);
          const parkedReason =
            `Cần được duyệt trước khi thực hiện: ${effectDescription}. Việc chưa chạy; ` +
            `nếu được duyệt việc sẽ tiếp tục, nếu bị từ chối hoặc hết hạn thì việc sẽ dừng hẳn.`;
          // Park first, and only request the approval - and tell the conversation - if the park itself
          // lands. A task that is no longer `running` when this gate reaches it (stopped, or parked by some
          // other path in the meantime) must not gain an approval nobody can ever decide for real: an
          // approval whose task is not `waiting_approval` is refused by `decideTaskApprovalForNode` before
          // it writes anything, which would leave this one permanently pending for nothing.
          const parked = applyTaskEvent(deps.conductor, job.taskId, "run.needs_approval", { parkedReason });
          if (!parked.ok) {
            // Stopped before it could park: this dispatcher holds it, so the stop is confirmed here, not left waiting.
            if (getTask(deps.conductor.db, job.taskId)?.state === "cancel_requested") {
              await refuse(job, "stopped before a worker was started for it");
            }
            return;
          }
          const approval = requestApproval(coordination, {
            taskId: job.taskId,
            operationDigest,
            operationDescription: effectDescription,
            effectCategory: descriptor.effectCategory,
            ttlMs: DEFAULT_APPROVAL_TTL_MS,
          });
          deps.onWaitingApproval?.({
            taskId: job.taskId,
            conversationId: task.conversationId,
            approvalId: approval.approvalId,
            message: parkedReason,
            effect: effectDescription,
          });
          return;
        }
        admission = policyDecision.kind === "execute" ? "policy" : "granted";
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
     * A repository is worked on in a worktree the node makes of it, never in place.
     *
     * Made after the gate, so a task the policy refuses or parks leaves nothing behind, and reused when it already
     * exists, so a task dispatched again after an approval continues from what it did.
     */
    const read = [...plan.read];
    const write = [...plan.write];
    const worktrees: ManagedWorktree[] = [];
    for (const repository of plan.repositories) {
      const made =
        deps.worktreesDir === undefined
          ? ({ ok: false, message: "this node keeps no place for task worktrees, so a repository cannot be worked on" } as const)
          : await ensureManagedWorktree({ repoPath: repository, worktreesDir: deps.worktreesDir(), taskId: job.taskId });
      if (!made.ok) {
        releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
        // The repositories before this one already have their worktree. None was worked in, so a clean one goes now
        // rather than at the next boot; the branch stays, with anything an earlier run of the task committed.
        await takeAwayWorktrees(job.taskId, task.conversationId, worktrees);
        await refuse(job, `refused: ${made.message}; the worker was never started`);
        return;
      }
      worktrees.push(made.worktree);
      read.push(made.worktree.path);
      write.push(made.worktree.path);
    }

    /*
     * A browser task gets a browser and nothing that runs commands: its checked sites are the whole of what it may act
     * on, and the broker built here for this run is where each of its clicks is decided and written down.
     */
    let openedBrowser: TaskBrowserBroker | undefined;
    if (browsing) {
      const host = deps.browser?.();
      const principalId = deps.ownerPrincipalId?.();
      // Without an owner there is no policy to decide a click by; without a registered capability the gate never ran.
      const refusal =
        host === undefined || principalId === undefined
          ? "this node gives no task a browser"
          : admission === undefined
            ? "the execution policy was never asked about this task, because this node does not know the browser capability"
            : undefined;
      if (host === undefined || principalId === undefined || admission === undefined || refusal !== undefined) {
        releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
        await refuse(job, `refused: ${refusal ?? "no browser"}; the worker was never started`);
        return;
      }
      openedBrowser = createTaskBrowserBroker({
        ledger: { services: host.services, taskId: job.taskId, runId },
        conversationId: task.conversationId,
        intent,
        policy: () => readExecutionPolicy({ db: deps.conductor.db, now: at }, principalId),
        principalId,
        allowedOrigins: browserSites,
        admission,
        profileDir: taskProfileDir(host.profilesDir, job.taskId),
        ...(host.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: host.answerTimeoutMs }),
        ...(host.lookup === undefined ? {} : { lookup: host.lookup }),
        ...(host.openDriver === undefined ? {} : { openDriver: host.openDriver }),
      });
      browsers.set(job.taskId, openedBrowser);
    }
    const browser = openedBrowser;

    const commandDeps = browsing || write.length === 0 ? undefined : deps.commandDeps?.();
    const broker =
      commandDeps === undefined
        ? undefined
        : createWorkerCommandBroker({
            command: commandDeps,
            taskId: job.taskId,
            conversationId: task.conversationId,
            roots: write,
            intent,
            // The task's effect ledger: a command that reaches outside the node is written against this run.
            ledger: {
              deps: { db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId },
              runId,
            },
          });

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
            stopEffectsOf(job.taskId);
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
          // A browser task reads and writes no project: its worker is given the browser and nothing on this disk.
          projectRoots: browsing ? [] : read,
          ...(plan.scoped ? { writableRoots: browsing ? [] : write } : {}),
          allowedCapabilityRefs: [...workerCapabilitiesFor(job.capabilityRef)],
        },
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(broker === undefined
          ? {}
          : {
              onCommand: async (raw: unknown) => {
                const request = parseWorkerCommandRequest(raw);
                if (request === undefined) {
                  return { kind: "refused", text: "refused: the request was not a command this host can read" };
                }
                return broker(request);
              },
            }),
        ...(browser === undefined
          ? {}
          : {
              onBrowser: async (raw: unknown) => {
                const request = parseTaskBrowserRequest(raw);
                if (request === undefined) {
                  return { kind: "refused", text: "refused: the request was not a browser action this host can read" };
                }
                return browser(request);
              },
            }),
        onChild: (child) => {
          liveChildren.set(runId, { taskId: job.taskId, child });
          // A stop that arrived while the run was being prepared ends the worker as soon as it exists.
          if (stopping.has(job.taskId)) {
            void stopTree(child);
            stopEffectsOf(job.taskId);
          }
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
      // Settled only once every command it asked the host for has ended and been written into the ledger: a task
      // reported before then is reported without knowing whether one of its effects landed. A browser action the same.
      await broker?.idle();
      await browser?.idle();

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
          const settling = settlingEvidence(result.record.evidence);
          if (settling === undefined) return undefined;
          return { kind: narrowEvidenceKind(settling.kind), summary: settling.summary, verified: settling.verdict === "verified" };
        },
      });

      journal((j) => j.taskEnded(job.taskId, outcome.outcome === "succeeded" ? "done" : "failed"));
      const outputs = grantedOutputs(result.outputs ?? [], write);
      settle(job, outcome.outcome, outcome.message, outputs);
    } catch (cause) {
      // A worker ended by a signal — a person's stop, the wall-clock budget, a crash — rejects rather than returning,
      // so this is the path most stops actually take. It settles the task through the state machine like every
      // other refusal: a message alone would leave the task `running` until the next boot called it uncertain. A stop
      // ends the worker and its commands together, and the worker usually goes first; the report waits for the commands.
      await broker?.idle();
      await browser?.idle();
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
      // The run's browser goes with the run, profile and all; nothing is left open for a worker that no longer exists.
      await browser?.close();
      browsers.delete(job.taskId);
      liveChildren.delete(runId);
      releaseLease({ db: deps.conductor.db, nodeId: deps.conductor.nodeId, now: at, newId: deps.conductor.newId }, lease.lease.leaseId);
      await takeAwayWorktrees(job.taskId, task.conversationId, worktrees);
    }
  }

  /** What the task committed stays on its branch; a worktree with uncommitted changes is kept and said so. */
  async function takeAwayWorktrees(taskId: string, conversationId: string, worktrees: readonly ManagedWorktree[]): Promise<void> {
    for (const worktree of worktrees) {
      const removed = await removeManagedWorktree({ repoPath: worktree.repoPath, path: worktree.path });
      if (!removed.removed) deps.onWorktreeKept?.({ taskId, conversationId, path: worktree.path, branch: worktree.branch });
    }
    if (worktrees.length > 0 && deps.worktreesDir !== undefined) {
      await removeEmptyTaskFolder({ worktreesDir: deps.worktreesDir(), taskId });
    }
  }

  /**
   * What a run may touch.
   *
   * A task that names its folders and repositories gets exactly those, each still inside what this node owns. A task a
   * person asked for in the conversation and that named none gets the node's roots, as it always has. Anything else
   * that named none is refused before a worker exists: work nobody is watching does not get every folder the node knows.
   */
  function planRoots(task: NonNullable<ReturnType<typeof getTask>>): RootPlan {
    const resources = task.resources ?? [];
    let plan: Extract<RootPlan, { ok: true }>;
    if (resources.length === 0) {
      if (task.origin !== undefined && task.origin.kind !== "interactive") {
        return {
          ok: false,
          refusal:
            "refused: work nobody asked for in this conversation has to name the folder or repository it may touch, " +
            "and this task named none, so the worker was never started",
        };
      }
      const roots = [...deps.projectRoots()];
      plan = { ok: true, read: roots, write: [...roots], repositories: [], scoped: false };
    } else {
      plan = { ok: true, read: [], write: [], repositories: [], scoped: true };
      for (const resource of resources) {
        if (resource.kind === "repository") {
          plan.repositories.push(resource.path);
        } else {
          plan.read.push(resource.path);
          if (resource.access === "write") plan.write.push(resource.path);
        }
      }
    }
    const owned = ownedResources(deps.ownedRoots());
    const outsideOwnership = [...plan.read, ...plan.repositories].find((root) => containingRoot(owned, root) === undefined);
    if (outsideOwnership !== undefined) {
      return {
        ok: false,
        refusal: `refused: ${outsideOwnership} is not a root this node owns, so the worker was never started`,
      };
    }
    return plan;
  }

  function settle(
    job: QueuedRun,
    outcome: "succeeded" | "failed" | "uncertain" | "cancelled",
    message: string,
    outputs?: readonly TaskOutputFile[],
  ): void {
    // Every path reports here straight after `runDispatchedTask` wrote the run's settlement, so from now on nothing this
    // run does can settle the task: an answer to one of its effects has to settle it itself.
    reported.add(job.taskId);
    const task = getTask(deps.conductor.db, job.taskId);
    if (task === undefined) return;
    deps.onSettled({
      taskId: job.taskId,
      conversationId: task.conversationId,
      outcome,
      message,
      ...(outputs === undefined || outputs.length === 0 ? {} : { outputs }),
    });
  }

  return {
    dispatch(input) {
      const job: QueuedRun = {
        taskId: input.taskId,
        capabilityRef: input.capabilityRef,
        executionNodeId: input.executionNodeId,
        ...(input.authorizedByApprovalId === undefined ? {} : { authorizedByApprovalId: input.authorizedByApprovalId }),
      };
      if (closing) {
        void refuse(job, "this node is shutting down; the task was not run and can be retried once the node is back");
        return false;
      }
      if (running >= maxConcurrent && queue.length >= maxQueued) {
        void refuse(
          job,
          `this node already has ${String(running)} task workers running and ${String(queue.length)} waiting, which is its limit; the task was not run and can be retried once one finishes`,
        );
        return false;
      }
      queue.push({ ...job, queuedAt: at() });
      pump();
      return true;
    },
    stopAll() {
      const stopped = liveChildren.size;
      // Admitted and still being prepared: its worker is stopped as soon as it exists.
      for (const taskId of active.keys()) stopping.add(taskId);
      for (const { taskId, child } of liveChildren.values()) {
        stopping.add(taskId);
        void stopTree(child);
        stopEffectsOf(taskId);
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
      if (!active.has(taskId)) return false;
      stopping.add(taskId);
      for (const entry of liveChildren.values()) {
        if (entry.taskId === taskId) void stopTree(entry.child);
      }
      // The commands its worker asked the host to run are the task's too, and a stop that left them running would
      // leave the effect the person meant to end still happening. Its browser takes no further action either.
      stopEffectsOf(taskId);
      return true;
    },
    holds(taskId) {
      return active.has(taskId) || queue.some((job) => job.taskId === taskId);
    },
    reportPending(taskId) {
      return (active.has(taskId) && !reported.has(taskId)) || queue.some((job) => job.taskId === taskId);
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

/**
 * Decide an approval a dispatched task raised through the gate above.
 *
 * Unlike `decideApprovalForNode` (the command-approval route), there is no card whose payload has to be found
 * first: the operation is named entirely by the approval row itself, and `decideApproval` re-checks the digest
 * the caller says it saw against the one stored, the same binding a card gives a command. What this adds is the
 * task match — an approval belongs to exactly one task, checked before the decision is written rather than
 * after, so a caller cannot decide a different task's approval by guessing its id — and, on a grant, turning the
 * decision into the re-dispatch it exists to unblock: the capability the digest names is read back out of it and
 * queued again on the task's execution node, this time authorized by the gate above.
 *
 * The task is loaded and checked *before* `decideApproval` is called, not after: a missing task or one that has
 * already left `waiting_approval` (cancelled, already resumed, timed out some other way) refuses the request
 * before anything is written, rather than committing a decision for a task that can no longer act on it.
 *
 * `redispatched` is `false` rather than a failure when a grant cannot be turned into a run — the task no longer
 * has an execution node, this node was not wired with a dispatcher at all (a fixture node, per
 * `TaskDispatcherDeps.ownerPrincipalId`'s own doc comment), or the dispatcher itself refused the job (closing,
 * or already at its queue limit) — because the decision itself still succeeded and must not be reported as
 * failed, and a caller must not claim work is running that was in fact refused.
 */
export function decideTaskApprovalForNode(
  deps: {
    coordination: CoordinationDeps;
    /** Absent on a node that never wired a dispatcher (a fixture node); a grant is then recorded but not run. */
    dispatch?: (input: {
      taskId: string;
      capabilityRef: string;
      executionNodeId: string;
      authorizedByApprovalId: string;
    }) => boolean;
  },
  input: {
    taskId: string;
    approvalId: string;
    decision: "granted" | "denied";
    decidingPrincipal: Principal;
    /** Digest the approver actually saw, so an approved operation cannot be swapped for a different one. */
    seenOperationDigest: string;
  },
):
  | { ok: true; conversationId: string; redispatched: boolean }
  | { ok: false; code: string; message: string; conversationId?: string } {
  const row = oneRow<{ task_id: string | null }>(
    deps.coordination.db,
    "SELECT task_id FROM approvals WHERE approval_id = ?",
    input.approvalId,
  );
  if (row === undefined) {
    return { ok: false, code: "APPROVAL_FORGED", message: "approval does not exist" };
  }
  if (row.task_id !== input.taskId) {
    return { ok: false, code: "APPROVAL_FORGED", message: "that approval does not belong to this task" };
  }

  const task = getTask(deps.coordination.db, input.taskId);
  if (task === undefined) {
    return { ok: false, code: "TASK_NOT_FOUND", message: "the task this approval belonged to no longer exists" };
  }
  if (task.state !== "waiting_approval") {
    return {
      ok: false,
      code: "TASK_NOT_WAITING",
      message: `task ${input.taskId} is ${task.state}, not waiting for an approval; the decision was not recorded`,
    };
  }

  const decided = decideApproval(deps.coordination, {
    approvalId: input.approvalId as ApprovalId,
    decision: input.decision,
    decidingPrincipal: input.decidingPrincipal,
    seenOperationDigest: input.seenOperationDigest,
  });
  if (!decided.ok) {
    // The approval expired between the person opening it and deciding it. Nobody decided anything, but the
    // task must not be left waiting on a deadline that has already passed - it is settled the same way a
    // denial is, just without a decision to record.
    if (decided.code === "APPROVAL_EXPIRED") {
      applyTaskEvent(deps.coordination, input.taskId, "run.approval_expired");
      return { ok: false, code: decided.code, message: decided.message, conversationId: task.conversationId };
    }
    return { ok: false, code: decided.code, message: decided.message };
  }

  if (input.decision === "denied") {
    // Terminal, not parked: there is no path left to resume this task on, and leaving it `waiting_approval`
    // after the one thing it was waiting for was refused would strand it there for good.
    applyTaskEvent(deps.coordination, input.taskId, "run.approval_denied");
    return { ok: true, conversationId: task.conversationId, redispatched: false };
  }

  // The gate wrote this digest as `sha256:task-effect:<taskId>:<capabilityRef>`; read the capability back out of
  // it rather than storing it a second time anywhere.
  const prefix = `sha256:task-effect:${input.taskId}:`;
  const capabilityRef = decided.approval.operationDigest.startsWith(prefix)
    ? decided.approval.operationDigest.slice(prefix.length)
    : undefined;

  if (capabilityRef === undefined || deps.dispatch === undefined || task.executionNodeId === undefined) {
    return { ok: true, conversationId: task.conversationId, redispatched: false };
  }

  // The gate parked this task in `waiting_approval` without touching its run; resume it back through
  // `dispatched` so the worker it already had a lease for can be re-queued, rather than resolving it a
  // second time. Either replay can legally fail — the task moved on while the approval sat pending (it
  // was cancelled, or somehow already resumed) — and that is reported as "granted but not re-run", the
  // same as any other reason a grant cannot be turned into a run, never as a failed decision.
  const parked = applyTaskEvent(deps.coordination, input.taskId, "run.approval_granted");
  if (!parked.ok) {
    return { ok: true, conversationId: task.conversationId, redispatched: false };
  }
  const resumed = applyTaskEvent(deps.coordination, input.taskId, "dispatch.acknowledged");
  if (!resumed.ok) {
    return { ok: true, conversationId: task.conversationId, redispatched: false };
  }

  const accepted = deps.dispatch({
    taskId: input.taskId,
    capabilityRef,
    executionNodeId: task.executionNodeId,
    authorizedByApprovalId: input.approvalId,
  });
  return { ok: true, conversationId: task.conversationId, redispatched: accepted };
}
