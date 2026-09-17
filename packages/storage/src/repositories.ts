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
