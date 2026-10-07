import type {
  ChannelBinding,
  ChannelDeliveryReceipt,
  ExternalConnection,
  ExternalIdentity,
  ExternalMessageLink,
  Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/**
 * External messaging channels, as stored.
 *
 * Every record is kept as its validated document beside the columns it is looked up by; the shapes are owned by
 * `packages/contracts/src/channels.ts`. Provider ids are stored here and nowhere in a conversation's messages.
 * An empty thread id stands for "the whole space" in every key, so a unique key never meets two NULLs.
 */

const threadKey = (threadId: string | undefined): string => threadId ?? "";

/* ------------------------------------------------------------------ *
 * Connections and identities
 * ------------------------------------------------------------------ */

export function putExternalConnection(db: Database, connection: ExternalConnection): void {
  db.prepare(
    `INSERT INTO external_connections
       (connection_ref, principal_id, provider, provider_account_id, state, document, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_ref) DO UPDATE SET
       state = excluded.state, document = excluded.document, updated_at = excluded.updated_at`,
  ).run(
    connection.connectionRef,
    connection.principalId,
    connection.provider,
    connection.providerAccountId,
    connection.state,
    toJson(connection),
    connection.createdAt,
    connection.updatedAt,
  );
}

export function getExternalConnection(db: Database, connectionRef: string): ExternalConnection | undefined {
  const row = oneRow<{ document: string }>(db, "SELECT document FROM external_connections WHERE connection_ref = ?", connectionRef);
  return row === undefined ? undefined : parseJson<ExternalConnection>(row.document, "external_connections.document");
}

export function putExternalIdentity(db: Database, identity: ExternalIdentity): void {
  db.prepare(
    `INSERT INTO external_identities (connection_ref, external_actor_id, principal_id, document, linked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_ref, external_actor_id) DO UPDATE SET
       principal_id = excluded.principal_id, document = excluded.document, linked_at = excluded.linked_at`,
  ).run(identity.connectionRef, identity.externalActorId, identity.principalId, toJson(identity), identity.linkedAt);
}

/**
 * Record an identity only when the provider account has none yet, and answer the one that holds. Two deliveries from
 * a new sender racing each other therefore agree on one principal.
 */
export function ensureExternalIdentity(db: Database, identity: ExternalIdentity): ExternalIdentity {
  db.prepare(
    `INSERT INTO external_identities (connection_ref, external_actor_id, principal_id, document, linked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_ref, external_actor_id) DO NOTHING`,
  ).run(identity.connectionRef, identity.externalActorId, identity.principalId, toJson(identity), identity.linkedAt);
  return getExternalIdentity(db, identity.connectionRef, identity.externalActorId) ?? identity;
}

export function getExternalIdentity(db: Database, connectionRef: string, externalActorId: string): ExternalIdentity | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM external_identities WHERE connection_ref = ? AND external_actor_id = ?",
    connectionRef,
    externalActorId,
  );
  return row === undefined ? undefined : parseJson<ExternalIdentity>(row.document, "external_identities.document");
}

/* ------------------------------------------------------------------ *
 * Bindings
 * ------------------------------------------------------------------ */

export function putChannelBinding(db: Database, binding: ChannelBinding): void {
  db.prepare(
    `INSERT INTO external_channel_bindings
       (binding_id, connection_ref, external_space_id, external_thread_id, conversation_id, state, document, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(binding_id) DO UPDATE SET
       conversation_id = excluded.conversation_id, state = excluded.state, document = excluded.document,
       updated_at = excluded.updated_at`,
  ).run(
    binding.bindingId,
    binding.connectionRef,
    binding.externalSpaceId,
    threadKey(binding.externalThreadId),
    binding.conversationId,
    binding.state,
    toJson(binding),
    binding.createdAt,
    binding.updatedAt,
  );
}

export function getChannelBinding(db: Database, bindingId: string): ChannelBinding | undefined {
  const row = oneRow<{ document: string }>(db, "SELECT document FROM external_channel_bindings WHERE binding_id = ?", bindingId);
  return row === undefined ? undefined : parseJson<ChannelBinding>(row.document, "external_channel_bindings.document");
}

/** The binding a message belongs to: one for its own thread first, then one for its whole space. */
export function findChannelBinding(
  db: Database,
  input: { connectionRef: string; externalSpaceId: string; externalThreadId?: string },
): ChannelBinding | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM external_channel_bindings
      WHERE connection_ref = ? AND external_space_id = ? AND external_thread_id IN (?, '')
      ORDER BY external_thread_id DESC LIMIT 1`,
    input.connectionRef,
    input.externalSpaceId,
    threadKey(input.externalThreadId),
  );
  return row === undefined ? undefined : parseJson<ChannelBinding>(row.document, "external_channel_bindings.document");
}

/* ------------------------------------------------------------------ *
 * Message links
 * ------------------------------------------------------------------ */

/** Link a provider message to a Clark message, once. */
export function recordExternalMessageLink(db: Database, link: ExternalMessageLink): void {
  db.prepare(
    `INSERT INTO external_message_links
       (connection_ref, external_space_id, external_thread_id, external_message_id, direction, provider, conversation_id,
        message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_ref, external_space_id, external_message_id, direction) DO NOTHING`,
  ).run(
    link.connectionRef,
    link.externalSpaceId,
    threadKey(link.externalThreadId),
    link.externalMessageId,
    link.direction,
    link.provider,
    link.conversationId,
    link.messageId,
    link.createdAt,
  );
}

interface LinkRow {
  connection_ref: string;
  external_space_id: string;
  external_thread_id: string;
  external_message_id: string;
  direction: string;
  provider: string;
  conversation_id: string;
  message_id: string;
  created_at: string;
}

function linkFromRow(row: LinkRow): ExternalMessageLink {
  return {
    connectionRef: row.connection_ref as ExternalMessageLink["connectionRef"],
    provider: row.provider,
    externalSpaceId: row.external_space_id,
    ...(row.external_thread_id === "" ? {} : { externalThreadId: row.external_thread_id }),
    externalMessageId: row.external_message_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    createdAt: row.created_at as Instant,
  };
}

export function findExternalMessageLink(
  db: Database,
  input: { connectionRef: string; externalSpaceId: string; externalMessageId: string; direction?: "inbound" | "outbound" },
): ExternalMessageLink | undefined {
  const row = oneRow<LinkRow>(
    db,
    `SELECT * FROM external_message_links
      WHERE connection_ref = ? AND external_space_id = ? AND external_message_id = ? AND direction IN (?, ?)
      ORDER BY direction LIMIT 1`,
    input.connectionRef,
    input.externalSpaceId,
    input.externalMessageId,
    input.direction ?? "inbound",
    input.direction ?? "outbound",
  );
  return row === undefined ? undefined : linkFromRow(row);
}

/** The provider messages one Clark message is, in either direction. */
export function externalLinksForMessage(db: Database, messageId: string): ExternalMessageLink[] {
  return allRows<LinkRow>(db, "SELECT * FROM external_message_links WHERE message_id = ? ORDER BY created_at", messageId).map(linkFromRow);
}

/** Whether Clark has said anything in this thread (or, with no thread, this space). */
export function clarkSpokeInThread(
  db: Database,
  input: { connectionRef: string; externalSpaceId: string; externalThreadId?: string },
): boolean {
  return (
    oneRow<{ found: number }>(
      db,
      `SELECT 1 AS found FROM external_message_links
        WHERE connection_ref = ? AND external_space_id = ? AND external_thread_id = ? AND direction = 'outbound' LIMIT 1`,
      input.connectionRef,
      input.externalSpaceId,
      threadKey(input.externalThreadId),
    ) !== undefined
  );
}

/* ------------------------------------------------------------------ *
 * Channel inputs: the channel branch's record of each recorded channel message
 * ------------------------------------------------------------------ */

export type ChannelInputState =
  | "pending"
  | "queued"
  | "started"
  | "answered"
  | "coalesced"
  | "context"
  | "context-expired"
  | "ignored"
  | "interrupted"
  | "dropped"
  | "failed";

export interface ChannelInputRecord {
  signalId: string;
  connectionRef: string;
  bindingId?: string;
  /** Binding and thread together: what is serialized and coalesced as one stream of talk. */
  threadKey: string;
  state: ChannelInputState;
  reason?: string;
  /** The input whose turn answered this one, when it was coalesced into it. */
  leadSignalId?: string;
  /** The Clark user message the turn appended. */
  messageId?: string;
  receivedAt: Instant;
  updatedAt: Instant;
}

interface InputRow {
  signal_id: string;
  connection_ref: string;
  binding_id: string | null;
  thread_key: string;
  state: string;
  reason: string | null;
  lead_signal_id: string | null;
  message_id: string | null;
  received_at: string;
  updated_at: string;
}

function inputFromRow(row: InputRow): ChannelInputRecord {
  return {
    signalId: row.signal_id,
    connectionRef: row.connection_ref,
    ...(row.binding_id === null ? {} : { bindingId: row.binding_id }),
    threadKey: row.thread_key,
    state: row.state as ChannelInputState,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.lead_signal_id === null ? {} : { leadSignalId: row.lead_signal_id }),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    receivedAt: row.received_at as Instant,
    updatedAt: row.updated_at as Instant,
  };
}

/** Record that the channel branch has a message to route. Once per signal: a redelivery records nothing. */
export function recordChannelInput(
  db: Database,
  input: { signalId: string; connectionRef: string; threadKey: string; receivedAt: Instant },
): boolean {
  const result = db
    .prepare(
      `INSERT INTO channel_inputs (signal_id, connection_ref, thread_key, state, received_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(signal_id) DO NOTHING`,
    )
    .run(input.signalId, input.connectionRef, input.threadKey, input.receivedAt, input.receivedAt);
  return Number(result.changes) === 1;
}

export function getChannelInput(db: Database, signalId: string): ChannelInputRecord | undefined {
  const row = oneRow<InputRow>(db, "SELECT * FROM channel_inputs WHERE signal_id = ?", signalId);
  return row === undefined ? undefined : inputFromRow(row);
}

/** Inputs in any of these states, oldest first. */
export function channelInputsInState(db: Database, states: readonly ChannelInputState[], limit = 200): ChannelInputRecord[] {
  if (states.length === 0) return [];
  return allRows<InputRow>(
    db,
    `SELECT * FROM channel_inputs WHERE state IN (${states.map(() => "?").join(", ")})
      ORDER BY received_at ASC, signal_id ASC LIMIT ?`,
    ...states,
    limit,
  ).map(inputFromRow);
}

export function updateChannelInput(
  db: Database,
  signalId: string,
  change: {
    state: ChannelInputState;
    at: Instant;
    reason?: string;
    bindingId?: string;
    leadSignalId?: string;
    messageId?: string;
  },
): void {
  db.prepare(
    `UPDATE channel_inputs SET state = ?, updated_at = ?,
       reason = COALESCE(?, reason), binding_id = COALESCE(?, binding_id),
       lead_signal_id = COALESCE(?, lead_signal_id), message_id = COALESCE(?, message_id)
     WHERE signal_id = ?`,
  ).run(
    change.state,
    change.at,
    change.reason ?? null,
    change.bindingId ?? null,
    change.leadSignalId ?? null,
    change.messageId ?? null,
    signalId,
  );
}

/**
 * The newest context-only inputs of a binding, oldest first. `since`, when given, leaves out anything received before
 * it: talk from hours ago is not what a new message is about.
 */
export function channelContextJournal(db: Database, bindingId: string, limit: number, since?: Instant): ChannelInputRecord[] {
  if (limit <= 0) return [];
  return allRows<InputRow>(
    db,
    `SELECT * FROM channel_inputs WHERE binding_id = ? AND state = 'context' AND received_at >= ?
      ORDER BY received_at DESC, signal_id DESC LIMIT ?`,
    bindingId,
    since ?? "",
    limit,
  )
    .map(inputFromRow)
    .reverse();
}

/** Keep a binding's context journal to its newest `keep` entries; older ones are marked expired. */
export function trimChannelContextJournal(db: Database, bindingId: string, keep: number, at: Instant): number {
  const result = db
    .prepare(
      `UPDATE channel_inputs SET state = 'context-expired', updated_at = ?
        WHERE binding_id = ? AND state = 'context' AND signal_id NOT IN (
          SELECT signal_id FROM channel_inputs WHERE binding_id = ? AND state = 'context'
           ORDER BY received_at DESC, signal_id DESC LIMIT ?)`,
    )
    .run(at, bindingId, bindingId, Math.max(0, keep));
  return Number(result.changes);
}

/* ------------------------------------------------------------------ *
 * Delivery receipts
 * ------------------------------------------------------------------ */

/**
 * Record an outbound operation under its idempotency key, or answer the one already recorded under it. The second
 * caller learns what became of the first rather than sending again.
 */
export function claimChannelDeliveryReceipt(
  db: Database,
  receipt: ChannelDeliveryReceipt,
): { created: boolean; receipt: ChannelDeliveryReceipt } {
  const result = db
    .prepare(
      `INSERT INTO channel_delivery_receipts
         (receipt_id, idempotency_key, connection_ref, conversation_id, message_id, state, document, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .run(
      receipt.receiptId,
      receipt.idempotencyKey,
      receipt.connectionRef,
      receipt.conversationId,
      receipt.messageId ?? null,
      receipt.state,
      toJson(receipt),
      receipt.createdAt,
      receipt.updatedAt,
    );
  if (Number(result.changes) === 1) return { created: true, receipt };
  const existing = getChannelDeliveryReceipt(db, receipt.idempotencyKey);
  if (existing === undefined) throw new Error(`delivery receipt ${receipt.idempotencyKey} vanished while it was claimed`);
  return { created: false, receipt: existing };
}

export function updateChannelDeliveryReceipt(db: Database, receipt: ChannelDeliveryReceipt): void {
  db.prepare("UPDATE channel_delivery_receipts SET state = ?, document = ?, updated_at = ? WHERE receipt_id = ?").run(
    receipt.state,
    toJson(receipt),
    receipt.updatedAt,
    receipt.receiptId,
  );
}

export function getChannelDeliveryReceipt(db: Database, idempotencyKey: string): ChannelDeliveryReceipt | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM channel_delivery_receipts WHERE idempotency_key = ?",
    idempotencyKey,
  );
  return row === undefined ? undefined : parseJson<ChannelDeliveryReceipt>(row.document, "channel_delivery_receipts.document");
}

/** Receipts of the operations that delivered one Clark message. */
export function channelDeliveryReceiptsForMessage(db: Database, messageId: string): ChannelDeliveryReceipt[] {
  return allRows<{ document: string }>(
    db,
    "SELECT document FROM channel_delivery_receipts WHERE message_id = ? ORDER BY created_at",
    messageId,
  ).map((row) => parseJson<ChannelDeliveryReceipt>(row.document, "channel_delivery_receipts.document"));
}

/** Receipts of a conversation written at or after `since`, oldest first: what one turn's replies became. */
export function channelDeliveryReceiptsSince(db: Database, conversationId: string, since: Instant, limit = 200): ChannelDeliveryReceipt[] {
  return allRows<{ document: string }>(
    db,
    "SELECT document FROM channel_delivery_receipts WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at LIMIT ?",
    conversationId,
    since,
    limit,
  ).map((row) => parseJson<ChannelDeliveryReceipt>(row.document, "channel_delivery_receipts.document"));
}

/** Receipts in one state, oldest first: what a node that stopped mid-send finds again. */
export function channelDeliveryReceiptsInState(
  db: Database,
  state: ChannelDeliveryReceipt["state"],
  limit = 200,
): ChannelDeliveryReceipt[] {
  return allRows<{ document: string }>(
    db,
    "SELECT document FROM channel_delivery_receipts WHERE state = ? ORDER BY created_at LIMIT ?",
    state,
    limit,
  ).map((row) => parseJson<ChannelDeliveryReceipt>(row.document, "channel_delivery_receipts.document"));
}
