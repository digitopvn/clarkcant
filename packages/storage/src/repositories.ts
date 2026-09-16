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
  type TaskRecord,
  type WidgetInstance,
  commandAckSchema,
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
