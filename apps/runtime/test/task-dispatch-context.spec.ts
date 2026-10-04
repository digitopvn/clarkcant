import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConversationId, Instant, Principal, TaskRecord } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, type ConductorDeps } from "@clarkcant/core";
import { getTask } from "@clarkcant/storage";

import { BUNDLE_DATA_HEADER, createContextBundles } from "../src/context-bundle.ts";
import { rememberMemory } from "../src/memory.ts";
import { bootRuntime, type Runtime } from "../src/node.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import { runWorkerProcess, type WorkerProcessOptions, type WorkerProcessResult } from "../src/worker-process.ts";

/**
 * A dispatched task's worker reads what the conversation already holds about its goal.
 *
 * What has to hold: the worker is told how many items there are, never their text; it reads them on demand over its
 * host channel, each read answered by the host's principal-scoped reader; nothing is retrieved without the owner; a
 * goal nothing matches gets no context tool; and reading context is never evidence that the task was done.
 */

const AT = "2026-10-04T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_task_context" as ConversationId;
const OWNER = "user_owner";
const PRINCIPAL: Principal = { principalId: OWNER, kind: "user", nodeId: "node_test" as never };

let runtime: Runtime | undefined;
let scratch: string | undefined;

afterEach(() => {
  runtime?.close();
  runtime = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function setup(goal: string): { conductor: ConductorDeps; task: TaskRecord } {
  runtime = bootRuntime({ dataDir: mkdtempSync(join(tmpdir(), "cc-task-context-")), label: "task context test node" });
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
      return `${prefix}_${String(counter)}`;
    },
    sampleRecipes: [],
    validateProps: () => ({ ok: true }),
  };
  const outcome = rememberMemory(
    { db: runtime.db, now: () => AT, newId: conductor.newId },
    {
      principalId: OWNER,
      conversationId: CONVERSATION_ID,
      kind: "decision",
      scope: "node",
      text: "Báo cáo tuần được lưu trong thư mục docs, đọc báo cáo đó trước khi tổng hợp.",
    },
  );
  if ("refused" in outcome) throw new Error(outcome.refused);
  const task = createTask(conductor, { conversationId: CONVERSATION_ID, goal, principal: PRINCIPAL });
  applyTaskEvent(conductor, task.taskId, "resolve.start");
  advanceResolving(conductor, task.taskId, { kind: "ready", executionNodeId: runtime.identity.nodeId });
  applyTaskEvent(conductor, task.taskId, "dispatch.acknowledged");
  const dispatched = getTask(conductor.db, task.taskId);
  if (dispatched === undefined) throw new Error("test setup: task disappeared right after dispatch");
  return { conductor, task: dispatched };
}

function emptyResult(): WorkerProcessResult {
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
      evidence: [{ kind: "absent", summary: "nothing", verdict: "not-verified", observedAt: AT }],
    },
    usage: { turns: 1 },
  };
}

async function dispatchOnce(
  goal: string,
  overrides: { owner?: boolean; bundles?: boolean } = {},
): Promise<WorkerProcessOptions> {
  const { conductor, task } = setup(goal);
  const db = conductor.db;
  let seen: WorkerProcessOptions | undefined;
  let settled = false;
  const dispatcher = createTaskDispatcher({
    conductor,
    projectRoots: () => [],
    ownedRoots: () => [],
    ...(overrides.owner === false ? {} : { ownerPrincipalId: () => OWNER }),
    ...(overrides.bundles === false ? {} : { contextBundles: () => createContextBundles({ db }) }),
    onSettled: () => {
      settled = true;
    },
    runWorker: async (options) => {
      seen = options;
      return emptyResult();
    },
  });
  dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: conductor.nodeId });
  const deadline = Date.now() + 5_000;
  while (!settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (seen === undefined) throw new Error("no worker was started");
  return seen;
}

const GOAL = "tổng hợp báo cáo tuần trong thư mục docs";

describe("a dispatched task's context", () => {
  it("is a count in the brief and a reader on the host channel", async () => {
    const options = await dispatchOnce(GOAL);
    expect(options.brief.contextItems).toBe(1);
    // Nothing of the text crosses into the brief file.
    expect(JSON.stringify(options.brief)).not.toContain("Báo cáo tuần được lưu");
    const listed = (await options.onContext?.({})) as { kind: string; text: string };
    expect(listed.kind).toBe("done");
    expect(listed.text.split("\n")[0]).toBe(BUNDLE_DATA_HEADER);
    const item = (await options.onContext?.({ item: "c1" })) as { kind: string; text: string };
    expect(item.text).toContain("Báo cáo tuần được lưu trong thư mục docs");
  });

  it("is not retrieved without the owner, or with the planner off", async () => {
    for (const overrides of [{ owner: false }, { bundles: false }]) {
      const options = await dispatchOnce(GOAL, overrides);
      expect(options.brief.contextItems).toBeUndefined();
      expect(options.onContext).toBeUndefined();
      runtime?.close();
      runtime = undefined;
    }
  });

  it("gives no context tool for a goal nothing matches", async () => {
    const options = await dispatchOnce("kiểm tra thời tiết ngày mai ở Đà Lạt");
    expect(options.brief.contextItems).toBeUndefined();
    expect(options.onContext).toBeUndefined();
  });
});

describe("a worker process reads its context over the host channel", () => {
  it("asks the host on demand, and reading context is not evidence of anything", async () => {
    scratch = mkdtempSync(join(tmpdir(), "cc-task-context-script-"));
    const scriptPath = join(scratch, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify([{ callTools: [{ name: "read_context", params: {} }, { name: "read_context", params: { item: "c1" } }], reply: "đã đọc" }]),
      "utf8",
    );
    const asked: unknown[] = [];
    const result = await runWorkerProcess({
      nodeId: "node_test",
      scriptPath,
      timeoutMs: 20_000,
      brief: {
        runId: "run_ctx",
        taskId: "task_ctx",
        taskRevision: 0,
        leaseEpoch: 1,
        goal: GOAL,
        projectRoots: [],
        allowedCapabilityRefs: [],
        contextItems: 1,
      },
      onContext: async (request) => {
        asked.push(request);
        return { kind: "done", text: `${BUNDLE_DATA_HEADER}\nc1 · ghi nhớ (decision): báo cáo ở docs` };
      },
    });
    expect(asked).toEqual([{}, { item: "c1" }]);
    expect(result.record.evidence).toHaveLength(1);
    expect(result.record.evidence[0]?.verdict).toBe("not-verified");
  }, 25_000);
});
