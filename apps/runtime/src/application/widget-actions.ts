import { randomUUID } from "node:crypto";

import {
  type ActionBinding,
  type ActionProposal,
  type FormField,
  type Instant,
  type ListItem,
  type WidgetInstance,
  type TurnOrigin,
  type WidgetPerformRequest,
  type WorkflowRunReport,
  PAGE_PERFORM_REFUSAL_CODES,
  VIEW_STATE_WRITE_VARIANT,
  WIDGET_PERFORM_VERSION,
  approvalCardBlockSchema,
  checkFormValues,
  describeFieldValue,
} from "@clarkcant/contracts";
import {
  type BoundActionCheck,
  type BoundActionResult,
  checkBoundAction,
  checkInvokeAction,
  decideExecution,
  forgetStartedInvokeAction,
  getActionBinding,
  getInstance,
  handleUserMessage,
  invokeMiniAppAction,
  readExecutionPolicy,
  readWidgetStateRow,
  recordInvokeAction,
  requestApproval,
  reservedInvocationIdRefusal,
  settleInvokeAction,
  writeViewState,
} from "@clarkcant/core";
import { appendAuditEvent, asJsonValue, hasUnsettledEffect, listConversationInstanceIds, payloadDigest } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";

import { readArtifactForContext } from "../artifact-broker.ts";
import { appendHostReply, blocksOfConversation, startBackgroundWork } from "../routes/conversations.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { AGENT_ITEM_KEY } from "./action-bindings.ts";
import { estimateTokens, renderActionContext, resolveActionContext } from "./action-context.ts";
import { type OpenedActionEffect, effectOperationDigest, openActionEffect, settleActionEffect } from "./action-effects.ts";
import { ACTION_LIMITS, admitCall, bindingLimits, rateLimitedMessage } from "./action-limits.ts";
import { actionRunning, beginActionRun, endActionRun } from "./action-runs.ts";
import {
  type CapabilityInvokeOutcome,
  type CapabilityInvokeRequest,
  type CapabilityLedgerHooks,
  type CapabilityInvokeSource,
  capabilityInvokeDeps,
  invokeCapability,
  validateArgs,
} from "./capability-invoke.ts";
import { type StepCall, runWorkflow } from "./workflow-executor.ts";
import type { WidgetPerformAwaited } from "../widget-perform-acks.ts";

const FORM_DEFINITION_ID = "canvas.form@1";
const LIST_DEFINITION_ID = "canvas.list@1";

function fieldsOf(instance: WidgetInstance): FormField[] {
  return Array.isArray(instance.props.fields) ? (instance.props.fields as FormField[]) : [];
}

function itemsOf(instance: WidgetInstance): ListItem[] {
  return Array.isArray(instance.props.items) ? (instance.props.items as ListItem[]) : [];
}

/**
 * Why the input a use of an action sent is not one it accepts, or `undefined` when it is.
 *
 * Checked by the node whatever the page already checked: the page can be bypassed, and the binding's recorded schema is
 * the host's own statement of what it accepts. A form's values are held to its fields' own rules as well — a date range
 * that ends before it starts is valid JSON — with the same function the page runs, so the two can only disagree when the
 * page was not the one that sent them.
 */
export function actionInputProblem(instance: WidgetInstance, binding: ActionBinding, input: Record<string, unknown>): string | undefined {
  if (instance.definitionRef.id === FORM_DEFINITION_ID) {
    const fields = fieldsOf(instance);
    const problems = checkFormValues(fields, input);
    const named = Object.entries(problems).map(([name, problem]) => {
      const label = fields.find((field) => field.name === name)?.label ?? name;
      return `${label}: ${problem}`;
    });
    if (named.length > 0) return named.slice(0, 5).join("; ");
  }
  const checked = validateArgs(binding.inputSchema, input);
  return checked.ok ? undefined : checked.message;
}

/** What a turn a form or a list item started says in the conversation: what the person pressed, and what they sent. */
function agentActionText(instance: WidgetInstance, label: string, input: Record<string, unknown>): string {
  if (instance.definitionRef.id === FORM_DEFINITION_ID) {
    const lines = fieldsOf(instance)
      .filter((field) => Object.hasOwn(input, field.name))
      .map((field) => `${field.label}: ${describeFieldValue(field, input[field.name])}`);
    return lines.length === 0 ? label : `${label}\n${lines.join("\n")}`;
  }
  if (instance.definitionRef.id === LIST_DEFINITION_ID) {
    const item = itemsOf(instance).find((entry) => entry.id === input[AGENT_ITEM_KEY]);
    return item === undefined ? label : `${label}: ${item.title}`;
  }
  return label;
}

/**
 * Widget actions: the cursor a spoken action is checked against, and the invocation itself.
 *
 * Both the conversation route and the voice session call these, so they live here rather than in either
 * caller. `services` is a parameter, not a lookup, narrowed to the fields each function reads, and the policy is
 * read at the invocation rather than captured, so a mode the user just changed applies to the next action they
 * take.
 */

/**
 * The revision and binding digest a spoken action is checked against, read from the node's own state.
 *
 * A click brings a cursor: the revision it saw, and the digest of the binding it was shown. A spoken sentence brings
 * nothing at all, so there is nothing to trust and nothing to be stale relative to - the node reads what it holds.
 * That is also why this refuses an action the instance no longer announces: the sentence was matched against a view
 * the page sent, and the page's view may be older than the instance.
 */
export function widgetActionTarget(
  services: Pick<NodeServices, "conductor">,
  instanceId: string,
  actionBindingId: string,
): { revision: number; bindingDigest: string; kind: string } | undefined {
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined) return undefined;
  if (!instance.actionBindingIds.includes(actionBindingId)) return undefined;
  const binding = getActionBinding(services.conductor, actionBindingId);
  if (binding === undefined) return undefined;
  return { revision: instance.revision, bindingDigest: binding.bindingDigest, kind: binding.proposal.kind };
}

/** One widget action invocation, as either a click or a spoken command asks for it. */
export interface WidgetActionRequest {
  conversationId: string;
  principalId: string;
  instanceId: string;
  actionBindingId: string;
  expectedRevision: number;
  expectedBindingDigest: string;
  input: Record<string, unknown>;
  invocationId: string;
  /** A player's write sequence, carried only by the state-only write (`writeWidgetViewState`). */
  sequence?: number;
}

/**
 * What an action came to.
 *
 * A body that arrives says what happened in `outcome`: `done`, `approval-required` (a host card waits in the
 * conversation) or `background` (the node's background lane took it, and its result arrives in the conversation). A
 * refusal carries its code and a sentence; `detail` adds what a surface needs to tell a refusal that changed nothing
 * from one that may have — `outcome: "uncertain"` for a call whose answer never came, `outcome: "partial"` for a
 * workflow that stopped after some steps ran — and a workflow's report of every step.
 */
export type WidgetActionResult =
  | { ok: true; status: 200 | 202; body: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      currentRevision?: number;
      detail?: Record<string, unknown>;
    };

function statusOf(code: string): number {
  switch (code) {
    case "INSTANCE_UNKNOWN":
    case "ACTION_UNKNOWN":
    case "CONTEXT_REF_UNKNOWN":
      return 404;
    case "NOT_AUTHORIZED":
    case "CONTEXT_REF_FORBIDDEN":
    case "POLICY_REFUSED":
    case "ARTIFACT_INPUT_REFUSED":
      return 403;
    case "REVISION_MISMATCH":
    case "BINDING_STALE":
    case "INVOCATION_KEY_REUSED":
    case "INVOCATION_IN_PROGRESS":
    case "ACTION_INTERRUPTED":
    case "TURN_IN_PROGRESS":
    case "SERVICE_CANCELLED":
    case "WORKFLOW_STOPPED":
    case "FRAME_NOT_MOUNTED":
    case "FRAME_NOT_READY":
    case "SURFACE_GONE":
    case "PERFORM_IN_PROGRESS":
    case "PERFORM_BUSY":
    case "PERFORM_OUTCOME_UNKNOWN":
    case "WIDGET_REFUSED":
    case "WIDGET_PERFORM_STOPPED":
      return 409;
    case "RATE_LIMITED":
    case "JOB_LIMIT_REACHED":
    case "PERFORM_CARDS_WAITING":
      return 429;
    case "ARTIFACT_INPUT_TOO_LARGE":
    case "PERFORM_INPUT_TOO_LONG":
      return 413;
    case "SERVICE_TOOL_FAILED":
      return 502;
    case "SERVICE_NOT_RUNNING":
    case "CAPABILITY_NOT_READY":
    case "BACKGROUND_UNAVAILABLE":
    case "LEDGER_UNAVAILABLE":
    case "JOB_HOST_UNAVAILABLE":
      return 503;
    case "SERVICE_TIMED_OUT":
    case "SERVICE_UNREACHABLE":
    case "WORKFLOW_DEADLINE":
    case "WIDGET_NO_ANSWER":
      return 504;
    default:
      return 400;
  }
}

function refusal(code: string, message: string, detail?: Record<string, unknown>): WidgetActionResult {
  return { ok: false, status: statusOf(code), code, message, ...(detail === undefined ? {} : { detail }) };
}

function gateRefusal(checked: Extract<BoundActionCheck, { ok: false }>): WidgetActionResult {
  return {
    ok: false,
    status: statusOf(checked.code),
    code: checked.code,
    message: checked.message,
    ...(checked.currentRevision === undefined ? {} : { currentRevision: checked.currentRevision }),
  };
}

export type WidgetActionServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "serviceHost" | "turnControl" | "packageJobs">;

type Admitted = Extract<BoundActionCheck, { ok: true }>;

/** The body every kind answers with, so a surface reads them the same way: the instance as it now is, and the page. */
function actionBody(
  services: WidgetActionServices,
  checked: Admitted,
  conversationId: string,
  duplicate: boolean,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const state = readWidgetStateRow(services.runtime.db, checked.instance.instanceId);
  return {
    duplicate,
    instanceId: checked.instance.instanceId,
    revision: checked.instance.revision,
    stateRevision: state?.revision ?? 0,
    state: state?.body ?? {},
    pinId: null,
    ...extra,
    timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
  };
}

/**
 * A press that started a durable job. `output` carries the JobRef as well, because a frame reads a binding's answer
 * there; the job itself, not this answer, says how it is going.
 */
function jobBody(jobId: string): Record<string, unknown> {
  return { outcome: "job", job: { jobId }, output: jobId };
}

/** Why a call that was sent has no answer that can be trusted, as a clause of the sentence the person reads. */
function noAnswerClause(code: string, message: string, deadlineMs: number | undefined): string {
  switch (code) {
    case "SERVICE_CANCELLED":
      return "you stopped it before the service answered";
    case "SERVICE_TIMED_OUT":
      return `the service did not answer within ${String(Math.ceil((deadlineMs ?? 60_000) / 1000))} s`;
    case "SERVICE_TOOL_FAILED":
      return `the service answered with an error (${message.slice(0, 200)}) after it may have done part of the work`;
    default:
      return "the service stopped answering while it ran";
  }
}

/**
 * A call sent without an answer that can be trusted, as the person is told it: what was sent, why it is unknown, what
 * happens next — the inbox only when the ledger really holds the question.
 */
function uncertainMessage(label: string, code: string, message: string, deadlineMs: number | undefined, recorded: boolean): string {
  const next = recorded
    ? "The inbox asks you to say whether it did."
    : "Say in the conversation whether it did before pressing it again.";
  return `“${label}” was sent, but ${noAnswerClause(code, message, deadlineMs)}, so whether it took effect is unknown. It was not retried. ${next}`;
}

/**
 * The effect-ledger hooks around one capability call made for a person: `beforeSend` opens the entry once the call is
 * decided (a `read` opens none), and `onJobSettled` settles it when a durable job the call started ends. A synchronous
 * call is settled by its caller on the answer, through `opened()`. Shared by a widget press and an approved card, so
 * both leave the same record of what was sent.
 */
export function actionLedgerHooks(
  services: Pick<NodeServices, "runtime" | "conductor">,
  call: { conversationId: string; principalId: string; intent: string; ref: string; args: Record<string, unknown> },
): { hooks: CapabilityLedgerHooks; opened: () => OpenedActionEffect | undefined } {
  let opened: OpenedActionEffect | undefined;
  return {
    opened: () => opened,
    hooks: {
      beforeSend: ({ effectCategory }) => {
        if (effectCategory === "read") return;
        opened = openActionEffect(services, {
          conversationId: call.conversationId,
          principalId: call.principalId,
          capabilityRef: call.ref,
          args: call.args,
          intent: call.intent,
          effectCategory,
        });
      },
      onJobSettled: (jobOutcome) => {
        if (opened === undefined) return;
        if (jobOutcome.sent === false) {
          settleActionEffect(services, opened, { kind: "not-sent", reason: "the package job ended before the service request was sent" });
          return;
        }
        if (jobOutcome.status === "completed") {
          settleActionEffect(services, opened, { kind: "answered", evidence: `the package job completed: ${call.ref}` });
          return;
        }
        settleActionEffect(services, opened, {
          kind: "no-answer",
          stopped: jobOutcome.status === "cancelled",
          reason: `the package job ${jobOutcome.status}; its effect may have happened before the service stopped answering`,
        });
      },
    },
  };
}

/**
 * One service call a press makes, inside the effect ledger.
 *
 * The ledger entry is opened by `invokeCapability`'s `beforeSend`, after the registry, the schema and the policy have
 * all said yes and before anything is sent, so a node that dies mid-call leaves a `submitted` row for boot recovery to
 * turn into an inbox question. It is settled here on what came back. A `read` opens nothing: asking again changes nothing.
 * A ledger that cannot be written refuses the call with nothing sent (`LEDGER_UNAVAILABLE`).
 */
async function callInLedger(
  services: WidgetActionServices,
  call: { conversationId: string; principalId: string; intent: string; request: Omit<CapabilityInvokeRequest, "beforeSend"> },
): Promise<StepCall & { taskId?: string }> {
  const ledger = actionLedgerHooks(services, {
    conversationId: call.conversationId,
    principalId: call.principalId,
    intent: call.intent,
    ref: call.request.ref,
    args: call.request.args,
  });
  let outcome: CapabilityInvokeOutcome;
  try {
    outcome = await invokeCapability(capabilityInvokeDeps(services), { ...call.request, ...ledger.hooks });
  } catch (cause) {
    // Thrown on this node before the call was sent: a service's failure is an answer, not a throw.
    const opened = ledger.opened();
    if (opened !== undefined) {
      settleActionEffect(services, opened, { kind: "not-sent", reason: cause instanceof Error ? cause.message : String(cause) });
    }
    throw cause;
  }
  const opened = ledger.opened();
  const settled = settleCallOutcome(services, opened, outcome);
  return { outcome, recorded: settled.recorded, ...(settled.recorded && opened !== undefined ? { taskId: opened.taskId } : {}) };
}

/**
 * Settle the ledger entry a call's `beforeSend` opened, on what the call came back with: an answer closes it, a call
 * that never left closes it as not sent, and a call sent without a trustworthy answer stays a question for the person.
 * A job is left open here; its `onJobSettled` closes it when the job ends. Shared by a widget press and an approved
 * card, so neither leaves an entry open after a plain answer.
 */
export function settleCallOutcome(
  services: Pick<NodeServices, "runtime" | "conductor">,
  opened: OpenedActionEffect | undefined,
  outcome: CapabilityInvokeOutcome,
): { recorded: boolean } {
  if (opened === undefined || outcome.kind === "job" || outcome.kind === "approval-required") return { recorded: false };
  if (outcome.kind === "done") {
    settleActionEffect(services, opened, { kind: "answered", evidence: `the service answered: ${outcome.output.slice(0, 200)}` });
    return { recorded: false };
  }
  if (!outcome.sent) {
    settleActionEffect(services, opened, { kind: "not-sent", reason: outcome.message });
    return { recorded: false };
  }
  return settleActionEffect(services, opened, {
    kind: "no-answer",
    stopped: outcome.code === "SERVICE_CANCELLED",
    reason: `no answer that can be trusted came back: ${outcome.message}`,
  });
}

/** An outcome of a workflow run, as the response carries it: its report, and whether anything it ran is kept. */
function workflowResult(
  services: WidgetActionServices,
  checked: Admitted,
  conversationId: string,
  report: WorkflowRunReport,
  duplicate: boolean,
): WidgetActionResult {
  if (report.completed) {
    return {
      ok: true,
      status: 200,
      body: actionBody(services, checked, conversationId, duplicate, {
        outcome: "done",
        output: report.output ?? "",
        message: report.message,
        workflow: report,
      }),
    };
  }
  const waiting = report.steps.find((step) => step.status === "awaiting-approval");
  if (waiting !== undefined) {
    return {
      ok: true,
      status: 202,
      body: actionBody(services, checked, conversationId, duplicate, {
        outcome: "approval-required",
        approvalRequired: { approvalId: waiting.detail ?? "" },
        message: report.message,
        workflow: report,
      }),
    };
  }
  const uncertain = report.steps.find((step) => step.status === "uncertain");
  const ran = report.steps.some((step) => step.status === "done" && step.kind === "invoke");
  return refusal(report.code ?? "WORKFLOW_STEP_FAILED", report.message, {
    outcome: uncertain !== undefined ? "uncertain" : ran ? "partial" : "refused",
    ...(uncertain !== undefined ? { mayHaveRun: true, recorded: uncertain.recorded === true } : {}),
    workflow: report,
  });
}

/**
 * The same invocation arriving again: its first outcome, returned rather than repeated.
 *
 * `started` is the one record that is not an outcome. With the run still going, the second request is told so; with no
 * run going, the node stopped while it ran — the record outlived the process — and its effect is unknown. It is not run a
 * second time either way.
 */
function replay(
  services: WidgetActionServices,
  checked: Admitted,
  request: WidgetActionRequest,
  prior: BoundActionResult,
): WidgetActionResult {
  const body = (status: 200 | 202, extra: Record<string, unknown>): WidgetActionResult => ({
    ok: true,
    status,
    body: actionBody(services, checked, request.conversationId, true, extra),
  });
  switch (prior.kind) {
    case "done":
      return body(200, { outcome: "done", output: prior.output });
    case "approval-required":
      return body(202, { outcome: "approval-required", approvalRequired: { approvalId: prior.approvalId } });
    case "background":
      return body(202, { outcome: "background", background: { workId: prior.workId, state: prior.state } });
    case "job":
      return body(202, jobBody(prior.jobId));
    case "workflow":
      return workflowResult(services, checked, request.conversationId, prior.report, true);
    case "uncertain":
      // A task id is recorded only when the ledger holds the question, so its presence is what "recorded" means.
      return refusal(prior.code, prior.message, {
        outcome: "uncertain",
        mayHaveRun: true,
        recorded: prior.taskId !== undefined,
        ...(prior.taskId === undefined ? {} : { taskId: prior.taskId }),
      });
    case "started":
      // The node stopped while it ran. A call it had sent left a `submitted` ledger row, which boot recovery turned
      // into an inbox question; a turn or a read left none, so the words promise nothing about the inbox.
      return actionRunning(request.invocationId)
        ? refusal("INVOCATION_IN_PROGRESS", "this action is already running; its answer will come back to the first request")
        : refusal(
            "ACTION_INTERRUPTED",
            `“${checked.binding.label}” started before this node restarted and never reported back, so whether it took effect is unknown. It was not run again; check before pressing it anew.`,
            { outcome: "uncertain", mayHaveRun: true },
          );
  }
}

/**
 * Admit one use against the binding's per-minute limit and start tracking it, or say why not.
 *
 * Synchronous from the gate to here on purpose: two requests with one invocation id cannot both pass, because the first
 * has either written its `started` record or is registered as running before the second is looked at.
 */
function admit(
  services: WidgetActionServices,
  checked: Admitted,
  request: WidgetActionRequest,
  perMinute: number,
  options: { stoppable?: boolean } = {},
): { ok: true; controller: AbortController } | { ok: false; result: WidgetActionResult } {
  const rate = admitCall(checked.binding.actionBindingId, perMinute);
  if (!rate.allowed) {
    return {
      ok: false,
      result: refusal("RATE_LIMITED", rateLimitedMessage(rate), { retryAfterMs: rate.retryAfterMs, limit: rate.limit }),
    };
  }
  const controller = beginActionRun({
    invocationId: request.invocationId,
    conversationId: request.conversationId,
    ...(options.stoppable === undefined ? {} : { stoppable: options.stoppable }),
  });
  if (controller === undefined) {
    return {
      ok: false,
      result: refusal("INVOCATION_IN_PROGRESS", "this action is already running; its answer will come back to the first request"),
    };
  }
  recordInvokeAction(services.conductor, {
    invocationId: request.invocationId,
    actionBindingId: request.actionBindingId,
    instanceId: checked.instance.instanceId,
    digest: checked.digest,
    result: { kind: "started", at: new Date().toISOString() },
  });
  return { ok: true, controller };
}

function settle(services: WidgetActionServices, checked: Admitted, request: WidgetActionRequest, result: BoundActionResult): void {
  settleInvokeAction(services.conductor, { invocationId: request.invocationId, digest: checked.digest, result });
}

/**
 * The `invoke` half: a widget button that calls a package's service capability.
 *
 * The widget gate runs first — owner, conversation, binding, revision, digest, one outcome per invocation id — and then
 * the same `invokeCapability` the agent's tool and a spoken command reach, so the registry, the input schema and the
 * policy answer a click exactly as they answer a sentence. When the policy asks, the question is a host card in this
 * conversation: the frame is told it is waiting, and nothing it sends can answer it.
 *
 * The call is bounded by the binding's deadline and stoppable by the conversation's Stop, and runs inside the effect
 * ledger (`callInLedger`). A call that was sent and then came back without an answer that can be trusted — no answer in
 * time, a Stop, the service going away mid-call, an error after it may have done part of the work — is not reported as
 * refused: the service may have done it. It is recorded as uncertain against the invocation id, so the same id is
 * answered with that again and never sent a second time, and it is never retried by the node. Only a refusal decided
 * before anything was sent frees the id, and so does a `read`, which changed nothing whatever happened.
 */
async function invokeCapabilityAction(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  source: CapabilityInvokeSource,
  origin?: TurnOrigin,
): Promise<WidgetActionResult> {
  const checked = checkInvokeAction(services.conductor, request);
  if (!checked.ok) return gateRefusal(checked);
  if (checked.duplicate !== undefined) return replay(services, checked, request, checked.duplicate);
  const problem = actionInputProblem(checked.instance, checked.binding, request.input);
  if (problem !== undefined) return refusal("INVALID_INPUT", problem);

  const limits = bindingLimits(checked.binding);
  const admitted = admit(services, checked, request, limits.maxCallsPerMinute ?? ACTION_LIMITS.invoke.maxCallsPerMinute?.default ?? 1);
  if (!admitted.ok) return admitted.result;

  const ref = checked.proposal.capabilityRef;
  let call: Awaited<ReturnType<typeof callInLedger>>;
  try {
    call = await callInLedger(services, {
      conversationId: request.conversationId,
      principalId: request.principalId,
      intent: `${checked.binding.label} (${ref})`,
      request: {
        ref,
        args: checked.args,
        source,
        conversationId: request.conversationId,
        bindingGeneration: checked.binding.packageGeneration,
        jobOrigin: { instanceId: request.instanceId, actionBindingId: request.actionBindingId, invocationId: request.invocationId },
        ...(limits.deadlineMs === undefined ? {} : { timeoutMs: limits.deadlineMs }),
        signal: admitted.controller.signal,
        ...(origin === undefined ? {} : { origin }),
      },
    });
  } catch (cause) {
    // Thrown before anything was sent, so there is nothing the same id could repeat.
    forgetStartedInvokeAction(services.conductor, request.invocationId);
    throw cause;
  } finally {
    endActionRun(request.invocationId);
  }
  const { outcome } = call;

  if (outcome.kind === "refused") {
    if (!outcome.sent) {
      // Decided before the service was asked, or never written to it: nothing changed, and the id is freed so a press
      // after whatever refused it has changed can run.
      forgetStartedInvokeAction(services.conductor, request.invocationId);
      return { ok: false, status: outcome.status, code: outcome.code, message: outcome.message };
    }
    if (outcome.effectCategory === "read") {
      forgetStartedInvokeAction(services.conductor, request.invocationId);
      return refusal(
        outcome.code,
        `“${checked.binding.label}” did not finish: ${noAnswerClause(outcome.code, outcome.message, limits.deadlineMs)}. It only reads, so nothing changed and pressing it again is safe.`,
        { outcome: "refused", readOnly: true },
      );
    }
    const said = uncertainMessage(checked.binding.label, outcome.code, outcome.message, limits.deadlineMs, call.recorded);
    settle(services, checked, request, {
      kind: "uncertain",
      code: outcome.code,
      message: said,
      ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
    });
    return refusal(outcome.code, said, {
      outcome: "uncertain",
      mayHaveRun: true,
      recorded: call.recorded,
      ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
    });
  }

  if (outcome.kind === "approval-required") {
    settle(services, checked, request, { kind: "approval-required", approvalId: outcome.approval.approvalId });
    appendHostReply(services, {
      conversationId: request.conversationId,
      blocks: [outcome.card],
      at: new Date().toISOString() as Instant,
    });
    return {
      ok: true,
      status: 202,
      body: actionBody(services, checked, request.conversationId, false, {
        outcome: "approval-required",
        approvalRequired: { approvalId: outcome.approval.approvalId },
      }),
    };
  }
  if (outcome.kind === "job") {
    settle(services, checked, request, { kind: "job", jobId: outcome.job.jobId });
    return {
      ok: true,
      status: 202,
      body: actionBody(services, checked, request.conversationId, false, jobBody(outcome.job.jobId)),
    };
  }
  settle(services, checked, request, { kind: "done", output: outcome.output });
  return {
    ok: true,
    status: 200,
    body: actionBody(services, checked, request.conversationId, false, { outcome: "done", output: outcome.output }),
  };
}

/** What the model is told about a turn a button started, beside the label the person saw. */
function agentActionNote(label: string, intent: string, input: Record<string, unknown>): string {
  const sent = Object.keys(input).length === 0 ? "" : `\nWhat they sent with it, as the host checked it: ${JSON.stringify(input)}`;
  return (
    `The person pressed the button "${label}" that you offered earlier in this conversation. ` +
    `You offered it for: ${intent}${sent}\nDo that now.`
  );
}

/**
 * The `agent` half: a button that asks Clark for something.
 *
 * It passes the same gate every bound action does, then becomes a turn in the same conversation whose message is the
 * button's label — exactly what the person saw and pressed — with the intent the button was offered for given to the
 * model beside it as host guidance. The press carries no free text, but the context its references name is not all
 * host-written: a `widget:` or `selection:` reference to an isolated widget reads that widget's description of itself,
 * and a `state:` value may have been written by the page. So that context never joins the guidance: it goes to the model
 * as the turn's data section, after everything the person said, labelled as data and with its bracket characters made
 * inert (`renderActionContext`). A background worker gets it the same way, never inside its request text. The request is
 * measured against the button's token budget before any model is asked, and refused whole when it does not fit. The
 * turn is an ordinary one: whatever it goes on to do passes the policy on its own. Its reply is the outcome, recorded
 * per invocation id, so a double click starts one turn and a spoken request hears the answer.
 *
 * A `background` button hands the same request to the node's supervisor instead, whose run reports into this
 * conversation and the inbox when it ends; the answer now is that it started.
 */
async function invokeAgentAction(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  source: "click" | "voice",
  origin: TurnOrigin = "person",
): Promise<WidgetActionResult> {
  const checked = checkBoundAction(services.conductor, request, "agent");
  if (!checked.ok) return gateRefusal(checked);
  if (checked.duplicate !== undefined) return replay(services, checked, request, checked.duplicate);
  const problem = actionInputProblem(checked.instance, checked.binding, request.input);
  if (problem !== undefined) return refusal("INVALID_INPUT", problem);

  const proposal = checked.binding.proposal as Extract<ActionProposal, { kind: "agent" }>;
  const background = proposal.background === true;
  // A button does not decide whether to interrupt, steer or queue beside a running answer the way a typed message is
  // decided: it says so and leaves the choice to the person, who can press it again once the answer is done. Work for
  // the background lane does not wait on the conversation's turn.
  if (!background && services.turnControl?.running().includes(request.conversationId) === true) {
    return refusal("TURN_IN_PROGRESS", "Clark is still answering in this conversation; press it again when the answer is done");
  }

  const context = resolveActionContext(services.conductor, {
    principalId: request.principalId,
    instanceId: checked.instance.instanceId,
    refs: proposal.contextRefs,
    // A file reference is read as the pressed widget, in this conversation: the broker's decision, not a second one.
    readArtifact: (artifactId) =>
      readArtifactForContext(
        {
          db: services.runtime.db,
          dataDir: services.runtime.dataDir,
          nodeId: services.runtime.identity.nodeId,
          newId: (prefix) => services.conductor.newId(prefix),
          now: () => new Date(),
        },
        { principalId: request.principalId, instanceId: checked.instance.instanceId, conversationId: request.conversationId, artifactId },
      ),
  });
  if (!context.ok) return refusal(context.code, `${context.message}; nothing was sent to the model`);

  const limits = bindingLimits(checked.binding);
  const maxTokens = limits.maxTokens ?? ACTION_LIMITS.agent.maxTokens?.default ?? 4_000;
  const text = agentActionText(checked.instance, checked.binding.label, request.input);
  // Host guidance only: the intent the model itself wrote when it offered the button, and the input the host checked.
  const note = agentActionNote(checked.binding.label, proposal.intent, request.input);
  // What the references read, some of it in a widget's own words: data, kept out of the guidance.
  const data = renderActionContext(context.items);
  // Measured before anything is admitted or sent, so a request over its budget costs nothing and is never cut short.
  const tokensEstimated = estimateTokens(`${text}\n${note}\n${data}`);
  if (tokensEstimated > maxTokens) {
    return refusal(
      "TOKEN_BUDGET_EXCEEDED",
      `this request and the context it reads come to about ${String(tokensEstimated)} tokens, over the ${String(maxTokens)} this button allows; nothing was sent to the model — ask Clark directly, or for a button that reads less`,
    );
  }

  // Tracked only as the in-flight guard. The turn it starts is ended by the conversation's own Stop as a reply, and
  // background work by the supervisor's; the run has no call of its own to withdraw, so a Stop does not count it again.
  const admitted = admit(services, checked, request, limits.maxCallsPerMinute ?? ACTION_LIMITS.agent.maxCallsPerMinute?.default ?? 1, {
    stoppable: false,
  });
  if (!admitted.ok) return admitted.result;
  const resolved = context.items.map((item) => ({ ref: item.ref, kind: item.kind, instanceId: item.instanceId }));
  const at = new Date().toISOString() as Instant;
  const principal = { principalId: request.principalId as never, kind: "user" as const, nodeId: services.runtime.identity.nodeId as never };

  try {
    if (background) {
      const started = startBackgroundWork(services, principal, () => new Date().toISOString() as Instant, request.conversationId, `${text}\n\n${note}`, {
        title: checked.binding.label,
        maxTokens,
        ...(data === "" ? {} : { data }),
      });
      if ("refusal" in started) {
        forgetStartedInvokeAction(services.conductor, request.invocationId);
        return refusal("BACKGROUND_UNAVAILABLE", `${started.refusal} Nothing was started.`);
      }
      settle(services, checked, request, { kind: "background", workId: started.sessionId, state: started.state });
      return {
        ok: true,
        status: 202,
        body: actionBody(services, checked, request.conversationId, false, {
          outcome: "background",
          background: { workId: started.sessionId, state: started.state },
          context: resolved,
          tokensEstimated,
        }),
      };
    }

    const outcome = await handleUserMessage(services.conductor, {
      conversationId: request.conversationId as never,
      principal,
      text,
      at,
      note,
      ...(data === "" ? {} : { data }),
      channel: source === "voice" ? "voice" : "chat",
      // The button's request is sent as the words of whoever pressed it: the person on their page or voice, or a
      // program that relayed the press.
      origin,
    });
    indexMessages(services.search, { conversationId: request.conversationId, messages: outcome.messages, at });
    const reply = outcome.messages
      .filter((message) => message.role === "assistant")
      .map((message) => textOfMessage(message))
      .join("\n\n")
      .trim()
      .slice(0, 2_000);
    settle(services, checked, request, { kind: "done", output: reply });
    return {
      ok: true,
      status: 200,
      body: actionBody(services, checked, request.conversationId, false, {
        outcome: "done",
        output: reply,
        context: resolved,
        tokensEstimated,
      }),
    };
  } catch (cause) {
    // A turn that threw left nothing to replay: the id is freed so the person's next press is a fresh request.
    forgetStartedInvokeAction(services.conductor, request.invocationId);
    throw cause;
  } finally {
    endActionRun(request.invocationId);
  }
}

/**
 * The `workflow` half: a button that runs a bounded sequence of steps (`workflow-executor.ts`).
 *
 * Each step that calls a service goes through `invokeCapability` on its own — its own registry check, schema check and
 * policy decision — so a workflow is never a way to run something a single button could not. The run is bounded by the
 * binding's total deadline and stopped by the conversation's Stop, and every step is written to the audit log whatever it
 * came to. What it came to is recorded against the invocation id once any step that calls a service has run, so a second
 * press with that id is answered with the same report and runs nothing.
 */
async function invokeWorkflowAction(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  source: CapabilityInvokeSource,
  origin?: TurnOrigin,
): Promise<WidgetActionResult> {
  const checked = checkBoundAction(services.conductor, request, "workflow");
  if (!checked.ok) return gateRefusal(checked);
  if (checked.duplicate !== undefined) return replay(services, checked, request, checked.duplicate);
  const problem = actionInputProblem(checked.instance, checked.binding, request.input);
  if (problem !== undefined) return refusal("INVALID_INPUT", problem);

  const proposal = checked.binding.proposal as Extract<ActionProposal, { kind: "workflow" }>;
  const limits = bindingLimits(checked.binding);
  const deadlineMs = limits.deadlineMs ?? ACTION_LIMITS.workflow.deadlineMs?.default ?? 120_000;
  const admitted = admit(services, checked, request, limits.maxCallsPerMinute ?? ACTION_LIMITS.workflow.maxCallsPerMinute?.default ?? 1);
  if (!admitted.ok) return admitted.result;

  const label = checked.binding.label;
  let result: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    result = await runWorkflow(
      {
        // Each step is its own call in the effect ledger, opened before it is sent and settled on what came back.
        invoke: (step, args, options) =>
          callInLedger(services, {
            conversationId: request.conversationId,
            principalId: request.principalId,
            intent: `${label}: step ${step.stepId} (${step.capabilityRef ?? ""})`,
            request: {
              ref: step.capabilityRef ?? "",
              args,
              source,
              conversationId: request.conversationId,
              bindingGeneration: checked.binding.packageGeneration,
              timeoutMs: options.timeoutMs,
              signal: options.signal,
              ...(origin === undefined ? {} : { origin }),
            },
          }),
        audit: (step, report) => {
          appendAuditEvent(services.runtime.db, {
            auditId: services.conductor.newId("audit"),
            principalId: request.principalId,
            nodeId: services.runtime.identity.nodeId,
            kind: "interaction",
            summary: `workflow “${label}” step ${step.stepId} (${step.kind}${step.capabilityRef === undefined ? "" : ` ${step.capabilityRef}`}): ${report.status}${report.detail === undefined ? "" : ` — ${report.detail}`}`,
            outcome:
              report.status === "done" || report.status === "skipped"
                ? "done"
                : report.status === "failed" || report.status === "uncertain"
                  ? "failed"
                  : "refused",
            at: new Date().toISOString() as Instant,
            ref: request.invocationId,
          });
        },
      },
      { steps: proposal.steps, input: request.input, deadlineMs, signal: admitted.controller.signal },
    );
  } catch (cause) {
    forgetStartedInvokeAction(services.conductor, request.invocationId);
    throw cause;
  } finally {
    endActionRun(request.invocationId);
  }

  if (result.approvalCard !== undefined) {
    appendHostReply(services, {
      conversationId: request.conversationId,
      blocks: [result.approvalCard],
      at: new Date().toISOString() as Instant,
    });
  }
  const { report } = result;
  const reachedAService = report.steps.some(
    (step) => step.kind === "invoke" && (step.status === "done" || step.status === "uncertain" || step.status === "awaiting-approval" || step.status === "failed"),
  );
  if (reachedAService) settle(services, checked, request, { kind: "workflow", report });
  else forgetStartedInvokeAction(services.conductor, request.invocationId);
  return workflowResult(services, checked, request.conversationId, report, false);
}

/**
 * Hands one perform to the page that shows the widget and waits for its report: what the frame answered, `"no-surface"`
 * when no live page was there to ask, or `"timeout"`. The signal is the conversation's Stop.
 */
export type WidgetPerformer = (request: WidgetPerformRequest, signal: AbortSignal) => Promise<WidgetPerformAwaited>;

/**
 * Who asked for a perform. `clark`: Clark chose it in a turn. `person-voice`: the person said the action's label to a
 * voice session, which pressed it for them. Only the wording of the ledger and the audit line follows it; the policy is
 * told who asked through `TurnOrigin`.
 */
export type PerformAsker = "clark" | "person-voice";

/** Options only some callers have: the live page a perform is handed to, and how a policy's card reaches the person. */
export interface WidgetActionOptions {
  perform?: WidgetPerformer;
  /**
   * The caller writes the approval card a policy asks for into the answer it is composing: a model tool returning its
   * `hostCard`, which the turn places. Every other caller gets the card placed in the conversation here, as a host
   * reply, before the result returns, so nothing can report a card that is not there.
   */
  cardInTurn?: boolean;
  /** Who asked for a perform. Absent is Clark. */
  askedBy?: PerformAsker;
}

/** How long a person has to answer the card a perform's policy asked for: as long as any other host card. */
const PERFORM_APPROVAL_TTL_MS = 15 * 60_000;

/** What one perform's digest covers: the conversation it was asked in, the widget, the binding as it was, the action and the input. */
interface PerformOperation {
  conversationId: string;
  instanceId: string;
  actionBindingId: string;
  bindingDigest: string;
  action: string;
  input: Record<string, unknown>;
}

/**
 * The digest the policy and the approval card see for one perform. The conversation and the binding are part of it, so
 * a card approves this action of this widget as it was offered, in this conversation, and two requests for the same
 * operation are recognised as one.
 */
function performDigest(operation: PerformOperation): string {
  return `sha256:${payloadDigest(asJsonValue({ kind: "widget-perform", ...operation, input: operation.input as never }))}`;
}

/**
 * The longest input, written as JSON, an approval card shows. The card's description carries the whole input — the
 * inbox and a spoken question read only the description — so a longer one is refused rather than shown in part: the
 * person approves only what they can read.
 */
export const PERFORM_CARD_INPUT_MAX_CHARS = 1_200;

/** How many perform cards may wait for the person at once in one conversation, so a looping model cannot fill it. */
export const PERFORM_CARDS_WAITING_MAX = 8;

/** The perform cards this process minted, by approval id, with their conversation: counted before the turn is written. */
const mintedPerformCards = new WeakMap<object, Map<string, string>>();

/** A perform card still waiting for exactly this operation, so asking again is answered with it, never a second card. */
function waitingPerformCard(services: WidgetActionServices, digest: string, at: Instant): string | undefined {
  return (
    services.runtime.db
      .prepare(
        `SELECT approval_id FROM approvals
          WHERE operation_digest = ? AND decision = 'pending' AND expires_at > ? AND task_id IS NULL
          ORDER BY requested_at DESC LIMIT 1`,
      )
      .get(digest, at) as { approval_id: string } | undefined
  )?.approval_id;
}

/**
 * The perform cards still waiting in a conversation: those this process minted (the turn that shows them may not be
 * written yet) and those already in the conversation (minted before a restart), each counted once and only while its
 * approval is pending and unexpired.
 */
function waitingPerformCards(services: WidgetActionServices, conversationId: string, at: Instant): number {
  const minted = mintedPerformCards.get(services.runtime.db) ?? new Map<string, string>();
  mintedPerformCards.set(services.runtime.db, minted);
  const ids = new Set<string>();
  for (const [approvalId, conversation] of minted) if (conversation === conversationId) ids.add(approvalId);
  for (const block of blocksOfConversation(services, conversationId)) {
    if (block.type === "approval-card" && typeof block.approvalId === "string" && typeof block.payload === "string" && isWidgetPerformPayload(block.payload)) {
      ids.add(block.approvalId);
    }
  }
  const read = services.runtime.db.prepare("SELECT decision, expires_at FROM approvals WHERE approval_id = ?");
  let waiting = 0;
  for (const approvalId of ids) {
    const row = read.get(approvalId) as { decision: string; expires_at: string } | undefined;
    if (row !== undefined && row.decision === "pending" && row.expires_at > at) waiting += 1;
    else minted.delete(approvalId);
  }
  return waiting;
}

/** The ledger's name for an action a widget offers, as `capabilityRef`: the widget and the action, never the instance. */
function performRef(definitionId: string, action: string): string {
  return `widget:${definitionId}#${action}`.slice(0, 160);
}

/** What the ledger records a perform was sent with: the instance as well as the input, so the same input on another
 * copy of the widget is another operation. */
function performLedgerArgs(instanceId: string, input: Record<string, unknown>): Record<string, unknown> {
  return { instanceId, input };
}

/**
 * The line in the audit log for a perform, worded for who asked: Clark's choice is never recorded as the person's press,
 * and the person's spoken press is never recorded as Clark's choice.
 */
function auditPerform(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  label: string,
  outcome: "done" | "failed" | "refused" | "stopped",
  said: string,
  /** Who asked for the turn that asked Clark to perform it (`TurnOrigin`). Absent is the person. */
  origin: TurnOrigin | undefined,
  askedBy: PerformAsker,
): void {
  const who = askedBy === "person-voice" ? `The person asked widget ${request.instanceId} by voice` : `Clark asked widget ${request.instanceId}`;
  try {
    appendAuditEvent(services.runtime.db, {
      auditId: services.conductor.newId("audit"),
      principalId: request.principalId,
      nodeId: services.runtime.identity.nodeId,
      kind: "interaction",
      summary: `${who} to perform “${label}”: ${said}`.slice(0, 500),
      outcome,
      at: new Date().toISOString() as Instant,
      ref: request.invocationId,
      ...(origin === undefined ? {} : { origin }),
    });
  } catch {
    // The audit line is a record of what happened, not a condition of it.
  }
}

/** Why a perform found nobody to ask. Said the same whether no screen was live or the surface running the turn has none. */
function notMountedMessage(label: string): string {
  return `“${label}” can only be performed by a screen that shows the widget, and the surface running this turn cannot reach one. Nothing was sent.`;
}

/** The perform-specific checks that come after the gate and before anything is sent, shared by a call and an approval. */
type PerformChecked = { ok: true; checked: Admitted; proposal: Extract<ActionProposal, { kind: "perform" }>; label: string } | { ok: false; result: WidgetActionResult };

/**
 * The gate, the declared input schema, and the rule that an action whose last attempt has no known outcome is not sent
 * again: the effect ledger still holds that attempt, handed off or `unknown`, until the person says what came of it.
 * Each call mints its own invocation id, so this — not the id — is what keeps Clark from retrying one.
 */
function checkPerform(services: WidgetActionServices, request: WidgetActionRequest): PerformChecked {
  const checked = checkBoundAction(services.conductor, request, "perform");
  if (!checked.ok) return { ok: false, result: gateRefusal(checked) };
  if (checked.duplicate !== undefined) return { ok: false, result: replay(services, checked, request, checked.duplicate) };
  const problem = actionInputProblem(checked.instance, checked.binding, request.input);
  if (problem !== undefined) return { ok: false, result: refusal("INVALID_INPUT", problem) };
  const proposal = checked.binding.proposal as Extract<ActionProposal, { kind: "perform" }>;
  const label = checked.binding.label;
  const ref = performRef(checked.instance.definitionRef.id, proposal.action);
  const unknownBefore = hasUnsettledEffect(services.runtime.db, {
    conversationId: request.conversationId,
    capabilityRef: ref,
    operationDigest: effectOperationDigest(ref, performLedgerArgs(request.instanceId, request.input)),
  });
  if (unknownBefore) {
    return {
      ok: false,
      result: refusal(
        "PERFORM_OUTCOME_UNKNOWN",
        `“${label}” was already sent to this widget with the same input, and whether it took effect is still unknown. It is not sent again until the person says whether it did. Nothing was sent.`,
        { outcome: "refused" },
      ),
    };
  }
  return { ok: true, checked, proposal, label };
}

/**
 * Hand an admitted perform to the page and settle what came back: the ledger opened before the page is asked, the
 * answer read against it, the invocation recorded, and Clark's line in the audit log.
 */
async function runPerform(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  target: Extract<PerformChecked, { ok: true }>,
  perform: WidgetPerformer,
  origin: TurnOrigin | undefined,
  askedBy: PerformAsker,
): Promise<WidgetActionResult> {
  const { checked, proposal, label } = target;
  const limits = bindingLimits(checked.binding);
  const admitted = admit(services, checked, request, limits.maxCallsPerMinute ?? ACTION_LIMITS.perform.maxCallsPerMinute?.default ?? 1);
  if (!admitted.ok) return admitted.result;

  // Random, because the page answers by this id alone: a counter would let another page guess the next one.
  const performId = `perform_${randomUUID().replaceAll("-", "")}`;
  const widgetId = checked.instance.definitionRef.id;
  const intent = askedBy === "person-voice" ? `The person asked “${widgetId}” by voice to ${label}` : `Clark asked “${widgetId}” to ${label}`;
  let opened: OpenedActionEffect;
  try {
    opened = openActionEffect(services, {
      conversationId: request.conversationId,
      principalId: request.principalId,
      capabilityRef: performRef(checked.instance.definitionRef.id, proposal.action),
      args: performLedgerArgs(request.instanceId, request.input),
      intent,
      effectCategory: "local-write",
    });
  } catch (cause) {
    endActionRun(request.invocationId);
    forgetStartedInvokeAction(services.conductor, request.invocationId);
    return refusal("LEDGER_UNAVAILABLE", `the effect ledger could not be written, so nothing was sent: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  let answered: WidgetPerformAwaited | "stopped";
  try {
    const signal = admitted.controller.signal;
    const stopped = new Promise<"stopped">((resolve) => {
      if (signal.aborted) resolve("stopped");
      else signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    answered = await Promise.race([
      perform(
        {
          v: WIDGET_PERFORM_VERSION,
          performId,
          instanceId: request.instanceId,
          actionBindingId: request.actionBindingId,
          action: proposal.action,
          input: request.input,
        },
        signal,
      ),
      stopped,
    ]);
  } catch (cause) {
    answered = { status: "no-answer", message: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    endActionRun(request.invocationId);
  }

  if (answered === "no-surface" || (typeof answered === "object" && answered.status === "refused")) {
    // Nothing was handed to the widget, or the widget refused before changing anything: the id is freed.
    const pageCode =
      typeof answered === "object" && answered.by === "page" && (PAGE_PERFORM_REFUSAL_CODES as readonly string[]).includes(answered.code)
        ? answered.code
        : undefined;
    const code = answered === "no-surface" ? "FRAME_NOT_MOUNTED" : pageCode ?? "WIDGET_REFUSED";
    const message =
      answered === "no-surface"
        ? notMountedMessage(label)
        : pageCode !== undefined
          ? `the screen could not ask the widget to ${label}: ${answered.message}`
          : `the widget refused “${label}” and says it changed nothing: ${answered.message}`;
    settleActionEffect(services, opened, { kind: "not-sent", reason: message });
    forgetStartedInvokeAction(services.conductor, request.invocationId);
    auditPerform(services, request, label, "refused", message, origin, askedBy);
    // The widget's own code is its word, kept apart from the host's codes so neither the model nor the audit can mistake
    // a widget's "POLICY_REFUSED" for the host's.
    const widgetCode = typeof answered === "object" && pageCode === undefined ? answered.code : undefined;
    return refusal(code, message, { outcome: "refused", ...(widgetCode === undefined ? {} : { widgetCode }) });
  }
  if (typeof answered === "object" && answered.status === "done") {
    const output = answered.output ?? "";
    settleActionEffect(services, opened, { kind: "answered", evidence: `the widget performed it${output === "" ? "" : `: ${output.slice(0, 200)}`}` });
    settle(services, checked, request, { kind: "done", output });
    auditPerform(services, request, label, "done", output === "" ? "done" : output.slice(0, 200), origin, askedBy);
    return {
      ok: true,
      status: 200,
      body: actionBody(services, checked, request.conversationId, false, { outcome: "done", output, performedBy: "clark" }),
    };
  }
  const stoppedNow = answered === "stopped";
  const why =
    answered === "stopped"
      ? "you stopped it before the widget answered"
      : answered === "timeout"
        ? "the screen did not report back in time"
        : answered.message;
  const ledger = settleActionEffect(services, opened, {
    kind: "no-answer",
    stopped: stoppedNow,
    reason: `the widget was asked to ${label} and no answer came back: ${why}`,
  });
  const next = ledger.recorded ? "The inbox asks you to say whether it did." : "Check the widget before asking again.";
  const said = `“${label}” was sent to the widget, but ${why}, so whether it took effect is unknown. It was not retried. ${next}`;
  settle(services, checked, request, {
    kind: "uncertain",
    code: stoppedNow ? "WIDGET_PERFORM_STOPPED" : "WIDGET_NO_ANSWER",
    message: said,
    ...(ledger.recorded ? { taskId: opened.taskId } : {}),
  });
  auditPerform(services, request, label, stoppedNow ? "stopped" : "failed", said, origin, askedBy);
  return refusal(stoppedNow ? "WIDGET_PERFORM_STOPPED" : "WIDGET_NO_ANSWER", said, {
    outcome: "uncertain",
    mayHaveRun: true,
    recorded: ledger.recorded,
    ...(ledger.recorded ? { taskId: opened.taskId } : {}),
  });
}

/**
 * The words on the host's card for a perform the policy asked about, in the person's language, with the whole input:
 * never cut, because the inbox and a spoken question read only these words (`PERFORM_CARD_INPUT_MAX_CHARS`).
 */
function performApprovalDescription(locale: "vi" | "en", label: string, widgetId: string, sent: string): string {
  return locale === "en"
    ? `Clark asks the widget ${widgetId} to ${label}${sent === "" ? "" : ` with ${sent}`}`
    : `Clark muốn widget ${widgetId} thực hiện “${label}”${sent === "" ? "" : ` với ${sent}`}`;
}

/** What an approval card for a perform carries, so the approved operation is the one that was shown. */
interface PerformApprovalPayload {
  kind: "widget-perform";
  instanceId: string;
  actionBindingId: string;
  bindingDigest: string;
  action: string;
  label: string;
  input: Record<string, unknown>;
  /** Present when the person asked for it by voice, so the run after their approval is recorded as theirs. */
  askedBy?: "person-voice";
}

/** Whether an approval card's payload is a perform rather than a command, a capability call or a tile policy. */
export function isWidgetPerformPayload(payload: string): boolean {
  try {
    return (JSON.parse(payload) as { kind?: unknown }).kind === "widget-perform";
  } catch {
    return false;
  }
}

/**
 * The `perform` half: Clark asking an isolated widget's frame to do one of the actions its package declared.
 *
 * Only Clark (`agent`) — or the person speaking to Clark (`voice`) — performs one: a click or a frame naming a perform
 * binding is refused, because the action is the widget's own and the page already reaches it directly. The same gate
 * every bound action passes runs first, then the declared input schema, then the rule that an attempt of unknown outcome
 * is not repeated, then the person's execution policy decides on a `local-write`: the widget never approves its own
 * action, and the model never approves on its behalf. A policy that asks puts a host-owned card in the conversation
 * (`approval-required`, the card also in `body.card`): placed here as a host reply, or by the caller's own turn when it
 * says so (`cardInTurn`), so no caller can report a card that was never placed. Approving it asks the frame then,
 * through `runApprovedPerform`, if the screen the person approves on still shows it. The same operation asked for again
 * while its card waits gets that card, not a second one, and a conversation holds at most `PERFORM_CARDS_WAITING_MAX`.
 *
 * Inside the effect ledger like a service call: written down as handed off before the page is asked, settled on the
 * frame's answer. A frame that was asked and did not answer in time, failed while performing, or a Stop while waiting,
 * may have done it: that is uncertain, recorded against the invocation id and never retried. No live page, or a page
 * with no such frame mounted, is a refusal with nothing sent and nothing queued.
 */
async function invokePerformAction(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  options: WidgetActionOptions,
  origin?: TurnOrigin,
): Promise<WidgetActionResult> {
  const target = checkPerform(services, request);
  if (!target.ok) return target.result;
  const { checked, proposal, label } = target;
  const { perform } = options;
  const askedBy = options.askedBy ?? "clark";
  if (perform === undefined) return refusal("FRAME_NOT_MOUNTED", notMountedMessage(label), { outcome: "refused" });

  const now = (): Instant => new Date().toISOString() as Instant;
  const policy = readExecutionPolicy({ db: services.runtime.db, now }, services.runtime.identity.ownerPrincipalId);
  const operationDigest = performDigest({
    conversationId: request.conversationId,
    instanceId: request.instanceId,
    actionBindingId: request.actionBindingId,
    bindingDigest: checked.binding.bindingDigest,
    action: proposal.action,
    input: request.input,
  });
  const decided = decideExecution({
    policy,
    action: { kind: "effect", category: "local-write", operationDigest: operationDigest as never },
    // Who asked for the turn: a program on a machine surface is asked about when the person chose `machineTurns: "ask"`.
    intent: origin === undefined ? { kind: "interactive" } : { kind: "interactive", origin },
  });
  if (decided.kind === "deny") {
    auditPerform(services, request, label, "refused", decided.reason, origin, askedBy);
    return refusal("POLICY_REFUSED", `${decided.reason}. Nothing was sent to the widget.`, { outcome: "refused" });
  }
  if (decided.kind === "ask") {
    // The person chose to be asked: a host-owned card, answered by them alone. Nothing is sent until they approve, and
    // then only to the screen they approve on, if it still shows the widget.
    const at = now();
    const waiting = waitingPerformCard(services, operationDigest, at);
    if (waiting !== undefined) {
      // The same operation already waits on a card: one card, one decision, one run. No second card is drawn.
      recordInvokeAction(services.conductor, {
        invocationId: request.invocationId,
        actionBindingId: request.actionBindingId,
        instanceId: checked.instance.instanceId,
        digest: checked.digest,
        result: { kind: "approval-required", approvalId: waiting },
      });
      return {
        ok: true,
        status: 202,
        body: actionBody(services, checked, request.conversationId, false, {
          outcome: "approval-required",
          approvalRequired: { approvalId: waiting },
          alreadyWaiting: true,
        }),
      };
    }
    const inputText = Object.keys(request.input).length === 0 ? "" : JSON.stringify(request.input);
    if (inputText.length > PERFORM_CARD_INPUT_MAX_CHARS) {
      return refusal(
        "PERFORM_INPUT_TOO_LONG",
        `the input is ${String(inputText.length)} characters, more than the ${String(PERFORM_CARD_INPUT_MAX_CHARS)} an approval card shows in full, and the person approves only what they can read. Nothing was sent; perform it in smaller steps.`,
        { outcome: "refused" },
      );
    }
    if (waitingPerformCards(services, request.conversationId, at) >= PERFORM_CARDS_WAITING_MAX) {
      return refusal(
        "PERFORM_CARDS_WAITING",
        `${String(PERFORM_CARDS_WAITING_MAX)} approval cards for widget actions already wait for the person in this conversation. Nothing was sent; wait for their answers before asking again.`,
        { outcome: "refused" },
      );
    }
    const locale = preferredAppIntentLocale({ db: services.runtime.db, now }, services.runtime.identity.ownerPrincipalId);
    const payload: PerformApprovalPayload = {
      kind: "widget-perform",
      instanceId: request.instanceId,
      actionBindingId: request.actionBindingId,
      bindingDigest: checked.binding.bindingDigest,
      action: proposal.action,
      label,
      input: request.input,
      ...(askedBy === "person-voice" ? { askedBy } : {}),
    };
    const operationDescription = performApprovalDescription(locale, label, checked.instance.definitionRef.id, inputText);
    const cardOf = (approval: { approvalId: string; expiresAt: string; decision: string }) => ({
      type: "approval-card" as const,
      owner: "host" as const,
      approvalId: approval.approvalId,
      operationDescription,
      operationDigest,
      payload: JSON.stringify(payload),
      effectCategory: "local-write" as const,
      expiresAt: approval.expiresAt,
      decider: "user" as const,
      decision: approval.decision,
      // Written on the host's card, so the decision route keeps who asked when the person approves.
      ...(origin === undefined ? {} : { origin }),
    });
    // Checked against the block schema before an approval exists, so a card that could not be drawn never waits unseen.
    if (!approvalCardBlockSchema.safeParse(cardOf({ approvalId: "appr_check", expiresAt: at, decision: "pending" })).success) {
      return refusal("PERFORM_INPUT_TOO_LONG", "the approval card for this action could not be drawn in full. Nothing was sent; perform it in smaller steps.", {
        outcome: "refused",
      });
    }
    const approval = requestApproval(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId },
      { operationDigest, operationDescription, effectCategory: "local-write", ttlMs: PERFORM_APPROVAL_TTL_MS },
    );
    mintedPerformCards.get(services.runtime.db)?.set(approval.approvalId, request.conversationId);
    recordInvokeAction(services.conductor, {
      invocationId: request.invocationId,
      actionBindingId: request.actionBindingId,
      instanceId: checked.instance.instanceId,
      digest: checked.digest,
      result: { kind: "approval-required", approvalId: approval.approvalId },
    });
    const card = cardOf(approval);
    // Placed before the result returns, so whoever reports "a card asks you" reports one that is there. A model turn
    // writes it into its own answer instead (`cardInTurn`), where it lands with the words that explain it.
    if (options.cardInTurn !== true) appendHostReply(services, { conversationId: request.conversationId, blocks: [approvalCardBlockSchema.parse(card)], at });
    return {
      ok: true,
      status: 202,
      body: actionBody(services, checked, request.conversationId, false, {
        outcome: "approval-required",
        approvalRequired: { approvalId: approval.approvalId },
        card,
      }),
    };
  }
  return runPerform(services, request, target, perform, origin, askedBy);
}

/**
 * Perform an action a person approved on the host's card.
 *
 * The card's payload is hashed again against the digest the decision covered, so what runs is what was shown. The
 * widget must still carry the same binding it had when the card was drawn, the input must still pass its schema, an
 * attempt of unknown outcome still blocks a second, and a refusal the person set after the card was shown still stands.
 * Then the frame is asked through `perform` — only a screen that shows the widget now can be — and nothing is queued
 * when there is none: the person is told it was approved and not sent.
 */
export async function runApprovedPerform(
  services: WidgetActionServices,
  input: {
    payload: string;
    expectedDigest: string;
    conversationId: string;
    principalId: string;
    perform: WidgetPerformer | undefined;
    /** Who asked for the perform, read from the card: the person decided it, but the record keeps who asked. */
    origin?: TurnOrigin;
  },
): Promise<{ ok: true; label: string; result: WidgetActionResult } | { ok: false; code: string; message: string }> {
  let parsed: Partial<PerformApprovalPayload>;
  try {
    parsed = JSON.parse(input.payload) as Partial<PerformApprovalPayload>;
  } catch {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload is not readable" };
  }
  const { instanceId, actionBindingId, bindingDigest, action, label } = parsed;
  const performInput = parsed.input;
  // Who asked, as the host wrote it on its own card: the person approved it either way, and the record keeps who asked.
  const askedBy: PerformAsker = parsed.askedBy === "person-voice" ? "person-voice" : "clark";
  if (
    typeof instanceId !== "string" ||
    typeof actionBindingId !== "string" ||
    typeof bindingDigest !== "string" ||
    typeof action !== "string" ||
    typeof label !== "string" ||
    performInput === null ||
    typeof performInput !== "object" ||
    Array.isArray(performInput)
  ) {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload names no widget action" };
  }
  const shownDigest = performDigest({
    conversationId: input.conversationId,
    instanceId,
    actionBindingId,
    bindingDigest,
    action,
    input: performInput as Record<string, unknown>,
  });
  if (shownDigest !== input.expectedDigest) {
    return { ok: false, code: "APPROVAL_FORGED", message: "the operation changed after it was displayed; the decision does not cover what would run" };
  }
  const cursor = widgetActionTarget(services, instanceId, actionBindingId);
  if (cursor === undefined || cursor.bindingDigest !== bindingDigest) {
    return {
      ok: true,
      label,
      result: refusal("BINDING_STALE", `the widget no longer offers “${label}” as it did when the card was shown. Nothing was sent.`, { outcome: "refused" }),
    };
  }
  const request: WidgetActionRequest = {
    conversationId: input.conversationId,
    principalId: input.principalId,
    instanceId,
    actionBindingId,
    expectedRevision: cursor.revision,
    expectedBindingDigest: bindingDigest,
    input: performInput,
    invocationId: `inv_${randomUUID()}`,
  };
  const target = checkPerform(services, request);
  if (!target.ok) return { ok: true, label, result: target.result };
  if (target.proposal.action !== action) {
    return { ok: false, code: "APPROVAL_FORGED", message: "the approved binding performs another action than the one shown" };
  }
  if (input.perform === undefined) return { ok: true, label, result: refusal("FRAME_NOT_MOUNTED", notMountedMessage(label), { outcome: "refused" }) };
  const now = (): Instant => new Date().toISOString() as Instant;
  const decided = decideExecution({
    policy: readExecutionPolicy({ db: services.runtime.db, now }, services.runtime.identity.ownerPrincipalId),
    action: { kind: "effect", category: "local-write", operationDigest: input.expectedDigest as never },
    intent: input.origin === undefined ? { kind: "interactive" } : { kind: "interactive", origin: input.origin },
  });
  if (decided.kind === "deny") {
    auditPerform(services, request, label, "refused", decided.reason, input.origin, askedBy);
    return { ok: true, label, result: refusal("POLICY_REFUSED", `${decided.reason}. Nothing was sent to the widget.`, { outcome: "refused" }) };
  }
  return { ok: true, label, result: await runPerform(services, request, target, input.perform, input.origin, askedBy) };
}

/**
 * What a person reads after approving a perform, in their language: done, refused with nothing sent, or unknown.
 * Written from the code, never from the widget's own words alone, so a widget cannot make the receipt claim more.
 */
export function performReceipt(locale: "vi" | "en", label: string, result: WidgetActionResult): { text: string; succeeded: boolean } {
  if (result.ok) {
    return { text: locale === "en" ? `Approved: the widget performed “${label}”.` : `Đã duyệt: widget đã thực hiện “${label}”.`, succeeded: true };
  }
  if (result.detail?.outcome === "uncertain") {
    return {
      text:
        locale === "en"
          ? `Approved and sent “${label}” to the widget, but whether it took effect is unknown. It was not retried; the inbox asks you whether it did.`
          : `Đã duyệt và gửi “${label}” tới widget, nhưng chưa rõ nó đã có hiệu lực chưa. Không thử lại; hộp thư sẽ hỏi bạn.`,
      succeeded: false,
    };
  }
  const why =
    result.code === "FRAME_NOT_MOUNTED" || result.code === "SURFACE_GONE"
      ? locale === "en"
        ? "the screen you approved on does not show the widget now"
        : "màn hình bạn duyệt lúc này không hiện widget đó"
      : result.code === "WIDGET_REFUSED"
        ? locale === "en"
          ? "the widget refused it"
          : "widget từ chối"
        : result.code === "POLICY_REFUSED"
          ? locale === "en"
            ? "your execution policy now refuses it"
            : "chính sách thực thi của bạn giờ từ chối việc này"
          : result.code === "PERFORM_OUTCOME_UNKNOWN"
            ? locale === "en"
              ? "an earlier attempt with the same input still has an unknown outcome"
              : "một lần gửi trước với cùng dữ liệu vẫn chưa rõ kết quả"
            : locale === "en"
              ? `it could not be performed (${result.code})`
              : `không thực hiện được (${result.code})`;
  return {
    text:
      locale === "en"
        ? `Approved, but “${label}” was not performed: ${why}. Nothing was sent.`
        : `Đã duyệt, nhưng “${label}” không được thực hiện: ${why}. Không có gì được gửi.`,
    succeeded: false,
  };
}

/**
 * Invoke a widget action.
 *
 * The single path a click and a spoken command both take. Everything that decides whether an action may run lives
 * here - the owner check, the revision the client saw, the binding digest, and one effect per invocation id - so a
 * second path would not be a second interface to the same gate, it would be a way around one of them.
 *
 * Extracted from the route so the voice path has somewhere to call rather than something to copy. The route keeps the
 * request-shaped validation and this keeps the authorization, which is the split that matters: what the HTTP body
 * looks like is the transport's business, and whether an action may run is not.
 */
export async function invokeWidgetAction(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  source: "click" | "voice" | "agent" = "click",
  /**
   * Who pressed it (`TurnOrigin`), decided by the caller and never read from a request body: the route reads the
   * gateway's surface mark (the page marks its own presses), voice is the person, and Clark's own press carries its
   * turn's origin. Handed to the execution policy with a service call and to the turn an agent button starts.
   */
  origin?: TurnOrigin,
  options: WidgetActionOptions = {},
): Promise<WidgetActionResult> {
  // The guard main added at the route, kept where the invocation actually happens so both callers get it.
  if (!Number.isFinite(request.expectedRevision)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SCHEMA",
      message: "an action invocation needs the expectedRevision the client saw",
    };
  }
  // The node's own state-only records share the ledger's key space, so no caller may name one, whatever the action.
  const reserved = reservedInvocationIdRefusal(request.invocationId);
  if (reserved !== undefined) return refusal(reserved.code, reserved.message);

  // The binding decides what the action is; the request only names it. An unknown binding falls through to the view path,
  // whose gate refuses it with the reason.
  const kind = getActionBinding(services.conductor, request.actionBindingId)?.proposal.kind;
  const capabilitySource: CapabilityInvokeSource = source === "voice" ? "voice" : source === "agent" ? "agent" : "widget";
  if (kind === "invoke") return invokeCapabilityAction(services, request, capabilitySource, origin);
  if (kind === "agent") {
    // An agent button sends its request to Clark as the person's own message. Clark pressing one would put words in the
    // person's mouth and record Clark's choice as their click, so it is refused rather than relabelled.
    if (source === "agent") {
      return refusal("NOT_AUTHORIZED", "Clark cannot press a button that asks Clark: it would be sent as the person's own message. Nothing was sent.");
    }
    return invokeAgentAction(services, request, source, origin);
  }
  if (kind === "workflow") return invokeWorkflowAction(services, request, capabilitySource, origin);
  if (kind === "perform") {
    // An offered action is Clark's to perform on the widget. A press or a frame naming its binding would be the widget
    // asking itself through the host, which is not a path anything needs and not one the gate should open.
    if (source === "click") {
      return refusal("NOT_AUTHORIZED", "an action a widget offers to Clark is performed by Clark, not pressed. Nothing was sent.");
    }
    return invokePerformAction(services, request, options, origin);
  }

  // Read at the invocation rather than captured, so a mode the user changed applies to the next action they take
  // instead of the next time the node starts.
  const policy = readExecutionPolicy(
    { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
    services.runtime.identity.ownerPrincipalId,
  );
  const outcome = invokeMiniAppAction(services.conductor, { ...request, policy });
  if (!outcome.ok) {
    return {
      ok: false,
      status: statusOf(outcome.code),
      code: outcome.code,
      message: outcome.message,
      ...(outcome.currentRevision === undefined ? {} : { currentRevision: outcome.currentRevision }),
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      duplicate: outcome.duplicate,
      instanceId: outcome.instanceId,
      revision: outcome.revision,
      stateRevision: outcome.stateRevision,
      state: outcome.state,
      pinId: outcome.pinId ?? null,
      outcome: "done",
      // The whole page comes back after a mutation, so the client does not have to guess whether
      // its cursor is still valid.
      timeline: buildTimeline(services, { conversationId: request.conversationId, afterSequence: 0 }),
    },
  };
}

/**
 * The state-only write of a host-held player's playback state (`variant: "view-state"` on the action call).
 *
 * The same gate as a view action — owner, binding, revision, digest, input — and then the bounded state is stored and
 * the answer is that state alone: no timeline is rebuilt, no history snapshot is marked superseded, and the page has
 * nothing to re-render. Nothing else is accepted on this path (`writeViewState`), so it is never a way around an
 * action's ledger, and a frame's own bridge never sends it: an isolated widget writes its state through its own route.
 */
export function writeWidgetViewState(
  services: Pick<NodeServices, "conductor">,
  request: WidgetActionRequest,
): WidgetActionResult {
  if (!Number.isFinite(request.expectedRevision)) {
    return { ok: false, status: 400, code: "INVALID_SCHEMA", message: "a state write needs the expectedRevision the client saw" };
  }
  const outcome = writeViewState(services.conductor, request);
  if (!outcome.ok) {
    return {
      ok: false,
      status: statusOf(outcome.code),
      code: outcome.code,
      message: outcome.message,
      ...(outcome.currentRevision === undefined ? {} : { currentRevision: outcome.currentRevision }),
    };
  }
  return {
    ok: true,
    status: 200,
    body: {
      variant: VIEW_STATE_WRITE_VARIANT,
      duplicate: outcome.duplicate,
      // A write older than the one the node holds wrote nothing; the state below is the node's current one.
      ...(outcome.stale === true ? { stale: true } : {}),
      instanceId: outcome.instanceId,
      revision: outcome.revision,
      stateRevision: outcome.stateRevision,
      state: outcome.state,
    },
  };
}

/** A widget's invoke binding to one capability, in a conversation the person owns. */
export interface CapabilityBindingTarget {
  instanceId: string;
  actionBindingId: string;
  label: string;
}

/** How many of a conversation's widgets are looked through for a binding; a conversation rarely holds more. */
const BINDING_SEARCH_INSTANCES = 50;

/**
 * The widgets in a conversation whose own invoke bindings call `capabilityRef`, newest first.
 *
 * A package job belongs to the widget binding that started it — that is whom it reports to and who may read or stop
 * it — so Clark starting one does not start a job nobody follows: it presses one of these bindings, through the same
 * gate a click does. Only the person's own instances, with a binding the instance still announces, are listed.
 */
export function conversationCapabilityBindings(
  services: Pick<NodeServices, "runtime" | "conductor">,
  conversationId: string,
  capabilityRef: string,
): CapabilityBindingTarget[] {
  const owner = services.runtime.identity.ownerPrincipalId;
  const found: CapabilityBindingTarget[] = [];
  for (const instanceId of listConversationInstanceIds(services.runtime.db, conversationId, BINDING_SEARCH_INSTANCES)) {
    const instance = getInstance(services.conductor, instanceId);
    if (instance === undefined || instance.ownerPrincipalId !== owner) continue;
    for (const actionBindingId of instance.actionBindingIds) {
      const binding = getActionBinding(services.conductor, actionBindingId);
      if (binding?.instanceId !== instanceId || binding.proposal.kind !== "invoke" || binding.proposal.capabilityRef !== capabilityRef) continue;
      found.push({ instanceId, actionBindingId, label: binding.label });
    }
  }
  return found;
}
