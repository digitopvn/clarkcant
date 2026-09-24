import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type CapabilityRef,
  type ConversationId,
  type Instant,
  type Principal,
  type TaskRecord,
} from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  advanceResolving,
  applyTaskEvent,
  createTask,
  registerCapability,
  writeRegisteredPreference,
  type ConductorDeps,
} from "@clarkcant/core";
import { getTask, oneRow } from "@clarkcant/storage";

import { bootRuntime, type Runtime } from "../src/node.ts";
import { createTaskDispatcher, decideTaskApprovalForNode } from "../src/task-dispatch.ts";
import type { WorkerProcessResult } from "../src/worker-process.ts";

/**
 * The route a granted task approval turns back into a run.
 *
 * The gate in `task-dispatch.ts` asks once, through the ordinary approval row; these tests exercise the other
 * side of it — the decide route that answers, and what a grant does that a card's decide route never had to do:
 * turn straight back into the very re-dispatch that was refused, on the strength of `approvalAuthorizes` rather
 * than asking the policy question a second time.
 */

const AT = "2026-09-22T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_task_approval_test" as ConversationId;
const CAPABILITY_REF = "demo.write@1" as CapabilityRef;
const PRINCIPAL: Principal = { principalId: "user_owner", kind: "user", nodeId: "node_test" as never };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-task-approval-decide-"));
}

interface TestNode {
  runtime: Runtime;
  conductor: ConductorDeps;
  close: () => void;
}

function testNode(): TestNode {
  const runtime = bootRuntime({ dataDir: tempDir(), label: "task approval decide test node" });
  runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(CONVERSATION_ID, runtime.identity.nodeId, AT, AT);
  let counter = 0;
  const conductor: ConductorDeps = {
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    now: () => AT,
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
    sampleRecipes: [],
    validateProps: () => ({ ok: true }),
  };

  // The gate only asks when a descriptor with a non-"read" effect category is registered for the node dispatching
  // the run, so every test below needs one on the books before it dispatches.
  registerCapability(
    { db: runtime.db, nodeId: runtime.identity.nodeId },
    {
      ref: CAPABILITY_REF,
      executionNodeId: runtime.identity.nodeId,
      summary: "ghi một file demo",
      resourceKinds: [],
      effectCategory: "local-write",
      supportsCancellation: false,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
    },
  );

  // "ask every time" is the mode that makes the gate raise an approval instead of running or refusing outright.
  const outcome = writeRegisteredPreference(
    { db: runtime.db, now: () => AT },
    {
      principalId: PRINCIPAL.principalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
      source: "user",
    },
  );
  if (!outcome.ok) throw new Error(outcome.message);

  return { runtime, conductor, close: () => runtime.close() };
}

/** A task already in `dispatched`, exactly as `handleUserMessage` leaves it before calling `runTask`. */
function dispatchedTask(conductor: ConductorDeps, executionNodeId: string): TaskRecord {
  const task = createTask(conductor, { conversationId: CONVERSATION_ID, goal: "ghi file demo", principal: PRINCIPAL });
  applyTaskEvent(conductor, task.taskId, "resolve.start");
  advanceResolving(conductor, task.taskId, { kind: "ready", executionNodeId });
  applyTaskEvent(conductor, task.taskId, "dispatch.acknowledged");
  const dispatched = getTask(conductor.db, task.taskId);
  if (dispatched === undefined) throw new Error("test setup: task disappeared right after dispatch");
  return dispatched;
}

function fakeWorkerResult(evidence: WorkerProcessResult["record"]["evidence"]): WorkerProcessResult {
  return {
    adapter: "fake",
    adapterVersion: "fake-1.0.0",
    stopReason: "settled",
    withheldCapabilities: [],
    record: {
      runId: "run_fake",
      taskId: "task_fake",
      taskRevision: 0,
      executionNodeId: "node_test",
      leaseEpoch: 1,
      startedAt: AT,
      endedAt: AT,
      evidence,
    },
  };
}

function pendingApprovalFor(node: TestNode, taskId: string) {
  const row = oneRow<{ approval_id: string; operation_digest: string }>(
    node.runtime.db,
    "SELECT approval_id, operation_digest FROM approvals WHERE task_id = ? AND decision = 'pending' ORDER BY requested_at DESC LIMIT 1",
    taskId,
  );
  if (row === undefined) throw new Error("test setup: no pending approval was raised for this task");
  return row;
}

let node: TestNode | undefined;

afterEach(() => {
  node?.close();
  node = undefined;
});

async function vi_flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("deciding an approval a dispatched task raised", () => {
  it("raises an approval instead of running when the policy asks, and parks the task waiting for it rather than failing it", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string; message: string }[] = [];
    const waiting: { taskId: string; conversationId: string; approvalId: string; message: string }[] = [];

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      onWaitingApproval: (input) => waiting.push(input),
      runWorker: async () => fakeWorkerResult([{ kind: "file-diff", summary: "đã ghi file", verdict: "verified", observedAt: AT }]),
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    // Nothing settled: an approval request is not a failure, and `onSettled` must stay free for the real
    // outcome this run eventually has once the approval is decided.
    expect(settled).toEqual([]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ taskId: task.taskId, conversationId: CONVERSATION_ID, approvalId: expect.any(String) });
    // Plain Vietnamese, built from the capability's own summary - never the capability ref, the approval id or a
    // digest. Those stay in the structured `taskId`/`approvalId` fields above, not in the sentence.
    expect(waiting[0]?.message).toBe(
      "Cần được duyệt trước khi thực hiện: ghi một file demo. Việc chưa chạy; " +
        "nếu được duyệt việc sẽ tiếp tục, nếu bị từ chối hoặc hết hạn thì việc sẽ dừng hẳn.",
    );
    expect(waiting[0]?.message).not.toContain(CAPABILITY_REF);
    expect(waiting[0]?.message).not.toContain(task.taskId);
    expect(getTask(node.conductor.db, task.taskId)?.state).toBe("waiting_approval");
    expect(pendingApprovalFor(node, task.taskId)).toBeDefined();
  });

  it("runs nothing when the approval is denied, settles the task as failed rather than leaving it parked, and refuses a repeat decision", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string; message: string }[] = [];
    let workerCalled = false;

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      runWorker: async () => {
        workerCalled = true;
        return fakeWorkerResult([{ kind: "file-diff", summary: "đã ghi file", verdict: "verified", observedAt: AT }]);
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    const raised = pendingApprovalFor(node, task.taskId);
    const decided = decideTaskApprovalForNode(
      { coordination: { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: () => AT, newId: node.conductor.newId } },
      {
        taskId: task.taskId,
        approvalId: raised.approval_id,
        decision: "denied",
        decidingPrincipal: PRINCIPAL,
        seenOperationDigest: raised.operation_digest,
      },
    );
    expect(decided).toEqual({ ok: true, conversationId: CONVERSATION_ID, redispatched: false });
    expect(workerCalled).toBe(false);

    // A denial leaves no path back to a run: the task is terminal (`failed`), not stranded in
    // `waiting_approval` forever with an approval that was already spent.
    expect(getTask(node.conductor.db, task.taskId)?.state).toBe("failed");
    const decidedRow = oneRow<{ decision: string }>(node.runtime.db, "SELECT decision FROM approvals WHERE approval_id = ?", raised.approval_id);
    expect(decidedRow?.decision).toBe("denied");

    // The task has already left `waiting_approval`, so a second decision (even a grant) is refused before
    // it is ever compared against the approval row, rather than reaching `APPROVAL_ALREADY_DECIDED`.
    const again = decideTaskApprovalForNode(
      { coordination: { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: () => AT, newId: node.conductor.newId } },
      {
        taskId: task.taskId,
        approvalId: raised.approval_id,
        decision: "granted",
        decidingPrincipal: PRINCIPAL,
        seenOperationDigest: raised.operation_digest,
      },
    );
    expect(again).toMatchObject({ ok: false, code: "TASK_NOT_WAITING" });
  });

  it("refuses a decision whose digest does not match what was raised, without deciding anything", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      onSettled: () => undefined,
      runWorker: async () => fakeWorkerResult([]),
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    const raised = pendingApprovalFor(node, task.taskId);
    const decided = decideTaskApprovalForNode(
      { coordination: { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: () => AT, newId: node.conductor.newId } },
      {
        taskId: task.taskId,
        approvalId: raised.approval_id,
        decision: "granted",
        decidingPrincipal: PRINCIPAL,
        seenOperationDigest: "sha256:mot-thu-khac",
      },
    );
    expect(decided).toMatchObject({ ok: false, code: "APPROVAL_FORGED" });
    const row = oneRow<{ decision: string }>(node.runtime.db, "SELECT decision FROM approvals WHERE approval_id = ?", raised.approval_id);
    expect(row?.decision).toBe("pending");
  });

  it("refuses a decision for an approval that belongs to a different task", async () => {
    node = testNode();
    const taskA = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const taskB = createTask(node.conductor, { conversationId: CONVERSATION_ID, goal: "một việc khác", principal: PRINCIPAL });

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      onSettled: () => undefined,
      runWorker: async () => fakeWorkerResult([]),
    });
    dispatcher.dispatch({ taskId: taskA.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    const raised = pendingApprovalFor(node, taskA.taskId);
    const decided = decideTaskApprovalForNode(
      { coordination: { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: () => AT, newId: node.conductor.newId } },
      {
        taskId: taskB.taskId,
        approvalId: raised.approval_id,
        decision: "granted",
        decidingPrincipal: PRINCIPAL,
        seenOperationDigest: raised.operation_digest,
      },
    );
    expect(decided).toMatchObject({ ok: false, code: "APPROVAL_FORGED" });
  });

  it("re-dispatches the same task on a grant, and this time the gate lets it run rather than asking again", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string; message: string }[] = [];
    let workerCalls = 0;

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      runWorker: async () => {
        workerCalls += 1;
        return fakeWorkerResult([{ kind: "file-diff", summary: "đã ghi file", verdict: "verified", observedAt: AT }]);
      },
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();
    expect(settled).toEqual([]);
    expect(workerCalls).toBe(0);
    expect(getTask(node.conductor.db, task.taskId)?.state).toBe("waiting_approval");

    const raised = pendingApprovalFor(node, task.taskId);
    const decided = decideTaskApprovalForNode(
      {
        coordination: { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: () => AT, newId: node.conductor.newId },
        dispatch: (input) => dispatcher.dispatch(input),
      },
      {
        taskId: task.taskId,
        approvalId: raised.approval_id,
        decision: "granted",
        decidingPrincipal: PRINCIPAL,
        seenOperationDigest: raised.operation_digest,
      },
    );
    expect(decided).toEqual({ ok: true, conversationId: CONVERSATION_ID, redispatched: true });

    await vi_flush();
    expect(workerCalls).toBe(1);
    // The re-dispatch ran the worker rather than asking a second time - the whole point of the grant. Only the
    // real outcome settles; the approval-pending park never called `onSettled` at all.
    expect(settled).toEqual([{ outcome: "succeeded", message: "đã ghi file" }]);
    expect(getTask(node.conductor.db, task.taskId)?.state).toBe("succeeded");

    // Nothing to re-decide: the approval this dispatch was authorized by is spent, its own decision recorded.
    const row = oneRow<{ decision: string }>(node.runtime.db, "SELECT decision FROM approvals WHERE approval_id = ?", raised.approval_id);
    expect(row?.decision).toBe("granted");
  });

  it("never lets a stored grant override a node-wide prohibition", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const operationDigest = `sha256:task-effect:${task.taskId}:${CAPABILITY_REF}`;

    // A grant already on record for this exact task and operation, as if a prior dispatch of the same task had
    // already been decided - inserted directly rather than through `decideTaskApprovalForNode`, so this proves
    // the gate's own ordering rather than depending on another code path to have produced the row.
    node.runtime.db
      .prepare(
        `INSERT INTO approvals
           (approval_id, task_id, operation_digest, operation_description, effect_category, decider, decision, requested_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'user', 'granted', ?, ?, ?)`,
      )
      .run("appr_stored_grant", task.taskId, operationDigest, "ghi một file demo", "local-write", AT, "2026-09-22T09:30:00.000Z", AT);

    // The user tightens their policy to refuse every effect on this node after the grant was recorded - exactly
    // the case a stored grant must never survive.
    const tightened = writeRegisteredPreference(
      { db: node.runtime.db, now: () => AT },
      {
        principalId: PRINCIPAL.principalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask", prohibition: "all" },
        source: "user",
      },
    );
    if (!tightened.ok) throw new Error(tightened.message);

    const settled: { outcome: string; message: string }[] = [];
    const waiting: unknown[] = [];
    let workerCalled = false;
    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      onWaitingApproval: (input) => waiting.push(input),
      runWorker: async () => {
        workerCalled = true;
        return fakeWorkerResult([{ kind: "file-diff", summary: "đã ghi file", verdict: "verified", observedAt: AT }]);
      },
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    // The prohibition wins over the stored grant: the worker never ran, the task was never parked waiting for
    // another approval (there is nothing left to ask - the node refuses this outright), and it did not settle
    // as if it had succeeded.
    expect(workerCalled).toBe(false);
    expect(waiting).toEqual([]);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).not.toBe("succeeded");
    expect(settled[0]?.message).toContain("refuses every effect");
    expect(getTask(node.conductor.db, task.taskId)?.state).not.toBe("waiting_approval");
  });

  it("accepts the approval that authorized a queued re-dispatch without re-checking that approval's own deadline", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    let currentTime: Instant = AT;
    const settled: { outcome: string; message: string }[] = [];
    let workerCalls = 0;

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => PRINCIPAL.principalId,
      at: () => currentTime,
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      runWorker: async () => {
        workerCalls += 1;
        return fakeWorkerResult([{ kind: "file-diff", summary: "đã ghi file", verdict: "verified", observedAt: AT }]);
      },
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CAPABILITY_REF, executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();
    expect(getTask(node.conductor.db, task.taskId)?.state).toBe("waiting_approval");

    const raised = pendingApprovalFor(node, task.taskId);
    const approvalRow = oneRow<{ expires_at: string }>(
      node.runtime.db,
      "SELECT expires_at FROM approvals WHERE approval_id = ?",
      raised.approval_id,
    );
    if (approvalRow === undefined) throw new Error("test setup: approval row disappeared");

    // The decision itself lands comfortably within the approval's own deadline.
    const decided = decideTaskApprovalForNode(
      {
        coordination: { db: node.runtime.db, nodeId: node.runtime.identity.nodeId, now: () => AT, newId: node.conductor.newId },
        dispatch: (input) => {
          // A queue backlog is what would let real time pass between the decision and the gate re-running for
          // the re-dispatch it authorized; simulated here by moving the dispatcher's own clock past the
          // approval's deadline right before the queued job's gate re-checks it.
          currentTime = new Date(new Date(approvalRow.expires_at).getTime() + 1000).toISOString() as Instant;
          return dispatcher.dispatch(input);
        },
      },
      {
        taskId: task.taskId,
        approvalId: raised.approval_id,
        decision: "granted",
        decidingPrincipal: PRINCIPAL,
        seenOperationDigest: raised.operation_digest,
      },
    );
    expect(decided).toEqual({ ok: true, conversationId: CONVERSATION_ID, redispatched: true });

    await vi_flush();
    // The carried approval authorized this one re-dispatch regardless of its own deadline having since passed,
    // so the worker ran rather than the gate parking the task waiting for a second approval.
    expect(workerCalls).toBe(1);
    expect(settled).toEqual([{ outcome: "succeeded", message: "đã ghi file" }]);
    expect(getTask(node.conductor.db, task.taskId)?.state).toBe("succeeded");
  });
});
