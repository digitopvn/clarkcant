import { type Instant } from "@clarkcant/contracts";
import {
  checkInvokeAction,
  getActionBinding,
  getInstance,
  invokeMiniAppAction,
  readExecutionPolicy,
  readWidgetStateRow,
  recordInvokeAction,
} from "@clarkcant/core";

import { appendHostReply } from "../routes/conversations.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { type CapabilityInvokeSource, capabilityInvokeDeps, invokeCapability } from "./capability-invoke.ts";

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
      : code === "REVISION_MISMATCH" || code === "BINDING_STALE" || code === "INVOCATION_KEY_REUSED"
        ? 409
        : 400;
}

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

  const outcome = await invokeCapability(capabilityInvokeDeps(services), {
    ref: checked.proposal.capabilityRef,
    args: checked.args,
    source,
    conversationId: request.conversationId,
    expectedGeneration: checked.binding.packageGeneration,
  });
  if (outcome.kind === "refused") {
    // Not recorded: a refusal changed nothing, and a retry after the service recovers should be able to run.
    return { ok: false, status: outcome.status, code: outcome.code, message: outcome.message };
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
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "serviceHost">,
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

  if (getActionBinding(services.conductor, request.actionBindingId)?.proposal.kind === "invoke") {
    return invokeCapabilityAction(services, request, source === "voice" ? "voice" : "widget");
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
