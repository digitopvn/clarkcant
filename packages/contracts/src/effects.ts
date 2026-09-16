import { z } from "zod";

import { effectCategorySchema, instantSchema, type Instant } from "./primitives.ts";

/**
 * Effect ledger.
 *
 * The ledger exists because external side effects are not atomic with the local
 * database. A process can die between "HTTP request sent" and "response
 * recorded", and no amount of retry logic can recover that by itself. Modelling
 * the gap explicitly is the only way to avoid double-spending a side effect.
 *
 * `unknown` is a resting state, not an error state. It is cleared only by
 * observing the external system, never by re-issuing the write.
 */

export const effectStateSchema = z.enum([
  "prepared",
  "submitted",
  "confirmed",
  "failed",
  "unknown",
]);
export type EffectState = z.infer<typeof effectStateSchema>;

/** Terminal-by-observation: a human or a probe decided what actually happened. */
export const effectResolutionSchema = z.enum([
  "observed-applied",
  "observed-not-applied",
  "abandoned-with-disclosure",
]);
export type EffectResolution = z.infer<typeof effectResolutionSchema>;

export const effectRecordSchema = z.strictObject({
  effectId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128).optional(),
  /**
   * Node that performed the effect. Reconciliation happens here, because this is
   * the only place that can observe the external system.
   */
  executorNodeId: z.string().min(1).max(128),
  category: effectCategorySchema,
  /** Capability or tool that carried the effect out. */
  capabilityRef: z.string().min(1).max(160),
  /** Idempotency key handed to the external system when it supports one. */
  externalIdempotencyKey: z.string().min(1).max(200).optional(),
  /** Whether the external API can deduplicate. Drives whether retry is even offered. */
  externalSupportsDedup: z.boolean(),
  state: effectStateSchema,
  /** Stable description of the intended effect, shown verbatim in approvals. */
  intent: z.string().min(1).max(2000),
  /** Digest of the exact operation, so an approved plan cannot be swapped out. */
  operationDigest: z.string().min(1).max(120),
  preparedAt: instantSchema,
  submittedAt: instantSchema.optional(),
  settledAt: instantSchema.optional(),
  resolution: effectResolutionSchema.optional(),
  /** Evidence used to move out of `unknown`. */
  reconciliationEvidence: z.string().min(1).max(1000).optional(),
  /** How many times a submit was attempted. Never incremented while unknown. */
  submitAttempts: z.int().nonnegative(),
});
export type EffectRecord = z.infer<typeof effectRecordSchema>;

export type EffectTransitionOutcome =
  | { ok: true; state: EffectState; retryAllowed: boolean }
  | { ok: false; code: "ILLEGAL_EFFECT_TRANSITION"; message: string };

const EFFECT_TRANSITIONS: Record<EffectState, readonly EffectState[]> = {
  prepared: ["submitted", "failed"],
  submitted: ["confirmed", "failed", "unknown"],
  // Reached only by observing the external system.
  unknown: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
};

export function canTransitionEffect(from: EffectState, to: EffectState): boolean {
  return EFFECT_TRANSITIONS[from].includes(to);
}

/**
 * Decide whether a submit may be retried.
 *
 * This is the single most consequential function in the ledger. It answers "no"
 * whenever the previous attempt might have landed: `submitted` with a lost
 * acknowledgement and `unknown` both mean the external world is in a state we
 * cannot see, and the honest response is to reconcile.
 */
export function mayRetrySubmit(effect: Pick<EffectRecord, "state" | "externalSupportsDedup">): boolean {
  if (effect.state === "prepared" || effect.state === "failed") return true;
  // Already confirmed: re-sending would duplicate.
  if (effect.state === "confirmed") return false;
  // `submitted` means we handed it off and never heard back.
  if (effect.state === "submitted") return false;
  // `unknown` means exactly that.
  if (effect.state === "unknown") return false;
  return effect.externalSupportsDedup;
}

export type EffectAdvance =
  | { ok: true; effect: EffectRecord }
  | { ok: false; code: "ILLEGAL_EFFECT_TRANSITION"; message: string };

/**
 * Advance the ledger.
 *
 * Timestamps are passed in rather than read from the clock so the state machine
 * stays deterministic and testable, and so a peer's clock never influences our
 * durability decisions.
 */
export function advanceEffect(
  effect: EffectRecord,
  move:
    | { to: "submitted"; at: Instant }
    | { to: "confirmed"; at: Instant; evidence?: string }
    | { to: "failed"; at: Instant; evidence?: string }
    | { to: "unknown"; at: Instant; reason: string },
): EffectAdvance {
  if (!canTransitionEffect(effect.state, move.to)) {
    return {
      ok: false,
      code: "ILLEGAL_EFFECT_TRANSITION",
      message: `cannot move effect from ${effect.state} to ${move.to}`,
    };
  }

  const next: EffectRecord = { ...effect };

  if (move.to === "submitted") {
    // A prior unknown outcome must be reconciled, not resubmitted.
    if (effect.state === "unknown") {
      return {
        ok: false,
        code: "ILLEGAL_EFFECT_TRANSITION",
        message: "an effect with unknown outcome must be reconciled before resubmission",
      };
    }
    next.state = "submitted";
    next.submittedAt = move.at;
    next.submitAttempts = effect.submitAttempts + 1;
    return { ok: true, effect: next };
  }

  next.settledAt = move.at;
  if (move.to === "unknown") {
    next.state = "unknown";
    next.reconciliationEvidence = move.reason;
    return { ok: true, effect: next };
  }

  next.state = move.to;
  next.resolution =
    move.to === "confirmed" ? "observed-applied" : "observed-not-applied";
  if (move.evidence !== undefined) next.reconciliationEvidence = move.evidence;
  return { ok: true, effect: next };
}

/**
 * Whether a task may be reported as succeeded with this ledger.
 *
 * An effect still in `prepared` or `submitted` or `unknown` means the world is
 * not in a known state, so the task cannot claim success no matter how clean the
 * worker's own output looked.
 */
export function ledgerBlocksSuccess(effects: readonly EffectRecord[]): EffectRecord | undefined {
  return effects.find(
    (effect) => effect.state === "prepared" || effect.state === "submitted" || effect.state === "unknown",
  );
}
