import type { Instant, PeerEnvelope } from "@clarkcant/contracts";
import { dismissNotificationsByKeyPrefix } from "@clarkcant/storage";

import { readOriginRemote } from "./automation-service.ts";
import { type ArtifactIntakeDeps, collectTaskArtifact, receiveArtifactOffer } from "./delegated-artifacts.ts";
import {
  type DelegationDeps,
  receiveCancel,
  receiveDelegate,
  receiveResult,
  receiveStatus,
  reportDelegatedOutcome,
  reportDelegatedStatus,
  settleLostResult,
  settleUndelivered,
} from "./delegation.ts";
import type { DeadLetter } from "./peer-transport.ts";
import { ownerHostText } from "./host-text.ts";
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

/** The dedup keys of the notices that say a task handed to a peer waits there: one per state and revision reported. */
function waitingNoticePrefix(taskId: string): string {
  return `delegation-status:${taskId}:`;
}

/**
 * Take the notice that a task waits on the other node's owner out of this node's inbox, once it no longer waits: they
 * allowed it, or an answer or a settlement ended it. The decision was theirs; this only stops saying it is pending.
 */
function clearWaitingNotice(services: Pick<NodeServices, "runtime">, taskId: string, at: Instant): void {
  try {
    dismissNotificationsByKeyPrefix(services.runtime.db, {
      principalId: services.runtime.identity.ownerPrincipalId,
      dedupKeyPrefix: waitingNoticePrefix(taskId),
      at,
    });
  } catch (cause) {
    process.stderr.write(`inbox: could not clear the waiting notice of ${taskId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

/**
 * Where the files a peer brings back for a task are fetched to, recorded and said: this node's data directory, and the
 * task's own conversation.
 */
export function artifactIntakeDeps(services: Pick<NodeServices, "runtime" | "conductor" | "search">, now: () => Instant): ArtifactIntakeDeps {
  const { runtime, conductor } = services;
  return {
    db: runtime.db,
    identity: runtime.identity,
    dataDir: runtime.dataDir,
    now,
    newId: conductor.newId,
    say: (conversationId, text, blocks = []) => {
      appendHostReply(services, {
        conversationId,
        blocks: [{ type: "text", format: "plain", content: text, streaming: false }, ...blocks],
        at: now(),
      });
    },
    words: () => ownerHostText(runtime).files,
  };
}

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
      title: ownerHostText(runtime).delegation.handOverNoticeTitle,
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
            say: ownerHostText(runtime),
          },
          envelope,
        ),
      ),
    result: (envelope: PeerEnvelope) => {
      const outcome = receiveResult(
        {
          db: runtime.db,
          nodeId: runtime.identity.nodeId,
          now,
          conductor,
          say: ownerHostText(runtime),
          onSettled: taskDispatchReports(services).onSettled,
        },
        envelope,
      );
      // Only an answer from the node the task was handed to ends its wait; anyone else's is refused above.
      if (outcome.accepted && envelope.taskId !== undefined) clearWaitingNotice(services, envelope.taskId, now());
      return answered(outcome);
    },
    cancel: (envelope: PeerEnvelope) =>
      answered(receiveCancel({ ...deps, ...(services.taskDispatch === undefined ? {} : { taskDispatch: services.taskDispatch }) }, envelope)),
    // Decided against this node's owner's grant for the task and recorded; nothing is sent back, so the outbox is not woken.
    offer: (envelope: PeerEnvelope) => receiveArtifactOffer({ db: runtime.db, identity: runtime.identity, now }, envelope),
    collect: (envelope: PeerEnvelope) => {
      const offered = envelope.payload["artifact"];
      const artifactId = offered !== null && typeof offered === "object" ? (offered as { artifactId?: unknown }).artifactId : undefined;
      if (envelope.taskId === undefined || typeof artifactId !== "string") return;
      void collectTaskArtifact(artifactIntakeDeps(services, now), envelope.taskId, artifactId);
    },
    // Nothing is sent back for this one, so the outbox is not woken.
    status: (envelope: PeerEnvelope) =>
      receiveStatus(
        {
          db: runtime.db,
          nodeId: runtime.identity.nodeId,
          say: ownerHostText(runtime),
          tell: ({ taskId, conversationId, text, about, waiting, title }) => {
            const at = now();
            appendHostReply(services, { conversationId, text, at });
            // Allowed there: it no longer waits, so the inbox stops saying it does.
            if (!waiting) {
              clearWaitingNotice(services, taskId, at);
              return;
            }
            // In the inbox too, for a person not looking at the conversation: the task is waiting on the other node.
            tryRecordNodeNotice(services, {
              sourceKind: "automation",
              category: "alert",
              severity: "info",
              title,
              body: text,
              conversationId,
              subject: { kind: "task", taskId, conversationId },
              dedupKey: `delegation-status:${about}`,
              at,
            });
          },
        },
        envelope,
      ),
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
    const settled = settleUndelivered(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now, conductor, say: ownerHostText(runtime), onSettled: taskDispatchReports(services).onSettled },
      letter,
    );
    if (settled && letter.taskId !== undefined) clearWaitingNotice(services, letter.taskId, now());
  };
}

/**
 * Settle the task a result was for, when the peer that ran it gave up delivering the result and skipped it.
 *
 * Without it the task waits for an answer that never comes.
 */
export function settleLostResults(services: NodeServices, now: () => Instant): (lost: { peerNodeId: string; taskId: string }) => boolean {
  return (lost) => {
    const { runtime, conductor } = services;
    const settled = settleLostResult(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now, conductor, say: ownerHostText(runtime), onSettled: taskDispatchReports(services).onSettled },
      lost,
    );
    if (settled) clearWaitingNotice(services, lost.taskId, now());
    return settled;
  };
}
/**
 * Tell the peer that handed a task over what this node's owner decided about the approval it waited for.
 *
 * Allowed, it goes on and the peer hears so. Refused or left until it expired, it ended here before its worker did
 * anything, and the peer's own task settles on that answer instead of waiting for one that never comes. Nothing for a
 * task no peer handed over.
 */
export function answerApprovalDecision(
  services: Pick<NodeServices, "runtime" | "conductor" | "peerDelivery">,
  now: () => Instant,
): (taskId: string, decision: "granted" | "denied" | "expired") => void {
  return (taskId, decision) => {
    const { runtime, conductor } = services;
    const deps: DelegationDeps = { db: runtime.db, identity: runtime.identity, now, newId: conductor.newId };
    const told =
      decision === "granted"
        ? reportDelegatedStatus(deps, { taskId, state: "running", message: "chủ của node này đã duyệt" })
        : reportDelegatedOutcome(deps, {
            taskId,
            outcome: "failed",
            ran: false,
            message:
              decision === "denied"
                ? "chủ của node này đã từ chối việc cần duyệt, nên không có gì được chạy"
                : "yêu cầu duyệt đã hết hạn mà chủ của node này chưa quyết định, nên không có gì được chạy",
          });
    if (told) services.peerDelivery?.kick();
  };
}