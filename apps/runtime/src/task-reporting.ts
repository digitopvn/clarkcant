import type { Instant, MessageBlock } from "@clarkcant/contracts";

import { reportDelegatedOutcome, reportDelegatedStatus } from "./delegation.ts";
import { unknownEffectsNotice } from "./effect-notices.ts";
import { ownerHostText } from "./host-text.ts";
import { tryRecordNodeNotice, workerSettledNotice } from "./notices.ts";
import { appendHostReply } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";
import type { TaskDispatcherDeps } from "./task-dispatch.ts";

/**
 * A settled task, as either path reports it: a run here says what its worker wrote, and a task handed to a peer says
 * what came back with the peer's answer.
 */
type TaskSettledReport = Parameters<TaskDispatcherDeps["onSettled"]>[0] & { blocks?: readonly MessageBlock[] };

/**
 * How a dispatched task is reported, where the person asked for it.
 *
 * In the task's own conversation, in plain words, and in the inbox for a person who is not looking at it. Its own
 * module rather than inline in the bootstrap so a journey test hears exactly what a person would.
 */
export function taskDispatchReports(
  services: NodeServices,
): Pick<TaskDispatcherDeps, "onWorktreeKept" | "onWaitingApproval"> & { onSettled: (input: TaskSettledReport) => void } {
  return {
    onWorktreeKept: ({ taskId, conversationId, path, branch }) => {
      appendHostReply(services, {
        conversationId,
        text: ownerHostText(services.runtime).tasks.worktreeKept(taskId, [{ path, branch }]),
        at: new Date().toISOString() as Instant,
      });
    },
    onSettled: ({ taskId, conversationId, outcome, message, ran, outputs, blocks }: TaskSettledReport) => {
      const at = new Date().toISOString() as Instant;
      const text = ownerHostText(services.runtime).tasks.settled(outcome, taskId, message);
      // What came back with it — the files a peer sent — shown right after the words that say it.
      appendHostReply(services, {
        conversationId,
        ...(blocks === undefined || blocks.length === 0
          ? { text }
          : { blocks: [{ type: "text", format: "plain", content: text, streaming: false }, ...blocks] }),
        at,
      });
      // The pointer for a person who is not looking at that conversation. A task with an effect whose outcome is unknown
      // is reported as that effect, under the same key: it is the one thing the person has to do something about, and
      // the effect sweep would otherwise say it a second time.
      let effectNotice: ReturnType<typeof unknownEffectsNotice>;
      try {
        effectNotice = unknownEffectsNotice(services.runtime.db, taskId, at);
      } catch (cause) {
        process.stderr.write(`inbox: could not read the effects of task ${taskId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
      }
      tryRecordNodeNotice(services, effectNotice ?? workerSettledNotice({ taskId, conversationId, outcome, message, at }));
      // A task a peer handed over is answered there too, which is how its own task settles.
      const { runtime, conductor } = services;
      // The files its worker wrote go back with the answer, read now, before the task's worktree is taken away.
      const files = outputs === undefined || outputs.length === 0 ? {} : { files: { dataDir: runtime.dataDir, outputs } };
      if (reportDelegatedOutcome({ db: runtime.db, identity: runtime.identity, now: () => at, newId: conductor.newId }, { taskId, outcome, message, ...(ran === undefined ? {} : { ran }), ...files })) {
        services.peerDelivery?.kick();
      }
    },
    // A park is not a settlement: it is reported to the conversation so the wait is not silent, but never
    // through `tryRecordNodeNotice`/`workerSettledNotice` above - that dedup key (`worker:<taskId>`) belongs to
    // this run's eventual real outcome, and a notice recorded here would suppress it once the approval is
    // decided and the run actually settles. The inbox already surfaces the pending approval itself as a
    // waiting item, derived live, so no separate notice is needed for the park to be visible.
    onWaitingApproval: ({ taskId, conversationId, message, effect }) => {
      const at = new Date().toISOString() as Instant;
      appendHostReply(services, {
        conversationId,
        text: ownerHostText(services.runtime).tasks.waitingApproval(taskId, message),
        at,
      });
      // A task a peer handed over: its owner hears it waits here, and that only this node's owner decides.
      const { runtime, conductor } = services;
      if (reportDelegatedStatus({ db: runtime.db, identity: runtime.identity, now: () => at, newId: conductor.newId }, { taskId, state: "waiting_approval", message: effect })) {
        services.peerDelivery?.kick();
      }
    },
  };
}