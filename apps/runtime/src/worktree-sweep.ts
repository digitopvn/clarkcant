import { isTerminal, type Instant } from "@clarkcant/contracts";
import { findManagedWorktrees, removeManagedWorktree } from "@clarkcant/project-work";
import { getTask } from "@clarkcant/storage";

import { recordNodeNotice } from "./notices.ts";
import { appendHostReply } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";

/**
 * What a crash left in the node's worktree folder, tidied at boot.
 *
 * A task's worktree is taken away when the task settles, but a node that stopped mid-run never got there. On the next
 * boot, a worktree whose task has finished and that holds nothing uncommitted is removed, exactly as the dispatcher
 * would have removed it. One with uncommitted changes is kept, because those changes exist nowhere else, and the person
 * is told where it is, in the task's own conversation (the inbox keeps a pointer to it). A worktree whose task is still open — running, parked, or called uncertain by recovery — is left
 * for that task to continue in. No branch is ever touched: what a task committed stays in the repository either way.
 */

export interface WorktreeSweep {
  removed: string[];
  kept: { taskId: string; path: string; branch: string }[];
}

export async function sweepTaskWorktrees(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: { worktreesDir: string; now?: () => Instant },
): Promise<WorktreeSweep> {
  const now = input.now ?? ((): Instant => new Date().toISOString() as Instant);
  const sweep: WorktreeSweep = { removed: [], kept: [] };
  for (const worktree of await findManagedWorktrees({ worktreesDir: input.worktreesDir })) {
    const task = getTask(services.runtime.db, worktree.name);
    if (task === undefined || !isTerminal(task.state)) continue;
    if (!worktree.dirty) {
      const removed = await removeManagedWorktree({ repoPath: worktree.repoPath, path: worktree.path });
      if (removed.removed) {
        sweep.removed.push(worktree.path);
        continue;
      }
    }
    sweep.kept.push({ taskId: task.taskId, path: worktree.path, branch: worktree.branch });
    // Once per task, however many boots find it: the inbox notice is the record that it was said, so a restart that
    // finds the same worktree again says nothing new. The path goes in the conversation; the inbox does not keep paths.
    let firstTime = true;
    try {
      firstTime = recordNodeNotice(services, {
        sourceKind: "worker",
        category: "alert",
        severity: "warning",
        title: "Worktree còn thay đổi chưa commit",
        body: `Task ${task.taskId} đã kết thúc nhưng để lại thay đổi chưa commit. Clark giữ nguyên, không xoá gì; vị trí có trong cuộc trò chuyện.`,
        conversationId: task.conversationId,
        dedupKey: `worktree-kept:${task.taskId}`,
        at: now(),
      }).created;
    } catch (cause) {
      process.stderr.write(`worktree sweep: could not record a notice (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
    if (!firstTime) continue;
    try {
      appendHostReply(services, {
        conversationId: task.conversationId,
        text: `Task ${task.taskId} để lại thay đổi chưa commit, nên chúng được giữ nguyên ở ${worktree.path} (nhánh ${worktree.branch}).`,
        at: now(),
      });
    } catch (cause) {
      // One conversation that cannot be written to does not stop the rest of the sweep.
      process.stderr.write(`worktree sweep: could not write to conversation ${task.conversationId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  }
  return sweep;
}
