import type { Instant, IntentRun, IntentRunState, PersistentIntent, Signal } from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/**
 * Signals, the standing requests that answer them, and the runs that did.
 *
 * Three tables with one job between them: a fact that arrived is never lost and never acted on twice. A delivery is
 * written before anything is decided about it; a run is unique on (intent, signal); and the run carries the id of the
 * task it creates from the moment it is recorded, so a crash anywhere in between is resumed rather than repeated.
 */

export type SignalDeliveryState = "pending" | "processed" | "dead";

export interface SignalDelivery {
  signal: Signal;
  state: SignalDeliveryState;
  attempts: number;
  nextAttemptAt: Instant;
  lastError?: string;
  settledAt?: Instant;
}

interface DeliveryRow {
  signal_id: string;
  document: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  settled_at: string | null;
}

function deliveryFromRow(row: DeliveryRow): SignalDelivery {
  return {
    signal: parseJson<Signal>(row.document, "signal_deliveries.document"),
    state: row.state as SignalDeliveryState,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at as Instant,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at as Instant }),
  };
}

/**
 * Record a signal, once.
 *
 * The same (source, dedupe key) a second time is not an error: at-least-once delivery is the normal case for every
 * source there is, and the answer names the signal that was already recorded.
 */
export function recordSignalDelivery(db: Database, signal: Signal): { created: boolean; signalId: string } {
  const result = db
    .prepare(
      `INSERT INTO signal_deliveries (signal_id, source_id, dedupe_key, topic, document, state, attempts, next_attempt_at,
         received_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(source_id, dedupe_key) DO NOTHING`,
    )
    .run(
      signal.signalId,
      signal.source.sourceId,
      signal.dedupeKey,
      signal.topic,
      toJson(signal),
      signal.receivedAt,
      signal.receivedAt,
    );
  if (Number(result.changes) === 1) return { created: true, signalId: signal.signalId };
  const existing = oneRow<{ signal_id: string }>(
    db,
    "SELECT signal_id FROM signal_deliveries WHERE source_id = ? AND dedupe_key = ?",
    signal.source.sourceId,
    signal.dedupeKey,
  );
  return { created: false, signalId: existing?.signal_id ?? signal.signalId };
}

export function getSignalDelivery(db: Database, signalId: string): SignalDelivery | undefined {
  const row = oneRow<DeliveryRow>(db, "SELECT * FROM signal_deliveries WHERE signal_id = ?", signalId);
  return row === undefined ? undefined : deliveryFromRow(row);
}

/** Deliveries waiting to be handled whose next attempt is due, oldest first. */
export function dueSignalDeliveries(db: Database, now: Instant, limit = 50): SignalDelivery[] {
  return allRows<DeliveryRow>(
    db,
    `SELECT * FROM signal_deliveries WHERE state = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at ASC, received_at ASC LIMIT ?`,
    now,
    limit,
  ).map(deliveryFromRow);
}

export function settleSignalDelivery(
  db: Database,
  signalId: string,
  state: "processed" | "dead",
  at: Instant,
  error?: string,
): void {
  db.prepare("UPDATE signal_deliveries SET state = ?, settled_at = ?, last_error = ? WHERE signal_id = ?").run(
    state,
    at,
    error ?? null,
    signalId,
  );
}

export function deferSignalDelivery(
  db: Database,
  signalId: string,
  input: { attempts: number; nextAttemptAt: Instant; error: string },
): void {
  db.prepare("UPDATE signal_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE signal_id = ?").run(
    input.attempts,
    input.nextAttemptAt,
    input.error,
    signalId,
  );
}

interface IntentRow {
  document: string;
}

function intentFromRow(row: IntentRow): PersistentIntent {
  return parseJson<PersistentIntent>(row.document, "persistent_intents.document");
}

/** Write an intent as it is now. The document is the record; the columns beside it exist to be searched. */
export function putPersistentIntent(db: Database, intent: PersistentIntent): void {
  db.prepare(
    `INSERT INTO persistent_intents (intent_id, principal_id, conversation_id, topic, state, document, revision,
       next_fire_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(intent_id) DO UPDATE SET
       topic = excluded.topic, state = excluded.state, document = excluded.document, revision = excluded.revision,
       next_fire_at = excluded.next_fire_at, updated_at = excluded.updated_at`,
  ).run(
    intent.intentId,
    intent.principalId,
    intent.conversationId,
    intent.when.topic,
    intent.state,
    toJson(intent),
    intent.revision,
    intent.nextFireAt ?? null,
    intent.createdAt,
    intent.updatedAt,
  );
}

export function getPersistentIntent(db: Database, intentId: string): PersistentIntent | undefined {
  const row = oneRow<IntentRow>(db, "SELECT document FROM persistent_intents WHERE intent_id = ?", intentId);
  return row === undefined ? undefined : intentFromRow(row);
}

/** A person's intents, newest first. Removed ones only when asked for. */
export function listPersistentIntents(
  db: Database,
  principalId: string,
  options: { includeRemoved?: boolean } = {},
): PersistentIntent[] {
  return allRows<IntentRow>(
    db,
    `SELECT document FROM persistent_intents WHERE principal_id = ?
     ${options.includeRemoved === true ? "" : "AND state <> 'removed'"}
     ORDER BY created_at DESC, intent_id DESC`,
    principalId,
  ).map(intentFromRow);
}

export function activeIntentsForTopic(db: Database, topic: string): PersistentIntent[] {
  return allRows<IntentRow>(
    db,
    "SELECT document FROM persistent_intents WHERE state = 'active' AND topic = ? ORDER BY created_at ASC, intent_id ASC",
    topic,
  ).map(intentFromRow);
}

/** Active intents whose topic starts with a family, such as `github.`: what a poller for that family is for. */
export function activeIntentsForTopicFamily(db: Database, family: string): PersistentIntent[] {
  return allRows<IntentRow>(
    db,
    "SELECT document FROM persistent_intents WHERE state = 'active' AND substr(topic, 1, length(?)) = ? ORDER BY created_at ASC, intent_id ASC",
    family,
    family,
  ).map(intentFromRow);
}

/**
 * When a source last delivered a signal whose dedupe key starts with a prefix, such as a verified webhook's
 * `delivery:`. Sources are compared case-insensitively, since a repository's name is.
 */
export function lastSignalReceivedAt(db: Database, sourceId: string, dedupePrefix: string): Instant | undefined {
  const row = oneRow<{ at: string | null }>(
    db,
    `SELECT MAX(received_at) AS at FROM signal_deliveries
     WHERE source_id = ? COLLATE NOCASE AND substr(dedupe_key, 1, length(?)) = ?`,
    sourceId,
    dedupePrefix,
    dedupePrefix,
  );
  return row?.at === null || row?.at === undefined ? undefined : (row.at as Instant);
}

/** Where polling one source got to. */
export interface SignalPollState {
  sourceKey: string;
  cursor?: string;
  etag?: string;
  nextPollAt: Instant;
  failures: number;
  failingSince?: Instant;
  lastError?: string;
  updatedAt: Instant;
}

interface PollStateRow {
  source_key: string;
  cursor: string | null;
  etag: string | null;
  next_poll_at: string;
  failures: number;
  failing_since: string | null;
  last_error: string | null;
  updated_at: string;
}

export function getSignalPollState(db: Database, sourceKey: string): SignalPollState | undefined {
  const row = oneRow<PollStateRow>(db, "SELECT * FROM signal_poll_state WHERE source_key = ?", sourceKey);
  if (row === undefined) return undefined;
  return {
    sourceKey: row.source_key,
    ...(row.cursor === null ? {} : { cursor: row.cursor }),
    ...(row.etag === null ? {} : { etag: row.etag }),
    nextPollAt: row.next_poll_at as Instant,
    failures: Number(row.failures),
    ...(row.failing_since === null ? {} : { failingSince: row.failing_since as Instant }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    updatedAt: row.updated_at as Instant,
  };
}

export function putSignalPollState(db: Database, state: SignalPollState): void {
  db.prepare(
    `INSERT INTO signal_poll_state (source_key, cursor, etag, next_poll_at, failures, failing_since, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       cursor = excluded.cursor, etag = excluded.etag, next_poll_at = excluded.next_poll_at, failures = excluded.failures,
       failing_since = excluded.failing_since, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).run(
    state.sourceKey,
    state.cursor ?? null,
    state.etag ?? null,
    state.nextPollAt,
    state.failures,
    state.failingSince ?? null,
    state.lastError ?? null,
    state.updatedAt,
  );
}

/** Active timer intents whose next firing is due. */
export function dueTimerIntents(db: Database, now: Instant): PersistentIntent[] {
  return allRows<IntentRow>(
    db,
    `SELECT document FROM persistent_intents
     WHERE state = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
     ORDER BY next_fire_at ASC, intent_id ASC`,
    now,
  ).map(intentFromRow);
}

interface RunRow {
  run_id: string;
  intent_id: string;
  signal_id: string;
  task_id: string;
  state: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function runFromRow(row: RunRow): IntentRun {
  return {
    runId: row.run_id,
    intentId: row.intent_id,
    signalId: row.signal_id,
    taskId: row.task_id,
    state: row.state as IntentRunState,
    ...(row.reason === null ? {} : { reason: row.reason }),
    createdAt: row.created_at as Instant,
    updatedAt: row.updated_at as Instant,
  };
}

/**
 * Record that an intent answers a signal, or find that it already does.
 *
 * Whichever row wins the unique (intent, signal) is the run; a second attempt gets the first run back, with the task
 * id the first attempt chose.
 */
export function recordIntentRun(db: Database, run: IntentRun): { created: boolean; run: IntentRun } {
  const result = db
    .prepare(
      `INSERT INTO intent_runs (run_id, intent_id, signal_id, task_id, state, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id, signal_id) DO NOTHING`,
    )
    .run(run.runId, run.intentId, run.signalId, run.taskId, run.state, run.reason ?? null, run.createdAt, run.updatedAt);
  if (Number(result.changes) === 1) return { created: true, run };
  const existing = oneRow<RunRow>(
    db,
    "SELECT * FROM intent_runs WHERE intent_id = ? AND signal_id = ?",
    run.intentId,
    run.signalId,
  );
  if (existing === undefined) throw new Error(`intent run for ${run.intentId}/${run.signalId} vanished after a conflict`);
  return { created: false, run: runFromRow(existing) };
}

export function setIntentRunState(
  db: Database,
  runId: string,
  state: IntentRunState,
  at: Instant,
  reason?: string,
): void {
  db.prepare("UPDATE intent_runs SET state = ?, reason = ?, updated_at = ? WHERE run_id = ?").run(
    state,
    reason ?? null,
    at,
    runId,
  );
}

export function getIntentRunByTask(db: Database, taskId: string): IntentRun | undefined {
  const row = oneRow<RunRow>(db, "SELECT * FROM intent_runs WHERE task_id = ?", taskId);
  return row === undefined ? undefined : runFromRow(row);
}

/** Runs recorded but never started, as a crash leaves them. */
export function pendingIntentRuns(db: Database): IntentRun[] {
  return allRows<RunRow>(db, "SELECT * FROM intent_runs WHERE state = 'pending' ORDER BY created_at ASC").map(runFromRow);
}

/** The last few runs of an intent, newest first, for "what has it done". */
export function recentIntentRuns(db: Database, intentId: string, limit = 5): IntentRun[] {
  return allRows<RunRow>(
    db,
    "SELECT * FROM intent_runs WHERE intent_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?",
    intentId,
    limit,
  ).map(runFromRow);
}
