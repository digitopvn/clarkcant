import { instantSchema, nodeIdSchema, principalIdSchema } from "@clarkcant/contracts";
import { getTask, migrate, openDatabase } from "@clarkcant/storage";
import { beforeEach, describe, expect, it } from "vitest";

import { applyTaskEvent, cancelTask, createTask } from "../src/index.ts";

/**
 * Stopping a task.
 *
 * Cancellation is two steps in the reducer on purpose — `cancel.requested` moves a task to
 * `cancel_requested` so the executor gets to confirm what actually happened — and the whole point of
 * `cancelTask` is that it decides between the two situations that look identical from a button:
 * one where confirming is a statement of fact, and one where it would be the host asserting an
 * outcome it cannot see. These tests are about that boundary, not about the reducer underneath it
 * (which has its own).
 */

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");
const USER = { principalId: principalIdSchema.parse("prin_owner"), kind: "user" as const, nodeId: NODE_A };

let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
  ).run("conv_1", NODE_A, AT, AT);
  return {
    db,
    nodeId: NODE_A,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

/**
 * Narrow a cancellation result to its success branch.
 *
 * `expect(...).toBe(true)` does not narrow for TypeScript, and casting would let a failure branch be
 * read as if it carried a state — which is the one thing these tests must not allow.
 */
function mustSucceed(result: ReturnType<typeof cancelTask>) {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result;
}

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  deps = makeDeps();
});

function newTask(goal = "sửa lỗi đăng nhập") {
  return createTask(deps, { conversationId: "conv_1" as never, goal, principal: USER });
}

describe("cancelTask", () => {
  it("confirms on the spot when nothing is running", () => {
    const task = newTask();

    const outcome = mustSucceed(cancelTask(deps, task.taskId));

    expect(outcome.ok).toBe(true);
    // Nothing has an effect in flight, so there is no executor to wait for and leaving the task in
    // `cancel_requested` would claim something is still going on.
    expect(outcome.confirmed).toBe(true);
    expect(outcome.task.state).toBe("cancelled");
    expect(getTask(deps.db, task.taskId)?.state).toBe("cancelled");
  });

  it("only records the request while a run is in flight", () => {
    const task = newTask();
    const started = applyTaskEvent(deps, task.taskId, "resolve.start", { activeRunId: "run_1" as never });
    expect(started.ok).toBe(true);

    const outcome = mustSucceed(cancelTask(deps, task.taskId));

    expect(outcome.ok).toBe(true);
    /*
     * The assertion this test exists for. A process somewhere is holding this task, and nobody has
     * observed what its effect did yet, so confirming on its behalf would be the host inventing an
     * outcome — a task that reads `cancelled` while its effect still lands is worse than one that
     * says it is still stopping.
     */
    expect(outcome.confirmed).toBe(false);
    expect(outcome.task.state).toBe("cancel_requested");
    expect(getTask(deps.db, task.taskId)?.state).toBe("cancel_requested");
  });

  it("confirms a task that was dispatched and has no run left", () => {
    const task = newTask();
    // A node recorded but no run id: the work was handed off and nothing is executing now. The run id
    // is the in-flight signal; a target node is only where work was sent.
    const dispatched = applyTaskEvent(deps, task.taskId, "resolve.start", {
      executionNodeId: NODE_A as never,
    });
    expect(dispatched.ok).toBe(true);

    const outcome = mustSucceed(cancelTask(deps, task.taskId));

    expect(outcome.ok).toBe(true);
    expect(outcome.task.executionNodeId).toBe(NODE_A);
    expect(outcome.task.activeRunId).toBeUndefined();
    // Waiting for a confirmation that can never come would leave the user reading "still stopping"
    // about work that had already stopped.
    expect(outcome.confirmed).toBe(true);
    expect(outcome.task.state).toBe("cancelled");
  });

  it("refuses a task that already ended, and says which state it is in", () => {
    const task = newTask();
    expect(cancelTask(deps, task.taskId).confirmed).toBe(true);

    const again = cancelTask(deps, task.taskId);

    expect(again.ok).toBe(false);
    if (!again.ok) {
      // Named, because "cannot cancel" without the state reads as a permissions problem rather than
      // as a task that is simply already over.
      expect(again.message).toContain("cancelled");
    }
  });

  it("refuses a task that does not exist rather than reporting success", () => {
    const outcome = cancelTask(deps, "task_missing");

    expect(outcome.ok).toBe(false);
    expect(outcome.confirmed).toBe(false);
  });

  it("leaves an audit trail of the request and the confirmation", () => {
    const task = newTask();
    cancelTask(deps, task.taskId);

    const events = deps.db
      .prepare("SELECT document FROM events WHERE task_id = ? ORDER BY rowid")
      .all(task.taskId) as { document: string }[];
    const kinds = events.map((row) => JSON.parse(row.document) as { event?: string }).map((doc) => doc.event);

    // Both steps are written, so the timeline explains how the task reached `cancelled` instead of
    // showing a state change nothing accounts for.
    expect(kinds).toContain("cancel.requested");
    expect(kinds).toContain("cancel.confirmed");
  });
});
