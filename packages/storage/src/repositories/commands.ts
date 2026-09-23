import {
  type CommandAck,
  type CommandEnvelope,
  type Instant,
  commandAckSchema,
} from "@clarkcant/contracts";

import { type Database, oneRow, parseJson, toJson, transaction } from "../db.ts";

import { asJsonValue, payloadDigest } from "./json.ts";

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
