import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConversationId, Instant, Principal } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, type ConductorDeps } from "@clarkcant/core";
import { getTask, getWorkRun, recordWorkRun, type WorkRunRecord } from "@clarkcant/storage";

import { bootRuntime, type Runtime } from "../src/node.ts";
import { createWorkJournal } from "../src/work-journal.ts";
import { createWorkSupervisor } from "../src/work-supervisor.ts";
import { RERUN_WINDOW_MS, WORK_RUN_RETENTION_MS, recoverUnfinishedWork, type WorkRecoveryDeps } from "../src/work-recovery.ts";

/**
 * What a boot does with the work an earlier process left open.
 *
 * Each case writes the `work_runs` rows a crashed process would have left, then runs the recovery pass with the
 * process-identity seams injected: a real pid cannot be made to survive a test's own "crash", and the rule under test
 * is which rows are acted on, not whether `kill` works (process-tree.spec.ts proves that).
 */

const AT = "2026-09-24T07:00:00.000Z" as Instant;
const CONVERSATION_ID = "conv_recovery" as ConversationId;
const PRINCIPAL: Principal = { principalId: "user_test", kind: "user", nodeId: "node_test" as never };
const OLD_BOOT = "boot-previous";
const THIS_BOOT = "boot-current";
const MACHINE = "machine-boot-1";

let runtime: Runtime | undefined;

afterEach(() => {
  runtime?.close();
  runtime = undefined;
});

function boot(): Runtime {
  runtime = bootRuntime({ dataDir: mkdtempSync(join(tmpdir(), "cc-work-recovery-")), label: "work recovery test node" });
  runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(CONVERSATION_ID, runtime.identity.nodeId, AT, AT);
  return runtime;
}

function leftRun(node: Runtime, overrides: Partial<WorkRunRecord> & Pick<WorkRunRecord, "workId" | "kind">): void {
  recordWorkRun(node.db, {
    nodeId: node.identity.nodeId,
    conversationId: CONVERSATION_ID,
    title: `left ${overrides.workId}`,
    nodeBootId: OLD_BOOT,
    state: "running",
    effectful: overrides.kind !== "background",
    attempt: 0,
    startedAt: AT,
    ...overrides,
  });
}

function recover(
  node: Runtime,
  overrides: Partial<WorkRecoveryDeps> = {},
): { report: ReturnType<typeof recoverUnfinishedWork>; said: string[]; reruns: string[]; signalled: number[] } {
  const said: string[] = [];
  const reruns: string[] = [];
  const signalled: number[] = [];
  let counter = 0;
  const report = recoverUnfinishedWork({
    db: node.db,
    nodeId: node.identity.nodeId,
    nodeBootId: THIS_BOOT,
    machineBootId: MACHINE,
    now: () => AT,
    newId: (prefix) => `${prefix}_${String((counter += 1))}`,
    policyMode: () => "autonomous",
    report: (_conversationId, text) => said.push(text),
    rerun: (run) => {
      reruns.push(run.workId);
      return true;
    },
    isSameProcess: () => true,
    signalGroup: (pgid) => signalled.push(pgid),
    ...overrides,
  });
  return { report, said, reruns, signalled };
}

describe("recovering work an earlier process left open", () => {
  it("reports an interrupted command once in its conversation and never re-runs it", () => {
    const node = boot();
    leftRun(node, { workId: "cmd-1", kind: "command", title: "npm publish" });

    const { report, said, reruns } = recover(node);

    expect(report.interrupted).toBe(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("npm publish");
    expect(said[0]).toContain("chưa được kiểm chứng");
    expect(reruns).toEqual([]);
    expect(getWorkRun(node.db, "cmd-1")?.state).toBe("interrupted");

    // A second boot finds nothing left to say.
    expect(recover(node).said).toEqual([]);
  });

  it("re-runs effect-free background work once, in Autonomous mode, within a day", () => {
    const node = boot();
    leftRun(node, { workId: "bg-1", kind: "background", requestText: "summarise the report" });

    const { report, said, reruns } = recover(node);

    expect(reruns).toEqual(["bg-1"]);
    expect(report.rerun).toBe(1);
    expect(said[0]).toContain("chạy lại nó một lần");
  });

  it("asks instead of re-running when the mode is not Autonomous, the run is old, or it was already re-run", () => {
    const node = boot();
    const old = new Date(Date.parse(AT) - RERUN_WINDOW_MS - 1_000).toISOString() as Instant;
    leftRun(node, { workId: "bg-old", kind: "background", requestText: "x", startedAt: old });
    leftRun(node, { workId: "bg-again", kind: "background", requestText: "x", attempt: 1 });

    const guarded = recover(node);
    expect(guarded.reruns).toEqual([]);
    expect(guarded.said.every((text) => text.includes("Nhắn lại nếu bạn vẫn cần"))).toBe(true);

    node.close();
    const other = boot();
    leftRun(other, { workId: "bg-new", kind: "background", requestText: "x" });
    expect(recover(other, { policyMode: () => "guarded" }).reruns).toEqual([]);
  });

  it("asks when a re-run is refused, rather than claiming it is running", () => {
    const node = boot();
    leftRun(node, { workId: "bg-1", kind: "background", requestText: "x" });

    const { said, report } = recover(node, { rerun: () => false });

    expect(report.rerun).toBe(0);
    expect(said[0]).toContain("chưa xong");
  });

  it("leaves rows written by this process alone", () => {
    const node = boot();
    leftRun(node, { workId: "cmd-now", kind: "command", nodeBootId: THIS_BOOT });

    expect(recover(node).report.interrupted).toBe(0);
    expect(getWorkRun(node.db, "cmd-now")?.state).toBe("running");
  });
});

describe("stopping a process an earlier node left running", () => {
  const withProcess = { pid: 4242, pgid: 4242, procStartTime: "987654", machineBootId: MACHINE };

  it("signals the group when pid, start time and machine boot all match", () => {
    const node = boot();
    leftRun(node, { workId: "cmd-1", kind: "command", ...withProcess });

    const { signalled, report, said } = recover(node);

    expect(signalled).toEqual([4242]);
    expect(report.reaped).toBe(1);
    expect(said[0]).toContain("tiến trình còn sót");
  });

  it("never signals a pid the kernel has given to another process", () => {
    const node = boot();
    leftRun(node, { workId: "cmd-1", kind: "command", ...withProcess });

    expect(recover(node, { isSameProcess: () => false }).signalled).toEqual([]);
  });

  it("never signals a pid recorded before the machine rebooted, or where the boot cannot be read", () => {
    const node = boot();
    leftRun(node, { workId: "cmd-1", kind: "command", ...withProcess, machineBootId: "machine-boot-0" });
    leftRun(node, { workId: "cmd-2", kind: "command", ...withProcess });

    expect(recover(node, { machineBootId: undefined }).signalled).toEqual([]);
  });
});

describe("tasks this node was executing", () => {
  function executingTask(conductor: ConductorDeps, executionNodeId: string): string {
    const task = createTask(conductor, { conversationId: CONVERSATION_ID, goal: "rename the files", principal: PRINCIPAL });
    applyTaskEvent(conductor, task.taskId, "resolve.start");
    advanceResolving(conductor, task.taskId, { kind: "ready", executionNodeId });
    applyTaskEvent(conductor, task.taskId, "dispatch.acknowledged");
    return task.taskId;
  }

  it("moves them to uncertain through the state machine and says so, without re-running them", () => {
    const node = boot();
    let counter = 0;
    const conductor: ConductorDeps = {
      db: node.db,
      nodeId: node.identity.nodeId,
      now: () => AT,
      newId: (prefix) => `${prefix}_${String((counter += 1))}`,
      sampleRecipes: [],
      validateProps: () => ({ ok: true }),
    };
    const taskId = executingTask(conductor, node.identity.nodeId);

    const { report, said, reruns } = recover(node);

    expect(report.uncertainTasks).toBe(1);
    expect(getTask(node.db, taskId)?.state).toBe("uncertain");
    expect(said.some((text) => text.includes("chưa rõ kết quả"))).toBe(true);
    expect(reruns).toEqual([]);
  });
});

describe("a shutdown followed by a boot", () => {
  it("reports background work the shutdown interrupted, rather than losing it", async () => {
    const node = boot();
    const journal = createWorkJournal({ db: node.db, nodeId: node.identity.nodeId, now: () => AT, nodeBootId: OLD_BOOT });
    const supervisor = createWorkSupervisor({ now: () => AT, backgroundLimit: () => 1, journal });
    const held = (signal: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error)));
    supervisor.submitBackground({ conversationId: CONVERSATION_ID, title: "running one", requestText: "a", run: held });
    supervisor.submitBackground({ conversationId: CONVERSATION_ID, title: "queued one", requestText: "b", run: held });

    await supervisor.drain(200);
    const { report, said } = recover(node, { policyMode: () => "guarded" });

    expect(report.interrupted).toBe(2);
    expect(said.some((text) => text.includes("running one") && text.includes("đang chạy"))).toBe(true);
    expect(said.some((text) => text.includes("queued one") && text.includes("đang chờ"))).toBe(true);
  });
});

describe("the journal the recovery reads", () => {
  it("records a command with its process identity, and its end", () => {
    const node = boot();
    const journal = createWorkJournal({
      db: node.db,
      nodeId: node.identity.nodeId,
      now: () => AT,
      nodeBootId: THIS_BOOT,
      machineBootId: MACHINE,
      procStartTime: () => "555",
    });

    journal.started({ workId: "cmd-1", command: "sleep 60", cwd: "/tmp", startedAt: AT, pid: 77, conversationId: CONVERSATION_ID });
    expect(getWorkRun(node.db, "cmd-1")).toMatchObject({
      kind: "command",
      pid: 77,
      pgid: 77,
      procStartTime: "555",
      machineBootId: MACHINE,
      effectful: true,
      state: "running",
    });

    journal.ended("cmd-1", "done");
    expect(getWorkRun(node.db, "cmd-1")?.state).toBe("done");
  });

  it("does not fail the work when the database cannot take the row", () => {
    const node = boot();
    const journal = createWorkJournal({ db: node.db, nodeId: node.identity.nodeId, nodeBootId: THIS_BOOT });
    node.close();
    runtime = undefined;

    expect(() => journal.ended("cmd-1", "done")).not.toThrow();
  });

  it("prunes ended rows past the retention window", () => {
    const node = boot();
    const old = new Date(Date.parse(AT) - WORK_RUN_RETENTION_MS - 60_000).toISOString() as Instant;
    leftRun(node, { workId: "old", kind: "command", state: "done", startedAt: old, endedAt: old, nodeBootId: THIS_BOOT });

    expect(recover(node).report.pruned).toBe(1);
    expect(getWorkRun(node.db, "old")).toBeUndefined();
  });
});
