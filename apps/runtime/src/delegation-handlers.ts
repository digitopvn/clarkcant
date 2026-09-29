import type { Instant, PeerEnvelope } from "@clarkcant/contracts";

import { readOriginRemote } from "./automation-service.ts";
import { type DelegationDeps, receiveCancel, receiveDelegate, receiveResult, reportDelegatedOutcome } from "./delegation.ts";
import { tryRecordNodeNotice } from "./notices.ts";
import { appendHostReply } from "./routes/conversations.ts";
import type { DelegationHandlers } from "./routes/peers.ts";
import type { NodeServices } from "./services.ts";
import { taskDispatchReports } from "./task-reporting.ts";

/**
 * What a hand-over, its answer and a stop do on this node, built from the node's own services.
 *
 * Every answer queues an envelope back, so the outbox is woken after each one rather than on its next round.
 */

/** Per node, the tasks whose answer is being settled right now, across requests. */
const settlingByNode = new WeakMap<object, Set<string>>();

export function peerDelegationHandlers(services: NodeServices, now: () => Instant): DelegationHandlers {
  const { runtime, conductor } = services;
  const settling = settlingByNode.get(runtime.db) ?? new Set<string>();
  settlingByNode.set(runtime.db, settling);
  const deps: DelegationDeps = { db: runtime.db, identity: runtime.identity, now, newId: conductor.newId };
  const kick = (): void => services.peerDelivery?.kick();

  const tell = (text: string, conversationId?: string): void => {
    const at = now();
    if (conversationId !== undefined) appendHostReply(services, { conversationId, text, at });
    tryRecordNodeNotice(services, {
      sourceKind: "automation",
      category: "message",
      severity: "info",
      title: "Việc một node khác giao",
      body: text,
      ...(conversationId === undefined ? {} : { conversationId }),
      dedupKey: `delegation:${conductor.newId("say")}`,
      at,
    });
  };

  const answered = <T,>(outcome: T): T => {
    kick();
    return outcome;
  };

  return {
    delegate: (envelope: PeerEnvelope) =>
      answered(
        receiveDelegate(
          {
            ...deps,
            readRemote: readOriginRemote,
            startTask: (taskId, capabilityRef) => {
              conductor.runTask?.({ taskId, capabilityRef, executionNodeId: runtime.identity.nodeId });
            },
            tell,
          },
          envelope,
        ),
      ),
    result: (envelope: PeerEnvelope) =>
      answered(
        receiveResult(
          {
            db: runtime.db,
            nodeId: runtime.identity.nodeId,
            now,
            conductor,
            onSettled: taskDispatchReports(services).onSettled,
            settling,
          },
          envelope,
        ),
      ),
    cancel: (envelope: PeerEnvelope) => answered(receiveCancel(deps, envelope)),
  };
}

/**
 * Tell the peer that handed a task over that its outcome here is unknown, when this node lost track of it.
 *
 * Without it the peer's own task waits for an answer that never comes. Nothing for a task no peer handed over.
 */
export function answerUncertain(services: NodeServices, now: () => Instant): (taskId: string, message: string) => void {
  return (taskId, message) => {
    const { runtime, conductor } = services;
    const deps: DelegationDeps = { db: runtime.db, identity: runtime.identity, now, newId: conductor.newId };
    if (reportDelegatedOutcome(deps, { taskId, outcome: "uncertain", message })) services.peerDelivery?.kick();
  };
}
