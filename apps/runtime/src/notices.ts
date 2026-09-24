import type { Instant, NoticeCategory, NoticeSeverity, NoticeSourceKind } from "@clarkcant/contracts";
import { type Database, recordNotification } from "@clarkcant/storage";

/**
 * Writing a notice into the person's inbox, from anywhere on this node.
 *
 * The one door producers use, so the rules live in one place: the notice belongs to the node's owner, its id is
 * minted here, and its text is redacted and bounded by the repository before it is stored. A producer says *what
 * happened* and *what key identifies it*; it does not get to pick who reads it.
 *
 * A notice is a pointer and a sentence, never the result itself. The result of background work is a message in its
 * conversation, which is where the person reads it; the notice exists because nobody was looking at that
 * conversation when it arrived.
 *
 * `originNodeId` is here for the NodeLink path that does not exist yet: a peer's notice is recorded through this
 * same function, with the peer's message id as its dedup key, so at-least-once delivery lands once.
 */
export interface NoticeServices {
  runtime: { db: Database; identity: { ownerPrincipalId: string } };
  conductor: { newId: (prefix: string) => string };
}

export interface NodeNotice {
  sourceKind: NoticeSourceKind;
  category: NoticeCategory;
  severity: NoticeSeverity;
  title: string;
  body?: string;
  conversationId?: string;
  originNodeId?: string;
  dedupKey: string;
  at: Instant;
}

export function recordNodeNotice(services: NoticeServices, notice: NodeNotice): { notificationId: string; created: boolean } {
  return recordNotification(services.runtime.db, {
    notificationId: services.conductor.newId("ntf"),
    principalId: services.runtime.identity.ownerPrincipalId,
    ...notice,
  });
}

/**
 * The same, for a producer that must not fail because the inbox did.
 *
 * Background work has already finished and written its result into the conversation by the time this runs. A
 * notice that could not be written is a missed pointer, not a lost result, so it is reported on stderr and the
 * producer carries on — throwing here would turn a finished job into a failed one.
 */
export function tryRecordNodeNotice(services: NoticeServices, notice: NodeNotice): void {
  try {
    recordNodeNotice(services, notice);
  } catch (cause) {
    process.stderr.write(
      `inbox: could not record a ${notice.sourceKind} notice (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

/**
 * The notice a dispatched task leaves when it settles.
 *
 * A cancellation was the person's own doing, so it is information rather than something that went wrong;
 * "uncertain" is a warning because the task may or may not have had its effect, and that is worth a look. The task id
 * is the dedup key and never the title: it is an internal handle, and the title is what a person reads first.
 */
export function workerSettledNotice(input: {
  taskId: string;
  conversationId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
  message: string;
  at: Instant;
}): NodeNotice {
  const { severity, title } = WORKER_OUTCOMES[input.outcome];
  return {
    sourceKind: "worker",
    category: "result",
    severity,
    title,
    body: input.message,
    conversationId: input.conversationId,
    dedupKey: `worker:${input.taskId}`,
    at: input.at,
  };
}

const WORKER_OUTCOMES: Record<
  "succeeded" | "failed" | "cancelled" | "uncertain",
  { severity: NoticeSeverity; title: string }
> = {
  succeeded: { severity: "success", title: "Việc chạy nền đã xong" },
  failed: { severity: "error", title: "Việc chạy nền không xong" },
  cancelled: { severity: "info", title: "Việc chạy nền đã được hủy" },
  uncertain: { severity: "warning", title: "Việc chạy nền chưa rõ kết quả" },
};
