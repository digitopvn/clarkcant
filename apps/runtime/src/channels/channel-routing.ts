import { type ChannelEvent, type Instant, channelEventSchema } from "@clarkcant/contracts";
import { routeChannelEvent } from "@clarkcant/core";
import {
  type ChannelInputRecord,
  type Database,
  channelInputsInState,
  clarkSpokeInThread,
  ensureExternalIdentity,
  findChannelBinding,
  findExternalMessageLink,
  getExternalConnection,
  getSignalDelivery,
  transaction,
  trimChannelContextJournal,
  updateChannelInput,
} from "@clarkcant/storage";

/**
 * The channel-input branch's first step: each recorded channel message routed once, from what is written down.
 *
 * Synchronous and per input, so a node that stops halfway routes the rest on its next pass and none twice: an input
 * leaves `pending` in the same write that says where it went.
 */

export interface ChannelRoutingDeps {
  db: Database;
  now: () => Instant;
  newId: (prefix: string) => string;
}

/** The provider-neutral event a recorded input carries, read back from the intake's own record of it. */
export function channelEventOf(db: Database, signalId: string): ChannelEvent | undefined {
  const payload = getSignalDelivery(db, signalId)?.signal.payload;
  const parsed = channelEventSchema.safeParse(payload?.event);
  return parsed.success ? parsed.data : undefined;
}

/** The principal a sender is, created the first time they write: identity is provenance, never a gate. */
export function actorPrincipalFor(deps: ChannelRoutingDeps, connectionRef: string, event: ChannelEvent): string {
  return ensureExternalIdentity(deps.db, {
    connectionRef: connectionRef as never,
    externalActorId: event.actor.externalActorId,
    principalId: deps.newId("prin"),
    ...(event.actor.displayName === undefined ? {} : { displayName: event.actor.displayName }),
    linkedAt: deps.now(),
  }).principalId;
}

export interface RoutedSummary {
  turns: number;
  context: number;
  ignored: number;
  failed: number;
}

export function routePendingChannelInputs(deps: ChannelRoutingDeps, limit = 100): RoutedSummary {
  const summary: RoutedSummary = { turns: 0, context: 0, ignored: 0, failed: 0 };
  for (const input of channelInputsInState(deps.db, ["pending"], limit)) {
    try {
      routeOne(deps, input, summary);
    } catch (cause) {
      summary.failed += 1;
      updateChannelInput(deps.db, input.signalId, {
        state: "failed",
        at: deps.now(),
        reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000),
      });
    }
  }
  return summary;
}

function routeOne(deps: ChannelRoutingDeps, input: ChannelInputRecord, summary: RoutedSummary): void {
  const at = deps.now();
  const event = channelEventOf(deps.db, input.signalId);
  const connection = getExternalConnection(deps.db, input.connectionRef);
  if (event === undefined || connection === undefined) {
    summary.ignored += 1;
    updateChannelInput(deps.db, input.signalId, {
      state: "ignored",
      at,
      reason: event === undefined ? "the recorded event is not one this node can read" : "the connection is gone",
    });
    return;
  }
  const where = { connectionRef: connection.connectionRef, externalSpaceId: event.space.externalSpaceId };
  const sentByClark =
    findExternalMessageLink(deps.db, { ...where, externalMessageId: event.externalMessageId, direction: "outbound" }) !== undefined;
  const repliesToClark =
    event.replyToExternalMessageId !== undefined &&
    findExternalMessageLink(deps.db, { ...where, externalMessageId: event.replyToExternalMessageId, direction: "outbound" }) !== undefined;
  const binding = findChannelBinding(deps.db, {
    ...where,
    ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
  });
  // A sender is mapped to a principal only once a bound space hears from them; an unbound space keeps no one.
  const actorPrincipalId = binding === undefined ? "" : actorPrincipalFor(deps, connection.connectionRef, event);
  const decision = routeChannelEvent({
    event,
    connection,
    binding,
    actorPrincipalId,
    sentByClark,
    repliesToClark,
    clarkInThread: clarkSpokeInThread(deps.db, {
      ...where,
      ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
    }),
  });

  if (decision.route === "ignore" || binding === undefined) {
    summary.ignored += 1;
    updateChannelInput(deps.db, input.signalId, { state: "ignored", at, reason: decision.because });
    return;
  }
  if (decision.route === "context") {
    summary.context += 1;
    transaction(deps.db, () => {
      updateChannelInput(deps.db, input.signalId, { state: "context", at, reason: decision.because, bindingId: binding.bindingId });
      trimChannelContextJournal(deps.db, binding.bindingId, binding.attentionPolicy.contextJournalLimit, at);
    });
    return;
  }
  summary.turns += 1;
  updateChannelInput(deps.db, input.signalId, { state: "queued", at, reason: decision.because, bindingId: binding.bindingId });
}
