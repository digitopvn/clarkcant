import { createHash } from "node:crypto";

import {
  type CommandAck,
  type CommandEnvelope,
  type EffectRecord,
  type Grant,
  type Instant,
  type MessageRecord,
  type PeerEnvelope,
  type Pin,
  type StoredPresentationBundle,
  type SurfaceCompositionSpec,
  type TaskRecord,
  type WidgetInstance,
  type WidgetSnapshot,
  commandAckSchema,
  storedPresentationBundleSchema,
  surfaceCompositionSpecSchema,
  widgetSnapshotSchema,
} from "@clarkcant/contracts";

import { type Database, oneRow, allRows, parseJson, toJson, transaction } from "./db.ts";

/**
 * Repositories.
 *
 * The one behaviour worth reading carefully is `acceptCommand`. Everything else
 * is a typed wrapper over SQL; that function is where "a retried user command
 * produces one logical task" is actually enforced.
 */

/** Values JSON can represent. Used instead of `unknown` at serialisation edges. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Raise an arbitrary value to `JsonValue`.
 *
 * Anything JSON cannot represent is refused here rather than silently dropped by
 * `JSON.stringify`, because a dropped field would change a payload digest and make
 * an idempotency check disagree with itself.
 */
export function asJsonValue(value: unknown, path = "$"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialise non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item, index) => asJsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, inner]) => inner !== undefined,
    );
    return Object.fromEntries(entries.map(([key, inner]) => [key, asJsonValue(inner, `${path}.${key}`)]));
  }
  throw new Error(`cannot serialise ${typeof value} at ${path}`);
}

/** Canonical payload digest. Key ordering must not change the digest. */
export function payloadDigest(payload: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]));
  }
  return value;
}

export type CommandAcceptance =
  | { status: "accepted"; ack: CommandAck }
  | { status: "replayed"; ack: CommandAck }
  | {
      status: "conflict";
      code: "IDEMPOTENCY_KEY_REUSED";
      message: string;
      existingCommandId: string;
    };

/**
 * Record a command durably and return its acknowledgement.
 *
 * Behaviour that matters for the durability story:
 *
 * - The acknowledgement is written in the same transaction as the command, so a
 *   crash can never produce an ack whose command is missing.
 * - Re-sending the same idempotency key with the same payload returns the
 *   original ack and reports `replayed`, so the caller knows not to execute again.
 * - Re-sending the same key with a *different* payload is refused. Reusing a key
 *   for different work is a programming error, and silently accepting it would
 *   turn a retry into a second, different task.
 */
export function acceptCommand(
  db: Database,
  envelope: CommandEnvelope,
  options: { receivedAt: Instant; nextSequence: number; taskId?: string; degraded?: CommandAck["degraded"] },
): CommandAcceptance {
  const digest = payloadDigest(asJsonValue({ kind: envelope.kind, payload: envelope.payload }));

  return transaction(db, () => {
    const existing = oneRow<{
      command_id: string;
      payload_digest: string;
      ack: string;
    }>(db, "SELECT command_id, payload_digest, ack FROM commands WHERE idempotency_key = ?", envelope.idempotencyKey);

    if (existing) {
      if (existing.payload_digest !== digest) {
        return {
          status: "conflict" as const,
          code: "IDEMPOTENCY_KEY_REUSED" as const,
          message:
            "the same idempotency key was reused with a different payload; use a new key for a new operation",
          existingCommandId: existing.command_id,
        };
      }
      return { status: "replayed" as const, ack: parseJson<CommandAck>(existing.ack, "commands.ack") };
    }

    const ack: CommandAck = commandAckSchema.parse({
      commandId: envelope.commandId,
      acceptedAt: options.receivedAt,
      duplicate: false,
      acceptedSequence: options.nextSequence,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      ...(options.degraded === undefined ? {} : { degraded: options.degraded }),
    });

    db.prepare(
      `INSERT INTO commands
         (command_id, idempotency_key, payload_digest, kind, conversation_id, task_id, accepted_sequence, ack, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      envelope.commandId,
      envelope.idempotencyKey,
      digest,
      envelope.kind,
      envelope.conversationId ?? null,
      options.taskId ?? envelope.taskId ?? null,
      options.nextSequence,
      toJson(ack),
      options.receivedAt,
    );

    return { status: "accepted" as const, ack };
  });
}

/** Reserve the next sequence number for a stream, inside the caller's transaction. */
export function nextStreamSequence(db: Database, stream: string, nodeId: string): number {
  const row = oneRow<{ max_sequence: number | null }>(
    db,
    "SELECT MAX(source_sequence) AS max_sequence FROM events WHERE stream = ? AND source_node_id = ?",
    stream,
    nodeId,
  );
  return Number(row?.max_sequence ?? 0) + 1;
}

export interface AppendEventInput {
  eventId: string;
  kind: string;
  stream: string;
  nodeId: string;
  conversationId?: string;
  taskId?: string;
  runId?: string;
  document: unknown;
  occurredAt: Instant;
}

/**
 * Append to the node's event log.
 *
 * The sequence is computed here rather than passed in, so two writers cannot
 * choose the same number. The unique index on
 * (source_node_id, stream, source_sequence) turns a collision into an error
 * instead of a silently reordered timeline.
 */
export function appendEvent(db: Database, input: AppendEventInput): number {
  const sequence = nextStreamSequence(db, input.stream, input.nodeId);
  db.prepare(
    `INSERT INTO events
       (event_id, source_node_id, stream, source_sequence, kind, conversation_id, task_id, run_id, document, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.nodeId,
    input.stream,
    sequence,
    input.kind,
    input.conversationId ?? null,
    input.taskId ?? null,
    input.runId ?? null,
    toJson(input.document),
    input.occurredAt,
  );
  return sequence;
}

export function eventsSince(
  db: Database,
  filter: { conversationId?: string; stream?: string; afterSequence: number; limit?: number },
): unknown[] {
  const clauses: string[] = ["source_sequence > ?"];
  const params: unknown[] = [filter.afterSequence];
  if (filter.conversationId) {
    clauses.push("conversation_id = ?");
    params.push(filter.conversationId);
  }
  if (filter.stream) {
    clauses.push("stream = ?");
    params.push(filter.stream);
  }
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM events WHERE ${clauses.join(" AND ")} ORDER BY source_sequence ASC LIMIT ?`,
    ...params,
    filter.limit ?? 500,
  );
  return rows.map((row) => parseJson<unknown>(row.document, "events.document"));
}

/* ------------------------------------------------------------------ *
 * Outbox
 * ------------------------------------------------------------------ */

/** Record intent before transmission, so a crash cannot lose an unsent message. */
export function enqueueOutbox(
  db: Database,
  input: { messageId: string; peerNodeId: string; correlationId: string; document: unknown; createdAt: Instant },
): void {
  db.prepare(
    `INSERT INTO outbox (message_id, peer_node_id, correlation_id, document, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.messageId, input.peerNodeId, input.correlationId, toJson(input.document), input.createdAt);
}

export function markOutboxAttempt(db: Database, messageId: string, at: Instant): void {
  db.prepare("UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ? WHERE message_id = ?").run(at, messageId);
}

export function markOutboxAcknowledged(db: Database, messageId: string, at: Instant): void {
  db.prepare("UPDATE outbox SET acknowledged_at = ? WHERE message_id = ?").run(at, messageId);
}

export function pendingOutbox(db: Database, peerNodeId?: string): unknown[] {
  const rows = peerNodeId
    ? allRows<{ document: string }>(
        db,
        "SELECT document FROM outbox WHERE acknowledged_at IS NULL AND peer_node_id = ? ORDER BY created_at",
        peerNodeId,
      )
    : allRows<{ document: string }>(
        db,
        "SELECT document FROM outbox WHERE acknowledged_at IS NULL ORDER BY created_at",
      );
  return rows.map((row) => parseJson<unknown>(row.document, "outbox.document"));
}

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

export type InboxRecordResult =
  | { status: "recorded" }
  | { status: "duplicate"; previousResponseJson: string | undefined };

/**
 * Record an inbound envelope and its computed response atomically.
 *
 * Storing the response alongside the dedup key is what makes a lost
 * acknowledgement recoverable: when the peer resends, we return the outcome we
 * already produced instead of executing a second time (acceptance test T02).
 */
export function recordInbox(
  db: Database,
  input: {
    dedupKey: string;
    peerNodeId: string;
    sourceSequence: number;
    messageId: string;
    kind: string;
    document: PeerEnvelope;
    /**
     * Serialised response, stored verbatim. Taking JSON text rather than a value
     * keeps this path free of any parse that could throw mid-message, and lets the
     * caller hand the identical bytes back on a replay.
     */
    responseJson: string;
    receivedAt: Instant;
  },
): InboxRecordResult {
  return transaction(db, () => {
    const existing = oneRow<{ response: string | null }>(
      db,
      "SELECT response FROM inbox WHERE dedup_key = ?",
      input.dedupKey,
    );
    if (existing) {
      return {
        status: "duplicate" as const,
        previousResponseJson: existing.response === null ? undefined : existing.response,
      };
    }

    db.prepare(
      `INSERT INTO inbox
         (dedup_key, peer_node_id, source_sequence, message_id, kind, document, response, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.dedupKey,
      input.peerNodeId,
      input.sourceSequence,
      input.messageId,
      input.kind,
      toJson(input.document),
      input.responseJson,
      input.receivedAt,
    );

    const cursor = oneRow<{ last_sequence: number }>(
      db,
      "SELECT last_sequence FROM peer_cursors WHERE peer_node_id = ?",
      input.peerNodeId,
    );
    if (cursor === undefined) {
      db.prepare("INSERT INTO peer_cursors (peer_node_id, last_sequence, updated_at) VALUES (?, ?, ?)").run(
        input.peerNodeId,
        input.sourceSequence,
        input.receivedAt,
      );
    } else if (input.sourceSequence > cursor.last_sequence) {
      db.prepare("UPDATE peer_cursors SET last_sequence = ?, updated_at = ? WHERE peer_node_id = ?").run(
        input.sourceSequence,
        input.receivedAt,
        input.peerNodeId,
      );
    }

    return { status: "recorded" as const };
  });
}

export function peerCursor(db: Database, peerNodeId: string): number | undefined {
  const row = oneRow<{ last_sequence: number }>(
    db,
    "SELECT last_sequence FROM peer_cursors WHERE peer_node_id = ?",
    peerNodeId,
  );
  return row === undefined ? undefined : Number(row.last_sequence);
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export function upsertTask(db: Database, task: TaskRecord): void {
  db.prepare(
    `INSERT INTO tasks
       (task_id, conversation_id, home_node_id, execution_node_id, state, disposition, revision, goal,
        parked_reason, waiting_capability_ref, waiting_install_plan_id, active_run_id, budget, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       execution_node_id = excluded.execution_node_id,
       state = excluded.state,
       disposition = excluded.disposition,
       revision = excluded.revision,
       goal = excluded.goal,
       parked_reason = excluded.parked_reason,
       waiting_capability_ref = excluded.waiting_capability_ref,
       waiting_install_plan_id = excluded.waiting_install_plan_id,
       active_run_id = excluded.active_run_id,
       budget = excluded.budget,
       updated_at = excluded.updated_at`,
  ).run(
    task.taskId,
    task.conversationId,
    task.homeNodeId,
    task.executionNodeId ?? null,
    task.state,
    dispositionColumnFor(task.state),
    task.revision,
    task.goal,
    task.parkedReason ?? null,
    task.waitingCapabilityRef ?? null,
    task.waitingInstallPlanId ?? null,
    task.activeRunId ?? null,
    task.budget === undefined ? null : toJson(task.budget),
    task.createdAt,
    task.updatedAt,
  );
}

/**
 * Local mirror of the disposition mapping.
 *
 * Kept in sync with `dispositionOf` in packages/contracts by
 * test/task-machine.spec.ts, which asserts the two agree for every state. Doing
 * it here avoids importing the contracts reducer into a query path.
 */
export function dispositionColumnFor(state: TaskStateName): string {
  switch (state) {
    case "queued":
    case "resolving":
    case "dispatched":
    case "running":
    case "pause_requested":
    case "cancel_requested":
      return "in-progress";
    case "waiting_input":
    case "waiting_approval":
    case "paused":
      return "needs-user";
    case "waiting_capability":
      return "needs-capability";
    case "verifying":
      return "verifying";
    case "uncertain":
    case "reconciling":
      return "uncertain";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

type TaskStateName = TaskRecord["state"];

export function getTask(db: Database, taskId: string): TaskRecord | undefined {
  const row = oneRow<Record<string, unknown>>(db, "SELECT * FROM tasks WHERE task_id = ?", taskId);
  if (!row) return undefined;
  return {
    taskId: String(row.task_id) as TaskRecord["taskId"],
    conversationId: String(row.conversation_id) as TaskRecord["conversationId"],
    homeNodeId: String(row.home_node_id) as TaskRecord["homeNodeId"],
    ...(row.execution_node_id === null
      ? {}
      : { executionNodeId: String(row.execution_node_id) as TaskRecord["executionNodeId"] }),
    state: String(row.state) as TaskRecord["state"],
    revision: Number(row.revision),
    goal: String(row.goal),
    ...(row.parked_reason === null ? {} : { parkedReason: String(row.parked_reason) }),
    ...(row.waiting_capability_ref === null
      ? {}
      : { waitingCapabilityRef: String(row.waiting_capability_ref) }),
    ...(row.waiting_install_plan_id === null
      ? {}
      : { waitingInstallPlanId: String(row.waiting_install_plan_id) }),
    ...(row.active_run_id === null ? {} : { activeRunId: String(row.active_run_id) }),
    ...(row.budget === null ? {} : { budget: parseJson(row.budget, "tasks.budget") }),
    createdAt: String(row.created_at) as TaskRecord["createdAt"],
    updatedAt: String(row.updated_at) as TaskRecord["updatedAt"],
  };
}

export function listActiveTasks(db: Database, conversationId: string): TaskRecord[] {
  const rows = allRows<{ task_id: string }>(
    db,
    `SELECT task_id FROM tasks
      WHERE conversation_id = ? AND state NOT IN ('succeeded','failed','cancelled')
      ORDER BY updated_at DESC`,
    conversationId,
  );
  return rows.map((row) => getTask(db, row.task_id)).filter((task): task is TaskRecord => task !== undefined);
}

/* ------------------------------------------------------------------ *
 * Conversation authority
 * ------------------------------------------------------------------ */

export type AuthorityClaim =
  | { ok: true }
  | { ok: false; code: "AUTHORITY_HELD_ELSEWHERE"; homeNodeId: string };

/**
 * Claim timeline authority for a conversation.
 *
 * Exactly one home node owns a conversation at a time. A second node attempting
 * to claim it is refused rather than allowed to append, because two authoritative
 * timelines cannot be merged after a partition (acceptance test T04).
 */
export function claimConversationAuthority(
  db: Database,
  input: { conversationId: string; homeNodeId: string; at: Instant },
): AuthorityClaim {
  return transaction(db, () => {
    const existing = oneRow<{ home_node_id: string }>(
      db,
      "SELECT home_node_id FROM conversation_authority WHERE conversation_id = ?",
      input.conversationId,
    );
    if (existing && existing.home_node_id !== input.homeNodeId) {
      return { ok: false as const, code: "AUTHORITY_HELD_ELSEWHERE" as const, homeNodeId: existing.home_node_id };
    }
    if (!existing) {
      db.prepare(
        "INSERT INTO conversation_authority (conversation_id, home_node_id, claimed_at) VALUES (?, ?, ?)",
      ).run(input.conversationId, input.homeNodeId, input.at);
    }
    return { ok: true as const };
  });
}

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

export function upsertEffect(db: Database, effect: EffectRecord): void {
  db.prepare(
    `INSERT INTO effects
       (effect_id, task_id, run_id, executor_node_id, category, capability_ref,
        external_idempotency_key, external_supports_dedup, state, intent, operation_digest,
        prepared_at, submitted_at, settled_at, resolution, reconciliation_evidence, submit_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(effect_id) DO UPDATE SET
       state = excluded.state,
       submitted_at = excluded.submitted_at,
       settled_at = excluded.settled_at,
       resolution = excluded.resolution,
       reconciliation_evidence = excluded.reconciliation_evidence,
       submit_attempts = excluded.submit_attempts`,
  ).run(
    effect.effectId,
    effect.taskId,
    effect.runId ?? null,
    effect.executorNodeId,
    effect.category,
    effect.capabilityRef,
    effect.externalIdempotencyKey ?? null,
    effect.externalSupportsDedup ? 1 : 0,
    effect.state,
    effect.intent,
    effect.operationDigest,
    effect.preparedAt,
    effect.submittedAt ?? null,
    effect.settledAt ?? null,
    effect.resolution ?? null,
    effect.reconciliationEvidence ?? null,
    effect.submitAttempts,
  );
}

export function effectsForTask(db: Database, taskId: string): EffectRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM effects WHERE task_id = ? ORDER BY prepared_at",
    taskId,
  );
  return rows.map((row) => ({
    effectId: String(row.effect_id) as EffectRecord["effectId"],
    taskId: String(row.task_id) as EffectRecord["taskId"],
    ...(row.run_id === null ? {} : { runId: String(row.run_id) as NonNullable<EffectRecord["runId"]> }),
    executorNodeId: String(row.executor_node_id) as EffectRecord["executorNodeId"],
    category: String(row.category) as EffectRecord["category"],
    capabilityRef: String(row.capability_ref) as EffectRecord["capabilityRef"],
    ...(row.external_idempotency_key === null
      ? {}
      : { externalIdempotencyKey: String(row.external_idempotency_key) }),
    externalSupportsDedup: Number(row.external_supports_dedup) === 1,
    state: String(row.state) as EffectRecord["state"],
    intent: String(row.intent),
    operationDigest: String(row.operation_digest),
    preparedAt: String(row.prepared_at) as EffectRecord["preparedAt"],
    ...(row.submitted_at === null ? {} : { submittedAt: String(row.submitted_at) as Instant }),
    ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) as Instant }),
    ...(row.resolution === null ? {} : { resolution: String(row.resolution) as NonNullable<EffectRecord["resolution"]> }),
    ...(row.reconciliation_evidence === null
      ? {}
      : { reconciliationEvidence: String(row.reconciliation_evidence) }),
    submitAttempts: Number(row.submit_attempts),
  }));
}

/** Effects whose outcome is undetermined, for the reconciliation queue (T05). */
export function unsettledEffects(db: Database, nodeId: string): EffectRecord[] {
  const rows = allRows<{ task_id: string }>(
    db,
    "SELECT DISTINCT task_id FROM effects WHERE executor_node_id = ? AND state IN ('prepared','submitted','unknown')",
    nodeId,
  );
  return rows.flatMap((row) => effectsForTask(db, row.task_id));
}

/* ------------------------------------------------------------------ *
 * Grants
 * ------------------------------------------------------------------ */

export function upsertGrant(db: Database, grant: Grant, createdAt: Instant): void {
  db.prepare(
    `INSERT INTO grants (grant_id, owner_principal_id, sender_node_id, receiver_node_id, document, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id) DO UPDATE SET
       document = excluded.document,
       expires_at = excluded.expires_at,
       revoked_at = excluded.revoked_at`,
  ).run(
    grant.grantId,
    grant.ownerPrincipalId,
    grant.senderNodeId,
    grant.receiverNodeId,
    toJson(grant),
    grant.expiresAt,
    grant.revokedAt ?? null,
    createdAt,
  );
}

export function getGrant(db: Database, grantId: string): Grant | undefined {
  const row = oneRow<{ document: string }>(db, "SELECT document FROM grants WHERE grant_id = ?", grantId);
  return row === undefined ? undefined : parseJson<Grant>(row.document, "grants.document");
}

/**
 * Live grants. A revoked grant is excluded here as well as at check time, so a
 * revoked key stops new delegations even before the next authorization pass.
 */
export function activeGrants(db: Database, senderNodeId: string, at: Instant): Grant[] {
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM grants
      WHERE sender_node_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    senderNodeId,
    at,
  );
  return rows.map((row) => parseJson<Grant>(row.document, "grants.document"));
}

export function revokeGrant(db: Database, grantId: string, at: Instant): boolean {
  const result = db.prepare("UPDATE grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(at, grantId);
  return Number(result.changes) > 0;
}

/* ------------------------------------------------------------------ *
 * Widgets and pins
 * ------------------------------------------------------------------ */

export function upsertWidgetInstance(db: Database, instance: WidgetInstance, updatedAt: Instant): void {
  db.prepare(
    `INSERT INTO widget_instances
       (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
        revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       revision = excluded.revision,
       presentation_revision = excluded.presentation_revision,
       data_revision = excluded.data_revision,
       action_binding_revision = excluded.action_binding_revision,
       lifecycle = excluded.lifecycle,
       document = excluded.document,
       updated_at = excluded.updated_at`,
  ).run(
    instance.instanceId,
    instance.definitionRef.id,
    instance.definitionRef.version,
    instance.definitionRef.packageDigest,
    instance.ownerNodeId,
    instance.ownerPrincipalId,
    instance.revision,
    instance.presentationRevision,
    instance.dataRevision,
    instance.actionBindingRevision,
    instance.lifecycle,
    toJson(instance),
    updatedAt,
  );
}

export function getWidgetInstance(db: Database, instanceId: string): WidgetInstance | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM widget_instances WHERE instance_id = ?",
    instanceId,
  );
  return row === undefined ? undefined : parseJson<WidgetInstance>(row.document, "widget_instances.document");
}

export function createPin(db: Database, pin: Pin): void {
  db.prepare(
    `INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, background_grant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pin.pinId,
    pin.conversationId,
    pin.instanceId,
    pin.displayMode,
    pin.position,
    pin.refreshPolicy,
    pin.backgroundGrantId ?? null,
    pin.createdAt,
  );
}

export function listPins(db: Database, conversationId: string): Pin[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM pins WHERE conversation_id = ? ORDER BY position",
    conversationId,
  );
  return rows.map((row) => ({
    pinId: String(row.pin_id) as Pin["pinId"],
    conversationId: String(row.conversation_id) as Pin["conversationId"],
    instanceId: String(row.instance_id) as Pin["instanceId"],
    displayMode: String(row.display_mode) as Pin["displayMode"],
    position: Number(row.position),
    refreshPolicy: String(row.refresh_policy) as Pin["refreshPolicy"],
    ...(row.background_grant_id === null
      ? {}
      : { backgroundGrantId: String(row.background_grant_id) }),
    createdAt: String(row.created_at) as Pin["createdAt"],
  }));
}

export function deletePin(db: Database, pinId: string): boolean {
  const result = db.prepare("DELETE FROM pins WHERE pin_id = ?").run(pinId);
  return Number(result.changes) > 0;
}

/**
 * The snapshots a message captured, oldest first.
 *
 * History is read from these rather than from the instance's current props: a snapshot is what the
 * user saw, and re-deriving it from the live row is how a transcript silently rewrites itself.
 */
export function listSnapshotsForMessage(db: Database, messageId: string): WidgetSnapshot[] {
  const rows = allRows<{ document: string; stale: number }>(
    db,
    "SELECT document, stale FROM widget_snapshots WHERE message_id = ? ORDER BY captured_at ASC",
    messageId,
  );
  return rows.map((row) => {
    const parsed = widgetSnapshotSchema.parse(parseJson<unknown>(row.document, "widget_snapshots.document"));
    // The column wins over the stored document. Staleness is the one field that changes after a
    // snapshot is written, and a reader that trusted the document would report history as current
    // for as long as nothing rewrote the whole row.
    return { ...parsed, stale: Number(row.stale) === 1 };
  });
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export function appendMessage(db: Database, message: MessageRecord, sequence: number): void {
  db.prepare(
    `INSERT INTO messages
       (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.messageId,
    message.conversationId,
    message.role,
    message.authorNodeId,
    message.taskId ?? null,
    message.delivery,
    toJson(message),
    sequence,
    message.createdAt,
  );
}

export function messagesSince(db: Database, conversationId: string, afterSequence: number, limit = 200): MessageRecord[] {
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM messages
      WHERE conversation_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?`,
    conversationId,
    afterSequence,
    limit,
  );
  return rows.map((row) => parseJson<MessageRecord>(row.document, "messages.document"));
}

export function conversationMetadata(
  db: Database,
  conversationId: string,
): { messageCount: number; taskCount: number; updatedAt: string; cursor: number } {
  const counts = oneRow<{ message_count: number; task_count: number; updated_at: string | null }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) AS message_count,
       (SELECT COUNT(*) FROM tasks WHERE conversation_id = ?) AS task_count,
       (SELECT MAX(occurred_at) FROM events WHERE conversation_id = ?) AS updated_at`,
    conversationId,
    conversationId,
    conversationId,
  );
  const cursor = oneRow<{ max_sequence: number | null }>(
    db,
    "SELECT MAX(source_sequence) AS max_sequence FROM events WHERE conversation_id = ?",
    conversationId,
  );
  return {
    messageCount: Number(counts?.message_count ?? 0),
    taskCount: Number(counts?.task_count ?? 0),
    updatedAt: String(counts?.updated_at ?? new Date(0).toISOString()),
    cursor: Number(cursor?.max_sequence ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Conversations and timeline
 * ------------------------------------------------------------------ */

/**
 * Create a conversation and claim its home authority in one step.
 *
 * A conversation with no authority cannot accept commands, and one with two authorities
 * is the multi-master failure the protocol exists to prevent, so both writes belong
 * together.
 */
export function createConversation(
  db: Database,
  input: { conversationId: string; homeNodeId: string; title?: string; at: Instant },
): void {
  transaction(db, () => {
    db.prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run(input.conversationId, input.title ?? null, input.homeNodeId, input.at, input.at);
    db.prepare(
      "INSERT INTO conversation_authority (conversation_id, home_node_id, claimed_at) VALUES (?,?,?)",
    ).run(input.conversationId, input.homeNodeId, input.at);
  });
}

/** Touch a conversation so listing by recency reflects the latest activity. */
export function touchConversation(db: Database, conversationId: string, at: Instant): void {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?").run(at, conversationId);
}

export function getConversation(
  db: Database,
  conversationId: string,
): { conversationId: string; homeNodeId: string; title: string | undefined; createdAt: string; updatedAt: string } | undefined {
  const row = oneRow<{ conversation_id: string; home_node_id: string; title: string | null; created_at: string; updated_at: string }>(
    db,
    "SELECT conversation_id, home_node_id, title, created_at, updated_at FROM conversations WHERE conversation_id = ?",
    conversationId,
  );
  if (!row) return undefined;
  return {
    conversationId: row.conversation_id,
    homeNodeId: row.home_node_id,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConversations(db: Database, limit = 50): string[] {
  return allRows<{ conversation_id: string }>(
    db,
    "SELECT conversation_id FROM conversations ORDER BY updated_at DESC LIMIT ?",
    limit,
  ).map((row) => row.conversation_id);
}

/**
 * Next timeline position for a conversation.
 *
 * Computed rather than supplied so two concurrent writers cannot claim the same
 * position, which would make the timeline order ambiguous for the client's cursor.
 */
export function nextMessageSequence(db: Database, conversationId: string): number {
  const row = oneRow<{ max_sequence: number | null }>(
    db,
    "SELECT MAX(sequence) AS max_sequence FROM messages WHERE conversation_id = ?",
    conversationId,
  );
  return Number(row?.max_sequence ?? 0) + 1;
}

/* ------------------------------------------------------------------ *
 * Datasets
 * ------------------------------------------------------------------ */

export interface DatasetView {
  datasetId: string;
  originNodeId: string;
  rowCount: number;
  /** Never inferred: a cached read must be labelled as cached, not as live. */
  freshness: "live" | "cached" | "sample" | "unknown";
  updatedAt: string;
  document: unknown;
}

/**
 * Store a dataset view.
 *
 * Datasets are addressed by an opaque reference rather than inlined into the timeline, so
 * a large result set never enters the transcript and the client can be told how fresh the
 * data is at the moment it renders it.
 */
export function upsertDataset(
  db: Database,
  input: {
    datasetId: string;
    originNodeId: string;
    rowCount: number;
    freshness: DatasetView["freshness"];
    updatedAt: Instant;
    document: unknown;
    /**
     * Whose data this is. Omitted means node-scoped, which is what the built-in sample is and
     * what a dataset registered for the node itself would be.
     */
    ownerPrincipalId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, origin_node_id, row_count, freshness, updated_at, document, owner_principal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dataset_id) DO UPDATE SET
       row_count = excluded.row_count,
       freshness = excluded.freshness,
       updated_at = excluded.updated_at,
       document = excluded.document,
       owner_principal_id = excluded.owner_principal_id`,
  ).run(
    input.datasetId,
    input.originNodeId,
    input.rowCount,
    input.freshness,
    input.updatedAt,
    toJson(input.document),
    input.ownerPrincipalId ?? null,
  );
}

/**
 * Read a dataset for one principal.
 *
 * Node-scoped datasets (owner NULL) are readable by anyone on the node; a dataset derived for one
 * person is readable only by them. The filter lives in the query rather than in a caller check,
 * because the caller that forgets it is the one that returns somebody else's rows.
 */
export function getDatasetForPrincipal(
  db: Database,
  datasetId: string,
  principalId: string,
): DatasetView | undefined {
  const row = oneRow<{ owner_principal_id: string | null }>(
    db,
    "SELECT owner_principal_id FROM datasets WHERE dataset_id = ?",
    datasetId,
  );
  if (row === undefined) return undefined;
  if (row.owner_principal_id !== null && row.owner_principal_id !== principalId) return undefined;
  return getDataset(db, datasetId);
}

/** Datasets this principal owns, newest first. Used to clean up derived views. */
export function listDatasetsForPrincipal(db: Database, principalId: string, limit = 50): DatasetView[] {
  const rows = allRows<{ dataset_id: string }>(
    db,
    "SELECT dataset_id FROM datasets WHERE owner_principal_id = ? ORDER BY updated_at DESC LIMIT ?",
    principalId,
    limit,
  );
  return rows.flatMap((row) => {
    const dataset = getDataset(db, row.dataset_id);
    return dataset === undefined ? [] : [dataset];
  });
}

export function getDataset(db: Database, datasetId: string): DatasetView | undefined {
  const row = oneRow<{
    dataset_id: string;
    origin_node_id: string;
    row_count: number;
    freshness: string;
    updated_at: string;
    document: string;
  }>(
    db,
    "SELECT dataset_id, origin_node_id, row_count, freshness, updated_at, document FROM datasets WHERE dataset_id = ?",
    datasetId,
  );
  if (!row) return undefined;
  return {
    datasetId: row.dataset_id,
    originNodeId: row.origin_node_id,
    rowCount: Number(row.row_count),
    freshness: row.freshness as DatasetView["freshness"],
    updatedAt: row.updated_at,
    document: parseJson<unknown>(row.document, "datasets.document"),
  };
}

/* ------------------------------------------------------------------ *
 * Project index
 * ------------------------------------------------------------------ */

export type ProjectKind = "code" | "docs" | "media" | "generic";

export interface ProjectRecord {
  projectId: string;
  nodeId: string;
  /** Absolute path. The only place an absolute path is stored; it never leaves the node. */
  path: string;
  name: string;
  aliases: string[];
  gitRemote: string | undefined;
  markers: string[];
  kind: ProjectKind;
  mtime: number;
  lastUsedAt: string | undefined;
  indexedAt: string;
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  const parsed = (value: unknown, column: string): string[] => parseJson<string[]>(value, column);
  return {
    projectId: String(row.project_id),
    nodeId: String(row.node_id),
    path: String(row.path),
    name: String(row.name),
    aliases: parsed(row.aliases, "project_index.aliases"),
    gitRemote: row.git_remote === null ? undefined : String(row.git_remote),
    markers: parsed(row.markers, "project_index.markers"),
    kind: String(row.kind) as ProjectKind,
    mtime: Number(row.mtime),
    lastUsedAt: row.last_used_at === null ? undefined : String(row.last_used_at),
    indexedAt: String(row.indexed_at),
  };
}

/**
 * Insert or update one indexed directory.
 *
 * `last_used_at` is preserved on conflict: a refresh is not a use, and resetting it would erase the
 * one signal that says which of two similarly named projects the user actually works in.
 */
export function upsertProject(db: Database, project: ProjectRecord): void {
  transaction(db, () => {
    db.prepare(
      `INSERT INTO project_index
         (project_id, node_id, path, name, aliases, git_remote, markers, kind, mtime, last_used_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         name = excluded.name,
         aliases = excluded.aliases,
         git_remote = excluded.git_remote,
         markers = excluded.markers,
         kind = excluded.kind,
         mtime = excluded.mtime,
         indexed_at = excluded.indexed_at`,
    ).run(
      project.projectId,
      project.nodeId,
      project.path,
      project.name,
      toJson(project.aliases),
      project.gitRemote ?? null,
      toJson(project.markers),
      project.kind,
      project.mtime,
      project.lastUsedAt ?? null,
      project.indexedAt,
    );

    // The FTS row is replaced rather than updated, because a renamed project must stop matching its
    // old name; leaving the old row behind would return a directory that no longer exists.
    db.prepare("DELETE FROM project_fts WHERE project_id = ?").run(project.projectId);
    db.prepare(
      `INSERT INTO project_fts (name, aliases, path, kind, project_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(project.name, project.aliases.join(" "), project.path, project.kind, project.projectId);
  });
}

export function getProject(db: Database, projectId: string): ProjectRecord | undefined {
  const row = oneRow<Record<string, unknown>>(db, "SELECT * FROM project_index WHERE project_id = ?", projectId);
  return row === undefined ? undefined : mapProject(row);
}

export function findProjectByPath(db: Database, nodeId: string, path: string): ProjectRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM project_index WHERE node_id = ? AND path = ?",
    nodeId,
    path,
  );
  return row === undefined ? undefined : mapProject(row);
}

export function listProjects(db: Database, nodeId: string, limit = 500): ProjectRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM project_index WHERE node_id = ? ORDER BY last_used_at DESC NULLS LAST, name LIMIT ?",
    nodeId,
    limit,
  );
  return rows.map(mapProject);
}

export interface ProjectMatch {
  project: ProjectRecord;
  /** BM25, lower is better. Undefined for a match that came from an exact alias. */
  score: number | undefined;
  how: "alias" | "search";
}

/**
 * Find projects by name, path or alias.
 *
 * FTS5 for the words and an exact alias match first, because "agentkit" is a name somebody used, not
 * a word to be ranked against every other name that contains the letters.
 */
export function searchProjects(db: Database, nodeId: string, text: string, limit = 8): ProjectMatch[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const matches: ProjectMatch[] = [];
  const seen = new Set<string>();

  const aliasRows = allRows<Record<string, unknown>>(
    db,
    `SELECT * FROM project_index
      WHERE node_id = ?
        AND (name = ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM json_each(project_index.aliases) WHERE json_each.value = ? COLLATE NOCASE))
      LIMIT ?`,
    nodeId,
    trimmed,
    trimmed,
    limit,
  );
  for (const row of aliasRows) {
    const project = mapProject(row);
    matches.push({ project, score: undefined, how: "alias" });
    seen.add(project.projectId);
  }

  const match = toMatchExpression(trimmed);
  if (match === "") return matches;

  const searchRows = allRows<{ project_id: string; score: number }>(
    db,
    `SELECT project_id, bm25(project_fts) AS score
       FROM project_fts
      WHERE project_fts MATCH ?
      ORDER BY score
      LIMIT ?`,
    match,
    limit * 2,
  );
  for (const row of searchRows) {
    if (seen.has(row.project_id)) continue;
    const project = getProject(db, row.project_id);
    if (project === undefined || project.nodeId !== nodeId) continue;
    matches.push({ project, score: Number(row.score), how: "search" });
    seen.add(project.projectId);
  }

  return matches.slice(0, limit);
}

/** Record that a project was used, which is what breaks a tie between similar names. */
export function touchProjectUse(db: Database, projectId: string, at: Instant): boolean {
  const result = db.prepare("UPDATE project_index SET last_used_at = ? WHERE project_id = ?").run(at, projectId);
  return Number(result.changes) > 0;
}

/**
 * Remove indexed projects that are no longer on disk.
 *
 * Takes the paths that survived a scan rather than a cutoff time: a directory can be scanned and
 * removed in the same pass, and a time-based prune would keep whichever answer came last.
 */
export function pruneProjects(db: Database, nodeId: string, survivingPaths: readonly string[]): number {
  return transaction(db, () => {
    const existing = listProjects(db, nodeId, 10_000);
    const keep = new Set(survivingPaths);
    let removed = 0;
    for (const project of existing) {
      if (keep.has(project.path)) continue;
      db.prepare("DELETE FROM project_fts WHERE project_id = ?").run(project.projectId);
      db.prepare("DELETE FROM project_index WHERE project_id = ?").run(project.projectId);
      removed += 1;
    }
    return removed;
  });
}

export function projectIndexStats(db: Database, nodeId: string): { total: number; kinds: Record<string, number> } {
  const rows = allRows<{ kind: string; n: number }>(
    db,
    "SELECT kind, COUNT(*) AS n FROM project_index WHERE node_id = ? GROUP BY kind",
    nodeId,
  );
  const kinds: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    kinds[row.kind] = Number(row.n);
    total += Number(row.n);
  }
  return { total, kinds };
}

/* ------------------------------------------------------------------ *
 * History index
 * ------------------------------------------------------------------ */

export type HistorySource = "message" | "session_entry";

export interface HistoryIndexInput {
  source: HistorySource;
  /** Stable identity of the indexed thing: a message id, or `sessionId:offset`. */
  ref: string;
  text: string;
  principalId: string;
  conversationId?: string;
  taskId?: string;
  createdAt: string;
}

/**
 * Index one piece of history.
 *
 * Re-indexing the same ref replaces it rather than duplicating it, so a re-run of an ingest batch is
 * harmless: the alternative is a search that returns the same sentence twice because a batch was
 * retried after a crash.
 */
export function indexHistory(db: Database, input: HistoryIndexInput): void {
  const text = input.text.trim();
  if (text === "") return;

  transaction(db, () => {
    const existing = oneRow<{ rowid: number }>(
      db,
      "SELECT rowid FROM history_fts WHERE source = ? AND ref = ?",
      input.source,
      input.ref,
    );
    if (existing !== undefined) {
      db.prepare("DELETE FROM history_fts WHERE rowid = ?").run(existing.rowid);
    }
    db.prepare(
      `INSERT INTO history_fts (text, source, ref, conversation_id, task_id, principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      text,
      input.source,
      input.ref,
      input.conversationId ?? null,
      input.taskId ?? null,
      input.principalId,
      input.createdAt,
    );
  });
}

export interface HistoryHit {
  source: HistorySource;
  ref: string;
  /** BM25 score. Lower is better, which is SQLite's convention and worth stating. */
  score: number;
  snippet: string;
  conversationId: string | undefined;
  taskId: string | undefined;
  createdAt: string;
}

export interface HistoryQuery {
  principalId: string;
  /** Free text. Tokenised into quoted terms, never interpolated as an expression. */
  text: string;
  from?: string;
  to?: string;
  conversationId?: string;
  taskId?: string;
  source?: HistorySource;
  limit?: number;
  offset?: number;
}

/**
 * Turn free text into an FTS5 MATCH expression.
 *
 * Each term is quoted, which is what stops a user's words from being read as FTS syntax: `AND`,
 * `NEAR`, `*` and a stray quote are all meaningful to FTS5, and a query that throws is worse than a
 * query that returns nothing. Terms are OR'd so a multi-word question still retrieves, and BM25 is
 * what orders the result.
 */
export function toMatchExpression(text: string, maxTerms = 12): string {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter((term) => term.length > 1)
    .slice(0, maxTerms);
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term}"`).join(" OR ");
}

/**
 * Search history for one principal.
 *
 * The principal filter is part of the SQL rather than a post-filter, because a result that is
 * fetched and then discarded still touched the data of another principal.
 */
export function searchHistory(db: Database, query: HistoryQuery): HistoryHit[] {
  const match = toMatchExpression(query.text);
  if (match === "") return [];

  const clauses = ["history_fts MATCH ?", "principal_id = ?"];
  const params: unknown[] = [match, query.principalId];
  if (query.from !== undefined) {
    clauses.push("created_at >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("created_at < ?");
    params.push(query.to);
  }
  if (query.conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    params.push(query.conversationId);
  }
  if (query.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (query.source !== undefined) {
    clauses.push("source = ?");
    params.push(query.source);
  }

  const rows = allRows<{
    text: string;
    source: string;
    ref: string;
    score: number;
    snippet: string;
    conversation_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT text, source, ref, bm25(history_fts) AS score,
            snippet(history_fts, 0, '[', ']', '…', 12) AS snippet,
            conversation_id, task_id, created_at
       FROM history_fts
      WHERE ${clauses.join(" AND ")}
      ORDER BY score
      LIMIT ? OFFSET ?`,
    ...params,
    query.limit ?? 10,
    query.offset ?? 0,
  );

  return rows.map((row) => ({
    source: row.source as HistorySource,
    ref: row.ref,
    score: Number(row.score),
    snippet: row.snippet,
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  }));
}

/**
 * Recent history inside a window, newest first.
 *
 * The companion to `searchHistory` for a query that has no terms left after its time phrase was
 * parsed ("what happened yesterday"). It reads the same table under the same principal scope, so the
 * two paths cannot disagree about whose history is visible.
 */
export function recentHistory(
  db: Database,
  query: {
    principalId: string;
    from: string;
    to: string;
    conversationId?: string;
    taskId?: string;
    source?: HistorySource;
    limit?: number;
  },
): HistoryHit[] {
  const clauses = ["principal_id = ?", "created_at >= ?", "created_at < ?"];
  const params: unknown[] = [query.principalId, query.from, query.to];
  if (query.conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    params.push(query.conversationId);
  }
  if (query.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (query.source !== undefined) {
    clauses.push("source = ?");
    params.push(query.source);
  }

  const rows = allRows<{
    text: string;
    source: string;
    ref: string;
    conversation_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT text, source, ref, conversation_id, task_id, created_at
       FROM history_fts
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?`,
    ...params,
    query.limit ?? 10,
  );

  return rows.map((row) => ({
    source: row.source as HistorySource,
    ref: row.ref,
    // No ranking was applied, and reporting a score here would imply one was.
    score: 0,
    snippet: row.text.slice(0, 240),
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  }));
}

/** How much history a principal has indexed, so a caller can tell "no matches" from "no index". */
export function historyIndexSize(db: Database, principalId: string): number {
  const row = oneRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM history_fts WHERE principal_id = ?",
    principalId,
  );
  return Number(row?.n ?? 0);
}

/**
 * One indexed entry, by identity.
 *
 * A semantic hit arrives as a distance and a ref, with no text: the vector index is what found it, and
 * the words live in the lexical table. Reading the entry back is what lets a fused result show a
 * snippet for a row that only the vector side matched.
 */
export function historyEntry(
  db: Database,
  input: { principalId: string; source: HistorySource; ref: string },
): { text: string; conversationId: string | undefined; taskId: string | undefined; createdAt: string } | undefined {
  const row = oneRow<{
    text: string;
    conversation_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(
    db,
    `SELECT text, conversation_id, task_id, created_at
       FROM history_fts
      WHERE principal_id = ? AND source = ? AND ref = ?
      LIMIT 1`,
    input.principalId,
    input.source,
    input.ref,
  );
  if (row === undefined) return undefined;
  return {
    text: row.text,
    conversationId: row.conversation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ *
 * Embeddings (Phase 10)
 * ------------------------------------------------------------------ */

export interface EmbeddingIndexState {
  count: number;
  /** The model that produced the vectors already stored, when there are any. */
  model: string | undefined;
  dims: number | undefined;
}

/** What is already embedded, and with which model. */
export function embeddingIndexState(db: Database, principalId: string): EmbeddingIndexState {
  const row = oneRow<{ n: number; model: string | null; dims: number | null }>(
    db,
    "SELECT COUNT(*) AS n, MIN(model) AS model, MIN(dims) AS dims FROM history_embeddings_meta WHERE principal_id = ?",
    principalId,
  );
  return {
    count: Number(row?.n ?? 0),
    model: row?.model ?? undefined,
    dims: row?.dims === null || row?.dims === undefined ? undefined : Number(row.dims),
  };
}

/**
 * Create the vector table, if the extension is loaded and the dimensions agree.
 *
 * Deliberately not part of a migration. A `vec0` table can only be created by a connection with
 * sqlite-vec loaded, and a migration runs on every machine whether or not that optional dependency
 * is installed — putting it in a migration would make the schema depend on an optional package, and
 * a database created without it could never grow the table later. Cosine distance is declared here
 * because these are E5 embeddings, where angle is the signal and magnitude is not.
 */
export function ensureEmbeddingTable(
  db: Database,
  dims: number,
): { ok: true } | { ok: false; reason: string } {
  const existing = oneRow<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE name = 'history_vec'",
  );
  if (existing !== undefined) {
    if (!existing.sql.includes(`float[${dims}]`)) {
      return {
        ok: false,
        reason: `history_vec holds ${existing.sql.match(/float\[(\d+)\]/)?.[1] ?? "unknown"}-dimension vectors, not ${dims}`,
      };
    }
    return { ok: true };
  }

  try {
    db.exec(
      `CREATE VIRTUAL TABLE history_vec USING vec0(embedding float[${dims}] distance_metric=cosine)`,
    );
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Insert one vector and return the rowid vec0 assigned it. */
export function insertEmbedding(db: Database, values: readonly number[]): number {
  const result = db
    .prepare("INSERT INTO history_vec(embedding) VALUES (?)")
    .run(JSON.stringify([...values]));
  return Number(result.lastInsertRowid);
}

export function deleteEmbedding(db: Database, vecRowid: number): void {
  db.prepare("DELETE FROM history_vec WHERE rowid = ?").run(vecRowid);
}

export interface EmbeddingMetaInput {
  source: HistorySource;
  ref: string;
  principalId: string;
  model: string;
  dims: number;
  digest: string;
  vecRowid: number;
  createdAt: string;
}

/**
 * Record that a row has a vector, replacing any previous vector for it.
 *
 * The old vector is deleted first so a re-index cannot leave two vectors for one ref, which would
 * make the same sentence appear twice in results that are supposed to be ranked.
 */
export function upsertEmbeddingMeta(db: Database, input: EmbeddingMetaInput): void {
  transaction(db, () => {
    const existing = oneRow<{ vec_rowid: number }>(
      db,
      "SELECT vec_rowid FROM history_embeddings_meta WHERE source = ? AND ref = ?",
      input.source,
      input.ref,
    );
    if (existing !== undefined) {
      deleteEmbedding(db, Number(existing.vec_rowid));
    }
    db.prepare(
      `INSERT INTO history_embeddings_meta
         (source, ref, principal_id, model, dims, digest, vec_rowid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, ref) DO UPDATE SET
         principal_id = excluded.principal_id,
         model = excluded.model,
         dims = excluded.dims,
         digest = excluded.digest,
         vec_rowid = excluded.vec_rowid,
         created_at = excluded.created_at`,
    ).run(
      input.source,
      input.ref,
      input.principalId,
      input.model,
      input.dims,
      input.digest,
      input.vecRowid,
      input.createdAt,
    );
  });
}

export function countEmbeddings(db: Database, principalId: string): number {
  const row = oneRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM history_embeddings_meta WHERE principal_id = ?",
    principalId,
  );
  return Number(row?.n ?? 0);
}

/** History rows with no vector yet, so an embed pass can resume rather than restart. */
export function historyMissingEmbedding(
  db: Database,
  input: { principalId: string; model: string; limit: number },
): { source: HistorySource; ref: string; text: string; createdAt: string }[] {
  return allRows<{ source: string; ref: string; text: string; created_at: string }>(
    db,
    `SELECT f.source AS source, f.ref AS ref, f.text AS text, f.created_at AS created_at
       FROM history_fts f
       LEFT JOIN history_embeddings_meta m
              ON m.source = f.source AND m.ref = f.ref AND m.model = ?
      WHERE f.principal_id = ? AND m.ref IS NULL
      ORDER BY f.created_at DESC
      LIMIT ?`,
    input.model,
    input.principalId,
    input.limit,
  ).map((row) => ({
    source: row.source as HistorySource,
    ref: row.ref,
    text: row.text,
    createdAt: row.created_at,
  }));
}

export interface SemanticHit {
  source: HistorySource;
  ref: string;
  /** Cosine distance. Lower is closer, which is sqlite-vec's convention. */
  distance: number;
}

/**
 * Exact KNN over the embedded history for one principal.
 *
 * `k` is fetched larger than the caller asked for because the principal filter is applied here rather
 * than inside the index walk: the search must not return another principal's row even transiently.
 */
export function searchEmbedding(
  db: Database,
  input: { values: readonly number[]; limit: number; principalId: string },
): SemanticHit[] {
  const rows = allRows<{ source: string; ref: string; distance: number }>(
    db,
    `SELECT m.source AS source, m.ref AS ref, v.distance AS distance
       FROM history_vec v
       JOIN history_embeddings_meta m ON m.vec_rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ? AND m.principal_id = ?
      ORDER BY v.distance`,
    JSON.stringify([...input.values]),
    input.limit * 4,
    input.principalId,
  );
  return rows
    .slice(0, input.limit)
    .map((row) => ({
      source: row.source as HistorySource,
      ref: row.ref,
      distance: Number(row.distance),
    }));
}

/* ------------------------------------------------------------------ *
 * Worker session files
 * ------------------------------------------------------------------ */

export interface SessionFileRecord {
  sessionId: string;
  nodeId: string;
  principalId: string;
  taskId: string | undefined;
  conversationId: string | undefined;
  /** Absolute path to the JSONL transcript. Never a URL, never a remote location. */
  path: string;
  byteSize: number;
  /** Byte offset already ingested into the history index. */
  ingestCursor: number;
  lastIngestedAt: string | undefined;
  createdAt: string;
  updatedAt: string;
}

/**
 * Record where a worker session's transcript lives.
 *
 * A row is written when the session is created rather than when it ends: a worker that is killed
 * mid-run still leaves a transcript, and a session whose file was never indexed is a session that
 * cannot be searched afterwards.
 */
export function upsertSessionFile(db: Database, input: SessionFileRecord): void {
  db.prepare(
    `INSERT INTO session_files
       (session_id, node_id, principal_id, task_id, conversation_id, path, byte_size, ingest_cursor,
        last_ingested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       path = excluded.path,
       byte_size = excluded.byte_size,
       updated_at = excluded.updated_at`,
  ).run(
    input.sessionId,
    input.nodeId,
    input.principalId,
    input.taskId ?? null,
    input.conversationId ?? null,
    input.path,
    input.byteSize,
    input.ingestCursor,
    input.lastIngestedAt ?? null,
    input.createdAt,
    input.updatedAt,
  );
}

export function getSessionFile(db: Database, sessionId: string): SessionFileRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM session_files WHERE session_id = ?",
    sessionId,
  );
  return row === undefined ? undefined : mapSessionFile(row);
}

export function listSessionFiles(
  db: Database,
  filter: { principalId?: string; taskId?: string; conversationId?: string; limit?: number } = {},
): SessionFileRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.principalId !== undefined) {
    clauses.push("principal_id = ?");
    params.push(filter.principalId);
  }
  if (filter.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.conversationId !== undefined) {
    clauses.push("conversation_id = ?");
    params.push(filter.conversationId);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT * FROM session_files${where} ORDER BY created_at DESC LIMIT ?`,
    ...params,
    filter.limit ?? 200,
  );
  return rows.map(mapSessionFile);
}

/**
 * Advance the ingest cursor.
 *
 * Takes an absolute offset rather than adding to the stored one, so a retried batch that ingested
 * the same bytes twice cannot skip a later batch by moving the cursor twice.
 */
export function advanceSessionIngestCursor(
  db: Database,
  input: { sessionId: string; cursor: number; byteSize?: number; at: Instant },
): boolean {
  const result = db
    .prepare(
      `UPDATE session_files
          SET ingest_cursor = ?, byte_size = COALESCE(?, byte_size), last_ingested_at = ?, updated_at = ?
        WHERE session_id = ? AND ingest_cursor <= ?`,
    )
    .run(
      input.cursor,
      input.byteSize ?? null,
      input.at,
      input.at,
      input.sessionId,
      input.cursor,
    );
  return Number(result.changes) > 0;
}

function mapSessionFile(row: Record<string, unknown>): SessionFileRecord {
  return {
    sessionId: String(row.session_id),
    nodeId: String(row.node_id),
    principalId: String(row.principal_id),
    taskId: row.task_id === null ? undefined : String(row.task_id),
    conversationId: row.conversation_id === null ? undefined : String(row.conversation_id),
    path: String(row.path),
    byteSize: Number(row.byte_size),
    ingestCursor: Number(row.ingest_cursor),
    lastIngestedAt: row.last_ingested_at === null ? undefined : String(row.last_ingested_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/* ------------------------------------------------------------------ *
 * Composed surfaces
 * ------------------------------------------------------------------ */

/**
 * Record the compiled layout document behind a composed surface.
 *
 * The document is parsed on the way in as well as on the way out. A spec that is only
 * validated when it is read means a corrupt write is discovered by a user looking at a broken
 * surface rather than by the writer that produced it.
 */
export function insertSurfaceComposition(
  db: Database,
  input: {
    composition: SurfaceCompositionSpec;
    ownerPrincipalId: string;
    messageId: string;
    conversationId: string;
    at: Instant;
  },
): void {
  const spec = surfaceCompositionSpecSchema.parse(input.composition);
  db.prepare(
    `INSERT INTO surface_compositions
       (composition_id, instance_id, owner_principal_id, message_id, conversation_id, template_id,
        template_version, catalog_digest, section_count, document, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spec.compositionId,
    spec.instanceId,
    input.ownerPrincipalId,
    input.messageId,
    input.conversationId,
    spec.templateId,
    spec.templateVersion,
    spec.catalogDigest,
    spec.sections.length,
    toJson(spec),
    input.at,
  );
}

/**
 * Read a composition for one principal.
 *
 * The principal is part of the query rather than a check the caller is trusted to make. A
 * composed surface can hold private rows, so a lookup that returns it and leaves authorization
 * to the caller is a lookup that will eventually be called without one.
 */
export function getSurfaceComposition(
  db: Database,
  compositionId: string,
  principalId: string,
): SurfaceCompositionSpec | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM surface_compositions WHERE composition_id = ? AND owner_principal_id = ?",
    compositionId,
    principalId,
  );
  return row === undefined
    ? undefined
    : surfaceCompositionSpecSchema.parse(parseJson<unknown>(row.document, "surface_compositions.document"));
}

/** The composition a message produced, if any. The idempotency key for a replayed turn. */
export function findCompositionByMessage(
  db: Database,
  messageId: string,
  principalId: string,
): SurfaceCompositionSpec | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM surface_compositions
      WHERE message_id = ? AND owner_principal_id = ?
      ORDER BY created_at DESC LIMIT 1`,
    messageId,
    principalId,
  );
  return row === undefined
    ? undefined
    : surfaceCompositionSpecSchema.parse(parseJson<unknown>(row.document, "surface_compositions.document"));
}

export function findCompositionByInstance(
  db: Database,
  instanceId: string,
  principalId: string,
): SurfaceCompositionSpec | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM surface_compositions
      WHERE instance_id = ? AND owner_principal_id = ?
      ORDER BY created_at DESC LIMIT 1`,
    instanceId,
    principalId,
  );
  return row === undefined
    ? undefined
    : surfaceCompositionSpecSchema.parse(parseJson<unknown>(row.document, "surface_compositions.document"));
}

/* ------------------------------------------------------------------ *
 * Presentation bundles
 * ------------------------------------------------------------------ */

/**
 * Write a materialised snapshot.
 *
 * A plain insert, deliberately. There is no upsert path because a bundle that can be rewritten
 * is not a snapshot, and the failure worth engineering for here is the accidental overwrite
 * that makes yesterday's message show today's numbers.
 */
export function insertPresentationBundle(db: Database, bundle: StoredPresentationBundle): void {
  const parsed = storedPresentationBundleSchema.parse(bundle);
  db.prepare(
    `INSERT INTO presentation_bundles
       (bundle_id, snapshot_id, message_id, instance_id, owner_principal_id, byte_size, document, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.bundleId,
    parsed.snapshotId,
    parsed.messageId,
    parsed.instanceId,
    parsed.ownerPrincipalId,
    parsed.byteSize,
    toJson(parsed),
    parsed.capturedAt,
  );
}

export function getPresentationBundle(
  db: Database,
  bundleId: string,
  principalId: string,
): StoredPresentationBundle | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM presentation_bundles WHERE bundle_id = ? AND owner_principal_id = ?",
    bundleId,
    principalId,
  );
  return row === undefined
    ? undefined
    : storedPresentationBundleSchema.parse(parseJson<unknown>(row.document, "presentation_bundles.document"));
}

/** The bundle a message captured, if any. */
export function findBundleForMessage(
  db: Database,
  messageId: string,
  principalId: string,
): StoredPresentationBundle | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM presentation_bundles
      WHERE message_id = ? AND owner_principal_id = ? ORDER BY created_at DESC LIMIT 1`,
    messageId,
    principalId,
  );
  return row === undefined
    ? undefined
    : storedPresentationBundleSchema.parse(parseJson<unknown>(row.document, "presentation_bundles.document"));
}

/** Which bundle, if any, the given snapshot captured. Absent means a legacy or unbundled row. */
export function findBundleForSnapshot(
  db: Database,
  snapshotId: string,
  principalId: string,
): StoredPresentationBundle | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM presentation_bundles
      WHERE snapshot_id = ? AND owner_principal_id = ? ORDER BY created_at DESC LIMIT 1`,
    snapshotId,
    principalId,
  );
  return row === undefined
    ? undefined
    : storedPresentationBundleSchema.parse(parseJson<unknown>(row.document, "presentation_bundles.document"));
}

/**
 * Replace a bundle with a tombstone.
 *
 * Retention and deletion are server concerns: a message outlives the data it displayed, and
 * the honest outcomes are "still here" and "removed, and here is why". Silently dropping the
 * bundle would make a deliberate deletion look indistinguishable from a rendering fault.
 */
export function tombstonePresentationBundle(
  db: Database,
  bundleId: string,
  reason: string,
  at: Instant,
): boolean {
  const row = oneRow<{ document: string; deleted_at: string | null }>(
    db,
    "SELECT document, deleted_at FROM presentation_bundles WHERE bundle_id = ?",
    bundleId,
  );
  if (row === undefined || row.deleted_at !== null) return false;
  const parsed = parseJson<Record<string, unknown>>(row.document, "presentation_bundles.document");
  const next: Record<string, unknown> = {
    ...parsed,
    sections: [],
    tombstone: { reason: reason.slice(0, 200), at },
  };
  db.prepare("UPDATE presentation_bundles SET deleted_at = ?, tombstone_reason = ?, document = ? WHERE bundle_id = ?").run(
    at,
    reason.slice(0, 200),
    toJson(next),
    bundleId,
  );
  return true;
}

/** Hard removal, for a retention job that must not leave a document behind at all. */
export function deletePresentationBundle(db: Database, bundleId: string): boolean {
  const result = db.prepare("DELETE FROM presentation_bundles WHERE bundle_id = ?").run(bundleId);
  return Number(result.changes) > 0;
}

export function countPresentationBundles(db: Database, principalId: string): number {
  const row = oneRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM presentation_bundles WHERE owner_principal_id = ? AND deleted_at IS NULL",
    principalId,
  );
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ *
 * Local calendar
 * ------------------------------------------------------------------ */

export interface CalendarEventRecord {
  eventId: string;
  ownerPrincipalId: string;
  nodeId: string;
  title: string;
  /** Instants are stored in UTC; `timezone` is what makes them displayable. */
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** The local calendar day the event starts on, so a day query is an index hit. */
  localDate: string;
  createdAt: string;
  updatedAt: string;
}

export function insertCalendarEvent(db: Database, input: CalendarEventRecord): void {
  db.prepare(
    `INSERT INTO calendar_events
       (event_id, owner_principal_id, node_id, title, starts_at, ends_at, timezone, local_date,
        document, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.ownerPrincipalId,
    input.nodeId,
    input.title,
    input.startsAt,
    input.endsAt,
    input.timezone,
    input.localDate,
    toJson(input),
    input.createdAt,
    input.updatedAt,
  );
}

export function updateCalendarEvent(
  db: Database,
  input: CalendarEventRecord,
): boolean {
  const result = db
    .prepare(
      `UPDATE calendar_events
          SET title = ?, starts_at = ?, ends_at = ?, timezone = ?, local_date = ?, document = ?, updated_at = ?
        WHERE event_id = ? AND owner_principal_id = ? AND deleted_at IS NULL`,
    )
    .run(
      input.title,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.localDate,
      toJson(input),
      input.updatedAt,
      input.eventId,
      input.ownerPrincipalId,
    );
  return Number(result.changes) > 0;
}

export function getCalendarEvent(
  db: Database,
  eventId: string,
  principalId: string,
): CalendarEventRecord | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM calendar_events WHERE event_id = ? AND owner_principal_id = ? AND deleted_at IS NULL",
    eventId,
    principalId,
  );
  return row === undefined ? undefined : parseJson<CalendarEventRecord>(row.document, "calendar_events.document");
}

/**
 * List events overlapping a window.
 *
 * Overlap rather than containment: an event that started yesterday and ends tomorrow belongs in
 * today's view, and a query written as `starts_at BETWEEN` would hide it.
 */
export function listCalendarEvents(
  db: Database,
  input: { principalId: string; from?: string; to?: string; limit?: number },
): CalendarEventRecord[] {
  const clauses = ["owner_principal_id = ?", "deleted_at IS NULL"];
  const params: unknown[] = [input.principalId];
  if (input.to !== undefined) {
    clauses.push("starts_at <= ?");
    params.push(input.to);
  }
  if (input.from !== undefined) {
    clauses.push("ends_at >= ?");
    params.push(input.from);
  }
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM calendar_events WHERE ${clauses.join(" AND ")} ORDER BY starts_at ASC LIMIT ?`,
    ...params,
    input.limit ?? 200,
  );
  return rows.map((row) => parseJson<CalendarEventRecord>(row.document, "calendar_events.document"));
}

/** Soft delete: an event the user removed must not silently vanish from a snapshot's provenance. */
export function deleteCalendarEvent(db: Database, eventId: string, principalId: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE calendar_events SET deleted_at = ?, updated_at = ? WHERE event_id = ? AND owner_principal_id = ? AND deleted_at IS NULL")
    .run(at, at, eventId, principalId);
  return Number(result.changes) > 0;
}

/* ------------------------------------------------------------------ *
 * Local images
 * ------------------------------------------------------------------ */

export interface LocalImageRecord {
  imageId: string;
  ownerPrincipalId: string;
  nodeId: string;
  artifactId: string;
  mimeType: string;
  byteSize: number;
  width: number | undefined;
  height: number | undefined;
  digest: string;
  altText: string;
  blobPath: string;
  createdAt: string;
}

export function insertLocalImage(db: Database, input: LocalImageRecord): void {
  db.prepare(
    `INSERT INTO local_images
       (image_id, owner_principal_id, node_id, artifact_id, mime_type, byte_size, width, height,
        digest, alt_text, blob_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.imageId,
    input.ownerPrincipalId,
    input.nodeId,
    input.artifactId,
    input.mimeType,
    input.byteSize,
    input.width ?? null,
    input.height ?? null,
    input.digest,
    input.altText,
    input.blobPath,
    input.createdAt,
  );
}

export function getLocalImage(db: Database, imageId: string, principalId: string): LocalImageRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM local_images WHERE image_id = ? AND owner_principal_id = ? AND deleted_at IS NULL",
    imageId,
    principalId,
  );
  return row === undefined ? undefined : mapLocalImage(row);
}

export function listLocalImages(db: Database, principalId: string, limit = 100): LocalImageRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM local_images WHERE owner_principal_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
    principalId,
    limit,
  );
  return rows.map(mapLocalImage);
}

export function deleteLocalImage(db: Database, imageId: string, principalId: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE local_images SET deleted_at = ? WHERE image_id = ? AND owner_principal_id = ? AND deleted_at IS NULL")
    .run(at, imageId, principalId);
  return Number(result.changes) > 0;
}

function mapLocalImage(row: Record<string, unknown>): LocalImageRecord {
  return {
    imageId: String(row.image_id),
    ownerPrincipalId: String(row.owner_principal_id),
    nodeId: String(row.node_id),
    artifactId: String(row.artifact_id),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    width: row.width === null || row.width === undefined ? undefined : Number(row.width),
    height: row.height === null || row.height === undefined ? undefined : Number(row.height),
    digest: String(row.digest),
    altText: String(row.alt_text),
    blobPath: String(row.blob_path),
    createdAt: String(row.created_at),
  };
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/**
 * A file someone attached to a message.
 *
 * `blobPath` is an absolute path on this node. It is stored because the bytes
 * have to be found again, and it never leaves the node: no route returns it and
 * no prompt carries it. Readers check it against the blob root before opening
 * it, because a row edited by hand must not become an arbitrary file read.
 */
export interface AttachmentRecord {
  attachmentId: string;
  principalId: string;
  conversationId: string;
  filename: string;
  mime: string;
  kind: string;
  sizeBytes: number;
  sha256: string;
  blobPath: string;
  createdAt: string;
}

export function insertAttachment(db: Database, input: AttachmentRecord): void {
  db.prepare(
    `INSERT INTO attachments
       (attachment_id, principal_id, conversation_id, filename, mime, kind, size_bytes, sha256,
        blob_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.attachmentId,
    input.principalId,
    input.conversationId,
    input.filename,
    input.mime,
    input.kind,
    input.sizeBytes,
    input.sha256,
    input.blobPath,
    input.createdAt,
  );
}

/** Scoped to the principal, so one person's id is not another person's read. */
export function getAttachment(
  db: Database,
  attachmentId: string,
  principalId: string,
): AttachmentRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM attachments WHERE attachment_id = ? AND principal_id = ?",
    attachmentId,
    principalId,
  );
  return row === undefined ? undefined : mapAttachment(row);
}

export function listAttachmentsForConversation(
  db: Database,
  conversationId: string,
): AttachmentRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at",
    conversationId,
  );
  return rows.map(mapAttachment);
}

/**
 * Remove a conversation's attachment rows and report where their bytes were.
 *
 * The caller deletes the files, and it does so after this returns: a row that
 * outlives its bytes is a missing file the UI can explain, while bytes that
 * outlive their row are garbage nobody can find.
 */
export function deleteAttachmentsForConversation(
  db: Database,
  conversationId: string,
): { removed: number; blobPaths: string[] } {
  return transaction(db, () => {
    const rows = listAttachmentsForConversation(db, conversationId);
    if (rows.length === 0) return { removed: 0, blobPaths: [] };
    const result = db.prepare("DELETE FROM attachments WHERE conversation_id = ?").run(conversationId);
    return { removed: Number(result.changes), blobPaths: rows.map((row) => row.blobPath) };
  });
}

/** Total stored bytes for one principal. The single source the quota is read from. */
export function attachmentUsageForPrincipal(db: Database, principalId: string): number {
  const row = oneRow<{ used: number | null }>(
    db,
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM attachments WHERE principal_id = ?",
    principalId,
  );
  return Number(row?.used ?? 0);
}

function mapAttachment(row: Record<string, unknown>): AttachmentRecord {
  return {
    attachmentId: String(row.attachment_id),
    principalId: String(row.principal_id),
    conversationId: String(row.conversation_id),
    filename: String(row.filename),
    mime: String(row.mime),
    kind: String(row.kind),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    blobPath: String(row.blob_path),
    createdAt: String(row.created_at),
  };
}

/**
 * Secrets a person typed into the host.
 *
 * The rule these functions keep is one-sided: a value goes in, and nothing hands it back out except the single
 * function the host calls when it needs to use it. There is no listing that includes values and no count of
 * characters, because a mistyped key must not turn up printed in a card, and a log line or an error message is
 * where a secret leaks by accident.
 */
export function putCredential(
  db: Database,
  input: { principalId: string; name: string; value: string; at: Instant },
): void {
  db.prepare(
    `INSERT INTO credentials (principal_id, name, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (principal_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(input.principalId, input.name, input.value, input.at);
}

/** Whether a name has been set. This is what a status line reports, and it reports only this. */
export function hasCredential(db: Database, principalId: string, name: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM credentials WHERE principal_id = ? AND name = ?").get(principalId, name);
  return row !== undefined;
}

/** The names that have been set, never the values: a list is what an interface may show. */
export function credentialNames(db: Database, principalId: string): string[] {
  const rows = db
    .prepare("SELECT name FROM credentials WHERE principal_id = ? ORDER BY name")
    .all(principalId) as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * The value itself, for the host and nothing else.
 *
 * Named to read like the thing it is: reading a credential is the operation that has to be justified at every
 * call site, so it is not called `getCredential` and it is not reachable from a route.
 */
export function readCredential(db: Database, principalId: string, name: string): string | undefined {
  const row = db.prepare("SELECT value FROM credentials WHERE principal_id = ? AND name = ?").get(principalId, name) as
    | { value: string }
    | undefined;
  return row?.value;
}

/*
 * Preferences: a choice somebody made, written down with what it replaced.
 *
 * `previous_value` and `revision` are kept because a stored choice is a decision, and "what was it before" is the first
 * question asked when a node starts behaving differently than expected. `scope` is part of the key, so the same setting
 * can differ per conversation without one silently overwriting the other.
 */
export function putPreference(
  db: Database,
  input: { principalId: string; key: string; value: string; scope: string; source: string; at: Instant },
): void {
  const existing = db
    .prepare("SELECT value, revision FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
    .get(input.principalId, input.key, input.scope) as { value: string; revision: number } | undefined;
  db.prepare(
    `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (principal_id, key, scope) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       revision = excluded.revision,
       previous_value = excluded.previous_value`,
  ).run(
    input.principalId,
    input.key,
    input.value,
    input.scope,
    input.source,
    (existing?.revision ?? 0) + 1,
    existing?.value ?? null,
    input.at,
  );
}

/** What a stored preference says, or undefined when nobody has chosen yet. */
export function readPreference(
  db: Database,
  principalId: string,
  key: string,
  scope: string,
): string | undefined {
  const row = db
    .prepare("SELECT value FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
    .get(principalId, key, scope) as { value: string } | undefined;
  return row?.value;
}

/** Forgets a name. Returns whether there was one to forget. */
export function deleteCredential(db: Database, principalId: string, name: string): boolean {
  const result = db.prepare("DELETE FROM credentials WHERE principal_id = ? AND name = ?").run(principalId, name);
  return Number(result.changes) > 0;
}

/* ------------------------------------------------------------------ *
 * Memory
 *
 * One row is a sentence the agent chose to keep, and the conversation
 * it was learned in. Deletion is real, because the Memory tab promises
 * that what somebody removes is gone rather than hidden.
 * ------------------------------------------------------------------ */

export interface MemoryRecordInput {
  memoryId: string;
  principalId: string;
  conversationId: string;
  sourceMessageId?: string;
  kind: string;
  scope: string;
  text: string;
  at: string;
}

export function insertMemoryRecord(db: Database, record: MemoryRecordInput): void {
  db.prepare(
    `INSERT INTO memory_records
       (memory_id, principal_id, conversation_id, source_message_id, kind, scope, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.memoryId,
    record.principalId,
    record.conversationId,
    record.sourceMessageId ?? null,
    record.kind,
    record.scope,
    record.text,
    record.at,
  );
}

interface MemoryRow extends Record<string, unknown> {
  memory_id: string;
  conversation_id: string;
  source_message_id: string | null;
  kind: string;
  scope: string;
  text: string;
  created_at: string;
}

function toMemoryRecord(row: MemoryRow): MemoryRecordInput & { memoryId: string } {
  return {
    memoryId: String(row.memory_id),
    principalId: "",
    conversationId: String(row.conversation_id),
    ...(row.source_message_id === null ? {} : { sourceMessageId: String(row.source_message_id) }),
    kind: String(row.kind),
    scope: String(row.scope),
    text: String(row.text),
    at: String(row.created_at),
  };
}

/** Newest first, because the newest thing remembered is the one most likely to be relevant. */
export function listMemoryRecords(
  db: Database,
  query: { principalId: string; kind?: string; scope?: string },
): MemoryRecordInput[] {
  const clauses = ["principal_id = ?"];
  const values: unknown[] = [query.principalId];
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    values.push(query.kind);
  }
  if (query.scope !== undefined) {
    clauses.push("scope = ?");
    values.push(query.scope);
  }
  const rows = allRows<MemoryRow>(
    db,
    `SELECT * FROM memory_records WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, memory_id DESC`,
    ...values,
  );
  return rows.map(toMemoryRecord);
}

export function getMemoryRecord(db: Database, memoryId: string): MemoryRecordInput | undefined {
  const row = oneRow<MemoryRow>(db, "SELECT * FROM memory_records WHERE memory_id = ?", memoryId);
  return row === undefined ? undefined : toMemoryRecord(row);
}

/**
 * Remove one record, and say whether anything was removed.
 *
 * The principal is part of the condition rather than checked afterwards: a delete that first reads the row and
 * then decides cannot be the thing that enforces ownership.
 */
export function deleteMemoryRecord(db: Database, principalId: string, memoryId: string): boolean {
  const result = db
    .prepare("DELETE FROM memory_records WHERE memory_id = ? AND principal_id = ?")
    .run(memoryId, principalId);
  return Number(result.changes) > 0;
}

/**
 * What goes into the brief for one turn.
 *
 * Node-scoped records and the ones learned in this conversation, never another conversation's: a decision taken
 * somewhere else is not context for what is being decided here.
 */
export function memoryRecordsForBrief(
  db: Database,
  principalId: string,
  conversationId: string,
  limit: number,
): MemoryRecordInput[] {
  const rows = allRows<MemoryRow>(
    db,
    `SELECT * FROM memory_records
      WHERE principal_id = ? AND (scope = 'node' OR conversation_id = ?)
      ORDER BY created_at DESC, memory_id DESC
      LIMIT ?`,
    principalId,
    conversationId,
    limit,
  );
  return rows.map(toMemoryRecord);
}
