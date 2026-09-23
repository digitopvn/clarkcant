import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConversationId, Instant, Principal, TaskRecord } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, registerCapability, type ConductorDeps } from "@clarkcant/core";
import { CONTROLLED_CODE_TASK, READ_FILE_QUESTION } from "@clarkcant/project-work";
import { getTask } from "@clarkcant/storage";

import { bootRuntime, type Runtime } from "../src/node.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import { runWorkerProcess } from "../src/worker-process.ts";

/**
 * The gap this closes: `packs/project-work` declares `project.file.read@1` and
 * `project.code.change@1`, but until now nothing implemented the second one — the worker only ever
 * registered a tool under the mismatched literal `capability:project.read`, so a task dispatched for
 * either of the pack's real refs could never reach a worker tool that proves it. This test dispatches
 * a task for `project.code.change@1` through a *real* worker child process (`apps/worker/src/main.ts`,
 * spawned by `runWorkerProcess`, not a fake `runWorker` injection) and drives it with a scripted
 * prompt that calls the worker's own registered `write_project_file` tool, ending the task in
 * `succeeded` with verified `read-after-write` evidence — and the file really is on disk afterward.
 */

const AT = "2026-09-23T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_project_work_pack_test" as ConversationId;
const PRINCIPAL: Principal = {
  principalId: "user_test",
  kind: "user",
  nodeId: "node_test" as never,
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface TestNode {
  runtime: Runtime;
  conductor: ConductorDeps;
  close: () => void;
}

function testNode(): TestNode {
  const runtime = bootRuntime({ dataDir: tempDir("cc-pack-dispatch-"), label: "project-work pack dispatch test node" });
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
  const task = createTask(conductor, {
    conversationId: CONVERSATION_ID,
    goal: "write a file inside the approved workspace",
    principal: PRINCIPAL,
  });
  applyTaskEvent(conductor, task.taskId, "resolve.start");
  advanceResolving(conductor, task.taskId, { kind: "ready", executionNodeId });
  applyTaskEvent(conductor, task.taskId, "dispatch.acknowledged");
  const dispatched = getTask(conductor.db, task.taskId);
  if (dispatched === undefined) throw new Error("test setup: task disappeared right after dispatch");
  return dispatched;
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let node: TestNode | undefined;
let projectRoot: string | undefined;
let scriptFile: string | undefined;

afterEach(() => {
  node?.close();
  node = undefined;
  if (projectRoot !== undefined) rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
  if (scriptFile !== undefined) rmSync(scriptFile, { force: true });
  scriptFile = undefined;
});

describe("dispatching project.code.change@1 through the project-work pack", () => {
  it("runs a real worker child that calls write_project_file, and settles the task succeeded with evidence", async () => {
    node = testNode();
    projectRoot = tempDir("cc-pack-workspace-");
    const targetPath = join(projectRoot, "notes.txt");

    // Register the pack's own capability descriptor, already usable — a real node would reach this
    // state through `apps/runtime/src/pack-load.ts`'s probe; that path is exercised separately, and
    // this test is about the worker tool behind the ref, not the readiness state machine in front of it.
    registerCapability(
      { db: node.conductor.db, nodeId: node.runtime.identity.nodeId },
      {
        ...CONTROLLED_CODE_TASK,
        executionNodeId: node.runtime.identity.nodeId as never,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      },
    );

    const task = dispatchedTask(node.conductor, node.runtime.identity.nodeId);

    // The scripted turn: before its reply, the fake adapter calls the worker's own registered
    // `write_project_file` tool exactly the way a real model deciding to use it would.
    scriptFile = join(tempDir("cc-pack-script-"), "script.json");
    writeFileSync(
      scriptFile,
      JSON.stringify([
        {
          callTool: {
            name: "write_project_file",
            params: { path: targetPath, contents: "the change the task asked for" },
          },
          reply: "wrote the file",
        },
      ]),
      "utf8",
    );

    const settled: { outcome: string; message: string }[] = [];
    const dispatcher = createTaskDispatcher({
      conductor: node.conductor,
      projectRoots: () => [projectRoot as string],
      ownedRoots: () => [projectRoot as string],
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      timeoutMs: 20_000,
      // Still the real `apps/worker/src/main.ts` child process — spawned by `runWorkerProcess`, not
      // replaced by a fake in-process function. The only thing injected is the script path, which
      // `main.ts` reads to build the fake adapter's `ScriptedTurn`s inside that child process.
      runWorker: (options) => runWorkerProcess({ ...options, scriptPath: scriptFile as string }),
    });

    dispatcher.dispatch({
      taskId: task.taskId,
      capabilityRef: CONTROLLED_CODE_TASK.ref,
      executionNodeId: node.runtime.identity.nodeId,
    });
    await waitUntil(() => settled.length > 0, 20_000);

    expect(settled[0]?.outcome).toBe("succeeded");
    const after = getTask(node.conductor.db, task.taskId);
    expect(after?.state).toBe("succeeded");

    // The evidence is not merely "the tool returned success": the file the tool was asked to write is
    // really on disk, with the contents the scripted call named.
    expect(readFileSync(targetPath, "utf8")).toBe("the change the task asked for");
  }, 25_000);

  it("registers project.file.read@1 under the ref the pack actually declares", () => {
    // A narrow regression check for the mismatch this whole test file exists to close: before this
    // change, the worker's read tool advertised `capability:project.read`, which is not a ref
    // `packs/project-work` ever declared, so a task dispatched for the pack's real ref could never
    // reach it. Both descriptors' refs are asserted directly against the worker's own constants
    // in `apps/worker/test/worker.spec.ts`; this just pins the pack's own exported refs so a future
    // rename of either side is caught here too.
    expect(READ_FILE_QUESTION.ref).toBe("project.file.read@1");
    expect(CONTROLLED_CODE_TASK.ref).toBe("project.code.change@1");
  });
});
