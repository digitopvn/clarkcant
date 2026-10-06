import { type CapabilityRef, type EffectCategory, type EffectRecord, advanceEffect, instantSchema } from "@clarkcant/contracts";
import {
  type TaskServiceDeps,
  applyTaskEvent,
  createTask,
  getCapability,
  markEffectUnknown,
  prepareEffect,
} from "@clarkcant/core";
import { asJsonValue, payloadDigest, upsertEffect } from "@clarkcant/storage";

import { COMMAND_STOPPED_ON_REQUEST, unknownEffectsNotice } from "../effect-notices.ts";
import { ownerLocale } from "../host-text.ts";
import { tryRecordNodeNotice } from "../notices.ts";
import type { NodeServices } from "../services.ts";

/**
 * A widget action's service call, written into the effect ledger around the call itself (#273).
 *
 * The same pattern a browser action and a worker's command follow (`browser-effects.ts`, `worker-command-broker.ts`):
 * the effect is written down as handed off (`submitted`) **before** the call is sent, and settled on what came back.
 *
 *   - An answer confirms it, and the task that carries it succeeds.
 *   - A call that never left the node — the service was not running, the call was withdrawn before it was written —
 *     failed, and nothing happened.
 *   - Anything else was sent without an answer the node can trust: it ran out of time, a person stopped it, the service
 *     went away mid-call, or the service answered with an error after it may have done part of the work. The effect is
 *     marked unknown, which moves the task to `uncertain` in the same write, and the inbox asks the person whether it
 *     took effect. Nothing here or anywhere retries the call.
 *
 * Because the row exists before the call, a node that dies mid-call needs no special case: boot recovery finds a
 * `submitted` row and a running task, marks both unknown, and the unknown-effect sweep leaves the same inbox question.
 *
 * A `read` is not written: asking again changes nothing, so there is no outcome to find out.
 */

export interface ActionCall {
  conversationId: string;
  principalId: string;
  capabilityRef: string;
  args: Record<string, unknown>;
  /** What a person reads in the inbox about what was asked for. */
  intent: string;
  effectCategory: EffectCategory;
}

/** An effect written as handed off, and the task that carries it. */
export interface OpenedActionEffect {
  taskId: string;
  effect: EffectRecord;
}

/** How a call ended, as the ledger settles it. */
export type ActionCallEnding =
  | { kind: "answered"; evidence: string }
  | { kind: "not-sent"; reason: string }
  | { kind: "no-answer"; stopped: boolean; reason: string };

/** The digest an effect is recorded under: the capability and what it was sent with. One place, so a lookup matches. */
export function effectOperationDigest(capabilityRef: string, args: Record<string, unknown>): string {
  return `sha256:${payloadDigest(asJsonValue({ capabilityRef, args: args as never }))}`;
}

/** The category a capability declares now, or `undefined` when the registry no longer holds it. */
export function effectCategoryOf(services: Pick<NodeServices, "runtime">, ref: string): EffectCategory | undefined {
  const nodeId = services.runtime.identity.nodeId;
  return getCapability({ db: services.runtime.db, nodeId }, ref as CapabilityRef, nodeId)?.effectCategory;
}

function ledgerDeps(services: Pick<NodeServices, "runtime" | "conductor">): TaskServiceDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => instantSchema.parse(new Date().toISOString()),
    newId: services.conductor.newId,
  };
}

function must(result: { ok: true } | { ok: false; message: string }, what: string): void {
  if (!result.ok) throw new Error(`${what}: ${result.message}`);
}

/**
 * Write the effect down as handed off, under a task of its own, before the call is sent.
 *
 * The effect row and the task's move to `dispatched` are one transaction. Throws when the ledger cannot be written, after
 * closing any task it had started as failed, so the caller sends nothing: a call the ledger cannot hold is not made.
 */
export function openActionEffect(services: Pick<NodeServices, "runtime" | "conductor">, call: ActionCall): OpenedActionEffect {
  const deps = ledgerDeps(services);
  const nodeId = deps.nodeId;
  const task = createTask(deps, {
    conversationId: call.conversationId as never,
    goal: call.intent.slice(0, 500),
    principal: { principalId: call.principalId as never, kind: "user" as const, nodeId: nodeId as never },
  });
  must(applyTaskEvent(deps, task.taskId, "resolve.start"), "the task could not start");
  let effect: EffectRecord | undefined;
  try {
    must(
      applyTaskEvent(deps, task.taskId, "resolve.ready", { executionNodeId: nodeId }, () => {
        const prepared = prepareEffect(deps, {
          taskId: task.taskId,
          executorNodeId: nodeId,
          category: call.effectCategory,
          capabilityRef: call.capabilityRef as CapabilityRef,
          intent: call.intent.slice(0, 500),
          operationDigest: effectOperationDigest(call.capabilityRef, call.args),
          externalSupportsDedup: false,
        });
        const submitted = advanceEffect(prepared, { to: "submitted", at: deps.now() });
        if (!submitted.ok) throw new Error(submitted.message);
        upsertEffect(deps.db, submitted.effect);
        effect = submitted.effect;
      }),
      "the effect could not be written",
    );
  } catch (cause) {
    // Nothing was handed off: the task says so rather than waiting for a call that will not be made.
    try {
      applyTaskEvent(deps, task.taskId, "resolve.failed");
    } catch {
      // The task stays `resolving` with no effect, which claims nothing happened; that is still true.
    }
    throw cause;
  }
  if (effect === undefined) throw new Error("the effect could not be written");
  // Past this point the effect is on record; a task that cannot say it is running still recovers as uncertain.
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return { taskId: task.taskId, effect };
}

/**
 * Settle an opened effect on how the call ended. Answers whether the ledger now holds it as unknown — the only case in
 * which the inbox asks the person — so the caller says that only when it is true.
 *
 * A failure to settle is logged and leaves the row `submitted`, which the next boot turns unknown: the question is
 * delayed, never lost.
 */
export function settleActionEffect(
  services: Pick<NodeServices, "runtime" | "conductor">,
  opened: OpenedActionEffect,
  ending: ActionCallEnding,
): { recorded: boolean } {
  const deps = ledgerDeps(services);
  const at = deps.now();
  try {
    if (ending.kind === "no-answer") {
      const reason = (ending.stopped ? COMMAND_STOPPED_ON_REQUEST : ending.reason).slice(0, 1000);
      if (!markEffectUnknown(deps, opened.effect.effectId, reason).ok) {
        // The task could not take the event (it is not running any more); the row still moves.
        const moved = advanceEffect(opened.effect, { to: "unknown", at, reason });
        if (!moved.ok) return { recorded: false };
        upsertEffect(deps.db, moved.effect);
      }
      const notice = unknownEffectsNotice(deps.db, opened.taskId, at, { language: ownerLocale(services.runtime) });
      // Best effort now; the unknown-effect sweep leaves the same notice for any unknown effect that has none.
      if (notice !== undefined) tryRecordNodeNotice(services, notice);
      return { recorded: true };
    }
    const moved =
      ending.kind === "answered"
        ? advanceEffect(opened.effect, { to: "confirmed", at, evidence: ending.evidence.slice(0, 1000) })
        : advanceEffect(opened.effect, { to: "failed", at, evidence: `nothing was sent: ${ending.reason}`.slice(0, 1000) });
    if (!moved.ok) throw new Error(moved.message);
    // The task leaves `running` for its end state, and the effect row moves in the second of those writes.
    must(applyTaskEvent(deps, opened.taskId, "run.verifying"), "the task could not settle");
    must(
      applyTaskEvent(deps, opened.taskId, ending.kind === "answered" ? "verify.passed" : "verify.failed", {}, () => {
        upsertEffect(deps.db, moved.effect);
      }),
      "the task could not settle",
    );
    return { recorded: false };
  } catch (cause) {
    process.stderr.write(
      `widget action: could not settle ${opened.effect.effectId} in the effect ledger (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
    return { recorded: false };
  }
}
