import {
  CHANNEL_CONTRACT_VERSION,
  type ChannelBinding,
  type ChannelEvent,
  type ChannelReplyRoute,
  type Instant,
  type MessageRecord,
} from "@clarkcant/contracts";
import { channelTurnData, coalescedTurnText, handleUserMessage } from "@clarkcant/core";
import {
  type ChannelInputRecord,
  channelContextJournal,
  findExternalMessageLink,
  getExternalConnection,
  getExternalIdentity,
  recordExternalMessageLink,
  transaction,
  updateChannelInput,
} from "@clarkcant/storage";

import type { NodeServices } from "../services.ts";
import { indexMessages } from "../session-search.ts";
import type { ChannelAdapterRegistry } from "./channel-adapter-registry.ts";
import { deliverChannelReply } from "./channel-reply-delivery.ts";
import { channelEventOf } from "./channel-routing.ts";

/**
 * One Clark turn for what someone said on a channel.
 *
 * The same turn a message typed into the page gets — `handleUserMessage`, the same model, tools and policy — with
 * three things only the host knows: who wrote it (`authorPrincipalId`), that it came from a channel (`origin`), and a
 * few lines of data saying where and what was said around it. Several lines one person sent in a burst are one
 * message and one turn. The reply route is recorded before the turn runs, and every reply the turn writes is carried
 * back along it (`deliverChannelReply`); the turn never sees a provider id.
 *
 * The inputs are marked started (and the rest of the burst coalesced into the first) before anything runs, so a node
 * that stops mid-turn finds them started and never answers them twice.
 */

export interface ChannelTurnDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "search">;
  registry: ChannelAdapterRegistry;
  now: () => Instant;
}

export interface QueuedBurst {
  binding: ChannelBinding;
  inputs: readonly ChannelInputRecord[];
  events: readonly ChannelEvent[];
  actorPrincipalId: string;
}

export async function runChannelTurn(deps: ChannelTurnDeps, burst: QueuedBurst): Promise<void> {
  const { services } = deps;
  const db = services.runtime.db;
  const [lead, ...rest] = burst.inputs;
  const first = burst.events[0];
  const last = burst.events[burst.events.length - 1];
  if (lead === undefined || first === undefined || last === undefined) return;
  const startedAt = deps.now();
  transaction(db, () => {
    updateChannelInput(db, lead.signalId, { state: "started", at: startedAt });
    for (const input of rest) updateChannelInput(db, input.signalId, { state: "coalesced", at: startedAt, leadSignalId: lead.signalId });
  });

  const binding = burst.binding;
  const connection = getExternalConnection(db, binding.connectionRef);
  const where = { connectionRef: binding.connectionRef, externalSpaceId: first.space.externalSpaceId };
  const answered =
    last.replyToExternalMessageId === undefined
      ? undefined
      : findExternalMessageLink(db, { ...where, externalMessageId: last.replyToExternalMessageId });
  const senderName = (actorId: string, fallback: string | undefined): string | undefined =>
    getExternalIdentity(db, binding.connectionRef, actorId)?.displayName ?? fallback;
  const context = channelContextJournal(db, binding.bindingId, binding.attentionPolicy.contextJournalLimit).flatMap((entry) => {
    const event = channelEventOf(db, entry.signalId);
    return event === undefined ? [] : [{ senderName: senderName(event.actor.externalActorId, event.actor.displayName), text: event.content.text }];
  });
  const address = {
    connectionRef: binding.connectionRef,
    externalSpaceId: last.space.externalSpaceId,
    ...(last.externalThreadId === undefined ? {} : { externalThreadId: last.externalThreadId }),
    replyToExternalMessageId: last.externalMessageId,
  };
  let accepted: MessageRecord | undefined;

  try {
    const adapter = connection === undefined ? undefined : deps.registry.get(connection.provider);
    // Best effort: a typing indicator that does not arrive changes nothing.
    if (adapter?.typing !== undefined && adapter.capabilities().typing === true) void adapter.typing(address).catch(() => undefined);

    const outcome = await handleUserMessage(services.conductor, {
      conversationId: binding.conversationId as never,
      principal: {
        principalId: services.runtime.identity.ownerPrincipalId as never,
        kind: "user",
        nodeId: services.runtime.identity.nodeId as never,
      },
      text: coalescedTurnText(burst.events),
      at: deps.now(),
      origin: "channel",
      authorPrincipalId: burst.actorPrincipalId,
      ...(answered === undefined ? {} : { inReplyToMessageId: answered.messageId }),
      // Always present, which also keeps the message from being steered into another thread's running turn: its reply
      // has to come back here.
      data: channelTurnData({
        provider: binding.provider,
        spaceKind: binding.spaceKind,
        senderName: senderName(first.actor.externalActorId, first.actor.displayName),
        context,
      }),
      onAccepted: (message) => {
        accepted = message;
        transaction(db, () => {
          for (const event of burst.events) {
            recordExternalMessageLink(db, {
              connectionRef: binding.connectionRef,
              provider: binding.provider,
              externalSpaceId: event.space.externalSpaceId,
              ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
              externalMessageId: event.externalMessageId,
              conversationId: binding.conversationId,
              messageId: message.messageId,
              direction: "inbound",
              createdAt: deps.now(),
            });
          }
          updateChannelInput(db, lead.signalId, { state: "started", at: deps.now(), messageId: message.messageId });
        });
      },
    });
    indexMessages(services.search, {
      conversationId: binding.conversationId,
      messages: accepted === undefined ? outcome.messages : [accepted, ...outcome.messages],
      at: deps.now(),
    });

    const route: ChannelReplyRoute = {
      version: CHANNEL_CONTRACT_VERSION,
      bindingId: binding.bindingId,
      address,
      inboundMessageId: accepted?.messageId ?? lead.signalId,
      actorPrincipalId: burst.actorPrincipalId,
    };
    const states: string[] = [];
    for (const message of outcome.messages) {
      if (message.role !== "assistant") continue;
      const receipts = await deliverChannelReply(deps, { route, binding, message });
      states.push(...receipts.map((receipt) => receipt.state));
    }
    updateChannelInput(db, lead.signalId, {
      state: "answered",
      at: deps.now(),
      reason: `${outcome.resolution}${states.length === 0 ? "; nothing to send" : `; ${states.join(", ")}`}`.slice(0, 1000),
    });
  } catch (cause) {
    updateChannelInput(db, lead.signalId, {
      state: "failed",
      at: deps.now(),
      reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000),
    });
  }
}
