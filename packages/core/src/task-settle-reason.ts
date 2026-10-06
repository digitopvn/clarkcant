/**
 * Why a task was settled the way it was, when the words are the host's own rather than the run's.
 *
 * A settled task carries a `message`: the sentence a peer that handed the task over is sent, and the one tests and
 * stored records read. When the host itself wrote that sentence (the run reported nothing, a stop raced the run, the
 * success gate refused), it also carries one of these, so the surfaces this node's owner reads can word it in the
 * owner's language instead of passing the host's English (or Vietnamese) through under a localized title.
 *
 * Text quoted from somewhere else — what a run reported, an evidence summary, an effect's intent — travels as data and
 * is shown quoted, never translated.
 */

/** Why the success gate refused a run, as `checkSuccessPreconditions` found it. */
export type SuccessGateReason =
  | { kind: "no-evidence" }
  | { kind: "nothing-verified" }
  | { kind: "contradicted"; summary: string }
  | { kind: "effect-unsettled"; effectId: string; state: string };

export type TaskSettleReason =
  /** The task was not found when its run reported. */
  | { code: "task-missing" }
  /** The task had already ended before its run reported. */
  | { code: "already-ended" }
  /** The run reported nothing to settle on. */
  | { code: "no-evidence" }
  /** Stopped on request, and the run reported nothing. */
  | { code: "stopped-unreported" }
  /** The run finished after a stop was asked for; `runSummary` is what it reported, absent when an effect is unsettled. */
  | { code: "finished-after-stop"; runSummary?: string }
  /** An effect of the run is still unsettled, so the outcome is undetermined. */
  | { code: "effect-unsettled"; effectId: string; state: string }
  /** The success gate refused the run; `runSummary` leads when the run itself did not verify its result. */
  | { code: "not-accepted"; gate: SuccessGateReason; runSummary?: string }
  /**
   * Settled on what the person recorded about its effects. `stopped` when it was on its way to stopping; `didNotLand`
   * is the intent of an effect they said did not take effect; `landed` the intents of those that did; `unverified` when
   * every effect landed but the run never verified its result.
   */
  | { code: "reconciled"; stopped: boolean; didNotLand?: string; landed: string[]; unverified: boolean };
