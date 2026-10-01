import type { ActionInvocationResult, ActionWorkflowReport } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * What a press of a bound button came to, said in the person's language.
 *
 * The node answers with a code, a sentence in English for logs and agents, and structured details. What a person reads
 * is built here from the code and the details alone, so a Vietnamese page never shows the node's English and never a
 * raw code. Every sentence says what happened, what was kept, and what happens next — and names the inbox only when
 * the node says it recorded the question there (`recorded`).
 */

type Translate = (key: MessageKey) => string;

/** Refusals decided before anything ran, each a whole sentence. */
const REFUSAL_KEYS: Record<string, MessageKey> = {
  TURN_IN_PROGRESS: "widgets.action.turnInProgress",
  REVISION_MISMATCH: "widgets.action.revisionMismatch",
  WORKFLOW_UNSUPPORTED: "widgets.action.unavailable.WORKFLOW_UNSUPPORTED",
  NOT_A_SERVICE_CAPABILITY: "widgets.action.unavailable.NOT_A_SERVICE_CAPABILITY",
  BINDING_STALE: "widgets.action.unavailable.BINDING_STALE",
  CAPABILITY_NOT_READY: "widgets.action.unavailable.CAPABILITY_NOT_READY",
  CAPABILITY_NOT_AUTHENTICATED: "widgets.action.unavailable.CAPABILITY_NOT_AUTHENTICATED",
  CAPABILITY_MISSING: "widgets.action.unavailable.CAPABILITY_MISSING",
  TOKEN_BUDGET_EXCEEDED: "widgets.action.refused.TOKEN_BUDGET_EXCEEDED",
  CONTEXT_REF_UNKNOWN: "widgets.action.refused.CONTEXT_REF_UNKNOWN",
  CONTEXT_REF_FORBIDDEN: "widgets.action.refused.CONTEXT_REF_FORBIDDEN",
  CONTEXT_REF_UNSUPPORTED: "widgets.action.refused.CONTEXT_REF_UNSUPPORTED",
  BACKGROUND_UNAVAILABLE: "widgets.action.refused.BACKGROUND_UNAVAILABLE",
  INVOCATION_IN_PROGRESS: "widgets.action.refused.INVOCATION_IN_PROGRESS",
  LEDGER_UNAVAILABLE: "widgets.action.refused.LEDGER_UNAVAILABLE",
  INSTANCE_UNKNOWN: "widgets.action.refused.INSTANCE_UNKNOWN",
  ACTION_UNKNOWN: "widgets.action.refused.ACTION_UNKNOWN",
  NOT_AUTHORIZED: "widgets.action.refused.NOT_AUTHORIZED",
  INVOCATION_KEY_REUSED: "widgets.action.refused.INVOCATION_KEY_REUSED",
  APPROVAL_UNAVAILABLE: "widgets.action.refused.APPROVAL_UNAVAILABLE",
  SERVICE_CANCELLED: "widgets.action.refused.SERVICE_CANCELLED",
  INVALID_INPUT: "widgets.action.refused.INVALID_INPUT",
  POLICY_REFUSED: "widgets.action.refused.POLICY_REFUSED",
  SERVICE_NOT_RUNNING: "widgets.action.refused.SERVICE_NOT_RUNNING",
};

/**
 * The sentence for a binding the node says cannot run at all, such as one whose capability is missing or not signed in,
 * or undefined for any other code. A chart's own view binding is refused for its own reasons, and says those itself.
 */
export function bindingUnavailableMessage(t: Translate, code: string | undefined): string | undefined {
  const key = code === undefined ? undefined : REFUSAL_KEYS[code];
  return key !== undefined && key.startsWith("widgets.action.unavailable.") ? t(key) : undefined;
}

/**
 * Why a call that was sent has no answer that can be trusted, as the opening of the sentence. Each ends by saying
 * whether it took effect is unknown; what happens next is added from `recorded`.
 */
const UNCERTAIN_KEYS: Record<string, MessageKey> = {
  SERVICE_CANCELLED: "widgets.action.uncertain.SERVICE_CANCELLED",
  SERVICE_TIMED_OUT: "widgets.action.uncertain.SERVICE_TIMED_OUT",
  SERVICE_TOOL_FAILED: "widgets.action.uncertain.SERVICE_TOOL_FAILED",
  SERVICE_UNREACHABLE: "widgets.action.uncertain.SERVICE_UNREACHABLE",
};

/** Why a workflow step that was sent has no trusted answer, as a clause inside the step's sentence. */
const STEP_UNCERTAIN_KEYS: Record<string, MessageKey> = {
  WORKFLOW_STOPPED: "widgets.workflow.why.stopped",
  WORKFLOW_DEADLINE: "widgets.workflow.why.deadline",
  SERVICE_CANCELLED: "widgets.workflow.why.stopped",
  SERVICE_TIMED_OUT: "widgets.workflow.why.timedOut",
  SERVICE_TOOL_FAILED: "widgets.workflow.why.toolFailed",
};

/** Why a step was refused before it was sent, as a clause. */
const STEP_REFUSED_KEYS: Record<string, MessageKey> = {
  POLICY_REFUSED: "widgets.workflow.refused.POLICY_REFUSED",
  SERVICE_NOT_RUNNING: "widgets.workflow.refused.SERVICE_NOT_RUNNING",
  CAPABILITY_NOT_READY: "widgets.workflow.refused.SERVICE_NOT_RUNNING",
  BINDING_STALE: "widgets.workflow.refused.BINDING_STALE",
  LEDGER_UNAVAILABLE: "widgets.workflow.refused.LEDGER_UNAVAILABLE",
};

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `“${id}”`).join(", ");
}

/** What happens next for a call whose outcome is unknown: the inbox asks only when the node recorded that question. */
function nextStep(t: Translate, recorded: unknown): string {
  return t(recorded === true ? "widgets.action.uncertain.next.inbox" : "widgets.action.uncertain.next.say");
}

/** A workflow's report, said from its steps: where it stopped and why, what ran and stays done, what did not run. */
export function workflowMessage(t: Translate, report: ActionWorkflowReport): string {
  const { steps } = report;
  if (report.completed) {
    const done = steps.filter((step) => step.status === "done").length;
    const skipped = steps.filter((step) => step.status === "skipped").map((step) => step.stepId);
    const ran = fill(t("widgets.workflow.completed"), { done: String(done), total: String(steps.length) });
    return skipped.length === 0 ? ran : `${ran} ${fill(t("widgets.workflow.skipped"), { steps: quoted(skipped) })}`;
  }
  const stopped = steps.find((step) => step.stepId === report.stoppedAt);
  const code = report.code ?? "";
  let why: string;
  if (stopped === undefined || stopped.status === "not-run") {
    why = t(code === "WORKFLOW_STOPPED" ? "widgets.workflow.before.stopped" : "widgets.workflow.before.deadline");
  } else if (stopped.status === "awaiting-approval") {
    why = t("widgets.workflow.awaitingApproval");
  } else if (stopped.status === "uncertain") {
    const clause = t(STEP_UNCERTAIN_KEYS[code] ?? "widgets.workflow.why.unreachable");
    why = `${fill(t("widgets.workflow.uncertain"), { why: clause })} ${nextStep(t, stopped.recorded)}`;
  } else if (stopped.status === "failed") {
    why = t(stopped.readOnly === true ? "widgets.workflow.readFailed" : "widgets.workflow.transformFailed");
  } else {
    why = t(STEP_REFUSED_KEYS[code] ?? "widgets.workflow.refused.generic");
  }
  const ran = steps.filter((step) => step.status === "done" && step.kind === "invoke").map((step) => step.stepId);
  const reachedService = stopped !== undefined && stopped.kind === "invoke" && (stopped.status === "uncertain" || stopped.status === "failed");
  const kept =
    ran.length > 0
      ? fill(t("widgets.workflow.kept"), { steps: quoted(ran) })
      : t(reachedService ? "widgets.workflow.noneBefore" : "widgets.workflow.nothingChanged");
  const notRun = steps.filter((step) => step.status === "not-run" && step.stepId !== report.stoppedAt).map((step) => step.stepId);
  const rest = notRun.length === 0 ? "" : ` ${fill(t("widgets.workflow.notRun"), { steps: quoted(notRun) })}`;
  return `${fill(t("widgets.workflow.stoppedAt"), { step: quoted([report.stoppedAt ?? ""]) })} ${why} ${kept}${rest}`;
}

/** A refused press, from the node's code and details. */
export function actionRefusalMessage(
  t: Translate,
  refusal: { code: string | undefined; reason: string | undefined; details: Record<string, unknown> },
): string {
  const { code, details } = refusal;
  const workflow = details.workflow as ActionWorkflowReport | undefined;
  if (workflow !== undefined && typeof workflow === "object" && Array.isArray(workflow.steps)) return workflowMessage(t, workflow);
  if (code === "ACTION_INTERRUPTED") return t("widgets.action.uncertain.ACTION_INTERRUPTED");
  if (details.outcome === "uncertain") {
    const opening = t(UNCERTAIN_KEYS[code ?? ""] ?? "widgets.action.uncertain");
    return `${opening} ${nextStep(t, details.recorded)}`;
  }
  if (details.readOnly === true) return t("widgets.action.readFailed");
  if (code === "RATE_LIMITED") {
    const seconds = typeof details.retryAfterMs === "number" ? Math.max(1, Math.ceil(details.retryAfterMs / 1000)) : 60;
    const limit = typeof details.limit === "number" ? details.limit : 1;
    return fill(t("widgets.action.refused.RATE_LIMITED"), { limit: String(limit), seconds: String(seconds) });
  }
  const key = code === undefined ? undefined : REFUSAL_KEYS[code];
  if (key !== undefined) return t(key);
  // A code this page does not know yet: the node's own sentence is still the real answer.
  return refusal.reason ?? t("widgets.action.refusedGeneric");
}

/** An answered press. A service's or Clark's own output is shown as it came; a workflow's report is said here. */
export function actionResultMessage(t: Translate, result: ActionInvocationResult): string {
  if (result.outcome === "background") return t("widgets.action.background");
  // The output of a job outcome is its JobRef, which is for the widget; the person is told what started.
  if (result.outcome === "job") return t("widgets.action.job");
  if (result.approvalRequired !== undefined) {
    return result.workflow === undefined ? t("widgets.action.awaitingApproval") : workflowMessage(t, result.workflow);
  }
  if (result.duplicate) return t("widgets.action.duplicate");
  if (typeof result.output === "string" && result.output !== "") return result.output;
  if (result.pinId !== null) return t("widgets.action.pinned");
  return result.workflow === undefined ? t("widgets.action.done") : workflowMessage(t, result.workflow);
}
