import { z } from "zod";

import { instantSchema, sequenceSchema } from "./primitives.ts";

/**
 * Command and event envelopes.
 *
 * A command is an intent from an authenticated principal. An event is a durable
 * fact about what already happened. They are separate types because conflating
 * them is how a replayed event gets mistaken for a fresh instruction.
 *
 * Neither envelope carries a caller identity: the gateway attaches the verified
 * principal after authentication. A payload that claims who it is from is data,
 * not authority.
 */

export const commandKindSchema = z.enum([
  "conversation.message",
  "task.create",
  "task.cancel",
  "task.pause",
  "task.resume",
  "task.status",
  "approval.decide",
  "capability.discover",
  "install.plan.create",
  "install.consent",
  "install.cancel",
  "install.activate",
  "install.rollback",
  "connection.begin",
  "connection.complete",
  "connection.revoke",
  "widget.instance.create",
  "widget.action.invoke",
  "widget.pin",
  "widget.unpin",
  "widget.state.update",
  "peer.pair.begin",
  "peer.pair.complete",
  "peer.revoke",
  "delegation.create",
  "delegation.cancel",
  "artifact.transfer",
  "automation.observe",
  "automation.act",
  "automation.stop",
  "voice.session.begin",
  "voice.session.end",
  "preference.set",
  "preference.undo",
  "onboarding.checkpoint",
  "emergency.stop",
]);
export type CommandKind = z.infer<typeof commandKindSchema>;

/**
 * Durable idempotency key. Senders persist the intent before transmitting and
 * reuse the same key on retry, so a lost acknowledgement cannot become a second
 * logical task (acceptance test T01).
 */
export const idempotencyKeySchema = z.string().min(8).max(160);

export const commandEnvelopeSchema = z.strictObject({
  schema: z.literal("agent.command"),
  /** Envelope revision, independent of the app release. */
  version: z.literal(1),
  commandId: z.string().min(1).max(128),
  /**
   * Groups retries of one logical operation. Equal `idempotencyKey` plus equal
   * payload digest is a retry; a different payload under the same key is a
   * programming error and is rejected rather than silently re-run.
   */
  idempotencyKey: idempotencyKeySchema,
  kind: commandKindSchema,
  /** Conversation this command belongs to, when conversation-scoped. */
  conversationId: z.string().min(1).max(128).optional(),
  /** Task this command targets, when task-scoped. */
  taskId: z.string().min(1).max(128).optional(),
  /**
   * Task revision the caller believed it was acting on. A mismatch means the
   * caller is working from a stale view and must re-read before acting (T27).
   */
  expectedTaskRevision: z.int().nonnegative().optional(),
  /** Command body. Validated per kind by the gateway before any effect. */
  payload: z.record(z.string(), z.unknown()),
  issuedAt: instantSchema,
  /** Client-supplied correlation for progress reporting. */
  clientTraceId: z.string().min(1).max(128).optional(),
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** Acknowledgement returned once the command is durable, before it is executed. */
export const commandAckSchema = z.strictObject({
  commandId: z.string().min(1).max(128),
  acceptedAt: instantSchema,
  /** True when this exact command was already committed and is being replayed. */
  duplicate: z.boolean(),
  /** Durable ordinal assigned by the home node's event log. */
  acceptedSequence: sequenceSchema,
  /** Task created or targeted by this command, if any. */
  taskId: z.string().min(1).max(128).optional(),
  /** Set when the command was accepted in a degraded mode that the UI must show. */
  degraded: z
    .strictObject({ code: z.string().min(1).max(120), message: z.string().min(1).max(500) })
    .optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

export const eventKindSchema = z.enum([
  "task.created",
  "task.state_changed",
  "task.revision_changed",
  "run.started",
  "run.progress",
  "run.finished",
  "evidence.recorded",
  "effect.recorded",
  "effect.uncertain",
  "approval.requested",
  "approval.decided",
  "input.requested",
  "input.provided",
  "capability.state_changed",
  "install.progress",
  "install.completed",
  "connection.state_changed",
  "widget.instance_changed",
  "widget.snapshot_captured",
  "pin.changed",
  "artifact.available",
  "delegation.updated",
  "peer.state_changed",
  "automation.observation",
  "automation.action_result",
  "voice.transcript",
  "voice.state_changed",
  "budget.warning",
  "emergency.stopped",
]);
export type EventKind = z.infer<typeof eventKindSchema>;

export const eventEnvelopeSchema = z.strictObject({
  schema: z.literal("agent.event"),
  version: z.literal(1),
  eventId: z.string().min(1).max(128),
  kind: eventKindSchema,
  /** Node that authored this event. Provenance is never rewritten downstream. */
  sourceNodeId: z.string().min(1).max(128),
  /**
   * Monotonic per (sourceNodeId, stream) counter. A gap is a sign of loss; a
   * regression is rejected. Ordering across nodes is never inferred from clocks.
   */
  sourceSequence: sequenceSchema,
  /** Stream this sequence belongs to, e.g. `task` or `conversation`. */
  stream: z.string().min(1).max(80),
  conversationId: z.string().min(1).max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  runId: z.string().min(1).max(128).optional(),
  /** Event that directly caused this one, for causal reconstruction. */
  causedByEventId: z.string().min(1).max(128).optional(),
  /** Command that caused this event, so a client can join ack to outcome. */
  causedByCommandId: z.string().min(1).max(128).optional(),
  occurredAt: instantSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * Recovery snapshot returned to a reconnecting client.
 *
 * `cursor` is the last node event sequence the client has already applied. The
 * client re-applies from there, so reconnect is a bounded replay rather than a
 * guess about how much was lost (`distributed-runtime.md` §7).
 */
export const conversationSnapshotSchema = z.strictObject({
  conversationId: z.string().min(1).max(128),
  cursor: sequenceSchema,
  /** Compact metadata only; message bodies are virtualized and paged. */
  metadata: z.strictObject({
    title: z.string().max(300).optional(),
    messageCount: z.int().nonnegative(),
    taskCount: z.int().nonnegative(),
    updatedAt: instantSchema,
  }),
  pinIds: z.array(z.string().min(1).max(128)).max(64),
  /** Tasks the client should show as in-flight, with their true state. */
  activeTaskIds: z.array(z.string().min(1).max(128)).max(256),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
