import { type CapabilityRef, type EffectCategory, advanceEffect, instantSchema } from "@clarkcant/contracts";
import {
  advanceResolving,
  applyTaskEvent,
  createTask,
  getCapability,
  markEffectUnknown,
  prepareEffect,
} from "@clarkcant/core";
import { asJsonValue, payloadDigest, upsertEffect } from "@clarkcant/storage";

import { COMMAND_STOPPED_ON_REQUEST, unknownEffectsNotice } from "../effect-notices.ts";
import { tryRecordNodeNotice } from "../notices.ts";
import type { NodeServices } from "../services.ts";

/**
 * A widget action's service call whose answer never came, written into the effect ledger (#273).
 *
 * A button's call is not a task the conductor dispatched, so it has no ledger entry until one is needed: when the call
 * was sent and then ran out of time or was stopped, whatever it was asked to do may have been done. That is the moment
 * the ledger exists for, so the call gets a task and an effect of its own, moved through the same machine a dispatched
 * task's effect is — prepared, submitted, then unknown by `markEffectUnknown`, which makes the task uncertain — and the
 * same inbox notice asks the person whether it took effect. Nothing here or anywhere retries the call.
 *
 * A `read` is not written: asking again changes nothing, so there is no outcome to find out. The caller says so.
 */

export interface UncertainCall {
  conversationId: string;
  principalId: string;
  capabilityRef: string;
  args: Record<string, unknown>;
  /** What a person reads in the inbox about what was asked for. */
  intent: string;
  /** Whether a person stopped it, rather than the deadline passing. */
  stopped: boolean;
  /** The transport's own words, for the deadline case. */
  message: string;
}

/** The category a capability declares now, or `undefined` when the registry no longer holds it. */
export function effectCategoryOf(services: Pick<NodeServices, "runtime">, ref: string): EffectCategory | undefined {
  const nodeId = services.runtime.identity.nodeId;
  return getCapability({ db: services.runtime.db, nodeId }, ref as CapabilityRef, nodeId)?.effectCategory;
}

/**
 * Write one uncertain call into the ledger and leave the inbox notice, answering the task it made.
 *
 * `undefined` when the call was a `read`, or when the ledger could not be written — the caller still reports the call as
 * uncertain and records that answer against the invocation id, so the same press is never sent again either way.
 */
export function recordUncertainCall(
  services: Pick<NodeServices, "runtime" | "conductor">,
  call: UncertainCall,
): string | undefined {
  const category = effectCategoryOf(services, call.capabilityRef) ?? "external-write";
  if (category === "read") return undefined;
  const now = () => instantSchema.parse(new Date().toISOString());
  const nodeId = services.runtime.identity.nodeId;
  const deps = { db: services.runtime.db, nodeId, now, newId: services.conductor.newId };
  try {
    const task = createTask(deps, {
      conversationId: call.conversationId as never,
      goal: call.intent.slice(0, 500),
      principal: { principalId: call.principalId as never, kind: "user" as const, nodeId: nodeId as never },
    });
    applyTaskEvent(deps, task.taskId, "resolve.start");
    advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: nodeId });
    applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
    const prepared = prepareEffect(deps, {
      taskId: task.taskId,
      executorNodeId: nodeId,
      category,
      capabilityRef: call.capabilityRef as CapabilityRef,
      intent: call.intent.slice(0, 500),
      operationDigest: `sha256:${payloadDigest(asJsonValue({ capabilityRef: call.capabilityRef, args: call.args }))}`,
      externalSupportsDedup: false,
    });
    const submitted = advanceEffect(prepared, { to: "submitted", at: now() });
    if (submitted.ok) upsertEffect(services.runtime.db, submitted.effect);
    const reason = call.stopped ? COMMAND_STOPPED_ON_REQUEST : `no answer came back in time: ${call.message}`.slice(0, 1000);
    markEffectUnknown(deps, prepared.effectId, reason);
    const notice = unknownEffectsNotice(services.runtime.db, task.taskId, now());
    if (notice !== undefined) tryRecordNodeNotice(services, notice);
    return task.taskId;
  } catch (cause) {
    process.stderr.write(
      `widget action: could not write an uncertain call into the effect ledger (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
    return undefined;
  }
}
