import { z } from "zod";

import type { feedbackCardSchema } from "./feedback.ts";
import type { commandCardSchema, providerSignInViewSchema } from "./slash-commands.ts";
import type { StatusTone } from "./status-cards.ts";
import type {
  approvalCardBlockSchema,
  browserSessionCardSchema,
  connectionCardBlockSchema,
  questionCardBlockSchema,
  reconnectCardSchema,
  systemCardBlockSchema,
  taskOverviewCardSchema,
  taskProgressCardSchema,
  taskSummaryCardSchema,
  toolActivityBlockSchema,
} from "./surfaces.ts";
import { oneLineText } from "./text-rules.ts";
import type { widgetLifecycleSchema } from "./widgets.ts";

/**
 * What a miniapp's state means, whatever machine produced it.
 *
 * Every built-in miniapp keeps its own state machine — a connection has fourteen states, a task summary has an outcome
 * and a separate evidence verdict, a sign-in runs, waits and settles. Those machines stay as they are: they carry the
 * facts. This contract is the one vocabulary they are read through when a surface has to decide how a state looks,
 * whether it is said aloud, whether it can be retried and whether it is still current. One reading for every surface is
 * what keeps a failure from looking like a success on one card while the next card gets it right.
 *
 * Nothing here is a wire format of its own yet. The schemas are strict so that a card that later carries a phase or a
 * reported value carries a checked one, versioned by the block that holds it.
 */

/* ------------------------------------------------------------------ *
 * Phases
 * ------------------------------------------------------------------ */

/**
 * - `loading`: the surface is reading what it shows and has nothing yet. Never an outcome.
 * - `empty`: the read succeeded and there is nothing. A different truth from `unavailable`.
 * - `pending`: the system is doing the work.
 * - `needs-action`: the work waits on the person — a decision, a sign-in, a permission.
 * - `success`: the work finished and nothing contradicts it.
 * - `partial`: it finished with something missing, unverified or degraded.
 * - `error`: it failed, or what it claimed is contradicted.
 * - `unavailable`: it cannot be done or read here, for a stated reason (unsupported, disabled, not permitted).
 * - `cancelled`: it was stopped, declined or expired before it finished.
 */
export const SURFACE_PHASES = [
  "loading",
  "empty",
  "pending",
  "needs-action",
  "success",
  "partial",
  "error",
  "unavailable",
  "cancelled",
] as const;
export const surfacePhaseSchema = z.enum(SURFACE_PHASES);
export type SurfacePhase = (typeof SURFACE_PHASES)[number];

/** Phases that end an attempt. A later "still working" for the same attempt never reopens one. */
export const OUTCOME_PHASES = ["success", "partial", "error", "cancelled"] as const satisfies readonly SurfacePhase[];

export function isOutcomePhase(phase: SurfacePhase): boolean {
  return (OUTCOME_PHASES as readonly SurfacePhase[]).includes(phase);
}

/**
 * The tone a phase is drawn in. One table, so `partial` is never green on one card and amber on the next.
 *
 * Tone is the second signal: every surface also says the phase in words or with a mark (DESIGN.md §15).
 */
export const SURFACE_PHASE_TONE: Record<SurfacePhase, StatusTone> = {
  loading: "neutral",
  empty: "neutral",
  pending: "info",
  "needs-action": "warning",
  success: "success",
  partial: "warning",
  error: "danger",
  // Something stands in the way and the card says what: louder than a quiet ending, quieter than a failure.
  unavailable: "warning",
  cancelled: "neutral",
};

/**
 * A mark for each phase, so state is never told by colour alone. Text, not an icon font: it survives a screenshot, a
 * transcript copy and a forced-colours theme. The pending mark is static; motion, when there is any, is added by the
 * surface and switched off under reduced motion.
 */
export const SURFACE_PHASE_MARK: Record<SurfacePhase, string> = {
  loading: "…",
  empty: "○",
  pending: "◐",
  "needs-action": "!",
  success: "✓",
  partial: "◑",
  error: "✕",
  unavailable: "⊘",
  cancelled: "—",
};

/* ------------------------------------------------------------------ *
 * Snapshot or live
 * ------------------------------------------------------------------ */

/**
 * Whether a surface is a record or a view.
 *
 * - `snapshot`: what the host wrote at a moment in the transcript. It is never refetched, so it can never be stale —
 *   it says when it was true (`statedAt`) and stops there. Most host cards are snapshots.
 * - `live`: a view the surface keeps current (a poll, a socket, a lease). It was last confirmed at `observedAt`, and
 *   past `staleAfterMs` without a new confirmation it is stale: it keeps what it showed and says how old it is.
 */
export const surfaceFreshnessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("snapshot"), statedAt: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({
    kind: z.literal("live"),
    observedAt: z.iso.datetime({ offset: true }),
    staleAfterMs: z.int().positive().max(7 * 24 * 60 * 60 * 1000),
  }),
]);
export type SurfaceFreshness = z.infer<typeof surfaceFreshnessSchema>;

export type FreshnessState = "snapshot" | "live" | "stale";

/** `stale` once a live view has gone `staleAfterMs` without a confirmation; a snapshot is never stale. */
export function freshnessState(freshness: SurfaceFreshness, nowMs: number): FreshnessState {
  if (freshness.kind === "snapshot") return "snapshot";
  const observed = Date.parse(freshness.observedAt);
  // An observation time nobody can read is not a recent one.
  if (Number.isNaN(observed)) return "stale";
  return nowMs - observed > freshness.staleAfterMs ? "stale" : "live";
}

/* ------------------------------------------------------------------ *
 * Status, next action, and late answers
 * ------------------------------------------------------------------ */

/**
 * What the person can do about a phase. `retry` repeats the same request; the others name where the fix is.
 * `none` is said on purpose, so "nothing to do" is a decision rather than a missing field.
 */
export const SURFACE_NEXT_ACTIONS = [
  "retry",
  "check-again",
  "sign-in",
  "decide",
  "grant-permission",
  "open-settings",
  "reconnect",
  "none",
] as const;
export const surfaceNextActionSchema = z.enum(SURFACE_NEXT_ACTIONS);
export type SurfaceNextAction = (typeof SURFACE_NEXT_ACTIONS)[number];

export const surfaceStatusSchema = z.strictObject({
  phase: surfacePhaseSchema,
  /** The domain's own bounded reason, for the surface's copy. Never the only signal and never a raw stack. */
  reason: oneLineText(300, true).optional(),
  next: surfaceNextActionSchema.optional(),
  /**
   * Which attempt this status belongs to. A retry starts the next attempt; an answer for an earlier attempt that
   * arrives late is dropped by `settleSurfaceStatus` instead of overwriting the current one.
   */
  attempt: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  freshness: surfaceFreshnessSchema,
});
export type SurfaceStatus = z.infer<typeof surfaceStatusSchema>;

/**
 * The status a surface shows after `incoming` arrives while it shows `current`.
 *
 * - An answer for an earlier attempt is late and is dropped.
 * - Within one attempt, an outcome is final: the first one shown stays. A late "pending" or "loading" does not reopen
 *   it, and a later outcome for the same attempt — a success after a cancel, an error after a success — does not
 *   replace it, however fresh its observation.
 * - Within one attempt, a live observation older than the one shown is dropped.
 *
 * A new attempt (a retry, a check again) always replaces what was shown, outcome or not.
 */
export function settleSurfaceStatus(current: SurfaceStatus | undefined, incoming: SurfaceStatus): SurfaceStatus {
  if (current === undefined) return incoming;
  if (incoming.attempt < current.attempt) return current;
  if (incoming.attempt > current.attempt) return incoming;
  if (isOutcomePhase(current.phase)) return current;
  if (current.freshness.kind === "live" && incoming.freshness.kind === "live") {
    const shown = Date.parse(current.freshness.observedAt);
    const arrived = Date.parse(incoming.freshness.observedAt);
    if (!Number.isNaN(shown) && !Number.isNaN(arrived) && arrived < shown) return current;
  }
  return incoming;
}

/** Whether the surface should offer to repeat the request: only after it failed or half-failed, and only when said. */
export function canRetry(status: Pick<SurfaceStatus, "phase" | "next">): boolean {
  return (status.phase === "error" || status.phase === "partial") && (status.next === "retry" || status.next === "check-again");
}

/* ------------------------------------------------------------------ *
 * What is said aloud
 * ------------------------------------------------------------------ */

export type LivePoliteness = "off" | "polite" | "assertive";

/**
 * How a phase change is announced to assistive technology.
 *
 * - A surface drawn from history (a reload, a scroll back, another tab) says nothing: its outcome is old news, and a
 *   transcript that re-announced every stored failure would be unusable.
 * - The same phase again says nothing, so progress ticks and polls never stream into a screen reader. A surface keeps
 *   counts and percentages out of its live region for the same reason.
 * - `loading` says nothing; the surface marks itself busy instead.
 * - `error` interrupts. Everything else waits its turn.
 */
export function surfaceAnnouncement(
  previous: SurfacePhase | undefined,
  next: SurfacePhase,
  options: { restored: boolean },
): LivePoliteness {
  if (options.restored || previous === next || next === "loading") return "off";
  return next === "error" ? "assertive" : "polite";
}

/* ------------------------------------------------------------------ *
 * Reported values: unknown is not zero
 * ------------------------------------------------------------------ */

/**
 * Who says a value is what it is.
 *
 * `official` is the provider's or the node's own figure; `inferred` is Clark's estimate from what it saw. A surface
 * names the source either way, and never draws an inferred figure as an official one.
 */
export const valueSourceSchema = z.strictObject({
  label: oneLineText(120, true),
  authority: z.enum(["official", "inferred"]),
});
export type ValueSource = z.infer<typeof valueSourceSchema>;

/**
 * One figure a surface shows, or the honest reason there is none.
 *
 * - `reported`: a value, its source and when it was true. Past `staleAfterMs` it is still shown, as of then.
 * - `unknown`: there may be a value, but nobody has said it (not reported yet, not measured).
 * - `unavailable`: the source could not be read (signed out, rate limited, offline), with the reason.
 * - `unsupported`: the source does not report this at all.
 *
 * None of the last three is zero, and no reader turns one into zero.
 */
export const reportedValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("reported"),
    value: z.number().finite(),
    unit: oneLineText(20, true).optional(),
    source: valueSourceSchema,
    asOf: z.iso.datetime({ offset: true }),
    staleAfterMs: z.int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
  }),
  z.strictObject({ state: z.literal("unknown"), reason: oneLineText(300, true).optional() }),
  z.strictObject({ state: z.literal("unavailable"), reason: oneLineText(300, true) }),
  z.strictObject({ state: z.literal("unsupported"), reason: oneLineText(300, true).optional() }),
]);
export type ReportedValue = z.infer<typeof reportedValueSchema>;

export type ReadValue =
  | { kind: "value"; value: number; unit?: string; source: ValueSource; asOf: string; stale: boolean }
  | { kind: "missing"; state: "unknown" | "unavailable" | "unsupported"; reason?: string };

/** A reported value as a surface draws it: the figure with its source and age, or the kind of absence. */
export function readReportedValue(value: ReportedValue, nowMs: number): ReadValue {
  if (value.state !== "reported") {
    return { kind: "missing", state: value.state, ...(value.reason === undefined ? {} : { reason: value.reason }) };
  }
  const freshness: SurfaceFreshness =
    value.staleAfterMs === undefined
      ? { kind: "snapshot", statedAt: value.asOf }
      : { kind: "live", observedAt: value.asOf, staleAfterMs: value.staleAfterMs };
  return {
    kind: "value",
    value: value.value,
    ...(value.unit === undefined ? {} : { unit: value.unit }),
    source: value.source,
    asOf: value.asOf,
    stale: freshnessState(freshness, nowMs) === "stale",
  };
}

/**
 * The value in one plain English sentence, for text alternatives and `inspect_ui`.
 *
 * A missing value is named as missing — "unknown", "unavailable: signed out" — never as 0, and an inferred figure says
 * it is an estimate.
 */
export function reportedValueText(value: ReportedValue, nowMs: number): string {
  const read = readReportedValue(value, nowMs);
  if (read.kind === "missing") return read.reason === undefined ? read.state : `${read.state}: ${read.reason}`;
  const unit = read.unit === undefined ? "" : ` ${read.unit}`;
  const estimate = read.source.authority === "inferred" ? "estimated by " : "";
  return `${String(read.value)}${unit} (${estimate}${read.source.label}, as of ${read.asOf}${read.stale ? ", stale" : ""})`;
}

/* ------------------------------------------------------------------ *
 * Domain machines, read through the contract
 * ------------------------------------------------------------------ */

/*
 * Each table is typed against the domain's own enum, so a state added to a machine without a reading here fails the
 * typecheck rather than falling through to a default that might be "success".
 */

type SystemCardStatus = z.infer<typeof systemCardBlockSchema>["status"];
export const SYSTEM_CARD_PHASE: Record<SystemCardStatus, SurfacePhase> = {
  "needs-decision": "needs-action",
  downloading: "pending",
  verifying: "pending",
  "needs-sign-in": "needs-action",
  ready: "success",
  blocked: "unavailable",
  working: "pending",
  done: "success",
  failed: "error",
};

type ConnectionStatus = z.infer<typeof connectionCardBlockSchema>["status"];
export const CONNECTION_PHASE: Record<ConnectionStatus, SurfacePhase> = {
  unconfigured: "empty",
  proposal: "needs-action",
  awaiting_user_consent: "needs-action",
  authorizing: "pending",
  verifying_account_and_scopes: "pending",
  probing_capability: "pending",
  connected: "success",
  needs_reauth: "needs-action",
  degraded: "partial",
  // Access withdrawn or refused: the connection no longer works, and the person may not have caused it. It is not
  // "stopped before it finished", so it reads as something standing in the way, with reconnecting as the way past.
  revoked: "unavailable",
  denied: "unavailable",
  partial: "partial",
  expired: "needs-action",
  failed: "error",
};

/**
 * The step a connection card names for a state, where it names one. A state left out has no next step on the card
 * today; it is never guessed.
 */
export const CONNECTION_NEXT_ACTION: Partial<Record<ConnectionStatus, SurfaceNextAction>> = {
  needs_reauth: "sign-in",
  expired: "sign-in",
  revoked: "reconnect",
  denied: "reconnect",
};

type TaskProgressStatus = z.infer<typeof taskProgressCardSchema>["status"];
export const TASK_PROGRESS_PHASE: Record<TaskProgressStatus, SurfacePhase> = {
  queued: "pending",
  working: "pending",
  blocked: "unavailable",
  "needs-decision": "needs-action",
};

type TaskOverviewStatus = z.infer<typeof taskOverviewCardSchema>["tasks"][number]["status"];
export const TASK_OVERVIEW_PHASE: Record<TaskOverviewStatus, SurfacePhase> = {
  ...TASK_PROGRESS_PHASE,
  done: "success",
  failed: "error",
  cancelled: "cancelled",
};

type TaskOutcome = z.infer<typeof taskSummaryCardSchema>["outcome"];
type TaskEvidence = z.infer<typeof taskSummaryCardSchema>["evidence"];

/**
 * A finished task, from its outcome and its evidence together.
 *
 * The run ending is not the work succeeding: `succeeded` with evidence that contradicts it is an error, and
 * `succeeded` without verified evidence is partial. A task that failed stays failed whatever its evidence says.
 */
export function taskSummaryPhase(outcome: TaskOutcome, evidence: TaskEvidence): SurfacePhase {
  if (outcome === "failed") return "error";
  if (outcome === "cancelled") return "cancelled";
  if (evidence === "contradicted") return "error";
  if (outcome === "succeeded" && evidence === "verified") return "success";
  return "partial";
}

type ApprovalDecision = z.infer<typeof approvalCardBlockSchema>["decision"];
export const APPROVAL_PHASE: Record<ApprovalDecision, SurfacePhase> = {
  pending: "needs-action",
  granted: "success",
  denied: "cancelled",
  expired: "cancelled",
};

type QuestionStatus = z.infer<typeof questionCardBlockSchema>["status"];
export const QUESTION_PHASE: Record<QuestionStatus, SurfacePhase> = {
  waiting: "needs-action",
  answered: "success",
  cancelled: "cancelled",
  expired: "cancelled",
};

type ReconnectStatus = z.infer<typeof reconnectCardSchema>["status"];
export const RECONNECT_PHASE: Record<ReconnectStatus, SurfacePhase> = {
  disconnected: "unavailable",
  reconnecting: "pending",
  failed: "error",
};

type ToolActivityStatus = z.infer<typeof toolActivityBlockSchema>["status"];
export const TOOL_ACTIVITY_PHASE: Record<ToolActivityStatus, SurfacePhase> = {
  running: "pending",
  done: "success",
  failed: "error",
};

type SessionPreview = NonNullable<z.infer<typeof browserSessionCardSchema>["preview"]>;
/** A driven session's preview: the screen can be seen, needs the person's permission, or cannot be seen here. */
export const SESSION_PREVIEW_PHASE: Record<SessionPreview, SurfacePhase> = {
  available: "success",
  "needs-permission": "needs-action",
  unavailable: "unavailable",
};

type SignInState = z.infer<typeof providerSignInViewSchema>["state"];
export const SIGN_IN_PHASE: Record<SignInState, SurfacePhase> = {
  running: "pending",
  waiting: "needs-action",
  done: "success",
  failed: "error",
  cancelled: "cancelled",
};

type CommandBadgeTone = NonNullable<z.infer<typeof commandCardSchema>["rows"][number]["badge"]>["tone"];
/**
 * A command card row's badge, read as a phase where its tone claims exactly one. The node writes the tone, not a
 * phase, so only a tone every badge that carries it means the same way is read as a phase: `active` is work under way,
 * `success` a kept outcome, `danger` a failure. `neutral` claims nothing — a queued job, a plain label — and `warning`
 * names no single phase: a folder not found now is unavailable, while a task the person stopped or one that was
 * interrupted ended early. Both are left out, so those badges are drawn plain, with their own words, rather than
 * guessed into a phase that says something that did not happen.
 */
export const COMMAND_BADGE_PHASE: Record<Exclude<CommandBadgeTone, "neutral" | "warning">, SurfacePhase> = {
  active: "pending",
  success: "success",
  danger: "error",
};

type FeedbackPublication = NonNullable<z.infer<typeof feedbackCardSchema>["publication"]>["status"];
/** A filed report: `unknown` means GitHub did not answer, which is not a failure and not a success. */
export const FEEDBACK_PUBLICATION_PHASE: Record<FeedbackPublication, SurfacePhase> = {
  published: "success",
  unknown: "partial",
  failed: "error",
  "needs-access": "needs-action",
  refused: "unavailable",
};

type WidgetLifecycle = z.infer<typeof widgetLifecycleSchema>;
export const WIDGET_LIFECYCLE_PHASE: Record<WidgetLifecycle, SurfacePhase> = {
  ready: "success",
  active: "success",
  suspended: "unavailable",
  needs_auth: "needs-action",
  offline: "unavailable",
  error: "error",
};

/**
 * A marketplace answer: nothing found, could not ask, or asked only some sources. An empty list with a reason is
 * `unavailable`, never "no results"; results with sources that did not answer are `partial`.
 */
export function marketplacePhase(input: { results: number; unavailableReason?: string; unansweredSources: number }): SurfacePhase {
  if (input.unavailableReason !== undefined && input.results === 0) return "unavailable";
  if (input.unansweredSources > 0 || input.unavailableReason !== undefined) return "partial";
  return input.results === 0 ? "empty" : "success";
}
