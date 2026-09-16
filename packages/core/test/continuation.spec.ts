import { describe, expect, it } from "vitest";

import { intentDiff, revalidateContinuation } from "../src/continuation.ts";

/**
 * Resuming a task whose goal may have changed (T27).
 *
 * The claim is that approvals do not survive a changed goal. The interesting cases are the two
 * near-misses: a goal that only looks different, and a goal that looks similar but lost a
 * constraint.
 */

const ORIGINAL = "Summarise the report at reports/q3.pdf and do not send it to anyone.";
const APPROVALS = ["appr_1", "appr_2"];

describe("an unchanged goal resumes with its approvals intact", () => {
  it("resumes when the goal is identical", () => {
    const verdict = revalidateContinuation({
      taskId: "task_1",
      originalGoal: ORIGINAL,
      currentGoal: ORIGINAL,
      approvalIds: APPROVALS,
    });
    expect(verdict.resume).toBe(true);
    expect(verdict.invalidatedApprovals).toEqual([]);
  });

  it("does not treat reflowed whitespace as a change", () => {
    // Invalidating consent over a reflowed paragraph would train people to ignore the warning.
    const verdict = revalidateContinuation({
      taskId: "task_1",
      originalGoal: ORIGINAL,
      currentGoal: "  summarise   the report at reports/q3.pdf\nand do NOT send it to anyone.  ",
      approvalIds: APPROVALS,
    });
    expect(verdict.resume).toBe(true);
  });
});

describe("a changed goal does not resume on the old approvals", () => {
  it("refuses and invalidates every approval", () => {
    const verdict = revalidateContinuation({
      taskId: "task_1",
      originalGoal: ORIGINAL,
      currentGoal: "Summarise the report at reports/q3.pdf and email it to the team.",
      approvalIds: APPROVALS,
    });

    expect(verdict.resume).toBe(false);
    expect(verdict.resume === false && verdict.code).toBe("INTENT_CHANGED");
    // All of them, not the ones that look related: deciding which approvals survive a reworded
    // goal is exactly the judgement a string comparison should not make.
    expect(verdict.invalidatedApprovals).toEqual(APPROVALS);
  });

  it("refuses when the goal lost a constraint", () => {
    const verdict = revalidateContinuation({
      taskId: "task_1",
      originalGoal: ORIGINAL,
      currentGoal: "Summarise the report at reports/q3.pdf.",
      approvalIds: APPROVALS,
    });

    expect(verdict.resume).toBe(false);
    expect(intentDiff({ originalGoal: ORIGINAL, currentGoal: "Summarise the report." }).removedConstraint).toBe(true);
  });

  it("says why, so the refusal is actionable rather than a dead end", () => {
    const verdict = revalidateContinuation({
      taskId: "task_1",
      originalGoal: ORIGINAL,
      currentGoal: "Do something else entirely.",
      approvalIds: APPROVALS,
    });
    expect(verdict.resume === false && verdict.reason).toContain("a new approval is needed");
  });

  it("refuses even when there were no approvals, so the plan change is still visible", () => {
    const verdict = revalidateContinuation({
      taskId: "task_1",
      originalGoal: ORIGINAL,
      currentGoal: "Delete the report.",
      approvalIds: [],
    });
    expect(verdict.resume).toBe(false);
    expect(verdict.invalidatedApprovals).toEqual([]);
  });
});

describe("the diff reports whether a constraint was dropped", () => {
  it("reports no change for the same goal", () => {
    expect(intentDiff({ originalGoal: ORIGINAL, currentGoal: ORIGINAL })).toEqual({
      changed: false,
      removedConstraint: false,
    });
  });

  it("reports a change for a longer goal, without claiming a constraint was lost", () => {
    expect(
      intentDiff({ originalGoal: "Read the file.", currentGoal: "Read the file and summarise it." }),
    ).toEqual({ changed: true, removedConstraint: false });
  });
});
