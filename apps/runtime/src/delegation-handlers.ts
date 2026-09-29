import type { Instant, PeerEnvelope } from "@clarkcant/contracts";

import { readOriginRemote } from "./automation-service.ts";
import { type DelegationDeps, receiveCancel, receiveDelegate, receiveResult, reportDelegatedOutcome, settleUndelivered } from "./delegation.ts";
import type { DeadLetter } from "./peer-transport.ts";
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

export function peerDelegationHandlers(services: NodeServices, now: () => Instant): DelegationHandlers {
  const { runtime, conductor } = services;
  const deps: DelegationDeps = { db: runtime.db, identity: runtime.identity, now, newId: conductor.newId };
  const kick = (): void => services.peerDelivery?.kick();

  const tell = (text: string, about: string, conversationId?: string): void => {
    const at = now();
    if (conversationId !== undefined) appendHostReply(services, { conversationId, text, at });
    tryRecordNodeNotice(services, {
      sourceKind: "automation",
      category: "message",
      severity: "info",
      title: "Việc một node khác giao",
      body: text,
      ...(conversationId === undefined ? {} : { conversationId }),
      dedupKey: `delegation:${about}`,
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
          },
          envelope,
        ),
      ),
    cancel: (envelope: PeerEnvelope) =>
      answered(receiveCancel({ ...deps, ...(services.taskDispatch === undefined ? {} : { taskDispatch: services.taskDispatch }) }, envelope)),
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

/**
 * Settle the task a hand-over or a stop was about, when this node gave up delivering it to the peer.
 *
 * Without it the task waits for an answer the peer never had the chance to give.
 */
export function settleUndeliveredTasks(services: NodeServices, now: () => Instant): (letter: DeadLetter) => void {
  return (letter) => {
    const { runtime, conductor } = services;
    settleUndelivered(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now, conductor, onSettled: taskDispatchReports(services).onSettled },
      letter,
    );
  };
}