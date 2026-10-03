import {
  type ActionBinding,
  type ActionProposal,
  type FormField,
  type Instant,
  type ListItem,
  type WidgetInstance,
  type WorkflowRunReport,
  VIEW_STATE_WRITE_VARIANT,
  checkFormValues,
  describeFieldValue,
} from "@clarkcant/contracts";
import {
  type BoundActionCheck,
  type BoundActionResult,
  checkBoundAction,
  checkInvokeAction,
  forgetStartedInvokeAction,
  getActionBinding,
  getInstance,
  handleUserMessage,
  invokeMiniAppAction,
  readExecutionPolicy,
  readWidgetStateRow,
  recordInvokeAction,
  reservedInvocationIdRefusal,
  settleInvokeAction,
  writeViewState,
} from "@clarkcant/core";
import { appendAuditEvent, listConversationInstanceIds } from "@clarkcant/storage";

import { readArtifactForContext } from "../artifact-broker.ts";
import { appendHostReply, startBackgroundWork } from "../routes/conversations.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { AGENT_ITEM_KEY } from "./action-bindings.ts";
import { estimateTokens, renderActionContext, resolveActionContext } from "./action-context.ts";
import { type OpenedActionEffect, openActionEffect, settleActionEffect } from "./action-effects.ts";
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
): { revision: number; bindingDigest: string } | undefined {
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined) return undefined;
  if (!instance.actionBindingIds.includes(actionBindingId)) return undefined;
  const binding = getActionBinding(services.conductor, actionBindingId);
  if (binding === undefined) return undefined;
  return { revision: instance.revision, bindingDigest: binding.bindingDigest };
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
      return 409;
    case "RATE_LIMITED":
    case "JOB_LIMIT_REACHED":
      return 429;
    case "ARTIFACT_INPUT_TOO_LARGE":
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
  if (kind === "invoke") return invokeCapabilityAction(services, request, capabilitySource);
  if (kind === "agent") {
    // An agent button sends its request to Clark as the person's own message. Clark pressing one would put words in the
    // person's mouth and record Clark's choice as their click, so it is refused rather than relabelled.
    if (source === "agent") {
      return refusal("NOT_AUTHORIZED", "Clark cannot press a button that asks Clark: it would be sent as the person's own message. Nothing was sent.");
    }
    return invokeAgentAction(services, request, source);
  }
  if (kind === "workflow") return invokeWorkflowAction(services, request, capabilitySource);

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
