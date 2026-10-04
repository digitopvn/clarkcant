import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConversationId, DataClass, Instant, Principal, TaskRecord } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, type ConductorDeps } from "@clarkcant/core";
import { getTask } from "@clarkcant/storage";

import { createConditionalInstructions } from "../src/conditional-instructions.ts";
import type { BackgroundFallback } from "../src/model-turn.ts";
import { BUNDLE_DATA_HEADER, type ContextBundles, createContextBundles } from "../src/context-bundle.ts";
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

function setup(goal: string, origin?: TaskRecord["origin"]): { conductor: ConductorDeps; task: TaskRecord } {
  scratch ??= mkdtempSync(join(tmpdir(), "cc-task-context-folder-"));
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
  const task = createTask(conductor, {
    conversationId: CONVERSATION_ID,
    goal,
    principal: PRINCIPAL,
    ...(origin === undefined ? {} : { origin, resources: [{ kind: "folder", path: scratch, access: "read" }] }),
  });
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

interface Dispatched {
  options: WorkerProcessOptions | undefined;
  settled: boolean;
  bundles: ContextBundles | undefined;
  leaseHeld: boolean;
  launched: unknown[];
}

async function dispatch(
  goal: string,
  overrides: {
    owner?: boolean;
    bundles?: boolean;
    origin?: TaskRecord["origin"];
    throwing?: "owner" | "bundles";
    /** Start the worker on a model that may receive only these classes. */
    allowed?: readonly DataClass[];
    /** Project instructions kept in the task's folder. */
    instructions?: string;
    /** Why routing fell back to the node's own model, as the launch reports it. */
    fallback?: BackgroundFallback;
    /** Report the worker process as started, so the host writes its audit row. */
    recordsStart?: boolean;
  } = {},
): Promise<Dispatched> {
  const { conductor, task } = setup(goal, overrides.origin);
  if (overrides.instructions !== undefined && scratch !== undefined) {
    mkdirSync(join(scratch, ".clarkcant", "instructions"), { recursive: true });
    writeFileSync(join(scratch, ".clarkcant", "instructions.json"), JSON.stringify({ rules: [{ include: ["style"] }] }), "utf8");
    writeFileSync(join(scratch, ".clarkcant", "instructions", "style.md"), overrides.instructions, "utf8");
  }
  const instructionRoot = scratch ?? "";
  const db = conductor.db;
  const bundles = overrides.bundles === false ? undefined : createContextBundles({ db });
  let seen: WorkerProcessOptions | undefined;
  let settled = false;
  const launched: unknown[] = [];
  const allowed = overrides.allowed;
  const dispatcher = createTaskDispatcher({
    conductor,
    ...(overrides.instructions === undefined
      ? {}
      : { conditionalInstructions: () => createConditionalInstructions({ roots: () => [instructionRoot] }) }),
    ...(allowed === undefined
      ? {}
      : {
          workerModel: {
            available: () => true,
            launch: async (work) => {
              launched.push(work);
              return {
                model: { provider: "acme", id: "narrow" },
                via: "configured" as const,
                ...(overrides.fallback === undefined ? {} : { fallback: overrides.fallback }),
                credentialSource: "model-config" as const,
              };
            },
          },
          allowedDataClasses: (model: { provider: string; id: string }) => (model.id === "narrow" ? allowed : ["public", "internal"]),
        }),
    projectRoots: () => [scratch ?? ""],
    ownedRoots: () => [scratch ?? ""],
    ...(overrides.owner === false
      ? {}
      : {
          ownerPrincipalId: () => {
            if (overrides.throwing === "owner") throw new Error("identity unavailable");
            return OWNER;
          },
        }),
    ...(bundles === undefined
      ? {}
      : {
          contextBundles: () => {
            if (overrides.throwing === "bundles") throw new Error("bundle cache unavailable");
            return bundles;
          },
        }),
    onSettled: () => {
      settled = true;
    },
    runWorker: async (options) => {
      seen = options;
      // A worker process "exists" here, which is when the host writes which model it was started on.
      if (overrides.recordsStart === true) options.onChild?.({ pid: undefined } as ChildProcess);
      return emptyResult();
    },
  });
  dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: conductor.nodeId });
  const deadline = Date.now() + 5_000;
  while (!settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const leaseHeld = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE holder_task_id = ? AND released_at IS NULL").get(task.taskId) as {
    n: number;
  };
  return { options: seen, settled, bundles, leaseHeld: leaseHeld.n > 0, launched };
}

async function dispatchOnce(goal: string, overrides: { owner?: boolean; bundles?: boolean } = {}): Promise<WorkerProcessOptions> {
  const { options } = await dispatch(goal, overrides);
  if (options === undefined) throw new Error("no worker was started");
  return options;
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

  it("is not given to work a peer delegated, an automation started or a signal raised", async () => {
    const others: TaskRecord["origin"][] = [
      { kind: "delegated", principalId: OWNER, peerNodeId: "node_peer", delegationId: "del_1", allowedCategories: [] },
      { kind: "persistent", principalId: OWNER, intentId: "intent_1", triggerSignalId: "signal_1", allowedCategories: [] },
      { kind: "system", reason: "the node's own maintenance" },
    ];
    for (const origin of others) {
      const { options, bundles } = await dispatch(GOAL, { origin });
      if (options === undefined) throw new Error(`no worker was started for a ${String(origin?.kind)} task`);
      expect(options.brief.contextItems).toBeUndefined();
      // No reader on the host channel, so a read_context the worker made up would reach nothing.
      expect(options.onContext).toBeUndefined();
      // Nothing of the owner's was even retrieved for it.
      expect(bundles?.stats().built).toBe(0);
      runtime?.close();
      runtime = undefined;
    }
  });

  it("still settles, and releases its lease, when retrieving context throws", async () => {
    for (const throwing of ["owner", "bundles"] as const) {
      const outcome = await dispatch(GOAL, { throwing });
      expect(outcome.settled).toBe(true);
      expect(outcome.leaseHeld).toBe(false);
      expect(outcome.options?.brief.contextItems).toBeUndefined();
      runtime?.close();
      runtime = undefined;
    }
  });

  it("routes by the goal's data class, and is narrowed to what the launched model may receive", async () => {
    const goal = `${GOAL}, gửi kết quả cho duy@example.com`;
    const narrowed = await dispatch(goal, { allowed: ["public"] });
    expect(narrowed.launched).toEqual([{ dataClass: "confidential" }]);
    // The note is internal and this model may receive only public data: no reader, no count, nothing retrieved shown.
    expect(narrowed.options?.brief.contextItems).toBeUndefined();
    expect(narrowed.options?.onContext).toBeUndefined();
    runtime?.close();
    runtime = undefined;

    const wide = await dispatch(GOAL, { allowed: ["public", "internal"] });
    expect(wide.launched).toEqual([{ dataClass: "internal" }]);
    expect(wide.options?.brief.contextItems).toBe(1);
  });

  it("records on the audit trail why its model is the node's own when routing fell back", async () => {
    const trail = (): string[] =>
      (runtime?.db.prepare("SELECT summary FROM audit_log WHERE kind = 'model'").all() as { summary: string }[]).map(
        (row) => row.summary,
      );
    const goal = `${GOAL}, gửi kết quả cho duy@example.com`;
    const cases: Array<{ fallback?: BackgroundFallback; says: string }> = [
      {
        fallback: { reason: "data-class", dataClass: "confidential" },
        says: "(the model this node runs, because no model in the pool may receive confidential data; key from",
      },
      { fallback: { reason: "route-failed" }, says: "(the model this node runs, because routing failed; key from" },
      { says: "(the model this node runs; key from" },
    ];
    for (const { fallback, says } of cases) {
      await dispatch(goal, {
        allowed: ["public", "internal", "confidential"],
        recordsStart: true,
        ...(fallback === undefined ? {} : { fallback }),
      });
      const rows = trail();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("worker started on acme/narrow");
      expect(rows[0]).toContain(says);
      // The class is named, never the text that made the goal that class.
      expect(rows[0]).not.toContain("duy@example.com");
      runtime?.close();
      runtime = undefined;
    }
  });

  it("carries the project's instructions for its folders in the brief, and none without them", async () => {
    const withThem = await dispatch(GOAL, { instructions: "Viết báo cáo bằng tiếng Việt có dấu." });
    expect(withThem.options?.brief.instructions).toContain("Viết báo cáo bằng tiếng Việt có dấu.");
    expect(withThem.options?.brief.instructions).toContain('/.clarkcant/instructions/style.md">');
    runtime?.close();
    runtime = undefined;
    const without = await dispatch(GOAL);
    expect(without.options?.brief.instructions).toBeUndefined();
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

  it("does not offer commands a host that answers only context would refuse", async () => {
    scratch = mkdtempSync(join(tmpdir(), "cc-task-context-script-"));
    const scriptPath = join(scratch, "script.json");
    writeFileSync(scriptPath, JSON.stringify([{ callTool: { name: "run_command", params: { command: "node", args: ["--version"] } }, reply: "x" }]), "utf8");
    const outcome = await runWorkerProcess({
      nodeId: "node_test",
      scriptPath,
      timeoutMs: 20_000,
      brief: {
        runId: "run_ctx_only",
        taskId: "task_ctx_only",
        taskRevision: 0,
        leaseEpoch: 1,
        goal: GOAL,
        projectRoots: [scratch],
        allowedCapabilityRefs: ["project.command.run@1"],
        contextItems: 1,
      },
      onContext: async () => ({ kind: "done", text: BUNDLE_DATA_HEADER }),
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: String(error) }),
    );
    if (!("result" in outcome)) throw new Error(`the worker did not run: ${outcome.error}`);
    // Never offered, so the call never reached the host to be refused there.
    expect(outcome.result.record.evidence[0]?.summary).toContain("tool run_command is not active");
  }, 25_000);
});
