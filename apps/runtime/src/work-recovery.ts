import type { Instant } from "@clarkcant/contracts";
import { applyTaskEvent } from "@clarkcant/core";
import {
  type Database,
  type WorkRunRecord,
  allRows,
  pruneWorkRuns,
  setWorkRunState,
  unfinishedWorkRuns,
  unsettledEffects,
} from "@clarkcant/storage";

import { isSameProcess, signalTree } from "./process-tree.ts";

/**
 * What a boot does with the work an earlier process of this node left open.
 *
 * The person never sees a process list, so a restart is invisible to them unless the node says something — and the
 * only honest thing to say is in the conversation where the work was asked for. Every unfinished run is reported
 * there, once, and then:
 *
 *   - **A process that is still alive is stopped.** A command or task worker whose node crashed keeps running with
 *     nobody able to reach it. Its pid is only acted on when this is the same machine boot *and* the kernel's start
 *     time for that pid is the one recorded, so a pid the kernel has since given to somebody else is never touched.
 *   - **Effect-free background work is run again, once.** Only in Autonomous mode, only within a day, and only for a
 *     request that has not already been re-run: a background worker has no folders and read-only tools, so running it
 *     again cannot do anything twice. Every other case asks instead.
 *   - **Work with effects is never re-run.** A task this node was executing moves to `uncertain` through the ordinary
 *     state machine, which is the state that says "reconcile before believing either outcome"; a command is reported
 *     with its result unverified.
 */

/** How old an interrupted background request may be and still be re-run without asking. */
export const RERUN_WINDOW_MS = 24 * 60 * 60_000;
/** How many times one request is re-run after restarts. Once: a request that dies twice is not a restart's fault. */
export const MAX_RERUNS = 1;
/** How long ended rows are kept for a later boot to read. */
export const WORK_RUN_RETENTION_MS = 7 * 24 * 60 * 60_000;

const INTERRUPTED_TASK_STATES = ["dispatched", "running", "pause_requested", "cancel_requested", "verifying"] as const;

export interface WorkRecoveryDeps {
  db: Database;
  nodeId: string;
  /** This process; rows written under it are its own and are left alone. */
  nodeBootId: string;
  /** This boot of the machine, or undefined where it cannot be read — in which case no pid is ever acted on. */
  machineBootId: string | undefined;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** The execution policy in force, read once for this recovery. */
  policyMode: () => "autonomous" | "guarded" | "ask";
  /** Write one host message into a conversation. */
  report: (conversationId: string, text: string) => void;
  /** Submit a background request again under its own work id. Answers whether it was accepted. */
  rerun: (run: WorkRunRecord & { conversationId: string; requestText: string }) => boolean;
  /** Seams for a test: whether a pid is still the recorded process, and how a group is signalled. */
  isSameProcess?: (pid: number, procStartTime: string) => boolean;
  signalGroup?: (pgid: number) => void;
}

export interface WorkRecoveryReport {
  interrupted: number;
  rerun: number;
  /** Leftover process groups that were proven to be ours and stopped. */
  reaped: number;
  /** Tasks moved to `uncertain` because the process executing them is gone. */
  uncertainTasks: number;
  /** Effects on this node still waiting to be reconciled, for the startup line. */
  unsettledEffects: number;
  pruned: number;
}

export function recoverUnfinishedWork(deps: WorkRecoveryDeps): WorkRecoveryReport {
  const at = deps.now();
  const sameProcess = deps.isSameProcess ?? ((pid, start) => isSameProcess(pid, start));
  const signalGroup = deps.signalGroup ?? ((pgid) => void signalTree(pgid, "SIGKILL"));
  const mode = deps.policyMode();
  const report: WorkRecoveryReport = {
    interrupted: 0,
    rerun: 0,
    reaped: 0,
    uncertainTasks: 0,
    unsettledEffects: 0,
    pruned: 0,
  };

  for (const run of unfinishedWorkRuns(deps.db, deps.nodeId, deps.nodeBootId)) {
    // One row that cannot be read back or reported must not stop the rest, nor the task pass after it.
    try {
      const reaped = reapLeftover(run, deps.machineBootId, sameProcess, signalGroup);
      if (reaped) report.reaped += 1;
      if (run.kind === "background") {
        // Closed first: a re-run reuses the work id and opens the row again under this boot.
        setWorkRunState(deps.db, run.workId, "interrupted", at);
        report.interrupted += 1;
        if (run.conversationId !== undefined && recoverBackground(deps, run, run.conversationId, mode, at)) report.rerun += 1;
        continue;
      }
      // Said before the row is closed: a boot that fails between the two says it again rather than never.
      if (run.kind === "command" && run.conversationId !== undefined) {
        deps.report(
          run.conversationId,
          `Lệnh “${run.title}” đang chạy thì node khởi động lại${reaped ? "; tiến trình còn sót của nó đã được dừng" : ""}. Kết quả của lệnh chưa được kiểm chứng — hãy kiểm tra trạng thái trước khi chạy lại, vì lệnh có thể đã làm một phần việc.`,
        );
      }
      // A task's report comes from the task pass below, which is where its state actually changes.
      setWorkRunState(deps.db, run.workId, "interrupted", at);
      report.interrupted += 1;
    } catch {
      // Left open; the next boot tries again.
    }
  }

  report.uncertainTasks = interruptTasks(deps, at);
  report.unsettledEffects = unsettledEffects(deps.db, deps.nodeId).length;
  report.pruned = pruneWorkRuns(deps.db, new Date(Date.parse(at) - WORK_RUN_RETENTION_MS).toISOString() as Instant);
  return report;
}

/** Re-run one interrupted background request when that is safe, or say it did not finish. Answers whether it re-ran. */
function recoverBackground(
  deps: WorkRecoveryDeps,
  run: WorkRunRecord,
  conversationId: string,
  mode: ReturnType<WorkRecoveryDeps["policyMode"]>,
  at: Instant,
): boolean {
  const where = run.state === "queued" ? "đang chờ đến lượt" : "đang chạy";
  const eligible =
    mode === "autonomous" &&
    !run.effectful &&
    run.attempt < MAX_RERUNS &&
    run.requestText !== undefined &&
    Date.parse(at) - Date.parse(run.startedAt) < RERUN_WINDOW_MS;
  if (eligible && deps.rerun({ ...run, conversationId, requestText: run.requestText as string })) {
    deps.report(
      conversationId,
      `Node vừa khởi động lại khi việc nền “${run.title}” ${where}. Việc này chỉ đọc, không thay đổi gì bên ngoài, nên tui đang chạy lại nó một lần; kết quả sẽ báo ở đây.`,
    );
    return true;
  }
  deps.report(
    conversationId,
    `Node đã khởi động lại khi việc nền “${run.title}” ${where}, nên việc đó chưa xong và chưa có kết quả. Nhắn lại nếu bạn vẫn cần, tui sẽ chạy lại.`,
  );
  return false;
}

/** Stop a leftover process group, but only one proven to be the process that was recorded. */
function reapLeftover(
  run: WorkRunRecord,
  machineBootId: string | undefined,
  sameProcess: (pid: number, procStartTime: string) => boolean,
  signalGroup: (pgid: number) => void,
): boolean {
  if (run.pid === undefined || run.pgid === undefined || run.procStartTime === undefined) return false;
  // Only a group the recorded process led: its start time proves the leader, not some other group's id.
  if (run.pgid !== run.pid) return false;
  if (machineBootId === undefined || run.machineBootId !== machineBootId) return false;
  if (!sameProcess(run.pid, run.procStartTime)) return false;
  try {
    signalGroup(run.pgid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tasks this node was executing when it went away.
 *
 * The process that would have reported their outcome is gone, so whether their effect happened is not known: that is
 * `uncertain`, reached through the same events a live executor would use. Reported once per task in its conversation.
 */
function interruptTasks(deps: WorkRecoveryDeps, at: Instant): number {
  const placeholders = INTERRUPTED_TASK_STATES.map(() => "?").join(",");
  const rows = allRows<{ task_id: string; conversation_id: string; state: string; goal: string }>(
    deps.db,
    `SELECT task_id, conversation_id, state, goal FROM tasks WHERE execution_node_id = ? AND state IN (${placeholders})`,
    deps.nodeId,
    ...INTERRUPTED_TASK_STATES,
  );
  const coordination = { db: deps.db, nodeId: deps.nodeId, now: () => at, newId: deps.newId };
  let moved = 0;
  for (const row of rows) {
    const event = row.state === "dispatched" ? "dispatch.timed_out" : "effect.unknown";
    try {
      const applied = applyTaskEvent(coordination, row.task_id, event);
      if (!applied.ok) continue;
    } catch {
      continue;
    }
    moved += 1;
    reportSafely(deps,
      row.conversation_id,
      `Task “${row.goal.slice(0, 120)}” đang chạy thì node khởi động lại, nên kết quả của nó chưa rõ. Tui đã ghi task là “chưa rõ kết quả” và sẽ không tự chạy lại; hãy kiểm tra hoặc yêu cầu đối chiếu trước khi chạy tiếp.`,
    );
  }
  return moved;
}

/** The task has already moved; a report that fails must not undo that or stop the next task. */
function reportSafely(deps: WorkRecoveryDeps, conversationId: string, text: string): void {
  try {
    deps.report(conversationId, text);
  } catch {
    // The task's state says it; the conversation line is the part that was lost.
  }
}
