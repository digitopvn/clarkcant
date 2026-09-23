import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConversationId, Instant, Principal, TaskRecord } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, type ConductorDeps } from "@clarkcant/core";
import { getTask } from "@clarkcant/storage";

import { bootRuntime, type Runtime } from "../src/node.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import type { WorkerProcessResult } from "../src/worker-process.ts";

/**
 * The dispatch vertical slice.
 *
 * Before this, `ConductorDeps.runTask` was declared and never called from anywhere: a task the
 * conductor marked `dispatched` had a capability chosen for it and nothing that ran it. These tests
 * exercise the dispatcher that closes that gap — a bounded worker pool, a lease per capability, root
 * confinement, and the run's evidence settling the task through the same state machine every other
 * path in this repository uses.
 *
 * Two of the tests below inject `runWorker` rather than spawning a real process, because the only
 * adapter this environment can run is the fake one, and the fake adapter never calls a tool on its
 * own — a plain `prompt()` produces text, not evidence — so a scripted success or a hung run has to
 * be simulated to be deterministic. The "real worker" test spawns an actual child process with no
 * injection at all, to prove the wiring itself: brief file, `node` invocation, JSON record read back,
 * and the honest `not-verified` outcome a session that called no tool always reports.
 */

const AT = "2026-09-21T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_dispatch_test" as ConversationId;
const PRINCIPAL: Principal = {
  principalId: "user_test",
  kind: "user",
  nodeId: "node_test" as never,
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-task-dispatch-"));
}

interface TestNode {
  runtime: Runtime;
  conductor: ConductorDeps;
  close: () => void;
}

function testNode(): TestNode {
  const runtime = bootRuntime({ dataDir: tempDir(), label: "task dispatch test node" });
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
  return { runtime, conductor, close: () => runtime.close() };
}

/** A task already in `dispatched`, exactly as `handleUserMessage` leaves it before calling `runTask`. */
function dispatchedTask(conductor: ConductorDeps, executionNodeId: string): TaskRecord {
  const task = createTask(conductor, { conversationId: CONVERSATION_ID, goal: "read the report", principal: PRINCIPAL });
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

let node: TestNode | undefined;

afterEach(() => {
  node?.close();
  node = undefined;
});

describe("dispatching a task runs a worker", () => {
  it("succeeds and settles the task through verification when the run produces verified evidence", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string; message: string }[] = [];

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      runWorker: async () =>
        fakeWorkerResult([
          { kind: "file-diff", summary: "applied the change", verdict: "verified", observedAt: AT },
        ]),
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    expect(settled).toEqual([{ outcome: "succeeded", message: "applied the change" }]);
    const after = getTask(node.conductor.db, task.taskId);
    expect(after?.state).toBe("succeeded");
  });

  it("fails the task when the run produces no verified evidence", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string }[] = [];

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      onSettled: (input) => settled.push({ outcome: input.outcome }),
      runWorker: async () =>
        fakeWorkerResult([
          { kind: "absent", summary: "nothing was demonstrated", verdict: "not-verified", observedAt: AT },
        ]),
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    expect(settled).toEqual([{ outcome: "failed" }]);
    const after = getTask(node.conductor.db, task.taskId);
    expect(after?.state).toBe("failed");
  });

  it("runs a real worker child process, which honestly reports not-verified and fails the task", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string; message: string }[] = [];

    // No `runWorker` injected: this spawns `apps/worker/src/main.ts` as a real child process with the
    // fake adapter. The fake adapter never calls a tool on a bare `prompt()`, so the session settles
    // having demonstrated nothing — the honest `not-verified` outcome, produced by a real process this
    // time rather than by a script.
    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      timeoutMs: 20_000,
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "capability:project.read", executionNodeId: node.runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 20_000);

    expect(settled[0]?.outcome).toBe("failed");
    const after = getTask(node.conductor.db, task.taskId);
    expect(after?.state).toBe("failed");
  }, 25_000);

  it("refuses a project root this node does not own, without starting a worker", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    const settled: { outcome: string; message: string }[] = [];
    let workerCalled = false;

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      // A root the dispatcher is asked to grant, and an owned set that plainly does not include it.
      projectRoots: () => ["/definitely-not-an-owned-root"],
      ownedRoots: () => ["/somewhere/this/node/actually/owns"],
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      runWorker: async () => {
        workerCalled = true;
        return fakeWorkerResult([]);
      },
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: node.runtime.identity.nodeId });
    await vi_flush();

    expect(workerCalled).toBe(false);
    expect(settled[0]?.outcome).toBe("failed");
    expect(settled[0]?.message).toContain("refused");
    const after = getTask(node.conductor.db, task.taskId);
    expect(after?.state).toBe("failed");
  });

  it("kills a running worker on stop, and reports how many it stopped", async () => {
    node = testNode();
    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);
    let killed = false;
    let release: (() => void) | undefined;

    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      onSettled: () => undefined,
      runWorker: async (options) => {
        options.onChild?.({ kill: () => { killed = true; release?.(); } } as never);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return fakeWorkerResult([]);
      },
    });

    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: node.runtime.identity.nodeId });
    await waitUntil(() => dispatcher.runningCount() === 1, 2_000);

    const stopped = dispatcher.stopAll();
    expect(stopped).toBe(1);
    expect(killed).toBe(true);
  });
});

/** Let queued microtasks (the dispatcher's own `.then` chain) run before asserting. */
async function vi_flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition was never met within the timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
