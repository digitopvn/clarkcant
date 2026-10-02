import {
  JOB_LIMITS,
  type JobOwner,
  type JobRecord,
  type JobStatus,
  type Instant,
  nowInstant,
} from "@clarkcant/contracts";
import {
  failInterruptedJobs,
  getJob,
  getOwnedJob,
  insertJob,
  listOpenJobs,
  listOwnedJobs,
  transitionJob,
  updateJobProgress,
  type Database,
} from "@clarkcant/storage";

import type { WorkSupervisor } from "./work-supervisor.ts";
import type { McpToolResult } from "@clarkcant/mcp-adapters";
import type { ArtifactBrokerDeps } from "./artifact-broker.ts";
import { storeJobResultArtifacts } from "./job-result-artifacts.ts";
import { ServiceCallError } from "./service-host.ts";

export interface JobRunOutcome {
  status: Extract<JobStatus, "completed" | "failed" | "cancelled">;
  output?: string;
  error?: string;
  sent?: boolean;
}

/** One package's own job limit, from its granted resource profile, inside the node's. */
export interface PackageJobScope {
  packageId: string;
  maxActive: number;
  /** The largest file a result may keep as an artifact; never above `ARTIFACT_LIMITS.maxBytes`. */
  artifactMaxBytes?: number;
}

export interface PackageJobHost {
  /** Whether a job can start now: the node is under its limit, and, with a scope, so is that package. */
  canAdmit(scope?: PackageJobScope): boolean;
  start(input: {
    job: Omit<JobRecord, "status" | "resultRefs" | "createdAt" | "startedAt" | "endedAt" | "progress" | "error" | "output">;
    scope?: PackageJobScope;
    run: (signal: AbortSignal, onProgress: (progress: { current: number; total?: number; message?: string }) => void) => Promise<McpToolResult>;
    onSettled?: (outcome: JobRunOutcome) => void;
  }): JobRecord;
  get(jobId: string, owner: JobOwner): JobRecord | undefined;
  /** The newest jobs one owner started, newest first. */
  list(owner: JobOwner, limit: number): JobRecord[];
  cancel(jobId: string, owner: JobOwner): boolean;
  subscribe(jobId: string, owner: JobOwner, listener: (job: JobRecord) => void): () => void;
  stopAll(): number;
  recover(): number;
}

const MAX_ACTIVE_JOBS = 4;

/** What a service said when its tool answered with an error, without the transport's prefix, as one bounded sentence. */
function serviceVerdict(message: string): string {
  const said = message.replace(/^mcp tool \S+ reported an error: /, "").replace(/\s+/g, " ").trim().slice(0, 400);
  return /[.!?]$/.test(said) ? said : `${said}.`;
}
const NAMED_RESULTS = 3;
/** The least time between two progress writes of one job; widgets read it once a second. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * The note a finished job leaves in its conversation: which capability, what it produced by name, and what to do next.
 * Words never claim more than the job record holds; a stopped or failed job that was sent may still have had its effect.
 */
export function jobEndNotice(
  job: Pick<JobRecord, "capabilityRef" | "status" | "resultRefs">,
  outcome: Pick<JobRunOutcome, "status" | "sent">,
): string {
  const what = `The package job for ${job.capabilityRef}`;
  if (outcome.status === "completed") {
    if (job.resultRefs.length === 0) return `${what} completed. Its widget shows the result.`;
    const names = job.resultRefs.slice(0, NAMED_RESULTS).map((ref) => `“${ref.name}”`).join(", ");
    const more = job.resultRefs.length > NAMED_RESULTS ? ` and ${String(job.resultRefs.length - NAMED_RESULTS)} more` : "";
    return `${what} completed and produced ${names}${more}. Open its widget to use ${job.resultRefs.length === 1 ? "it" : "them"}.`;
  }
  if (outcome.sent === false) return `${what} ended before its request was sent. Nothing ran; it can be started again from its widget.`;
  if (outcome.status === "cancelled") {
    return `${what} was stopped. The service may have finished its effect before it received the cancellation; check the result before starting it again.`;
  }
  return `${what} failed. The service may have done part of its work; check the result before starting it again.`;
}

export function createPackageJobHost(input: {
  db: Database;
  nodeId: string;
  nodeBootId: string;
  newId: (prefix: string) => string;
  supervisor: WorkSupervisor;
  /** How a job ended, said in its conversation. `job` is the ended record, so a caller can point an inbox notice at it. */
  report?: (conversationId: string, text: string, job: Pick<JobRecord, "jobId" | "status">) => void;
  now?: () => Instant;
  maxActiveJobs?: number;
  artifactBroker?: ArtifactBrokerDeps;
}): PackageJobHost {
  const now = input.now ?? nowInstant;
  const active = new Map<string, AbortController>();
  /** The package of each active job, so a package's own limit counts only its jobs. */
  const activePackage = new Map<string, string>();
  const listeners = new Map<string, Set<(job: JobRecord) => void>>();
  const capacity = input.maxActiveJobs ?? MAX_ACTIVE_JOBS;

  const publish = (job: JobRecord): void => {
    for (const listener of listeners.get(job.jobId) ?? []) {
      try {
        listener(job);
      } catch {
        // A stale frame listener cannot prevent other observers or the durable terminal transition from being seen.
      }
    }
  };
  const finish = (jobId: string, outcome: JobRunOutcome, resultRefs: JobRecord["resultRefs"] = []): JobRecord | undefined => {
    const at = now();
    const changed = transitionJob(input.db, {
      jobId,
      status: outcome.status,
      at,
      resultRefs: outcome.status === "completed" ? resultRefs : [],
      ...(outcome.status === "completed" && outcome.output !== undefined ? { output: outcome.output.slice(0, JOB_LIMITS.outputChars) } : {}),
      ...(outcome.error === undefined ? {} : { error: outcome.error.slice(0, 800) }),
    });
    const job = getJob(input.db, jobId);
    if (!changed || job === undefined) return undefined;
    publish(job);
    const message = jobEndNotice(job, outcome);
    if (job.conversationId !== undefined) {
      try {
        input.report?.(job.conversationId, message, job);
      } catch {
        // Reporting is best effort; the persisted job and effect ledger remain authoritative.
      }
    }
    return job;
  };

  const packageActive = (packageId: string): number => {
    let count = 0;
    for (const owner of activePackage.values()) if (owner === packageId) count += 1;
    return count;
  };

  input.supervisor.addSource({
    kind: "job",
    list: () => listOpenJobs(input.db, input.nodeId).map((job) => ({
      workId: job.jobId,
      kind: "job",
      title: job.capabilityRef,
      state: job.status === "queued" ? "queued" : "running",
      ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
      startedAt: job.startedAt ?? job.createdAt,
    })),
    cancel: (jobId) => {
      const controller = active.get(jobId);
      if (controller === undefined) return false;
      controller.abort(new Error("stopped by the person"));
      return true;
    },
  });

  return {
    canAdmit: (scope) => active.size < capacity && (scope === undefined || packageActive(scope.packageId) < scope.maxActive),
    start({ job: draft, scope, run, onSettled }) {
      if (active.size >= capacity) throw new Error("the node is at its active package job limit; this job was not sent");
      if (scope !== undefined && packageActive(scope.packageId) >= scope.maxActive) {
        throw new Error("the package is at its active job limit; this job was not sent");
      }
      const at = now();
      const job = {
        ...draft,
        status: "queued" as const,
        resultRefs: [],
        createdAt: at as JobRecord["createdAt"],
      };
      insertJob(input.db, { ...job, nodeBootId: input.nodeBootId });
      transitionJob(input.db, { jobId: job.jobId, status: "running", at });
      const running = getJob(input.db, job.jobId);
      if (running === undefined) throw new Error("the node saved no record for the accepted job");
      const controller = new AbortController();
      let dispatched = false;
      let lastProgressAt = 0;
      active.set(job.jobId, controller);
      if (scope !== undefined) activePackage.set(job.jobId, scope.packageId);
      publish(running);
      const reportSettled = (outcome: JobRunOutcome, refs: JobRecord["resultRefs"] = []): void => {
        if (finish(job.jobId, outcome, refs) === undefined) return;
        try {
          onSettled?.(outcome);
        } catch {
          // A caller's ledger callback cannot change the service answer or rewrite a terminal job.
        }
      };
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        dispatched = true;
        return run(controller.signal, (progress) => {
          // A service may report as often as it likes; the node keeps at most a few a second, and always the last step.
          const reportedAt = Date.now();
          const last = progress.total !== undefined && progress.current >= progress.total;
          if (!last && reportedAt - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = reportedAt;
          if (!updateJobProgress(input.db, { jobId: job.jobId, progress, at: now() })) return;
          const current = getJob(input.db, job.jobId);
          if (current !== undefined) publish(current);
        });
      }).then((result) => {
        const files = result.files ?? [];
        let captured: { refs: JobRecord["resultRefs"]; omitted: boolean } = { refs: [], omitted: files.length > 0 };
        try {
          if (input.artifactBroker !== undefined) {
            captured = storeJobResultArtifacts(input.artifactBroker, running, files, scope?.artifactMaxBytes);
          }
        } catch {
          // The service answered; a host file-storage error does not make its effect uncertain.
          captured.omitted = files.length > 0;
        }
        const output = [result.content, captured.omitted
          ? "Some service files could not be retained as artifacts; the remaining results are still available."
          : ""].filter(Boolean).join("\n").slice(0, JOB_LIMITS.outputChars);
        reportSettled({ status: "completed", output }, captured.refs);
      }, (cause: unknown) => {
        const cancelled = controller.signal.aborted;
        const sent = cause instanceof ServiceCallError ? cause.sent : dispatched;
        const outcome: JobRunOutcome = {
          status: cancelled ? "cancelled" : "failed",
          sent,
          error: !sent
            ? "The service request was not sent. Nothing ran; this job can be tried again."
            : cancelled
            ? "The service was told to cancel, but it may already have completed its effect; review before retrying."
            : cause instanceof ServiceCallError && cause.code === "SERVICE_TOOL_FAILED"
            // The service's own verdict, so the widget can say what failed; bounded like the rest of the record.
            ? `The package service reported an error: ${serviceVerdict(cause.message)} Its effect may have happened; review before retrying.`
            : "The package service did not complete the job. Its effect may have happened; review before retrying.",
        };
        reportSettled(outcome);
      }).catch(() => {
        // Recording the ending itself failed (a full or locked database). The job stays open in storage, so the next
        // boot's recovery marks it interrupted with a may-have-run explanation; nothing is retried here.
      }).finally(() => {
        active.delete(job.jobId);
        activePackage.delete(job.jobId);
      });
      return running;
    },
    get: (jobId, owner) => getOwnedJob(input.db, jobId, owner),
    list: (owner, limit) => listOwnedJobs(input.db, owner, limit),
    cancel(jobId, owner) {
      if (getOwnedJob(input.db, jobId, owner) === undefined) return false;
      const controller = active.get(jobId);
      if (controller === undefined) return false;
      controller.abort(new Error("stopped by the originating widget"));
      return true;
    },
    subscribe(jobId, owner, listener) {
      if (getOwnedJob(input.db, jobId, owner) === undefined) return () => undefined;
      const subscribers = listeners.get(jobId) ?? new Set();
      subscribers.add(listener);
      listeners.set(jobId, subscribers);
      const current = getOwnedJob(input.db, jobId, owner);
      if (current !== undefined) listener(current);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(jobId);
      };
    },
    stopAll() {
      let stopped = 0;
      for (const controller of active.values()) {
        controller.abort(new Error("stopped by emergency stop"));
        stopped += 1;
      }
      return stopped;
    },
    recover() {
      const interrupted = listOpenJobs(input.db, input.nodeId, input.nodeBootId);
      const count = failInterruptedJobs(input.db, { nodeId: input.nodeId, currentBootId: input.nodeBootId, at: now() });
      for (const job of interrupted) {
        if (job.conversationId === undefined) continue;
        try {
          input.report?.(
            job.conversationId,
            `The package job for ${job.capabilityRef} was interrupted when the node restarted. Its service may have completed its effect; review it before retrying.`,
            { jobId: job.jobId, status: "failed" },
          );
        } catch {
          // The job is already marked failed; one note that cannot be written must not stop the rest of recovery.
        }
      }
      return count;
    },
  };
}
