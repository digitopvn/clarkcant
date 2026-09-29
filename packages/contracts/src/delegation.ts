import { z } from "zod";

import { effectCategorySchema } from "./primitives.ts";
import { signalTopicSchema } from "./signals.ts";
import { taskResourceSchema } from "./tasks.ts";

/**
 * What travels in a NodeLink `delegate` and the `result` that answers it.
 *
 * A brief is what the sender's owner asked for, in the terms the receiver checks: a goal, the folders on the receiver it
 * names, and the effects the sender allows. None of it widens anything. The receiver runs it only inside its own
 * owner's allowance for that peer, and it rebuilds the worker's picture of what started the task from the structured
 * trigger, never from a payload's free text.
 *
 * A `delegate` payload is `{ grant, taskBrief, dataClass }`, the fields NodeLink requires of every hand-over. The grant
 * in it is only what the sender believes it holds: the receiver checks the one it stored when that grant arrived.
 *
 * The task id is the envelope's own `taskId`, chosen by the sender when its run was recorded, so the same work handed
 * over twice is one task on the receiver and one answer back.
 */

export const delegationBriefSchema = z.strictObject({
  goal: z.string().min(1).max(2000),
  /** In the sender's owner's words, for the receiver's owner to recognise the work by. */
  summary: z.string().min(1).max(300),
  /** Paths on the receiver. */
  resources: z.array(taskResourceSchema).min(1).max(8),
  allowedCategories: z.array(effectCategorySchema).max(8),
  /** The fields a program set on the signal that started it, when one did. */
  trigger: z
    .strictObject({
      provider: z.string().min(1).max(80).optional(),
      topic: signalTopicSchema,
      subject: z
        .strictObject({
          type: z.string().min(1).max(80).optional(),
          id: z.string().min(1).max(200).optional(),
          refs: z.record(z.string().min(1).max(80), z.string().max(500)).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type DelegationBrief = z.infer<typeof delegationBriefSchema>;

/** A `result` envelope's payload: the outcome, and what the receiver says it saw. */
export const delegationResultSchema = z.strictObject({
  outcome: z.enum(["succeeded", "failed", "uncertain", "cancelled"]),
  evidence: z.strictObject({
    /** What happened, in the receiver's words; for a refusal, why it did not run. */
    message: z.string().min(1).max(1000),
    /** Whether the task ever ran on the receiver, which is the difference between a refusal and a failure. */
    ran: z.boolean(),
  }),
});
export type DelegationResult = z.infer<typeof delegationResultSchema>;
