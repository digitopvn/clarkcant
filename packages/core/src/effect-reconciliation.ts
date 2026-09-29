import { type EffectRecord, type TaskEvent, type TaskRecord, advanceEffect, reduceTask } from "@clarkcant/contracts";
import {
  type Database,
  appendEvent,
  effectsForTask,
  getEffect,
  getTask,
  taskEventDocuments,
  transaction,
  unsettledEffects,
  upsertEffect,
  upsertTask,
} from "@clarkcant/storage";

import type { TaskServiceDeps } from "./task-service.ts";

/**
 * A person's answer to an effect whose outcome nobody observed.
 *
 * An effect is `unknown` when it was handed off and its answer never came back. Nothing on the node can tell whether it
 * landed, and running it again to find out is how it would happen twice, so the one way out is somebody looking at the
 * other side — the remote, the service — and saying which it was. This records that answer, through the ledger's own
 * state machine (`advanceEffect`: `unknown` moves only to `confirmed` or `failed`), with who gave it and when.
 *
 * It is the person's to give. Every surface that reaches it is one the person holds; a machine surface cannot, because an
 * AI client that could say "that push landed" could clear its own uncertainty and then report its own success.
 */
export type ReconcileOutcome = "confirmed" | "failed";

/** Where the answer was given, for the record. Every one of them is the person's own surface. */
export type ReconcileSource = "click" | "chat" | "voice";

/** How a task left `uncertain` once nothing about it is unknown any more, and the sentence that says so. */
export interface ReconciledSettlement {
  outcome: "succeeded" | "failed" | "cancelled";
  message: string;
}

export type ReconcileEffectResult =
  | {
      ok: true;
      effect: EffectRecord;
      task: TaskRecord | undefined;
      /** The task's effects still unknown after this answer, oldest first. */
      remainingUnknown: EffectRecord[];
      /** How the task settled in the same write, when this answer was the last thing it was uncertain about. */
      settlement: ReconciledSettlement | undefined;
    }
  | { ok: false; code: "EFFECT_NOT_FOUND"; message: string }
  | { ok: false; code: "EFFECT_NOT_UNKNOWN"; message: string; state: EffectRecord["state"] };

/**
 * Whether `principalId` may answer for this effect: one this node carried out, for a task it holds that was asked for
 * by that person, or by nobody in particular (the node's own work, or work a peer handed this node's owner). A task
 * another person asked for is theirs to answer, and reads here as not found rather than as refused, so its existence is
 * not disclosed either.
 */
function ownedBy(scope: AnswerScope, effect: EffectRecord): boolean {
  if (effect.executorNodeId !== scope.nodeId) return false;
  const task = getTask(scope.db, effect.taskId);
  if (task === undefined) return false;
  const origin = task.origin;
  if (origin === undefined || origin.kind === "system" || origin.kind === "delegated") return true;
  return origin.principalId === scope.principalId;
}

/** Who is answering, on which node: what decides whether an effect is theirs to answer for. */
export interface AnswerScope {
  db: Database;
  nodeId: string;
  principalId: string;
}

/**
 * The oldest effect of a task that is still `unknown` and that this principal may answer for, or nothing. What the
 * inbox offers to answer for, decided by the same rule `reconcileEffect` enforces, so a button is never offered that the
 * route would refuse as not found.
 */
export function answerableUnknownEffect(scope: AnswerScope, taskId: string): EffectRecord | undefined {
  return effectsForTask(scope.db, taskId).find((effect) => effect.state === "unknown" && ownedBy(scope, effect));
}

/**
 * Every effect on this node still `unknown` that this principal may answer for, oldest first: what a sentence such as
 * "it took effect" could be about. The caller answers only when there is exactly one — a sentence carries no effect id,
 * so with two waiting it would be a guess.
 */
export function answerableUnknownEffects(scope: AnswerScope): EffectRecord[] {
  return unsettledEffects(scope.db, scope.nodeId).filter((effect) => effect.state === "unknown" && ownedBy(scope, effect));
}

/**
 * Record what the person observed. `EFFECT_NOT_FOUND` for an id this principal cannot answer for, `EFFECT_NOT_UNKNOWN`
 * once it is no longer a question — answered already, from another surface or a second press.
 *
 * The effect row, the `effect.reconciled` event (who, when, from where) and — when `settle` is set and this was the last
 * thing the task was uncertain about — the task's settlement are one write: the ledger never says `confirmed` without
 * saying who said so, and a task never keeps reading `uncertain` about something already answered. `settle` is false
 * while the task's run is still going; the run's own settlement (`settleDispatchedTask`) finishes it then.
 */
export function reconcileEffect(
  deps: TaskServiceDeps,
  input: { effectId: string; outcome: ReconcileOutcome; principalId: string; source: ReconcileSource; settle: boolean },
): ReconcileEffectResult {
  const effect = getEffect(deps.db, input.effectId);
  if (effect === undefined || !ownedBy({ db: deps.db, nodeId: deps.nodeId, principalId: input.principalId }, effect)) {
    return { ok: false, code: "EFFECT_NOT_FOUND", message: `no effect ${input.effectId} to answer for` };
  }
  if (effect.state !== "unknown") {
    return {
      ok: false,
      code: "EFFECT_NOT_UNKNOWN",
      message: `effect ${effect.effectId} is ${effect.state}, not unknown; there is nothing left to answer`,
      state: effect.state,
    };
  }
  const at = deps.now();
  const evidence =
    input.outcome === "confirmed"
      ? `recorded by ${input.principalId} at ${at}: it took effect`
      : `recorded by ${input.principalId} at ${at}: it did not take effect`;
  const moved = advanceEffect(effect, { to: input.outcome, at, evidence });
  // Only reachable if the state machine changed under this code: `unknown` is checked above.
  if (!moved.ok) return { ok: false, code: "EFFECT_NOT_UNKNOWN", message: moved.message, state: effect.state };
  const settlement = transaction(deps.db, () => {
    upsertEffect(deps.db, moved.effect);
    const task = getTask(deps.db, effect.taskId);
    appendEvent(deps.db, {
      eventId: deps.newId("evt"),
      kind: "effect.reconciled",
      stream: "task",
      nodeId: deps.nodeId,
      ...(task === undefined ? {} : { conversationId: task.conversationId }),
      taskId: effect.taskId,
      document: {
        taskId: effect.taskId,
        effectId: effect.effectId,
        outcome: input.outcome,
        decidedBy: input.principalId,
        source: input.source,
        at,
      },
      occurredAt: at,
    });
    return input.settle ? settleInTransaction(deps, effect.taskId) : undefined;
  });
  return {
    ok: true,
    effect: moved.effect,
    task: getTask(deps.db, effect.taskId),
    remainingUnknown: effectsForTask(deps.db, effect.taskId).filter((other) => other.state === "unknown"),
    settlement,
  };
}

/**
 * Settle a task that is `uncertain` only because of effects the person has answered for, or leave it — in one write.
 *
 * Left alone when it is not `uncertain`, when any of its effects is still unsettled, or when it became uncertain for a
 * reason no effect explains (a dispatch that timed out: whether the worker started is not an effect anyone reconciled).
 *
 * Otherwise, through the machine's own `reconcile.*` events:
 *
 *   - `cancelled` when it became uncertain on its way to stopping — the person's stop stands; what they recorded says
 *     whether the thing it was doing landed first, and the message says which;
 *   - `failed` when an effect the person answered for did not take effect;
 *   - `succeeded` only when every answered effect landed and the run's own last evidence was verified — the same
 *     positive-evidence rule every other path to success keeps (`checkSuccessPreconditions`): "the push landed" is not
 *     "the task did what it was asked";
 *   - `failed`, saying so, when the effects landed but the run never verified its result.
 */
export function settleReconciledTask(deps: TaskServiceDeps, taskId: string): ReconciledSettlement | undefined {
  return transaction(deps.db, () => settleInTransaction(deps, taskId));
}

interface StateChange {
  state?: unknown;
  from?: unknown;
  event?: unknown;
}

function settleInTransaction(deps: TaskServiceDeps, taskId: string): ReconciledSettlement | undefined {
  const plan = settlementPlan(deps.db, taskId);
  if (plan === undefined) return undefined;
  const at = deps.now();
  let current = plan.task;
  for (const event of ["reconcile.start", plan.event] as const) {
    const outcome = reduceTask(current.state, event);
    // Only reachable if the task machine changed under this code: the plan read `uncertain`.
    if (!outcome.ok) throw new Error(outcome.message);
    const next: TaskRecord = { ...current, state: outcome.state, revision: current.revision + 1, updatedAt: at };
    upsertTask(deps.db, next);
    appendEvent(deps.db, {
      eventId: deps.newId("evt"),
      kind: "task.state_changed",
      stream: "task",
      nodeId: deps.nodeId,
      conversationId: next.conversationId,
      taskId,
      document: { taskId, state: next.state, revision: next.revision, from: current.state, event },
      occurredAt: at,
    });
    current = next;
  }
  return plan.settlement;
}

function settlementPlan(
  db: Database,
  taskId: string,
): { task: TaskRecord; event: TaskEvent; settlement: ReconciledSettlement } | undefined {
  const task = getTask(db, taskId);
  if (task === undefined || task.state !== "uncertain") return undefined;
  const effects = effectsForTask(db, taskId);
  if (effects.some((effect) => effect.state === "prepared" || effect.state === "submitted" || effect.state === "unknown")) {
    return undefined;
  }
  const entered = (taskEventDocuments(db, { taskId, kind: "task.state_changed", limit: 50 }) as StateChange[]).find(
    (change) => change.state === "uncertain",
  );
  if (entered === undefined || entered.event !== "effect.unknown") return undefined;

  // Newest first, so a later answer for the same effect (there is none today: `unknown` is answered once) would win.
  const answered = new Map<string, "confirmed" | "failed">();
  for (const document of taskEventDocuments(db, { taskId, kind: "effect.reconciled", limit: 100 }) as Array<{
    effectId?: unknown;
    outcome?: unknown;
  }>) {
    if (typeof document.effectId !== "string" || answered.has(document.effectId)) continue;
    if (document.outcome === "confirmed" || document.outcome === "failed") answered.set(document.effectId, document.outcome);
  }
  const reconciled = effects.filter((effect) => answered.has(effect.effectId));
  // Uncertain about something nobody answered for: not this function's to settle.
  if (reconciled.length === 0) return undefined;
  const didNotLand = reconciled.find((effect) => answered.get(effect.effectId) === "failed");
  const landed = reconciled.filter((effect) => answered.get(effect.effectId) === "confirmed").map(quotedEffectIntent).join(", ");

  if (entered.from === "cancel_requested") {
    return {
      task,
      event: "reconcile.cancelled",
      settlement: {
        outcome: "cancelled",
        message:
          didNotLand !== undefined
            ? `bạn xác nhận ${quotedEffectIntent(didNotLand)} chưa có hiệu lực; việc vẫn dừng theo yêu cầu của bạn`
            : `bạn xác nhận ${landed} đã có hiệu lực trước khi dừng; việc vẫn dừng theo yêu cầu của bạn`,
      },
    };
  }
  if (didNotLand !== undefined) {
    return {
      task,
      event: "reconcile.failed",
      settlement: { outcome: "failed", message: `bạn xác nhận ${quotedEffectIntent(didNotLand)} chưa có hiệu lực` },
    };
  }
  const [lastEvidence] = taskEventDocuments(db, { taskId, kind: "evidence.recorded", limit: 1 }) as Array<{ verdict?: unknown }>;
  if (lastEvidence?.verdict === "verified") {
    return { task, event: "reconcile.succeeded", settlement: { outcome: "succeeded", message: `bạn xác nhận ${landed} đã có hiệu lực` } };
  }
  return {
    task,
    event: "reconcile.failed",
    settlement: {
      outcome: "failed",
      message: `bạn xác nhận ${landed} đã có hiệu lực, nhưng lần chạy chưa xác minh được kết quả của việc nên chưa thể báo là xong`,
    },
  };
}

/** An effect as a person recognises it: the start of its own intent (a command, before where it ran), quoted. */
export function quotedEffectIntent(effect: EffectRecord): string {
  const intent = effect.intent.split(" — ")[0] ?? effect.intent;
  const flat = intent.replace(/\s+/g, " ").trim();
  return `“${flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`}”`;
}
