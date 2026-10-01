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

export interface PackageJobHost {
  canAdmit(): boolean;
  start(input: {
    job: Omit<JobRecord, "status" | "resultRefs" | "createdAt" | "startedAt" | "endedAt" | "progress" | "error" | "output">;
    run: (signal: AbortSignal, onProgress: (progress: { current: number; total?: number; message?: string }) => void) => Promise<McpToolResult>;
    onSettled?: (outcome: JobRunOutcome) => void;
  }): JobRecord;
  get(jobId: string, owner: JobOwner): JobRecord | undefined;
  cancel(jobId: string, owner: JobOwner): boolean;
  subscribe(jobId: string, owner: JobOwner, listener: (job: JobRecord) => void): () => void;
  stopAll(): number;
  recover(): number;
}

const MAX_ACTIVE_JOBS = 4;
const NAMED_RESULTS = 3;

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
  report?: (conversationId: string, text: string) => void;
  now?: () => Instant;
  maxActiveJobs?: number;
  artifactBroker?: ArtifactBrokerDeps;
}): PackageJobHost {
  const now = input.now ?? nowInstant;
  const active = new Map<string, AbortController>();
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
        input.report?.(job.conversationId, message);
      } catch {
        // Reporting is best effort; the persisted job and effect ledger remain authoritative.
      }
    }
    return job;
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
    canAdmit: () => active.size < capacity,
    start({ job: draft, run, onSettled }) {
      if (active.size >= capacity) throw new Error("the node is at its active package job limit; this job was not sent");
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
      active.set(job.jobId, controller);
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
          if (!updateJobProgress(input.db, { jobId: job.jobId, progress, at: now() })) return;
          const current = getJob(input.db, job.jobId);
          if (current !== undefined) publish(current);
        });
      }).then((result) => {
        const files = result.files ?? [];
        let captured: { refs: JobRecord["resultRefs"]; omitted: boolean } = { refs: [], omitted: files.length > 0 };
        try {
          if (input.artifactBroker !== undefined) captured = storeJobResultArtifacts(input.artifactBroker, running, files);
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
            : "The package service did not complete the job. Its effect may have happened; review before retrying.",
        };
        reportSettled(outcome);
      }).catch(() => {
        // Recording the ending itself failed (a full or locked database). The job stays open in storage, so the next
        // boot's recovery marks it interrupted with a may-have-run explanation; nothing is retried here.
      }).finally(() => active.delete(job.jobId));
      return running;
    },
    get: (jobId, owner) => getOwnedJob(input.db, jobId, owner),
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
        if (job.conversationId !== undefined) {
          input.report?.(job.conversationId, "A package job was interrupted when the node restarted. Its service may have completed its effect; review it before retrying.");
        }
      }
      return count;
    },
  };
}
