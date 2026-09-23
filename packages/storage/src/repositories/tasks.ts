import {
  type TaskRecord,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export function upsertTask(db: Database, task: TaskRecord): void {
  db.prepare(
    `INSERT INTO tasks
       (task_id, conversation_id, home_node_id, execution_node_id, state, disposition, revision, goal,
        parked_reason, waiting_capability_ref, waiting_install_plan_id, active_run_id, budget, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       execution_node_id = excluded.execution_node_id,
       state = excluded.state,
       disposition = excluded.disposition,
       revision = excluded.revision,
       goal = excluded.goal,
       parked_reason = excluded.parked_reason,
       waiting_capability_ref = excluded.waiting_capability_ref,
       waiting_install_plan_id = excluded.waiting_install_plan_id,
       active_run_id = excluded.active_run_id,
       budget = excluded.budget,
       updated_at = excluded.updated_at`,
  ).run(
    task.taskId,
    task.conversationId,
    task.homeNodeId,
    task.executionNodeId ?? null,
    task.state,
    dispositionColumnFor(task.state),
    task.revision,
    task.goal,
    task.parkedReason ?? null,
    task.waitingCapabilityRef ?? null,
    task.waitingInstallPlanId ?? null,
    task.activeRunId ?? null,
    task.budget === undefined ? null : toJson(task.budget),
    task.createdAt,
    task.updatedAt,
  );
}

/**
 * Local mirror of the disposition mapping.
 *
 * Kept in sync with `dispositionOf` in packages/contracts by
 * test/task-machine.spec.ts, which asserts the two agree for every state. Doing
 * it here avoids importing the contracts reducer into a query path.
 */
export function dispositionColumnFor(state: TaskStateName): string {
  switch (state) {
    case "queued":
    case "resolving":
    case "dispatched":
    case "running":
    case "pause_requested":
    case "cancel_requested":
      return "in-progress";
    case "waiting_input":
    case "waiting_approval":
    case "paused":
      return "needs-user";
    case "waiting_capability":
      return "needs-capability";
    case "verifying":
      return "verifying";
    case "uncertain":
    case "reconciling":
      return "uncertain";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

type TaskStateName = TaskRecord["state"];

export function getTask(db: Database, taskId: string): TaskRecord | undefined {
  const row = oneRow<Record<string, unknown>>(db, "SELECT * FROM tasks WHERE task_id = ?", taskId);
  if (!row) return undefined;
  return {
    taskId: String(row.task_id) as TaskRecord["taskId"],
    conversationId: String(row.conversation_id) as TaskRecord["conversationId"],
    homeNodeId: String(row.home_node_id) as TaskRecord["homeNodeId"],
    ...(row.execution_node_id === null
      ? {}
      : { executionNodeId: String(row.execution_node_id) as TaskRecord["executionNodeId"] }),
    state: String(row.state) as TaskRecord["state"],
    revision: Number(row.revision),
    goal: String(row.goal),
    ...(row.parked_reason === null ? {} : { parkedReason: String(row.parked_reason) }),
    ...(row.waiting_capability_ref === null
      ? {}
      : { waitingCapabilityRef: String(row.waiting_capability_ref) }),
    ...(row.waiting_install_plan_id === null
      ? {}
      : { waitingInstallPlanId: String(row.waiting_install_plan_id) }),
    ...(row.active_run_id === null ? {} : { activeRunId: String(row.active_run_id) }),
    ...(row.budget === null ? {} : { budget: parseJson(row.budget, "tasks.budget") }),
    createdAt: String(row.created_at) as TaskRecord["createdAt"],
    updatedAt: String(row.updated_at) as TaskRecord["updatedAt"],
  };
}

export function listActiveTasks(db: Database, conversationId: string): TaskRecord[] {
  const rows = allRows<{ task_id: string }>(
    db,
    `SELECT task_id FROM tasks
      WHERE conversation_id = ? AND state NOT IN ('succeeded','failed','cancelled')
      ORDER BY updated_at DESC`,
    conversationId,
  );
  return rows.map((row) => getTask(db, row.task_id)).filter((task): task is TaskRecord => task !== undefined);
}
