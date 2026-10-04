import type { ActionBinding, ActionLimits, ActionProposal } from "@clarkcant/contracts";

/**
 * The limits a bound action runs under, and the one place they are counted.
 *
 * A proposal may ask for tighter limits than these defaults; it can never loosen them, because what it asks for is
 * clamped to the ceilings here when the binding is compiled. A binding compiled before limits existed recorded none,
 * and is given the defaults when it runs, so no binding runs unbounded.
 */

interface LimitRange {
  default: number;
  min: number;
  max: number;
}

type Limited = Exclude<ActionProposal["kind"], "view">;

/**
 * Per kind, only the limits that kind can apply.
 *
 * An `invoke` is one service call: the host's own call ceiling is its deadline's ceiling, so a button cannot ask a
 * service for more time than any other caller gets. An `agent` action is a model turn: its budget is tokens, and its
 * time is the node's turn or background deadline. A `workflow` is bounded as a whole, every step inside that deadline.
 */
export const ACTION_LIMITS: Record<Limited, Partial<Record<keyof ActionLimits, LimitRange>>> = {
  invoke: {
    deadlineMs: { default: 60_000, min: 1_000, max: 60_000 },
    maxCallsPerMinute: { default: 30, min: 1, max: 120 },
  },
  agent: {
    maxTokens: { default: 4_000, min: 256, max: 16_000 },
    maxCallsPerMinute: { default: 10, min: 1, max: 30 },
  },
  workflow: {
    deadlineMs: { default: 120_000, min: 1_000, max: 300_000 },
    maxCallsPerMinute: { default: 10, min: 1, max: 60 },
  },
  // One request to the widget's own frame, bounded in time by the host's wait (`WIDGET_PERFORM_TIMEOUT_MS`).
  perform: {
    maxCallsPerMinute: { default: 30, min: 1, max: 120 },
  },
};

/** The limits a binding of this kind runs under: what was asked for, clamped to the ceilings, with the rest defaulted. */
export function effectiveLimits(kind: ActionProposal["kind"], asked: ActionLimits | undefined): ActionLimits {
  if (kind === "view") return {};
  const ranges = ACTION_LIMITS[kind];
  const limits: ActionLimits = {};
  for (const [name, range] of Object.entries(ranges) as [keyof ActionLimits, LimitRange][]) {
    const value = asked?.[name];
    limits[name] = value === undefined ? range.default : Math.min(range.max, Math.max(range.min, value));
  }
  return limits;
}

/** A binding's limits as it runs now: its recorded ones, clamped again, so a binding stored with none is still bounded. */
export function bindingLimits(binding: ActionBinding): ActionLimits {
  return effectiveLimits(binding.proposal.kind, binding.limits);
}

/**
 * Presses per binding in the last minute, on this node.
 *
 * Kept in memory on purpose: it bounds how fast one button can be driven, which a restart does not make any faster in a
 * way that matters, and writing a row per press would cost more than the limit protects. Bounded as well: a binding
 * whose window has emptied is dropped, and past `MAX_TRACKED` bindings the ones pressed longest ago are swept, so the
 * map holds the buttons pressed in the last minute rather than every button ever pressed.
 */
const WINDOW_MS = 60_000;
const MAX_TRACKED = 1_000;
const presses = new Map<string, number[]>();

/** Drop every binding with no press inside the window. */
function sweep(nowMs: number): void {
  for (const [bindingId, times] of presses) {
    const last = times[times.length - 1];
    if (last === undefined || nowMs - last >= WINDOW_MS) presses.delete(bindingId);
  }
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterMs: number; limit: number };

/**
 * Count one use of a binding against its limit, or refuse it with how long until the next is allowed.
 *
 * Counted only when the use is admitted, so a refused press does not push the window further out.
 */
export function admitCall(bindingId: string, perMinute: number, nowMs: number = Date.now()): RateDecision {
  const recent = (presses.get(bindingId) ?? []).filter((at) => nowMs - at < WINDOW_MS);
  if (recent.length >= perMinute) {
    presses.set(bindingId, recent);
    const oldest = recent[0] ?? nowMs;
    return { allowed: false, retryAfterMs: Math.max(0, WINDOW_MS - (nowMs - oldest)), limit: perMinute };
  }
  recent.push(nowMs);
  // Re-inserted so the map's order is least recently pressed first, which is the order a sweep can give up.
  presses.delete(bindingId);
  presses.set(bindingId, recent);
  if (presses.size > MAX_TRACKED) {
    sweep(nowMs);
    // Every tracked binding was pressed in the last minute: the oldest go, which can only let one of them through early.
    for (const bindingId of presses.keys()) {
      if (presses.size <= MAX_TRACKED) break;
      presses.delete(bindingId);
    }
  }
  return { allowed: true };
}

/** The sentence a press over the limit is refused with: what was refused, that nothing ran, and when to try again. */
export function rateLimitedMessage(decision: Extract<RateDecision, { allowed: false }>): string {
  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  return (
    `this action already ran ${String(decision.limit)} times in the last minute, which is its limit; ` +
    `nothing was run this time — try again in ${String(seconds)} s`
  );
}

/** For tests: forget every count. */
export function resetActionRateLimits(): void {
  presses.clear();
}

/** For tests: how many bindings the counter holds. */
export function trackedActionRateLimits(): number {
  return presses.size;
}
