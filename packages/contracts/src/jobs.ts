import { z } from "zod";

import { artifactRefSchema } from "./artifacts.ts";
import { capabilityRefSchema } from "./grants.ts";
import {
  conversationIdSchema,
  instantSchema,
  jobIdSchema,
  effectCategorySchema,
  principalIdSchema,
  type Instant,
} from "./primitives.ts";

/** Versioned, bounded identity for work a package service owns after its call returns. */
export const JOBS_EXTENSION = "jobs@1";
export const JOB_LIMITS = Object.freeze({ progressMessageChars: 500, resultRefs: 32, errorChars: 800, outputChars: 16_000 });

export const jobStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobProgressSchema = z.strictObject({
  current: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  message: z.string().max(JOB_LIMITS.progressMessageChars).optional(),
}).superRefine((progress, context) => {
  if (progress.total !== undefined && progress.current > progress.total) {
    context.addIssue({ code: "custom", path: ["current"], message: "current progress cannot exceed total" });
  }
});
export type JobProgress = z.infer<typeof jobProgressSchema>;

/** Persisted snapshot. Owner fields are checked by the host on every access; the ref alone grants no authority. */
export const jobRecordSchema = z.strictObject({
  jobId: jobIdSchema,
  nodeId: z.string().min(1).max(128),
  ownerPrincipalId: principalIdSchema,
  conversationId: conversationIdSchema.optional(),
  instanceId: z.string().min(1).max(128),
  actionBindingId: z.string().min(1).max(128),
  packageId: z.string().min(1).max(160),
  packageGeneration: z.string().min(1).max(200),
  capabilityRef: capabilityRefSchema,
  effectCategory: effectCategorySchema,
  status: jobStatusSchema,
  progress: jobProgressSchema.optional(),
  resultRefs: z.array(artifactRefSchema).max(JOB_LIMITS.resultRefs),
  output: z.string().max(JOB_LIMITS.outputChars).optional(),
  error: z.string().min(1).max(JOB_LIMITS.errorChars).optional(),
  createdAt: instantSchema,
  startedAt: instantSchema.optional(),
  endedAt: instantSchema.optional(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobRef = JobRecord["jobId"];

export function isOpenJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return isOpenJobStatus(from);
  if (from === "queued") return to === "running" || to === "completed" || to === "failed" || to === "cancelled";
  if (from === "running" || from === "waiting") return to === "running" || to === "waiting" || to === "completed" || to === "failed" || to === "cancelled";
  return false;
}

export interface JobOwner {
  ownerPrincipalId: string;
  instanceId: string;
  actionBindingId: string;
  packageGeneration: string;
}

/** The server time is written once; this type alias keeps repository callers aligned with the shared contract. */
export type JobCreatedAt = Instant;
