import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type ExecutionPolicyConfig } from "@clarkcant/contracts";
import type { ExecutionIntent } from "@clarkcant/core";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import type { CommandToolDeps } from "../src/node-tools.ts";
import { ownedResources } from "../src/preflight.ts";
import { listRunningCommands, stopCommandsForTask, type CommandOutcome } from "../src/run-command.ts";
import { createWorkerCommandBroker, parseWorkerCommandRequest } from "../src/worker-command-broker.ts";

/**
 * Commands a task's worker asks the host to run.
 *
 * The worker has no shell of its own, so this is the one place a background task's command can become a process. Each
 * case below is a boundary the conversation's `run_command` already holds, held again for a caller nobody is watching:
 * the task's own folders and no others, a policy that would ask is a refusal rather than a wait, and what did run is
 * written down.
 */

let dir: string;
let taskRoot: string;
let elsewhere: string;
let database: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-broker-"));
  taskRoot = join(dir, "task-root");
  elsewhere = join(dir, "someone-elses");
  mkdirSync(taskRoot, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  database = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(database);
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

type Audited = { summary: string; outcome: string; ref?: string };

function makeBroker(options: {
  policy?: Partial<ExecutionPolicyConfig>;
  intent?: ExecutionIntent;
  roots?: readonly string[];
  run?: CommandToolDeps["run"] | "real";
} = {}): {
  broker: ReturnType<typeof createWorkerCommandBroker>;
  runs: { command: string; cwd: string }[];
  audited: Audited[];
  effects: () => number;
} {
  const runs: { command: string; cwd: string }[] = [];
  const audited: Audited[] = [];
  const inForce: ExecutionPolicyConfig = { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...options.policy };
  const run: CommandToolDeps["run"] =
    options.run === "real"
      ? undefined
      : (options.run ??
        (async (request): Promise<CommandOutcome> => {
          runs.push({ command: request.command, cwd: request.cwd });
          return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 3, timedOut: false };
        }));
  const deps: CommandToolDeps = {
    autonomy: () => inForce,
    // The node's own roots include a folder the task was not given: the broker must not fall back to them.
    resources: () => ownedResources([taskRoot, elsewhere]),
    fallbackCwd: () => elsewhere,
    guardrails: async () => ({ status: "allow" }),
    newId: () => `op_${runs.length + audited.length}`,
    audit: (event) => audited.push(event),
    effectAudit: () => ({
      deps: {
        db: database,
        nodeId: "node_local",
        now: () => "2026-09-29T00:00:00.000Z" as never,
        newId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2)}`,
      },
      principalId: "principal_1",
    }),
    ...(run === undefined ? {} : { run }),
  };
  const broker = createWorkerCommandBroker({
    command: deps,
    taskId: "task_broker",
    conversationId: "conv_1",
    roots: options.roots ?? [taskRoot],
    intent: options.intent ?? { kind: "interactive" },
  });
  const effects = (): number =>
    (database.prepare("SELECT count(*) AS n FROM events WHERE kind = 'effect.executed'").get() as { n: number }).n;
  return { broker, runs, audited, effects };
}

describe("reading what a worker sent", () => {
  it("takes a command and the optional fields, trimmed", () => {
    expect(parseWorkerCommandRequest({ command: "  git status ", cwd: " sub ", why: "check" })).toEqual({
      command: "git status",
      cwd: "sub",
      why: "check",
    });
  });

  it("refuses anything that is not a request, rather than guessing at it", () => {
    for (const value of [
      undefined,
      null,
      "git status",
      ["git status"],
      {},
      { command: "" },
      { command: "   " },
      { command: 42 },
      { command: "ls", cwd: 7 },
      { command: "x".repeat(4001) },
      { command: "ls", why: "y".repeat(1001) },
    ]) {
      expect(parseWorkerCommandRequest(value)).toBeUndefined();
    }
  });
});

describe("a background task's command goes through the host's own path", () => {
  it("runs an allowed command in the task's folder, and writes it down twice", async () => {
    const { broker, runs, audited, effects } = makeBroker({ policy: { mode: "autonomous" } });
    const reply = await broker({ command: "git status", why: "see what changed" });

    expect(reply.kind).toBe("ran");
    expect(runs).toEqual([{ command: "git status", cwd: taskRoot }]);
    expect(audited.map((event) => event.outcome)).toEqual(["done"]);
    expect(audited[0]?.summary).toContain("task_broker");
    expect(effects()).toBe(1);
  });

  it("refuses a folder the node owns but the task was not given, and runs nothing", async () => {
    const { broker, runs, audited } = makeBroker({ policy: { mode: "autonomous" } });
    const reply = await broker({ command: "git status", cwd: elsewhere });

    expect(reply.kind).toBe("refused");
    expect(runs).toEqual([]);
    expect(audited.map((event) => event.outcome)).toEqual(["refused"]);
  });

  it("refuses when the task has no folder at all", async () => {
    const { broker, runs } = makeBroker({ roots: [] });
    const reply = await broker({ command: "git status" });
    expect(reply).toEqual({ kind: "refused", text: expect.stringContaining("no folder") });
    expect(runs).toEqual([]);
  });

  it("does not run what the policy would ask a person about, and says why instead of waiting", async () => {
    const { broker, runs, audited } = makeBroker({ policy: { mode: "ask" } });
    const reply = await broker({ command: "pnpm test" });

    expect(reply.kind).toBe("refused");
    if (reply.kind !== "refused") return;
    expect(reply.text).toContain("does not wait");
    expect(runs).toEqual([]);
    expect(audited.map((event) => event.outcome)).toEqual(["refused"]);
  });

  it("refuses everything on a node that refuses every effect", async () => {
    const { broker, runs } = makeBroker({ policy: { mode: "autonomous", prohibition: "all" } });
    expect((await broker({ command: "git status" })).kind).toBe("refused");
    expect(runs).toEqual([]);
  });
});

describe("whose intent a background command carries", () => {
  it("pushes for an automation that was given external writes", async () => {
    const { broker, runs } = makeBroker({
      policy: { mode: "autonomous" },
      intent: { kind: "persistent", allowedCategories: ["local-write", "external-write"] },
    });
    expect((await broker({ command: "git push origin HEAD" })).kind).toBe("ran");
    expect(runs.map((run) => run.command)).toEqual(["git push origin HEAD"]);
  });

  it("does not push for an automation that was only given local changes", async () => {
    const { broker, runs } = makeBroker({
      policy: { mode: "autonomous" },
      intent: { kind: "persistent", allowedCategories: ["local-write"] },
    });
    const reply = await broker({ command: "git push origin HEAD" });
    expect(reply.kind).toBe("refused");
    if (reply.kind !== "refused") return;
    expect(reply.text).toContain("automation was not given it");
    expect(runs).toEqual([]);
  });

  it("does not push for the node's own work", async () => {
    const { broker, runs } = makeBroker({ policy: { mode: "autonomous" }, intent: { kind: "system" } });
    expect((await broker({ command: "git push origin HEAD" })).kind).toBe("refused");
    expect(runs).toEqual([]);
  });
});

describe("stopping a task stops what it started on the host", () => {
  it("ends a real command the task's worker is still running", async () => {
    const { broker } = makeBroker({ policy: { mode: "autonomous" }, run: "real" });
    const long = process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30";
    const pending = broker({ command: long });

    // Wait until the command is actually a process on the host, then stop the task.
    const started = Date.now();
    while (!listRunningCommands().some((running) => running.taskId === "task_broker")) {
      if (Date.now() - started > 10_000) throw new Error("the command never started");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(stopCommandsForTask("task_broker")).toBe(1);

    const reply = await pending;
    expect(reply.kind).toBe("ran");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(listRunningCommands().some((running) => running.taskId === "task_broker")).toBe(false);
    // Another task's id reaches nothing.
    expect(stopCommandsForTask("task_other")).toBe(0);
  }, 30_000);
});
