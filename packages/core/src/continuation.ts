/**
 * Resuming a task whose goal may have changed.
 *
 * A continuation resumes work that was planned against a goal. If the goal has moved since, the
 * plan is for a task nobody asked for, and the approvals gathered for the original one are
 * approvals of something else.
 *
 * The comparison normalises whitespace and case, because a goal that differs only in formatting
 * has not changed and invalidating consent over a reflowed paragraph would train people to ignore
 * the warning. Everything else counts as a change, including a goal that got shorter: removing a
 * constraint ("summarise the report, don't send it") widens what the task may do.
 */

export interface ContinuationInput {
  taskId: string;
  /** The goal as the user first stated it. */
  originalGoal: string;
  /** The goal as it reads now. */
  currentGoal: string;
  /** Identifiers of approvals gathered against the original goal. */
  approvalIds: readonly string[];
}

export type ContinuationVerdict =
  | { resume: true; reason: string; invalidatedApprovals: readonly string[] }
  | {
      resume: false;
      code: "INTENT_CHANGED";
      reason: string;
      /** Every prior approval, because none of them was given for this goal. */
      invalidatedApprovals: readonly string[];
    };

function normalise(goal: string): string {
  return goal.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Decide whether a task may resume, and what its approvals are worth now.
 *
 * Refusing here rather than resuming and asking later is deliberate: by the time a resumed task
 * has read a file or called a capability, the question "was this what you meant?" is too late to
 * be useful.
 */
export function revalidateContinuation(input: ContinuationInput): ContinuationVerdict {
  const original = normalise(input.originalGoal);
  const current = normalise(input.currentGoal);

  if (original === current) {
    return {
      resume: true,
      reason: "the goal is unchanged, so the approvals gathered for it still apply",
      invalidatedApprovals: [],
    };
  }

  return {
    resume: false,
    code: "INTENT_CHANGED",
    reason:
      "the goal changed since this task was planned; the earlier approvals were given for a different goal and a new approval is needed before work resumes",
    // All of them, not the ones that look related: which approvals survive a reworded goal is
    // exactly the judgement that should not be made by a string comparison.
    invalidatedApprovals: [...input.approvalIds],
  };
}

/** Whether a goal was reworded into a narrower one, for the notice the user sees. */
export function intentDiff(input: { originalGoal: string; currentGoal: string }): {
  changed: boolean;
  removedConstraint: boolean;
} {
  const original = normalise(input.originalGoal);
  const current = normalise(input.currentGoal);
  return {
    changed: original !== current,
    // A goal that got shorter usually lost a constraint, which widens what the task may do.
    removedConstraint: current.length < original.length,
  };
}

export const CONTINUATION_STATUS = "implemented-goal-revalidation";
