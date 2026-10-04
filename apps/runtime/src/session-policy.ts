import { contextTerms } from "./context-planner.ts";

/**
 * When a conversation's session is reused, and when the next turn starts a fresh one (#433).
 *
 * A session is reused until it fails, is evicted, or the model changes. Rebuilding on every turn was measured to cost
 * more (each rebuild writes a new cached prefix), so the question is narrower: is a rebuild at a well-chosen boundary
 * cheaper than reuse? This module answers it from numbers the node already has, deterministically:
 *
 * - never on a session's first turn, or while a turn is running;
 * - a rebuild only when the cache has gone cold anyway (idle past its lifetime), the context is large, and the subject
 *   changed: the one case where reuse re-writes a large stale prefix at the write price and a fresh session writes only
 *   a short recap;
 * - the selector, when an operator opted in, only in the band where the subject change is unclear; it is shown counts,
 *   never text;
 * - otherwise reuse.
 *
 * A rebuild happens only when a turn starts, and the transcript is never touched: the fresh session is told the
 * conversation by the planned recap, exactly as one created after a failure is. Off by default; `observe` reports what
 * it would decide and changes nothing.
 */

export type SessionPolicyMode = "off" | "observe" | "rebuild";

export function sessionPolicyFromEnv(env: NodeJS.ProcessEnv): SessionPolicyMode {
  const value = env.CLARKCANT_SESSION_POLICY?.trim().toLowerCase();
  return value === "observe" || value === "rebuild" ? value : "off";
}

/** The thresholds, labelled: each one is a judgement a live A/B should revisit. */
export const SESSION_POLICY_LIMITS = {
  /** How long a provider keeps a cached prefix after its last use; past this, reuse writes the whole prefix again. */
  cacheTtlMs: 5 * 60_000,
  /** A context below this is cheap to re-write, so a rebuild saves too little to lose continuity for. */
  largeContextTokens: 20_000,
  /** At or above this share of new terms the subject changed. */
  shiftRebuild: 0.75,
  /** Between this and `shiftRebuild` the change is unclear, and only the selector, when asked, may call it. */
  shiftAmbiguous: 0.5,
  /** The session's own recent messages the shift is measured against. */
  recentTexts: 6,
} as const;

/** What a session looks like when the next turn starts: counts and times, never text. */
export interface SessionTelemetry {
  ageMs: number;
  idleMs: number;
  /** Turns this session has answered. */
  turns: number;
  contextTokens?: number;
  contextWindow?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** How long the session's last turn took. */
  lastLatencyMs?: number;
  /** 0 when every term of the new message was in the session's recent messages, 1 when none was. */
  topicShift: number;
}

export type SessionDecision = { decision: "reuse" | "rebuild" | "ask"; reason: string };

/**
 * The share of the new message's terms the session's recent messages do not have.
 *
 * Term overlap rather than a model's opinion, so the same messages always give the same number. A message with no
 * terms that carry a subject ("ok", "tiếp đi") is no change at all.
 */
export function topicShift(recent: readonly string[], text: string): number {
  const terms = contextTerms(text);
  if (terms.size === 0) return 0;
  const seen = new Set<string>();
  for (const message of recent) for (const term of contextTerms(message, Number.MAX_SAFE_INTEGER)) seen.add(term);
  let fresh = 0;
  for (const term of terms) if (!seen.has(term)) fresh += 1;
  return fresh / terms.size;
}

/** How many lines differ between two briefs: what changed in the context a turn was given, as a count. */
export function linesChanged(previous: string, next: string): number {
  const before = new Set(previous.split("\n").filter((line) => line.trim() !== ""));
  const after = new Set(next.split("\n").filter((line) => line.trim() !== ""));
  let changed = 0;
  for (const line of before) if (!after.has(line)) changed += 1;
  for (const line of after) if (!before.has(line)) changed += 1;
  return changed;
}

/** The deterministic decision; `ask` only names the band where the selector may be consulted. */
export function decideSessionReuse(telemetry: SessionTelemetry, state: { firstTurn: boolean; inFlight: boolean }): SessionDecision {
  if (state.firstTurn) return { decision: "reuse", reason: "first-turn" };
  if (state.inFlight) return { decision: "reuse", reason: "in-flight" };
  if (telemetry.idleMs < SESSION_POLICY_LIMITS.cacheTtlMs) return { decision: "reuse", reason: "cache-warm" };
  if ((telemetry.contextTokens ?? 0) < SESSION_POLICY_LIMITS.largeContextTokens) return { decision: "reuse", reason: "context-small" };
  if (telemetry.topicShift >= SESSION_POLICY_LIMITS.shiftRebuild) return { decision: "rebuild", reason: "cold-large-new-subject" };
  if (telemetry.topicShift >= SESSION_POLICY_LIMITS.shiftAmbiguous) return { decision: "ask", reason: "subject-unclear" };
  return { decision: "reuse", reason: "same-subject" };
}

/**
 * The decision, with the selector asked in the unclear band when there is one. Its answer can only move an unclear case
 * to rebuild or reuse; anything it does not decide is reuse, which is what the session would have done anyway.
 */
export async function decideSession(
  telemetry: SessionTelemetry,
  state: { firstTurn: boolean; inFlight: boolean },
  ask?: (telemetry: SessionTelemetry) => Promise<boolean | undefined>,
): Promise<SessionDecision> {
  const decided = decideSessionReuse(telemetry, state);
  if (decided.decision !== "ask") return decided;
  if (ask === undefined) return { decision: "reuse", reason: "subject-unclear" };
  const answer = await ask(telemetry).catch(() => undefined);
  if (answer === true) return { decision: "rebuild", reason: "selector-rebuild" };
  return { decision: "reuse", reason: answer === false ? "selector-reuse" : "selector-undecided" };
}

/** One stderr line per turn: counts, times and the decision, never text or ids beyond the conversation's. */
export function reportSessionTelemetry(input: {
  conversationId: string;
  mode: Exclude<SessionPolicyMode, "off">;
  telemetry: SessionTelemetry;
  decision: SessionDecision;
  rebuilt: boolean;
  linesChanged: number;
}): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "session-policy",
      conversationId: input.conversationId,
      mode: input.mode,
      ...input.telemetry,
      topicShift: Number(input.telemetry.topicShift.toFixed(3)),
      linesChanged: input.linesChanged,
      decision: input.decision.decision,
      reason: input.decision.reason,
      rebuilt: input.rebuilt,
    })}\n`,
  );
}
