import {
  CHANNEL_TEXT_MAX,
  type ChannelBinding,
  type ChannelDeliveryReceipt,
  type ChannelReplyRoute,
  type ChannelSendOutcome,
  type Instant,
  type MessageRecord,
} from "@clarkcant/contracts";
import { channelReplyText, decideChannelReply, readExecutionPolicy, recordEffectExecution, splitChannelText } from "@clarkcant/core";
import {
  claimChannelDeliveryReceipt,
  getExternalConnection,
  recordExternalMessageLink,
  updateChannelDeliveryReceipt,
} from "@clarkcant/storage";

import { type OpenedActionEffect, effectOperationDigest, openActionEffect, settleActionEffect } from "../application/action-effects.ts";
import { type ChannelNotSentCause, ownerHostText } from "../host-text.ts";
import { appendHostReply } from "../routes/conversations.ts";
import type { NodeServices } from "../services.ts";
import type { ChannelAdapterRegistry } from "./channel-adapter-registry.ts";

/**
 * Clark's reply, carried back to the route the message came in on.
 *
 * The turn wrote an ordinary message and knows nothing about where it goes; this sends it. Each piece is one
 * `communication` effect through the same path every outbound effect takes:
 *
 *   1. a receipt claimed under the piece's idempotency key — a second attempt finds it and sends nothing;
 *   2. the execution policy (`decideChannelReply`): a reply on the bound route is the conversation itself, unless the
 *      owner refused or asked to be asked about communication;
 *   3. an audit entry, and the effect written as handed off before the adapter is called (`openActionEffect`);
 *   4. settled on what the adapter answered: sent, not sent, or — on anything it cannot promise — unknown. An unknown
 *      send is never retried; the effect ledger asks the person whether it arrived, the same as any other — and when
 *      the ledger could not record it, the conversation says so instead of promising a question that will not come.
 *
 * A reply that is not sent stays in the conversation, and the conversation names what stopped it: the connection, the
 * missing connector, the owner's policy, the provider, or the ledger.
 */

export interface ChannelReplyDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "search">;
  registry: ChannelAdapterRegistry;
  now: () => Instant;
}

/** The capability an outbound channel operation is recorded under in the effect ledger. */
export function channelCapabilityRef(provider: string, operation: "send"): string {
  return `channel.${provider}.${operation}`;
}

function firstWords(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export async function deliverChannelReply(
  deps: ChannelReplyDeps,
  input: { route: ChannelReplyRoute; binding: ChannelBinding; message: MessageRecord },
): Promise<ChannelDeliveryReceipt[]> {
  const { services } = deps;
  const db = services.runtime.db;
  const text = channelReplyText(input.message.blocks);
  if (text === "") return [];
  const connection = getExternalConnection(db, input.route.address.connectionRef);
  const adapter = connection === undefined ? undefined : deps.registry.get(connection.provider);
  const provider = connection?.provider ?? input.binding.provider;
  const words = ownerHostText(services.runtime).channels;
  const ownerPrincipalId = services.runtime.identity.ownerPrincipalId;

  const capabilities = adapter?.capabilities();
  const limit = Math.min(capabilities?.maxTextLength ?? CHANNEL_TEXT_MAX, CHANNEL_TEXT_MAX);
  const format = capabilities?.richText === true ? "markdown" : "plain";
  const pieces = splitChannelText(text, limit);
  const receipts: ChannelDeliveryReceipt[] = [];

  for (const [index, piece] of pieces.entries()) {
    const at = deps.now();
    const idempotencyKey = `reply:${input.message.messageId}:${String(index)}`;
    const claimed = claimChannelDeliveryReceipt(db, {
      receiptId: services.conductor.newId("rcpt"),
      connectionRef: input.route.address.connectionRef,
      bindingId: input.binding.bindingId,
      operation: "send",
      idempotencyKey,
      state: "pending",
      conversationId: input.message.conversationId,
      messageId: input.message.messageId,
      createdAt: at,
      updatedAt: at,
    });
    // Already handled by an earlier attempt: whatever became of it stands, and nothing is sent twice.
    if (!claimed.created) {
      receipts.push(claimed.receipt);
      if (claimed.receipt.state !== "sent") break;
      continue;
    }
    const settle = (change: Partial<ChannelDeliveryReceipt> & Pick<ChannelDeliveryReceipt, "state">): ChannelDeliveryReceipt => {
      const next = { ...claimed.receipt, ...change, updatedAt: deps.now() };
      updateChannelDeliveryReceipt(db, next);
      receipts.push(next);
      return next;
    };

    if (connection === undefined || adapter === undefined || connection.state === "revoked") {
      const cause: ChannelNotSentCause =
        connection === undefined ? { kind: "connection-gone" } : connection.state === "revoked" ? { kind: "revoked" } : { kind: "no-adapter" };
      const reason =
        cause.kind === "connection-gone"
          ? "the channel connection is gone"
          : cause.kind === "revoked"
            ? "the channel connection was revoked"
            : `this node has no ${provider} adapter`;
      settle({ state: "failed", reason });
      appendHostReply(services, { conversationId: input.message.conversationId, text: words.replyNotSent(provider, cause), at: deps.now() });
      break;
    }

    // Only the first piece answers the message; the rest follow it in the same place.
    const { replyToExternalMessageId: _answered, ...unanswering } = input.route.address;
    const address = index === 0 ? input.route.address : unanswering;
    const args = { address, idempotencyKey };
    const capabilityRef = channelCapabilityRef(provider, "send");
    const operationDigest = effectOperationDigest(capabilityRef, args);
    const policy = readExecutionPolicy({ db, now: deps.now }, ownerPrincipalId);
    const decision = decideChannelReply(policy, operationDigest);
    if (decision.kind !== "execute") {
      settle({ state: decision.kind === "ask" ? "held" : "refused", reason: decision.reason });
      appendHostReply(services, {
        conversationId: input.message.conversationId,
        text: words.replyNotSent(provider, { kind: "policy", reason: decision.reason }),
        at: deps.now(),
      });
      break;
    }

    recordEffectExecution(
      { db, nodeId: services.runtime.identity.nodeId, now: deps.now, newId: services.conductor.newId },
      {
        principalId: ownerPrincipalId,
        mode: policy.mode,
        decision,
        category: "communication",
        operationDigest,
        conversationId: input.message.conversationId,
        description: `reply on ${provider}`,
        origin: "channel",
      },
    );
    let opened: OpenedActionEffect;
    try {
      opened = openActionEffect(services, {
        conversationId: input.message.conversationId,
        principalId: ownerPrincipalId,
        capabilityRef,
        args,
        intent: `Reply on ${provider}: “${firstWords(piece)}”`,
        effectCategory: "communication",
      });
    } catch (cause) {
      // A send the ledger cannot hold is not made, and the conversation says so.
      settle({ state: "failed", reason: `the effect ledger could not record it: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 1000) });
      appendHostReply(services, { conversationId: input.message.conversationId, text: words.replyNotSent(provider, { kind: "ledger" }), at: deps.now() });
      break;
    }
    updateChannelDeliveryReceipt(db, { ...claimed.receipt, effectId: opened.effect.effectId, updatedAt: deps.now() });

    let outcome: ChannelSendOutcome | undefined;
    let failure: string | undefined;
    try {
      outcome = await adapter.send(address, { text: piece, format }, { idempotencyKey });
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    if (outcome?.status === "sent") {
      settleActionEffect(services, opened, { kind: "answered", evidence: `${provider} accepted it` });
      recordExternalMessageLink(db, {
        connectionRef: connection.connectionRef,
        provider,
        externalSpaceId: address.externalSpaceId,
        ...((outcome.externalThreadId ?? address.externalThreadId) === undefined
          ? {}
          : { externalThreadId: outcome.externalThreadId ?? address.externalThreadId }),
        externalMessageId: outcome.externalMessageId,
        conversationId: input.message.conversationId,
        messageId: input.message.messageId,
        direction: "outbound",
        createdAt: deps.now(),
      });
      settle({ state: "sent", effectId: opened.effect.effectId, externalMessageId: outcome.externalMessageId });
      continue;
    }
    if (outcome?.status === "not-sent") {
      settleActionEffect(services, opened, { kind: "not-sent", reason: outcome.reason });
      settle({ state: "failed", effectId: opened.effect.effectId, reason: outcome.reason.slice(0, 1000) });
      appendHostReply(services, {
        conversationId: input.message.conversationId,
        text: words.replyNotSent(provider, { kind: "provider", reason: outcome.reason.slice(0, 300) }),
        at: deps.now(),
      });
      break;
    }
    const reason = `no answer from ${provider}: ${failure ?? "the adapter returned nothing"}`.slice(0, 1000);
    // Whether the ledger holds it as unknown decides what the person is told: only a recorded one is asked about.
    const { recorded } = settleActionEffect(services, opened, { kind: "no-answer", stopped: false, reason });
    settle({ state: "unknown", effectId: opened.effect.effectId, reason });
    appendHostReply(services, { conversationId: input.message.conversationId, text: words.replyUnknown(provider, recorded), at: deps.now() });
    break;
  }
  return receipts;
}
