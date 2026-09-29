import { type ActionProposal, type Instant } from "@clarkcant/contracts";
import {
  checkBoundAction,
  checkInvokeAction,
  getActionBinding,
  getInstance,
  handleUserMessage,
  invokeMiniAppAction,
  readExecutionPolicy,
  readWidgetStateRow,
  recordInvokeAction,
} from "@clarkcant/core";

import { appendHostReply } from "../routes/conversations.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { type CapabilityInvokeSource, capabilityInvokeDeps, invokeCapability, mayHaveRun } from "./capability-invoke.ts";

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
}

export type WidgetActionResult =
  | { ok: true; status: 200 | 202; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string; currentRevision?: number };

function statusOf(code: string): number {
  return code === "INSTANCE_UNKNOWN" || code === "ACTION_UNKNOWN"
    ? 404
    : code === "NOT_AUTHORIZED"
      ? 403
      : code === "REVISION_MISMATCH" ||
          code === "BINDING_STALE" ||
          code === "INVOCATION_KEY_REUSED" ||
          code === "TURN_IN_PROGRESS"
        ? 409
        : 400;
}

/** Invocation ids whose service call has not answered yet, on this node. */
const inFlight = new Set<string>();

/**
 * The `invoke` half: a widget button that calls a package's service capability.
 *
 * The widget gate runs first — owner, binding, revision, digest, one outcome per invocation id — and then the same
 * `invokeCapability` the agent's tool and a spoken command reach, so the registry, the input schema and the policy
 * answer a click exactly as they answer a sentence. When the policy asks, the question is a host card in this
 * conversation: the frame is told it is waiting, and nothing it sends can answer it.
 */
async function invokeCapabilityAction(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "serviceHost">,
  request: WidgetActionRequest,
  source: CapabilityInvokeSource,
): Promise<WidgetActionResult> {
  const checked = checkInvokeAction(services.conductor, request);
  if (!checked.ok) {
    return {
      ok: false,
      status: statusOf(checked.code),
      code: checked.code,
      message: checked.message,
      ...(checked.currentRevision === undefined ? {} : { currentRevision: checked.currentRevision }),
    };
  }

  const state = readWidgetStateRow(services.runtime.db, checked.instance.instanceId);
  const respond = (status: 200 | 202, extra: Record<string, unknown>, duplicate: boolean): WidgetActionResult => ({
    ok: true,
    status,
    body: {
      duplicate,
      instanceId: checked.instance.instanceId,
      revision: checked.instance.revision,
      stateRevision: state?.revision ?? 0,
      state: state?.body ?? {},
      pinId: null,
      ...extra,
      timeline: buildTimeline(services, { conversationId: request.conversationId, afterSequence: 0 }),
    },
  });

  if (checked.duplicate !== undefined) {
    return checked.duplicate.kind === "done"
      ? respond(200, { output: checked.duplicate.output }, true)
      : respond(202, { approvalRequired: { approvalId: checked.duplicate.approvalId } }, true);
  }

  // A second request with the same invocation id while the first is still with the service would run it twice: the
  // outcome that makes it a duplicate is only recorded once the service answers.
  if (inFlight.has(request.invocationId)) {
    return {
      ok: false,
      status: 409,
      code: "INVOCATION_IN_PROGRESS",
      message: "this action is already running; its answer will come back to the first request",
    };
  }
  inFlight.add(request.invocationId);
  let outcome: Awaited<ReturnType<typeof invokeCapability>>;
  try {
    outcome = await invokeCapability(capabilityInvokeDeps(services), {
      ref: checked.proposal.capabilityRef,
      args: checked.args,
      source,
      conversationId: request.conversationId,
      bindingGeneration: checked.binding.packageGeneration,
    });
  } finally {
    inFlight.delete(request.invocationId);
  }
  if (outcome.kind === "refused") {
    // Not recorded, so a retry after the service recovers can run. A refusal decided before the service was asked
    // changed nothing; one after it may have, and the person is told so rather than that nothing happened.
    const message = mayHaveRun(outcome.code)
      ? `${outcome.message} — the request reached the service, so it may have done part of it`
      : outcome.message;
    return { ok: false, status: outcome.status, code: outcome.code, message };
  }

  const record = {
    invocationId: request.invocationId,
    actionBindingId: request.actionBindingId,
    instanceId: checked.instance.instanceId,
    digest: checked.digest,
  };
  if (outcome.kind === "approval-required") {
    recordInvokeAction(services.conductor, {
      ...record,
      result: { kind: "approval-required", approvalId: outcome.approval.approvalId },
    });
    appendHostReply(services, {
      conversationId: request.conversationId,
      blocks: [outcome.card],
      at: new Date().toISOString() as Instant,
    });
    return respond(202, { approvalRequired: { approvalId: outcome.approval.approvalId } }, false);
  }
  recordInvokeAction(services.conductor, { ...record, result: { kind: "done", output: outcome.output } });
  return respond(200, { output: outcome.output }, false);
}

/** What the model is told about a turn a button started, beside the label the person saw. */
function agentActionNote(label: string, intent: string): string {
  return (
    `The person pressed the button "${label}" that you offered earlier in this conversation. ` +
    `You offered it for: ${intent}\nDo that now.`
  );
}

type WidgetActionServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "serviceHost" | "turnControl">;

/**
 * The `agent` half: a button that asks Clark for something.
 *
 * It passes the same gate every bound action does, then becomes a turn in the same conversation whose message is the
 * button's label — exactly what the person saw and pressed — with the intent the button was offered for given to the
 * model beside it. The turn is an ordinary one: whatever it goes on to do passes the policy on its own. Its reply is the
 * outcome, recorded per invocation id, so a double click starts one turn and a spoken request hears the answer.
 */
async function invokeAgentAction(
  services: WidgetActionServices,
  request: WidgetActionRequest,
  source: "click" | "voice",
): Promise<WidgetActionResult> {
  const checked = checkBoundAction(services.conductor, request, "agent");
  if (!checked.ok) {
    return {
      ok: false,
      status: statusOf(checked.code),
      code: checked.code,
      message: checked.message,
      ...(checked.currentRevision === undefined ? {} : { currentRevision: checked.currentRevision }),
    };
  }
  // The same body an `invoke` answers with, so a surface reads every kind the same way.
  const state = readWidgetStateRow(services.runtime.db, checked.instance.instanceId);
  const respond = (output: string, duplicate: boolean): WidgetActionResult => ({
    ok: true,
    status: 200,
    body: {
      duplicate,
      instanceId: checked.instance.instanceId,
      revision: checked.instance.revision,
      stateRevision: state?.revision ?? 0,
      state: state?.body ?? {},
      pinId: null,
      output,
      timeline: buildTimeline(services, { conversationId: request.conversationId, afterSequence: 0 }),
    },
  });
  if (checked.duplicate !== undefined) {
    return respond(checked.duplicate.kind === "done" ? checked.duplicate.output : "", true);
  }
  if (inFlight.has(request.invocationId)) {
    return {
      ok: false,
      status: 409,
      code: "INVOCATION_IN_PROGRESS",
      message: "this action is already running; its answer will come back to the first request",
    };
  }
  // A button does not decide whether to interrupt, steer or queue beside a running answer the way a typed message is
  // decided: it says so and leaves the choice to the person, who can press it again once the answer is done.
  if (services.turnControl?.running().includes(request.conversationId) === true) {
    return {
      ok: false,
      status: 409,
      code: "TURN_IN_PROGRESS",
      message: "Clark is still answering in this conversation; press it again when the answer is done",
    };
  }

  const proposal = checked.binding.proposal as Extract<ActionProposal, { kind: "agent" }>;
  const at = new Date().toISOString() as Instant;
  inFlight.add(request.invocationId);
  try {
    const outcome = await handleUserMessage(services.conductor, {
      conversationId: request.conversationId as never,
      principal: { principalId: request.principalId as never, kind: "user", nodeId: services.runtime.identity.nodeId as never },
      text: checked.binding.label,
      at,
      note: agentActionNote(checked.binding.label, proposal.intent),
      channel: source === "voice" ? "voice" : "chat",
    });
    indexMessages(services.search, { conversationId: request.conversationId, messages: outcome.messages, at });
    const reply = outcome.messages
      .filter((message) => message.role === "assistant")
      .map((message) => textOfMessage(message))
      .join("\n\n")
      .trim()
      .slice(0, 2_000);
    recordInvokeAction(services.conductor, {
      invocationId: request.invocationId,
      actionBindingId: request.actionBindingId,
      instanceId: checked.instance.instanceId,
      digest: checked.digest,
      result: { kind: "done", output: reply },
    });
    return respond(reply, false);
  } finally {
    inFlight.delete(request.invocationId);
  }
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
  source: "click" | "voice" = "click",
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

  // The binding decides what the action is; the request only names it. An unknown binding falls through to the view path,
  // whose gate refuses it with the reason.
  const kind = getActionBinding(services.conductor, request.actionBindingId)?.proposal.kind;
  if (kind === "invoke") return invokeCapabilityAction(services, request, source === "voice" ? "voice" : "widget");
  if (kind === "agent") return invokeAgentAction(services, request, source);
  if (kind === "workflow") {
    // Gated first, so a stale or foreign binding is refused as that rather than as a missing executor.
    const checked = checkBoundAction(services.conductor, request, "workflow");
    if (!checked.ok) {
      return {
        ok: false,
        status: statusOf(checked.code),
        code: checked.code,
        message: checked.message,
        ...(checked.currentRevision === undefined ? {} : { currentRevision: checked.currentRevision }),
      };
    }
    return { ok: false, status: 400, code: "UNSUPPORTED_ACTION", message: "this node cannot run a workflow action yet" };
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
      // The whole page comes back after a mutation, so the client does not have to guess whether
      // its cursor is still valid.
      timeline: buildTimeline(services, { conversationId: request.conversationId, afterSequence: 0 }),
    },
  };
}
