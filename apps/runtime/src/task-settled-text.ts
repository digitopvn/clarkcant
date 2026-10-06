import type { AppIntentLocale, DataClass } from "@clarkcant/contracts";
import type { PolicyRefusal, TaskSettleReason } from "@clarkcant/core";

import { dispatchRefusalOwnerText, settleReasonOwnerText } from "./task-settled-owner-text.ts";
import { dataClassTaskRefusal } from "./send-boundary.ts";

/**
 * Why a dispatched task was refused or ended without an accepted result, when this node's dispatcher decided it.
 *
 * The dispatcher's sentence for a task is written from this in English (`dispatchRefusalMessage`): that is what the task's
 * evidence records and what a peer that handed the task over is sent, both unchanged. The owner of this node is told
 * the same thing in their own language (`taskSettledText`), where text from elsewhere — an error, a lease's own
 * message — is quoted rather than blended into the sentence, and internal codes are left out.
 */
export type DispatchRefusal =
  | { code: "stopped-before-start" }
  | { code: "capability-busy"; capabilityRef: string; heldUntil?: string; detail?: string }
  | { code: "browser-not-asked" }
  | { code: "browser-no-sites" }
  | { code: "browser-sites-mismatch" }
  | { code: "unscoped-background" }
  | { code: "root-not-owned"; path: string }
  | { code: "data-class"; dataClass: DataClass; model: string; checked: "model" | "every-candidate"; unread: boolean }
  | { code: "no-model" }
  | { code: "model-not-chosen"; detail: string }
  | { code: "model-no-tools"; model: string }
  /** `reason` is the policy's own English sentence, kept for the message a peer is sent. */
  | { code: "policy-denied"; refusal: PolicyRefusal; reason: string }
  | { code: "no-worktree-place" }
  | { code: "worktree-failed"; detail: string }
  | { code: "no-browser" }
  | { code: "browser-policy-unknown" }
  | { code: "wall-clock"; maxMs: number }
  | { code: "stopped-during-run" }
  | { code: "token-budget"; maxTokens: number; used: number }
  | { code: "worker-failed"; detail: string }
  | { code: "shutting-down" }
  | { code: "queue-full"; running: number; waiting: number };

/** Every reason a settled task's host-written message stands for: the conductor's, or this node's dispatcher's. */
export type TaskSettledReason = TaskSettleReason | DispatchRefusal;

/**
 * The dispatcher's sentence for a refusal, in English: what the task records and what a peer is sent. Kept word for
 * word as it was before the owner was told it in their own language, so stored records and peers see no change.
 */
export function dispatchRefusalMessage(reason: DispatchRefusal): string {
  const never = "the worker was never started";
  switch (reason.code) {
    case "stopped-before-start":
      return "stopped before a worker was started for it";
    case "capability-busy":
      return `capability ${reason.capabilityRef} is busy on this node (${reason.heldUntil === undefined ? (reason.detail ?? "busy") : `held by another run until ${reason.heldUntil}`}); the task was not run and can be retried`;
    case "browser-not-asked":
      return `refused: a browser task acts only for a person who asked for it in the conversation, and this one was not started that way; ${never}`;
    case "browser-no-sites":
      return `refused: the task carries no checked list of sites, so there is no site it could be allowed onto; ${never}`;
    case "browser-sites-mismatch":
      return `refused: the sites the task was checked for are not the sites its goal names; ${never}`;
    case "unscoped-background":
      return (
        "refused: work nobody asked for in this conversation has to name the folder or repository it may touch, " +
        "and this task named none, so the worker was never started"
      );
    case "root-not-owned":
      return `refused: ${reason.path} is not a root this node owns, so the worker was never started`;
    case "data-class":
      return dataClassTaskRefusal(reason);
    case "no-model":
      return `refused: this node has no model configured to do the work; ${never} and nothing was done`;
    case "model-not-chosen":
      return `refused: the model for it could not be chosen (${reason.detail}); ${never} and nothing was done`;
    case "model-no-tools":
      return `refused: the model this task would run on (${reason.model}) cannot call tools, so it could not use the browser; choose one that can in Settings → AI & Routing; ${never} and nothing was done`;
    case "policy-denied":
      return `refused: ${reason.reason}`;
    case "no-worktree-place":
      return `refused: this node keeps no place for task worktrees, so a repository cannot be worked on; ${never}`;
    case "worktree-failed":
      return `refused: ${reason.detail}; ${never}`;
    case "no-browser":
      return `refused: this node gives no task a browser; ${never}`;
    case "browser-policy-unknown":
      return `refused: the execution policy was never asked about this task, because this node does not know the browser capability; ${never}`;
    case "wall-clock":
      return `the wall-clock budget of ${String(reason.maxMs)} ms was exhausted before the worker finished; nothing it did was verified; raise the task's budget or re-run it`;
    case "stopped-during-run":
      return "stopped on request before the worker finished; nothing it did was verified";
    case "token-budget":
      return `the token budget of ${String(reason.maxTokens)} was exceeded (the worker used ${String(reason.used)}); the run already happened but is not accepted, and can be retried with a higher budget`;
    case "worker-failed":
      return `the worker could not run: ${reason.detail}`;
    case "shutting-down":
      return "this node is shutting down; the task was not run and can be retried once the node is back";
    case "queue-full":
      return `this node already has ${String(reason.running)} task workers running and ${String(reason.waiting)} waiting, which is its limit; the task was not run and can be retried once one finishes`;
  }
}

/**
 * Which family each conductor reason code belongs to, checked by the compiler: a code added to `TaskSettleReason` and
 * missing here, or one here that is not a conductor code, fails to typecheck rather than being routed as a dispatcher's.
 */
const SETTLE_REASON_CODES = {
  "task-missing": true,
  "already-ended": true,
  "no-evidence": true,
  "stopped-unreported": true,
  "finished-after-stop": true,
  "effect-unsettled": true,
  "not-accepted": true,
  reconciled: true,
} as const satisfies Record<TaskSettleReason["code"], true>;

function isSettleReason(reason: TaskSettledReason): reason is TaskSettleReason {
  return Object.hasOwn(SETTLE_REASON_CODES, reason.code);
}

/**
 * What a settled task's host-written message says, in the owner's language. Vietnamese when no language is named.
 *
 * Without a reason the message is the run's own words (or a peer's), shown as written; with one, the message is the
 * host's and is worded again here, so a title in the owner's language never sits over a body in another.
 */
export function taskSettledText(input: { message: string; reason?: TaskSettledReason }, locale: AppIntentLocale = "vi"): string {
  const { reason } = input;
  if (reason === undefined) return input.message;
  return isSettleReason(reason) ? settleReasonOwnerText(reason, locale) : dispatchRefusalOwnerText(reason, locale);
}
