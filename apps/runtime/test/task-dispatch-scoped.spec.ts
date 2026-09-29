import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ConversationId,
  type Instant,
  type IntentOrigin,
  type Principal,
  type TaskRecord,
  type TaskResource,
} from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, registerCapability, type ConductorDeps } from "@clarkcant/core";
import { CONTROLLED_CODE_TASK, managedBranchFor } from "@clarkcant/project-work";
import { getTask } from "@clarkcant/storage";

import type { CommandToolDeps } from "../src/node-tools.ts";
import { bootRuntime, type Runtime } from "../src/node.ts";
import { ownedResources } from "../src/preflight.ts";
import { listRunningCommands } from "../src/run-command.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import { runWorkerProcess, type WorkerProcessResult } from "../src/worker-process.ts";

/**
 * What a dispatched task may touch, decided from the task.
 *
 * A task a person asks for in the conversation keeps the node's folders, as it always has. Work nobody is watching — an
 * automation, a peer, the node's own — names the folders and repositories it may touch and gets exactly those; one that
 * names none never gets a worker. A repository is worked on in a worktree the node makes of it, and the commands the
 * worker needs go to the host over the worker's own channel rather than to a shell of the worker's.
 */

const AT = "2026-09-29T09:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_scoped_dispatch" as ConversationId;
const PRINCIPAL: Principal = { principalId: "user_test", kind: "user", nodeId: "node_test" as never };
const AUTOMATION: IntentOrigin = {
  kind: "persistent",
  principalId: "user_test",
  intentId: "intent_1",
  triggerSignalId: "signal_1",
  allowedCategories: ["read", "local-write"],
};

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.reverse()) step();
  cleanup = [];
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(parent: string): string {
  const path = join(parent, "repo");
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--initial-branch=main"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  writeFileSync(join(path, "readme.txt"), "original\n", "utf8");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

function testNode(): { runtime: Runtime; conductor: ConductorDeps } {
  const runtime = bootRuntime({ dataDir: tempDir("cc-scoped-node-"), label: "scoped dispatch test node" });
  cleanup.push(() => runtime.close());
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
  return { runtime, conductor };
}

function dispatchedTask(
  conductor: ConductorDeps,
  executionNodeId: string,
  input: { origin?: IntentOrigin; resources?: TaskResource[] },
): TaskRecord {
  const task = createTask(conductor, {
    conversationId: CONVERSATION_ID,
    goal: "change the repository",
    principal: PRINCIPAL,
    ...input,
  });
  applyTaskEvent(conductor, task.taskId, "resolve.start");
  advanceResolving(conductor, task.taskId, { kind: "ready", executionNodeId });
  applyTaskEvent(conductor, task.taskId, "dispatch.acknowledged");
  const dispatched = getTask(conductor.db, task.taskId);
  if (dispatched === undefined) throw new Error("test setup: task disappeared right after dispatch");
  return dispatched;
}

function verifiedResult(): WorkerProcessResult {
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
      evidence: [{ kind: "file-diff", summary: "done", verdict: "verified", observedAt: AT }],
    },
    usage: { turns: 1 },
  };
}

function commandDeps(fallback: string): CommandToolDeps {
  return {
    autonomy: () => ({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "autonomous" }),
    resources: () => ownedResources([fallback]),
    fallbackCwd: () => fallback,
    guardrails: async () => ({ status: "allow" }),
    newId: () => `op_${Math.random().toString(36).slice(2)}`,
  };
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("work nobody asked for in the conversation names what it may touch", () => {
  it("refuses an automation's task that named no folder, before any worker exists", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const task = dispatchedTask(conductor, runtime.identity.nodeId, { origin: AUTOMATION });
    let workerStarted = false;
    const settled: { outcome: string; message: string }[] = [];

    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      runWorker: async () => {
        workerStarted = true;
        return verifiedResult();
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 5_000);

    expect(workerStarted).toBe(false);
    expect(settled[0]?.outcome).toBe("failed");
    expect(settled[0]?.message).toContain("named none");
    expect(getTask(conductor.db, task.taskId)?.origin).toEqual(AUTOMATION);
  });

  it("gives a task exactly the folders it named, writable only where it said so", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const readable = join(owned, "docs");
    const writable = join(owned, "src");
    const notGiven = join(owned, "private");
    for (const path of [readable, writable, notGiven]) mkdirSync(path, { recursive: true });
    const task = dispatchedTask(conductor, runtime.identity.nodeId, {
      origin: AUTOMATION,
      resources: [
        { kind: "folder", path: readable, access: "read" },
        { kind: "folder", path: writable, access: "write" },
      ],
    });
    let brief: Parameters<typeof runWorkerProcess>[0] | undefined;
    const settled: string[] = [];

    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      commandDeps: () => commandDeps(owned),
      onSettled: (input) => settled.push(input.outcome),
      runWorker: async (options) => {
        brief = options;
        return verifiedResult();
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CONTROLLED_CODE_TASK.ref, executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 5_000);

    expect(brief?.brief.projectRoots).toEqual([readable, writable]);
    expect(brief?.brief.writableRoots).toEqual([writable]);
    expect(brief?.brief.projectRoots).not.toContain(notGiven);
    expect(brief?.brief.allowedCapabilityRefs).toEqual([
      "project.code.change@1",
      "project.file.read@1",
      "project.command.run@1",
    ]);
    // A worker that may write may ask the host for commands; that channel exists only then.
    expect(typeof brief?.onCommand).toBe("function");
  });

  it("refuses a named folder this node does not own", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const foreign = tempDir("cc-scoped-foreign-");
    const task = dispatchedTask(conductor, runtime.identity.nodeId, {
      origin: AUTOMATION,
      resources: [{ kind: "folder", path: foreign, access: "write" }],
    });
    let workerStarted = false;
    const settled: string[] = [];

    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      onSettled: (input) => settled.push(input.message),
      runWorker: async () => {
        workerStarted = true;
        return verifiedResult();
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CONTROLLED_CODE_TASK.ref, executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 5_000);

    expect(workerStarted).toBe(false);
    expect(settled[0]).toContain("not a root this node owns");
  });

  it("keeps a person's own task on the node's folders when it named none", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const task = dispatchedTask(conductor, runtime.identity.nodeId, {});
    let brief: Parameters<typeof runWorkerProcess>[0] | undefined;
    const settled: string[] = [];

    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      onSettled: (input) => settled.push(input.outcome),
      runWorker: async (options) => {
        brief = options;
        return verifiedResult();
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: "project.file.read@1", executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 5_000);

    expect(getTask(conductor.db, task.taskId)?.origin).toEqual({ kind: "interactive", principalId: "user_test" });
    expect(brief?.brief.projectRoots).toEqual([owned]);
    expect(brief?.brief.writableRoots).toBeUndefined();
    expect(settled).toEqual(["succeeded"]);
  });
});

describe("a repository is worked on in the task's own worktree", () => {
  it("runs a real worker whose command commits on the task's branch, and leaves the person's tree alone", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const repo = makeRepo(owned);
    // Something the person is in the middle of, which nothing the task does may touch.
    writeFileSync(join(repo, "readme.txt"), "a person's unsaved thought\n", "utf8");
    const worktreesDir = join(tempDir("cc-scoped-data-"), "worktrees");

    registerCapability(
      { db: conductor.db, nodeId: runtime.identity.nodeId },
      {
        ...CONTROLLED_CODE_TASK,
        executionNodeId: runtime.identity.nodeId as never,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      },
    );
    const task = dispatchedTask(conductor, runtime.identity.nodeId, {
      origin: AUTOMATION,
      resources: [{ kind: "repository", path: repo }],
    });

    // The model's one tool call: a command, which the worker cannot run itself and asks the host for.
    const scriptFile = join(tempDir("cc-scoped-script-"), "script.json");
    writeFileSync(
      scriptFile,
      JSON.stringify([
        {
          callTool: { name: "run_command", params: { command: "git commit --allow-empty -m task-change", why: "record the change" } },
          reply: "committed",
        },
      ]),
      "utf8",
    );

    const settled: { outcome: string; message: string }[] = [];
    const kept: string[] = [];
    let givenRoots: readonly string[] = [];
    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      worktreesDir: () => worktreesDir,
      commandDeps: () => commandDeps(owned),
      onWorktreeKept: (input) => kept.push(input.path),
      onSettled: (input) => settled.push({ outcome: input.outcome, message: input.message }),
      timeoutMs: 30_000,
      runWorker: (options) => {
        givenRoots = options.brief.projectRoots;
        return runWorkerProcess({ ...options, scriptPath: scriptFile });
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CONTROLLED_CODE_TASK.ref, executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 30_000);

    expect(settled[0]?.outcome).toBe("succeeded");
    // The worker was given the worktree, never the repository the person has open.
    expect(givenRoots).toHaveLength(1);
    expect(givenRoots[0]?.startsWith(worktreesDir)).toBe(true);
    // The commit is on the task's branch; the person's branch and unsaved work are where they were.
    const branch = managedBranchFor(task.taskId);
    expect(git(repo, ["log", "-1", "--format=%s", branch])).toBe("task-change");
    expect(git(repo, ["log", "-1", "--format=%s", "main"])).toBe("initial");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readFileSync(join(repo, "readme.txt"), "utf8")).toBe("a person's unsaved thought\n");
    // A clean worktree is taken away when the task ends; its branch stays.
    expect(existsSync(givenRoots[0] ?? "")).toBe(false);
    expect(kept).toEqual([]);
  }, 40_000);

  it("refuses a repository task on a node that keeps no place for worktrees, rather than working in place", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const repo = makeRepo(owned);
    const task = dispatchedTask(conductor, runtime.identity.nodeId, {
      origin: AUTOMATION,
      resources: [{ kind: "repository", path: repo }],
    });
    let workerStarted = false;
    const settled: string[] = [];

    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      onSettled: (input) => settled.push(input.message),
      runWorker: async () => {
        workerStarted = true;
        return verifiedResult();
      },
    });
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CONTROLLED_CODE_TASK.ref, executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => settled.length > 0, 5_000);

    expect(workerStarted).toBe(false);
    expect(settled[0]).toContain("worker was never started");
  });
});

describe("stopping a task stops the commands its worker started on the host", () => {
  it("ends a long command when the task is stopped", async () => {
    const { runtime, conductor } = testNode();
    const owned = tempDir("cc-scoped-owned-");
    const work = join(owned, "work");
    mkdirSync(work, { recursive: true });
    const task = dispatchedTask(conductor, runtime.identity.nodeId, {
      origin: AUTOMATION,
      resources: [{ kind: "folder", path: work, access: "write" }],
    });
    let commandReply: unknown;
    let release: ((cause: Error) => void) | undefined;
    const settled: string[] = [];

    const dispatcher = createTaskDispatcher({
      conductor,
      projectRoots: () => [owned],
      ownedRoots: () => [owned],
      commandDeps: () => commandDeps(owned),
      onSettled: (input) => settled.push(input.message),
      runWorker: async (options) => {
        options.onChild?.({ kill: () => release?.(new Error("the worker exited on SIGKILL")) } as never);
        const long = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30";
        commandReply = await options.onCommand?.({ command: long });
        await new Promise<void>((_resolve, reject) => {
          release = reject;
        });
        return verifiedResult();
      },
    });
    const started = Date.now();
    dispatcher.dispatch({ taskId: task.taskId, capabilityRef: CONTROLLED_CODE_TASK.ref, executionNodeId: runtime.identity.nodeId });
    await waitUntil(() => listRunningCommands().some((running) => running.taskId === task.taskId), 10_000);

    expect(dispatcher.stop(task.taskId)).toBe(true);
    await waitUntil(() => commandReply !== undefined, 15_000);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(listRunningCommands().some((running) => running.taskId === task.taskId)).toBe(false);
    release?.(new Error("the worker exited on SIGKILL"));
    await waitUntil(() => settled.length > 0, 5_000);
    expect(settled[0]).toContain("stopped on request");
  }, 30_000);
});
