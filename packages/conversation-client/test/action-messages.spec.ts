import { describe, expect, it } from "vitest";

import { actionRefusalMessage, actionResultMessage, workflowMessage } from "../src/action-messages.ts";
import type { ActionInvocationResult, ActionWorkflowReport } from "../src/api.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";

/**
 * What a person reads after pressing a bound button, in each language.
 *
 * The node answers with a code, an English sentence and details. None of the English and none of the code reaches a
 * person; the inbox is named only when the node says it recorded the question there.
 */

const vi = (key: MessageKey): string => MESSAGES_VI[key];
const en = (key: MessageKey): string => MESSAGES_EN[key];

const ENGLISH_REASON = "the node's own English sentence";

/** Every code the action route can refuse with, as the node writes them. */
const CODES = [
  "TURN_IN_PROGRESS",
  "REVISION_MISMATCH",
  "BINDING_STALE",
  "CAPABILITY_NOT_READY",
  "CAPABILITY_NOT_AUTHENTICATED",
  "CAPABILITY_MISSING",
  "NOT_A_SERVICE_CAPABILITY",
  "TOKEN_BUDGET_EXCEEDED",
  "CONTEXT_REF_UNKNOWN",
  "CONTEXT_REF_FORBIDDEN",
  "CONTEXT_REF_UNSUPPORTED",
  "BACKGROUND_UNAVAILABLE",
  "INVOCATION_IN_PROGRESS",
  "INVOCATION_KEY_REUSED",
  "LEDGER_UNAVAILABLE",
  "INSTANCE_UNKNOWN",
  "ACTION_UNKNOWN",
  "NOT_AUTHORIZED",
  "INVALID_INPUT",
  "POLICY_REFUSED",
  "APPROVAL_UNAVAILABLE",
  "SERVICE_NOT_RUNNING",
  "SERVICE_CANCELLED",
  "RATE_LIMITED",
  "ACTION_INTERRUPTED",
];

function stoppedReport(overrides: Partial<ActionWorkflowReport["steps"][number]>, code: string): ActionWorkflowReport {
  return {
    completed: false,
    stoppedAt: "save",
    code,
    message: ENGLISH_REASON,
    steps: [
      { stepId: "fetch", kind: "invoke", status: "done" },
      { stepId: "save", kind: "invoke", status: "uncertain", ...overrides },
      { stepId: "notify", kind: "invoke", status: "not-run" },
    ],
  };
}

describe("a refused press, in the person's language", () => {
  it("never shows the node's English or a raw code for a code it knows", () => {
    for (const code of CODES) {
      for (const t of [vi, en]) {
        const said = actionRefusalMessage(t, { code, reason: ENGLISH_REASON, details: { retryAfterMs: 4_200, limit: 3 } });
        expect(said, code).not.toContain(ENGLISH_REASON);
        expect(said, code).not.toContain(code);
        expect(said, code).not.toMatch(/\{[a-z]+\}/u);
      }
    }
  });

  it("says a sent call's unknown outcome, and names the inbox only when the node recorded it", () => {
    for (const code of ["SERVICE_TIMED_OUT", "SERVICE_CANCELLED", "SERVICE_TOOL_FAILED", "SERVICE_UNREACHABLE", "SOMETHING_NEW"]) {
      const recorded = actionRefusalMessage(vi, { code, reason: ENGLISH_REASON, details: { outcome: "uncertain", recorded: true } });
      const unrecorded = actionRefusalMessage(vi, { code, reason: ENGLISH_REASON, details: { outcome: "uncertain", recorded: false } });
      expect(recorded, code).toContain("chưa rõ việc này đã có hiệu lực hay chưa");
      expect(recorded, code).toContain("Hộp thư sẽ hỏi");
      expect(unrecorded, code).not.toContain("Hộp thư");
      expect(unrecorded, code).toContain("hãy nói trong cuộc trò chuyện");
      expect(recorded, code).not.toContain(ENGLISH_REASON);
      const english = actionRefusalMessage(en, { code, reason: ENGLISH_REASON, details: { outcome: "uncertain" } });
      expect(english, code).toContain("whether it took effect is unknown");
      expect(english, code).not.toContain("inbox");
    }
  });

  it("says a read that did not finish changed nothing", () => {
    const said = actionRefusalMessage(vi, { code: "SERVICE_TIMED_OUT", reason: ENGLISH_REASON, details: { outcome: "refused", readOnly: true } });
    expect(said).toBe(MESSAGES_VI["widgets.action.readFailed"]);
  });

  it("fills the per-minute limit and the wait into the rate-limit sentence", () => {
    expect(actionRefusalMessage(en, { code: "RATE_LIMITED", reason: ENGLISH_REASON, details: { retryAfterMs: 4_200, limit: 3 } })).toBe(
      "This button can be pressed 3 times a minute. Nothing ran; try again in 5 s.",
    );
  });

  it("falls back to the node's sentence for a code this page does not know yet", () => {
    expect(actionRefusalMessage(vi, { code: "FROM_A_NEWER_NODE", reason: ENGLISH_REASON, details: {} })).toBe(ENGLISH_REASON);
  });
});

describe("a workflow's report, in the person's language", () => {
  it("names the step it stopped at, what stays done, what did not run, and the inbox only when recorded", () => {
    const recorded = workflowMessage(vi, stoppedReport({ recorded: true }, "SERVICE_TIMED_OUT"));
    expect(recorded).toContain("“save”");
    expect(recorded).toContain("chưa rõ đã thực hiện hay chưa");
    expect(recorded).toContain("dịch vụ không trả lời kịp");
    expect(recorded).toContain("“fetch” đã chạy và vẫn giữ nguyên");
    expect(recorded).toContain("“notify” không chạy");
    expect(recorded).toContain("Hộp thư sẽ hỏi");
    const unrecorded = workflowMessage(vi, stoppedReport({ recorded: false }, "WORKFLOW_DEADLINE"));
    expect(unrecorded).not.toContain("Hộp thư");
    expect(unrecorded).toContain("hết thời gian");
    expect(unrecorded).not.toContain(ENGLISH_REASON);
  });

  it("says a read step that did not finish changed nothing, and a refused step was not sent", () => {
    const read = workflowMessage(en, stoppedReport({ status: "failed", readOnly: true }, "SERVICE_TIMED_OUT"));
    expect(read).toContain("it only reads, so nothing changed");
    expect(read).not.toContain("unknown");
    const refused = workflowMessage(en, stoppedReport({ status: "refused" }, "POLICY_REFUSED"));
    expect(refused).toContain("your policy does not allow this step, so it was not sent");
  });

  it("says a run stopped before any step was sent changed nothing", () => {
    const report: ActionWorkflowReport = {
      completed: false,
      stoppedAt: "fetch",
      code: "WORKFLOW_STOPPED",
      message: ENGLISH_REASON,
      steps: [{ stepId: "fetch", kind: "invoke", status: "not-run" }],
    };
    expect(workflowMessage(vi, report)).toBe(
      "Quy trình dừng ở bước “fetch”: bạn đã dừng quy trình trước khi bước này chạy. Chưa có bước nào gọi dịch vụ, nên không có gì bị thay đổi.",
    );
  });

  it("counts a completed run and names what a condition skipped", () => {
    const report: ActionWorkflowReport = {
      completed: true,
      message: ENGLISH_REASON,
      steps: [
        { stepId: "fetch", kind: "invoke", status: "done" },
        { stepId: "check", kind: "condition", status: "skipped" },
      ],
    };
    expect(workflowMessage(en, report)).toBe("Ran 1 of 2 steps. “check” skipped because a condition was not met.");
  });
});

describe("an answered press", () => {
  const base: ActionInvocationResult = {
    duplicate: false,
    instanceId: "wi_1",
    revision: 1,
    stateRevision: 0,
    state: {},
    pinId: null,
    timeline: {} as ActionInvocationResult["timeline"],
    message: ENGLISH_REASON,
  };

  it("shows a service's or Clark's output as it came, and says the rest itself", () => {
    expect(actionResultMessage(vi, { ...base, outcome: "done", output: "42" })).toBe("42");
    expect(actionResultMessage(vi, { ...base, outcome: "done" })).toBe(MESSAGES_VI["widgets.action.done"]);
    expect(actionResultMessage(vi, { ...base, outcome: "background" })).toBe(MESSAGES_VI["widgets.action.background"]);
    expect(actionResultMessage(vi, { ...base, outcome: "job", job: { jobId: "job_1" }, output: "job_1" })).toBe(MESSAGES_VI["widgets.action.job"]);
    expect(actionResultMessage(vi, { ...base, outcome: "approval-required", approvalRequired: { approvalId: "ap_1" } })).toBe(
      MESSAGES_VI["widgets.action.awaitingApproval"],
    );
  });

  it("says a workflow waiting on one step's approval from its report, not the node's English", () => {
    const workflow: ActionWorkflowReport = {
      completed: false,
      stoppedAt: "save",
      code: "APPROVAL_REQUIRED",
      message: ENGLISH_REASON,
      steps: [
        { stepId: "fetch", kind: "invoke", status: "done" },
        { stepId: "save", kind: "invoke", status: "awaiting-approval" },
      ],
    };
    const said = actionResultMessage(vi, { ...base, outcome: "approval-required", approvalRequired: { approvalId: "ap_1" }, workflow });
    expect(said).toContain("Duyệt chỉ chạy riêng bước này");
    expect(said).not.toContain(ENGLISH_REASON);
  });
});
