import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant, Principal } from "@clarkcant/contracts";
import { advanceResolving, applyTaskEvent, createTask, setPreference, type TaskSettleReason } from "@clarkcant/core";
import { allRows } from "@clarkcant/storage";

import { noticeText } from "../src/notice-text.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createTaskDispatcher, type TaskDispatcherDeps } from "../src/task-dispatch.ts";
import { taskDispatchReports } from "../src/task-reporting.ts";
import { type DispatchRefusal, dispatchRefusalMessage, taskSettledText } from "../src/task-settled-text.ts";
import type { WorkerProcessResult } from "../src/worker-process.ts";

/**
 * A settled task is told to its owner in one language, title and body alike.
 *
 * The host writes its own sentence when a task ends without the run's words to show: the run reported nothing, the
 * dispatcher refused it, a stop raced it. That sentence is what the task records and what a peer that handed the task
 * over is sent, unchanged, in English. The owner reads it worded again from its reason, in their `experience.language`,
 * so a Vietnamese title never sits over an English sentence.
 */

const AT = "2026-10-06T09:00:00.000Z" as Instant;

/** Any letter only Vietnamese writes. */
const VIETNAMESE_LETTER = /[ăâđêôơưạảãàáậầấẩẫặằắẳẵẹẻẽèéệềếểễịỉĩìíọỏõòóộồốổỗợờớởỡụủũùúựừứửữỵỷỹỳýĐ]/iu;

const DISPATCH_REFUSALS: DispatchRefusal[] = [
  { code: "stopped-before-start" },
  { code: "capability-busy", capabilityRef: "project.file.read@1", heldUntil: AT },
  { code: "capability-busy", capabilityRef: "project.file.read@1", detail: "lease store unavailable" },
  { code: "browser-not-asked" },
  { code: "browser-no-sites" },
  { code: "browser-sites-mismatch" },
  { code: "unscoped-background" },
  { code: "root-not-owned", path: "/work/elsewhere" },
  { code: "data-class", dataClass: "secret", model: "openai/gpt", checked: "model", unread: false },
  { code: "data-class", dataClass: "secret", model: "openai/gpt", checked: "every-candidate", unread: true },
  { code: "no-model" },
  { code: "model-not-chosen", detail: "routing table is empty" },
  { code: "model-no-tools", model: "local/tiny" },
  { code: "policy-denied", refusal: { code: "prohibited" }, reason: "this node refuses every effect, so no category is exempt" },
  { code: "policy-denied", refusal: { code: "rule", category: "communication" }, reason: "a rule refuses communication effects on this machine" },
  { code: "policy-denied", refusal: { code: "unknown-mode", mode: "wild" }, reason: 'the execution mode "wild" is not one this build knows' },
  { code: "no-worktree-place" },
  { code: "worktree-failed", detail: "fatal: not a git repository" },
  { code: "no-browser" },
  { code: "browser-policy-unknown" },
  { code: "wall-clock", maxMs: 90_000 },
  { code: "stopped-during-run" },
  { code: "token-budget", maxTokens: 1000, used: 1500 },
  { code: "worker-failed", detail: "spawn ENOENT" },
  { code: "shutting-down" },
  { code: "queue-full", running: 4, waiting: 16 },
];

const SETTLE_REASONS: TaskSettleReason[] = [
  { code: "task-missing" },
  { code: "already-ended" },
  { code: "no-evidence" },
  { code: "stopped-unreported" },
  { code: "finished-after-stop" },
  { code: "finished-after-stop", runSummary: "pushed the branch" },
  { code: "effect-unsettled", effectId: "eff_1", state: "unknown" },
  { code: "not-accepted", gate: { kind: "no-evidence" } },
  { code: "not-accepted", gate: { kind: "nothing-verified" }, runSummary: "ran the tests" },
  { code: "not-accepted", gate: { kind: "contradicted", summary: "3 tests failed" } },
  { code: "not-accepted", gate: { kind: "effect-unsettled", effectId: "eff_1", state: "submitted" } },
  { code: "reconciled", stopped: true, didNotLand: "git push origin HEAD — /work/repo", landed: [], unverified: false },
  { code: "reconciled", stopped: true, landed: ["git push origin HEAD"], unverified: false },
  { code: "reconciled", stopped: false, didNotLand: "git push origin HEAD", landed: [], unverified: false },
  { code: "reconciled", stopped: false, landed: ["git push origin HEAD"], unverified: true },
  { code: "reconciled", stopped: false, landed: ["git push origin HEAD"], unverified: false },
];

describe("the host's sentence for a settled task", () => {
  it("is the dispatcher's own English, word for word, for an owner who reads English", () => {
    for (const reason of DISPATCH_REFUSALS) {
      expect(taskSettledText({ message: dispatchRefusalMessage(reason), reason }, "en")).toBe(dispatchRefusalMessage(reason));
    }
  });

  it("is Vietnamese for every reason when no language is named", () => {
    for (const reason of [...DISPATCH_REFUSALS, ...SETTLE_REASONS]) {
      const text = taskSettledText({ message: "unused", reason });
      expect(text, reason.code).toMatch(VIETNAMESE_LETTER);
      expect(text, reason.code).not.toMatch(/\b(refused|the worker|nothing was|the run|the task)\b/u);
    }
  });

  it("has no Vietnamese in it for any reason when the owner reads English", () => {
    for (const reason of [...DISPATCH_REFUSALS, ...SETTLE_REASONS]) {
      // An effect's own intent is quoted as written, and these intents are English.
      expect(taskSettledText({ message: "unused", reason }, "en"), reason.code).not.toMatch(VIETNAMESE_LETTER);
    }
  });

  it("quotes text it did not write instead of blending it in", () => {
    expect(taskSettledText({ message: "", reason: { code: "worker-failed", detail: "spawn ENOENT" } })).toContain("“spawn ENOENT”");
    expect(
      taskSettledText({ message: "", reason: { code: "not-accepted", gate: { kind: "nothing-verified" }, runSummary: "ran the tests" } }, "en"),
    ).toContain("“ran the tests”");
    expect(taskSettledText({ message: "", reason: SETTLE_REASONS[11] as TaskSettleReason }, "en")).toBe(
      "you confirmed “git push origin HEAD” did not take effect; the work stays stopped as you asked",
    );
  });

  it("shows the run's own words as they were written when there is no reason", () => {
    expect(taskSettledText({ message: "opened the pull request" })).toBe("opened the pull request");
    expect(taskSettledText({ message: "opened the pull request" }, "en")).toBe("opened the pull request");
  });
});

let dir: string;
let services: NodeServices;
const owner = (): Principal => ({
  principalId: services.runtime.identity.ownerPrincipalId as never,
  kind: "user",
  nodeId: services.runtime.identity.nodeId as never,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-task-settled-language-"));
  services = bootNodeServices({ dataDir: dir, label: "task settled language test node" });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function inEnglish(): void {
  setPreference(
    { db: services.runtime.db, now: () => AT },
    { principalId: services.runtime.identity.ownerPrincipalId, key: "experience.language", scope: "global", value: "en", source: "user" },
  );
}

/** A task already `dispatched`, the way the conductor leaves it before the dispatcher picks it up. */
function dispatchedTask(): { taskId: string; conversationId: string } {
  const conversationId = `conv_settled_${services.conductor.newId("id")}`;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
  const deps = { ...services.conductor, now: () => AT };
  const task = createTask(deps, { conversationId: conversationId as never, goal: "read the report", principal: owner() });
  applyTaskEvent(deps, task.taskId, "resolve.start");
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
  return { taskId: task.taskId, conversationId };
}

/** A worker that ran and reported nothing at all. */
async function silentWorker(): Promise<WorkerProcessResult> {
  return {
    adapter: "fake",
    adapterVersion: "fake-1.0.0",
    stopReason: "settled",
    withheldCapabilities: [],
    record: {
      runId: "run_fake",
      taskId: "task_fake",
      taskRevision: 0,
      executionNodeId: services.runtime.identity.nodeId,
      leaseEpoch: 1,
      startedAt: AT,
      endedAt: AT,
      evidence: [],
    },
    usage: { turns: 1 },
  };
}

type Settled = Parameters<TaskDispatcherDeps["onSettled"]>[0];

/** A dispatcher reporting the way the node does, recording what it was handed. */
function dispatcher(heard: Settled[]) {
  const reports = taskDispatchReports(services);
  return createTaskDispatcher({
    conductor: services.conductor,
    projectRoots: () => [],
    ownedRoots: () => [],
    onSettled: (input) => {
      heard.push(input);
      reports.onSettled(input);
    },
    runWorker: silentWorker,
  });
}

async function settledOnce(heard: Settled[]): Promise<Settled> {
  for (let attempt = 0; attempt < 200 && heard.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const [settled] = heard;
  if (settled === undefined) throw new Error("the task was never settled");
  return settled;
}

function told(taskId: string, conversationId: string): { line: string; title: string; body: string } {
  const lines = allRows<{ document: string }>(
    services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY rowid",
    conversationId,
  ).flatMap((row) => {
    const message = JSON.parse(row.document) as { role: string; blocks: { content?: string }[] };
    return message.role === "assistant" ? message.blocks.map((block) => block.content ?? "") : [];
  });
  const [notice] = allRows<{ title: string; body: string }>(
    services.runtime.db,
    "SELECT title, body FROM notifications WHERE dedup_key = ?",
    `worker:${taskId}`,
  );
  const line = lines.find((text) => text.includes(`(task ${taskId}):`));
  if (line === undefined || notice === undefined) throw new Error("the owner was not told");
  return { line, ...notice };
}

describe("a settled task, as its owner is told it", () => {
  it("words a run that reported nothing in English, title and body, for an owner who chose English", async () => {
    inEnglish();
    const { taskId, conversationId } = dispatchedTask();
    const heard: Settled[] = [];
    dispatcher(heard).dispatch({ taskId, capabilityRef: "project.file.read@1", executionNodeId: services.runtime.identity.nodeId });
    const settled = await settledOnce(heard);

    expect(settled.reason).toEqual({ code: "no-evidence" });
    const { line, title, body } = told(taskId, conversationId);
    expect(title).toBe(noticeText("en").workerOutcome.failed);
    expect(body).toBe("the run produced no evidence, so it is reported as failed rather than as success");
    expect(line).toBe(`Did not finish (task ${taskId}): ${body}`);
    expect(`${title}\n${body}\n${line}`).not.toMatch(VIETNAMESE_LETTER);
  });

  it("words the same run in Vietnamese, title and body, by default, and keeps the English sentence for a peer", async () => {
    const { taskId, conversationId } = dispatchedTask();
    const heard: Settled[] = [];
    dispatcher(heard).dispatch({ taskId, capabilityRef: "project.file.read@1", executionNodeId: services.runtime.identity.nodeId });
    const settled = await settledOnce(heard);

    // What the task records and a peer is sent is unchanged.
    expect(settled.message).toBe("the run produced no evidence, so it is reported as failed rather than as success");
    const { line, title, body } = told(taskId, conversationId);
    expect(title).toBe(noticeText("vi").workerOutcome.failed);
    expect(body).toBe("lần chạy không tạo ra bằng chứng nào, nên được báo là không xong chứ không phải thành công");
    expect(line).toBe(`Không xong (task ${taskId}): ${body}`);
  });

  it("words a refusal by the dispatcher in the owner's language, in the same language as its title", async () => {
    for (const english of [false, true]) {
      if (english) inEnglish();
      const { taskId, conversationId } = dispatchedTask();
      const heard: Settled[] = [];
      const shut = dispatcher(heard);
      shut.close();
      shut.dispatch({ taskId, capabilityRef: "project.file.read@1", executionNodeId: services.runtime.identity.nodeId });
      const settled = await settledOnce(heard);

      expect(settled.reason).toEqual({ code: "shutting-down" });
      expect(settled.message).toBe("this node is shutting down; the task was not run and can be retried once the node is back");
      const { title, body } = told(taskId, conversationId);
      if (english) {
        expect(title).toBe(noticeText("en").workerOutcome.failed);
        expect(body).toBe(settled.message);
        expect(`${title}\n${body}`).not.toMatch(VIETNAMESE_LETTER);
      } else {
        expect(title).toBe(noticeText("vi").workerOutcome.failed);
        expect(body).toBe("node này đang tắt; việc chưa được chạy và có thể thử lại khi node chạy lại");
      }
    }
  });
});
