import type { Instant } from "@clarkcant/contracts";
import { resumeCapabilityWaiters, type ResumedTask } from "@clarkcant/core";

import { reportDelegatedStatus } from "./delegation.ts";
import { appendHostReply } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";

/**
 * The tasks waiting on a capability, run now that it is usable, each told once.
 *
 * Called when this node's capabilities change: after the project-work pack finishes loading, which is what a task
 * parked in the first minute after a start is waiting for. The sentence goes to the task's own conversation before the
 * run starts, so the person reads that it is going ahead before they read how it went. A task a paired node handed over
 * is said to that node too, so its owner hears it runs now.
 */
export function resumeTasksWaitingOnCapability(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "peerDelivery">,
  input: { now?: () => Instant } = {},
): ResumedTask[] {
  const now = input.now ?? ((): Instant => new Date().toISOString() as Instant);
  const { runtime, conductor } = services;
  let toPeers = false;
  const resumed = resumeCapabilityWaiters(conductor, (task) => {
    try {
      appendHostReply(services, {
        conversationId: task.conversationId,
        text: `${task.capabilityRef} đã dùng được, nên task ${task.taskId} đang chờ nó giờ chạy tiếp trên ${task.executionNodeId}.`,
        at: now(),
      });
    } catch (cause) {
      // A conversation that cannot be written to does not hold back the task it asked for.
      process.stderr.write(
        `could not tell conversation ${task.conversationId} that task ${task.taskId} resumed (${cause instanceof Error ? cause.message : String(cause)})\n`,
      );
    }
    // Nothing for a task no peer handed over.
    const told = reportDelegatedStatus(
      { db: runtime.db, identity: runtime.identity, now, newId: conductor.newId },
      { taskId: task.taskId, state: "running", message: `${task.capabilityRef} đã dùng được`, capabilityRef: task.capabilityRef },
    );
    toPeers ||= told;
  });
  if (toPeers) services.peerDelivery?.kick();
  return resumed;
}
