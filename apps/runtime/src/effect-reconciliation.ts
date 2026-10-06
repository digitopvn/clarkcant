import { type EffectReconcileResponse, type Instant, nowInstant } from "@clarkcant/contracts";
import { type ReconcileOutcome, type ReconcileSource, quotedEffectIntent, reconcileEffect } from "@clarkcant/core";
import { dismissNotificationByKey, dismissNotificationsByKeyPrefix, getEffect } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "./app-intents.ts";
import { unknownEffectFollowUpKey, unknownEffectsNotice } from "./effect-notices.ts";
import { hostText, ownerLocale } from "./host-text.ts";
import { tryRecordNodeNotice, workerNoticeKey } from "./notices.ts";
import { appendHostReply } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";
import { taskDispatchReports } from "./task-reporting.ts";

/**
 * Recording what a person saw of an effect whose outcome nobody observed, for this node's owner.
 *
 * The one path every surface takes — the inbox's two buttons, a typed or spoken "it landed" — so they cannot disagree
 * about what an answer does. What it does, in order:
 *
 *   1. writes the answer through the ledger's state machine, with who and when (`reconcileEffect` in core), and settles
 *      the task in the same write when this was the last thing it was uncertain about and no run of it is still going;
 *   2. resolves the notice that asked: the task's own notice and any follow-up are dismissed, the way a person would,
 *      so they stay deduplicated; when another effect of the task is still unknown, one new notice names that one;
 *   3. tells the conversation: how the task settled, through the same report a run's own settlement uses (and so the
 *      peer that handed the task over hears it too), or, when it did not settle yet, what was recorded and what is left.
 */
export type EffectReconcileServices = NodeServices;

export type EffectReconcileResult =
  | { ok: true; response: EffectReconcileResponse }
  | { ok: false; status: 404 | 409; code: "RESOURCE_NOT_FOUND" | "EFFECT_NOT_UNKNOWN"; message: string };

export function reconcileEffectForNode(
  services: EffectReconcileServices,
  input: { effectId: string; outcome: ReconcileOutcome; source: ReconcileSource; at: Instant },
): EffectReconcileResult {
  const principalId = services.runtime.identity.ownerPrincipalId;
  const before = getEffect(services.runtime.db, input.effectId);
  // A run whose report is still to come settles the task itself when it reports (`settleDispatchedTask`); settling it
  // here as well would race that report. Not `holds`: the dispatcher keeps holding a task while it tidies up after the
  // report, and an answer given then has no later report to settle it.
  const runGoing = before !== undefined && services.taskDispatch?.reportPending(before.taskId) === true;
  const recorded = reconcileEffect(
    { ...services.conductor, now: () => input.at },
    { effectId: input.effectId, outcome: input.outcome, principalId, source: input.source, settle: !runGoing },
  );
  if (!recorded.ok) {
    return recorded.code === "EFFECT_NOT_FOUND"
      ? { ok: false, status: 404, code: "RESOURCE_NOT_FOUND", message: "there is no action with that id whose outcome you can record" }
      : {
          ok: false,
          status: 409,
          code: "EFFECT_NOT_UNKNOWN",
          message: `that action's outcome is no longer unknown (it is ${recorded.state}), so there is nothing left to record`,
        };
  }

  const { effect, task, remainingUnknown, settlement } = recorded;
  const taskId = effect.taskId;
  resolveNotices(services, taskId, remainingUnknown[0]?.effectId, input.at);

  const conversationId = task?.conversationId;
  if (conversationId !== undefined) {
    try {
      if (settlement !== undefined) {
        taskDispatchReports(services).onSettled({
          taskId,
          conversationId,
          outcome: settlement.outcome,
          message: settlement.message,
          reason: settlement.reason,
        });
      } else {
        appendHostReply(services, { conversationId, text: recordedLine(services, effect, input.outcome, taskId, remainingUnknown.length, runGoing), at: input.at });
      }
    } catch (cause) {
      // The answer is recorded and the task settled; a conversation that could not be told is a missed line, not a lost answer.
      process.stderr.write(`effects: could not tell conversation ${conversationId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  }

  return {
    ok: true,
    response: {
      effectId: effect.effectId,
      taskId,
      outcome: input.outcome,
      taskState: task?.state ?? "unknown",
      ...(settlement === undefined ? {} : { settled: settlement.outcome }),
      remainingUnknown: remainingUnknown.length,
    },
  };
}

/**
 * The notice that asked is answered, so it leaves the inbox: the task's own and any follow-up for an earlier effect.
 * Exact key plus the follow-up family (`worker:<taskId>:`), never the bare prefix, which would also take another task
 * whose id starts with this one's. When another effect is still unknown, it gets one notice of its own.
 */
function resolveNotices(services: EffectReconcileServices, taskId: string, nextUnknownId: string | undefined, at: Instant): void {
  const db = services.runtime.db;
  const principalId = services.runtime.identity.ownerPrincipalId;
  try {
    dismissNotificationByKey(db, { principalId, dedupKey: workerNoticeKey(taskId), at });
    dismissNotificationsByKeyPrefix(db, { principalId, dedupKeyPrefix: `${workerNoticeKey(taskId)}:`, at });
    if (nextUnknownId !== undefined) {
      const next = unknownEffectsNotice(db, taskId, at, {
        dedupKey: unknownEffectFollowUpKey(taskId, nextUnknownId),
        language: ownerLocale(services.runtime),
      });
      if (next !== undefined) tryRecordNodeNotice(services, next);
    }
  } catch (cause) {
    process.stderr.write(`inbox: could not resolve the notices of task ${taskId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

/** What the conversation hears when the answer is recorded but the task has not settled on it yet. */
function recordedLine(
  services: EffectReconcileServices,
  effect: Parameters<typeof quotedEffectIntent>[0],
  outcome: ReconcileOutcome,
  taskId: string,
  remaining: number,
  runGoing: boolean,
): string {
  const locale = preferredAppIntentLocale({ db: services.runtime.db, now: nowInstant }, services.runtime.identity.ownerPrincipalId);
  return hostText(locale).tasks.effectRecorded(taskId, quotedEffectIntent(effect, locale), outcome === "confirmed", remaining, runGoing);
}
