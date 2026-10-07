import type { ChannelDelivery, ChannelEvent, Instant } from "@clarkcant/contracts";
import { type ChannelInputRecord, channelInputsInState, getChannelBinding, updateChannelInput } from "@clarkcant/storage";

import { ownerHostText } from "../host-text.ts";
import { appendHostReply } from "../routes/conversations.ts";
import type { NodeServices } from "../services.ts";
import { type ChannelAdapterRegistry, createChannelAdapterRegistry } from "./channel-adapter-registry.ts";
import { type ChannelIntakeResult, receiveChannelDelivery } from "./channel-intake.ts";
import { recoverChannelWork } from "./channel-recovery.ts";
import { actorPrincipalFor, channelEventOf, routePendingChannelInputs } from "./channel-routing.ts";
import { type QueuedBurst, runChannelTurn } from "./channel-turn.ts";

/**
 * External messaging channels on this node: the host-managed service between the shared intake and the conversation.
 *
 * Owned by the node, not by any Pi session, so a channel keeps receiving while no turn runs. Every pass works only from
 * what is written down:
 *
 *   1. recorded channel messages are routed (`channel-routing.ts`): ignored, kept as context, or queued for a turn;
 *   2. a thread holding more queued messages than its binding allows drops the oldest, and the conversation says so;
 *   3. queued messages become turns: one person's burst in one thread is one turn once the thread has been quiet for
 *      the binding's burst window, and one conversation runs one channel turn at a time, oldest thread first.
 *
 * At start it settles what a previous process left: a message whose turn had started is marked interrupted (never
 * answered twice), and a reply handed off without an answer is unknown (never sent twice).
 */

export interface ChannelService {
  readonly registry: ChannelAdapterRegistry;
  /** A delivery from a connection's ingress: verified, recorded once, and routed soon after. */
  receive(connectionRef: string, delivery: ChannelDelivery): Promise<ChannelIntakeResult>;
  kick(): void;
  /** Resolves once nothing is waiting or running; for tests and an orderly stop. */
  idle(timeoutMs?: number): Promise<void>;
  stop(): void;
}

export type ChannelServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "automation">;

const DEFAULT_INTERVAL_MS = 30_000;

export function startChannelService(
  services: ChannelServices,
  options: { registry?: ChannelAdapterRegistry; now?: () => Instant; intervalMs?: number } = {},
): ChannelService {
  const registry = options.registry ?? createChannelAdapterRegistry();
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const db = services.runtime.db;
  const routing = { db, now, newId: services.conductor.newId };
  const busyConversations = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  let passing: Promise<void> | undefined;
  let again = false;
  let wake: NodeJS.Timeout | undefined;

  recoverChannelWork(services, now);

  const say = (conversationId: string, text: string): void => {
    try {
      appendHostReply(services, { conversationId, text, at: now() });
    } catch (cause) {
      process.stderr.write(`channels: could not write to conversation ${conversationId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  };

  const wakeAt = (dueMs: number): void => {
    if (stopped) return;
    const delay = Math.max(0, dueMs - Date.parse(now()));
    if (wake !== undefined) clearTimeout(wake);
    wake = setTimeout(() => {
      wake = undefined;
      service.kick();
    }, delay);
    wake.unref();
  };

  const queuedBursts = (): { due: QueuedBurst[]; nextDueMs: number | undefined } => {
    // Group queued messages by binding, thread and sender, oldest first; a burst is one sender's run in one thread.
    const groups = new Map<string, { inputs: ChannelInputRecord[]; events: ChannelEvent[]; actor: string; bindingId: string }>();
    for (const input of channelInputsInState(db, ["queued"], 500)) {
      const event = channelEventOf(db, input.signalId);
      if (event === undefined || input.bindingId === undefined) {
        updateChannelInput(db, input.signalId, { state: "failed", at: now(), reason: "the queued message could not be read back" });
        continue;
      }
      const key = JSON.stringify([input.bindingId, input.threadKey, event.actor.externalActorId]);
      const group = groups.get(key) ?? { inputs: [], events: [], actor: event.actor.externalActorId, bindingId: input.bindingId };
      group.inputs.push(input);
      group.events.push(event);
      groups.set(key, group);
    }
    const due: QueuedBurst[] = [];
    let nextDueMs: number | undefined;
    const current = Date.parse(now());
    for (const group of groups.values()) {
      const binding = getChannelBinding(db, group.bindingId);
      const lastInput = group.inputs[group.inputs.length - 1];
      const firstEvent = group.events[0];
      if (binding === undefined || lastInput === undefined || firstEvent === undefined) continue;
      const dueMs = Date.parse(lastInput.receivedAt) + binding.attentionPolicy.burstWindowMs;
      if (dueMs > current) {
        nextDueMs = nextDueMs === undefined ? dueMs : Math.min(nextDueMs, dueMs);
        continue;
      }
      due.push({
        binding,
        inputs: group.inputs,
        events: group.events,
        actorPrincipalId: actorPrincipalFor(routing, binding.connectionRef, firstEvent),
      });
    }
    return { due, nextDueMs };
  };

  /** A thread holding more turn-starting messages than its binding allows keeps the newest, and says so once. */
  const dropOverflow = (): void => {
    const byThread = new Map<string, ChannelInputRecord[]>();
    for (const input of channelInputsInState(db, ["queued"], 500)) {
      const key = JSON.stringify([input.bindingId, input.threadKey]);
      byThread.set(key, [...(byThread.get(key) ?? []), input]);
    }
    for (const inputs of byThread.values()) {
      const bindingId = inputs[0]?.bindingId;
      const binding = bindingId === undefined ? undefined : getChannelBinding(db, bindingId);
      if (binding === undefined) continue;
      const excess = inputs.length - binding.attentionPolicy.maxQueuedPerThread;
      if (excess <= 0) continue;
      for (const input of inputs.slice(0, excess)) {
        updateChannelInput(db, input.signalId, { state: "dropped", at: now(), reason: "more messages waited in this thread than it holds" });
      }
      say(binding.conversationId, ownerHostText(services.runtime).channels.dropped(binding.provider, excess));
    }
  };

  const pass = (): void => {
    routePendingChannelInputs(routing);
    dropOverflow();
    const { due, nextDueMs } = queuedBursts();
    // Oldest first, and one channel turn per conversation at a time.
    due.sort((left, right) => (left.inputs[0]?.receivedAt ?? "").localeCompare(right.inputs[0]?.receivedAt ?? ""));
    for (const burst of due) {
      const conversationId = burst.binding.conversationId;
      if (stopped || busyConversations.has(conversationId)) continue;
      busyConversations.add(conversationId);
      const running = runChannelTurn({ services, registry, now }, burst)
        .catch((cause: unknown) => {
          process.stderr.write(`channels: a turn failed (${cause instanceof Error ? cause.message : String(cause)})\n`);
        })
        .finally(() => {
          busyConversations.delete(conversationId);
          inflight.delete(running);
          service.kick();
        });
      inflight.add(running);
    }
    if (nextDueMs !== undefined) wakeAt(nextDueMs);
  };

  const runPass = (): Promise<void> => {
    if (passing !== undefined) {
      again = true;
      return passing;
    }
    passing = (async () => {
      do {
        again = false;
        try {
          pass();
        } catch (cause) {
          process.stderr.write(`channels: pass failed (${cause instanceof Error ? cause.message : String(cause)})\n`);
        }
        // Yield between passes so a kick that arrived during one is answered by the next.
        await Promise.resolve();
      } while (again && !stopped);
    })().finally(() => {
      passing = undefined;
    });
    return passing;
  };

  const timer = setInterval(() => void runPass(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();

  const service: ChannelService = {
    registry,
    async receive(connectionRef, delivery) {
      const result = await receiveChannelDelivery(
        { deps: { db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId }, registry },
        { connectionRef, delivery },
      );
      if (result.ok && result.recorded > 0) {
        service.kick();
        // The same record is a signal: a standing request on `channel.message.received` is matched like any other.
        services.automation?.kick();
      }
      return result;
    },
    kick() {
      if (stopped) return;
      setImmediate(() => void runPass());
    },
    async idle(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await runPass();
        await Promise.all([...inflight]);
        const waiting = channelInputsInState(db, ["pending", "queued"], 1).length > 0;
        if (!waiting && inflight.size === 0 && passing === undefined) return;
        if (Date.now() > deadline) throw new Error("the channel service did not settle in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (wake !== undefined) clearTimeout(wake);
    },
  };
  return service;
}
