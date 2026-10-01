import { randomBytes } from "node:crypto";

import type { FrameJobOutcome } from "@clarkcant/widget-host";
import { jobRequestSchema, type JobSnapshot } from "@clarkcant/widget-sdk";
import { z } from "zod";

/**
 * `jobs@1` in `clark widget dev`: a long-running capability, simulated from the package's own fixture.
 *
 * A widget that starts a job has to handle a queue, progress, a result, a failure and a cancel, and an author should
 * be able to reach each of them without a service, a provider or half an hour. The dev host answers the same requests
 * with the same refusal codes the node does, and the shell's "Simulated jobs" controls move a job along on purpose.
 *
 * Nothing here runs: there is no service, the progress is the fixture's, and every ending says it was simulated. A job
 * lives in memory and is forgotten when the dev host stops, as a remount against a real node would not forget it.
 */

export const DEV_JOB_LIMITS = Object.freeze({
  /** Jobs held at once. A widget in a loop should not grow the dev host without end. */
  maxJobs: 32,
  maxSteps: 32,
});

const SIMULATED = "(simulated by clark widget dev)";

/** What a binding's job does in the dev host: the progress it reports, and what it ends with. */
export const devJobFixtureSchema = z.strictObject({
  steps: z
    .array(z.strictObject({
      current: z.number().finite().nonnegative(),
      total: z.number().finite().positive().optional(),
      message: z.string().min(1).max(400).optional(),
    }))
    .max(DEV_JOB_LIMITS.maxSteps)
    .default([]),
  output: z.string().max(15_000).optional(),
  error: z.string().min(1).max(700).optional(),
});
export type DevJobFixture = z.infer<typeof devJobFixtureSchema>;

export type DevJobControl = "advance" | "complete" | "fail";

export interface DevJobEvent {
  jobId: string;
  op: "start" | DevJobControl | "cancel";
  status: JobSnapshot["status"];
}

interface HeldJob {
  snapshot: JobSnapshot;
  actionBindingId: string;
  capabilityRef: string;
  fixture: DevJobFixture;
  /** The next fixture step `advance` reports. */
  step: number;
}

const ACTIVE = new Set<JobSnapshot["status"]>(["queued", "running", "waiting"]);
const refuse = (code: string, message: string): FrameJobOutcome => ({ status: "refused", code, message });

export function createDevJobBroker(input: { now?: () => string } = {}): {
  start(binding: { actionBindingId: string; capabilityRef: string; job: DevJobFixture }): JobSnapshot | undefined;
  handle(request: unknown): FrameJobOutcome;
  control(jobId: string, control: DevJobControl): FrameJobOutcome;
  list(): readonly (JobSnapshot & { actionBindingId: string; capabilityRef: string })[];
  events(): readonly DevJobEvent[];
} {
  const now = input.now ?? (() => new Date().toISOString());
  const held = new Map<string, HeldJob>();
  const events: DevJobEvent[] = [];
  const record = (job: HeldJob, op: DevJobEvent["op"]): void => {
    events.push({ jobId: job.snapshot.jobId, op, status: job.snapshot.status });
    if (events.length > 200) events.shift();
  };
  const missing = (): FrameJobOutcome =>
    refuse("JOB_NOT_FOUND", "that job is not held by this dev host (it forgets every job when it stops)");
  const end = (job: HeldJob, status: "completed" | "failed" | "cancelled"): void => {
    job.snapshot = {
      ...job.snapshot,
      status,
      endedAt: now(),
      ...(status === "completed"
        ? { output: `${job.fixture.output ?? "done"} ${SIMULATED}` }
        : { error: `${status === "failed" ? job.fixture.error ?? "the job failed" : "the job was cancelled"} ${SIMULATED}` }),
    };
  };

  return {
    start(binding) {
      // The oldest ended job makes room; a dev host full of running jobs refuses, as a node at its limit does.
      if (held.size >= DEV_JOB_LIMITS.maxJobs) {
        const ended = [...held.values()].find((job) => !ACTIVE.has(job.snapshot.status));
        if (ended === undefined) return undefined;
        held.delete(ended.snapshot.jobId);
      }
      const job: HeldJob = {
        snapshot: { jobId: `job_dev_${randomBytes(9).toString("hex")}`, status: "queued", resultRefs: [], createdAt: now() },
        actionBindingId: binding.actionBindingId,
        capabilityRef: binding.capabilityRef,
        fixture: binding.job,
        step: 0,
      };
      held.set(job.snapshot.jobId, job);
      record(job, "start");
      return job.snapshot;
    },

    handle(raw) {
      const parsed = jobRequestSchema.safeParse(raw);
      if (!parsed.success) return refuse("SCHEMA_INVALID", "the request does not match the jobs@1 schema");
      const job = held.get(parsed.data.jobId);
      if (job === undefined) return missing();
      if (parsed.data.op === "get") return { status: "ok", job: job.snapshot };
      if (!ACTIVE.has(job.snapshot.status)) return refuse("JOB_NOT_RUNNING", "that job has already ended; its saved result is still available");
      end(job, "cancelled");
      record(job, "cancel");
      return { status: "ok", job: job.snapshot };
    },

    control(jobId, control) {
      const job = held.get(jobId);
      if (job === undefined) return missing();
      if (!ACTIVE.has(job.snapshot.status)) return refuse("JOB_NOT_RUNNING", "that job has already ended");
      if (control === "advance") {
        const next = job.fixture.steps[job.step];
        if (job.snapshot.status === "queued") {
          job.snapshot = { ...job.snapshot, status: "running", startedAt: now() };
        } else if (next === undefined) {
          end(job, "completed");
        } else {
          job.step += 1;
          job.snapshot = { ...job.snapshot, progress: next };
        }
      } else {
        end(job, control === "complete" ? "completed" : "failed");
      }
      record(job, control);
      return { status: "ok", job: job.snapshot };
    },

    list: () => [...held.values()].map((job) => ({ ...job.snapshot, actionBindingId: job.actionBindingId, capabilityRef: job.capabilityRef })),
    events: () => events,
  };
}
