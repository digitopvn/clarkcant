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

const NEVER = "the worker was never started";

/**
 * Every dispatcher refusal, beside the English sentence the dispatcher wrote for it before the owner was told it in
 * their own language — copied from the code as it stood, not computed — because that sentence is what the task records
 * and what a peer is sent, and neither may change.
 */
const DISPATCH_REFUSALS: Array<[DispatchRefusal, string]> = [
  [{ code: "stopped-before-start" }, "stopped before a worker was started for it"],
  [
    { code: "capability-busy", capabilityRef: "project.file.read@1", heldUntil: AT },
    `capability project.file.read@1 is busy on this node (held by another run until ${AT}); the task was not run and can be retried`,
  ],
  [
    { code: "capability-busy", capabilityRef: "project.file.read@1", detail: "lease store unavailable" },
    "capability project.file.read@1 is busy on this node (lease store unavailable); the task was not run and can be retried",
  ],
  [
    { code: "browser-not-asked" },
    `refused: a browser task acts only for a person who asked for it in the conversation, and this one was not started that way; ${NEVER}`,
  ],
  [
    { code: "browser-no-sites" },
    `refused: the task carries no checked list of sites, so there is no site it could be allowed onto; ${NEVER}`,
  ],
  [{ code: "browser-sites-mismatch" }, `refused: the sites the task was checked for are not the sites its goal names; ${NEVER}`],
  [
    { code: "unscoped-background" },
    "refused: work nobody asked for in this conversation has to name the folder or repository it may touch, and this task named none, so the worker was never started",
  ],
  [{ code: "root-not-owned", path: "/work/elsewhere" }, "refused: /work/elsewhere is not a root this node owns, so the worker was never started"],
  [
    { code: "data-class", dataClass: "secret", model: "openai/gpt", checked: "model", unread: false },
    "refused: MODEL_DATA_CLASS_UNAVAILABLE: the task carries secret data, and openai/gpt may not receive secret data; nothing was sent to a model and the worker was never started; choose a model that may receive secret data (such as one that runs on this machine), or allow secret for that model in Settings → AI & Routing, and run the task again",
  ],
  [
    { code: "data-class", dataClass: "secret", model: "openai/gpt", checked: "every-candidate", unread: true },
    "refused: MODEL_DATA_CLASS_UNAVAILABLE: the task carries secret data, and what the models this node could start its worker on may receive could not be read; nothing was sent to a model and the worker was never started; run the task again; if this keeps happening, check the model's profile in Settings → AI & Routing",
  ],
  [{ code: "no-model" }, `refused: this node has no model configured to do the work; ${NEVER} and nothing was done`],
  [
    { code: "model-not-chosen", detail: "routing table is empty" },
    `refused: the model for it could not be chosen (routing table is empty); ${NEVER} and nothing was done`,
  ],
  [
    { code: "model-no-tools", model: "local/tiny" },
    `refused: the model this task would run on (local/tiny) cannot call tools, so it could not use the browser; choose one that can in Settings → AI & Routing; ${NEVER} and nothing was done`,
  ],
  [
    { code: "policy-denied", refusal: { code: "prohibited" }, reason: "this node refuses every effect, so no category is exempt" },
    "refused: this node refuses every effect, so no category is exempt",
  ],
  [
    { code: "policy-denied", refusal: { code: "rule", category: "communication" }, reason: "a rule refuses communication effects on this machine" },
    "refused: a rule refuses communication effects on this machine",
  ],
  [
    { code: "policy-denied", refusal: { code: "unknown-mode", mode: "wild" }, reason: 'the execution mode "wild" is not one this build knows' },
    'refused: the execution mode "wild" is not one this build knows',
  ],
  [
    { code: "no-worktree-place" },
    `refused: this node keeps no place for task worktrees, so a repository cannot be worked on; ${NEVER}`,
  ],
  [{ code: "worktree-failed", detail: "fatal: not a git repository" }, `refused: fatal: not a git repository; ${NEVER}`],
  [{ code: "no-browser" }, `refused: this node gives no task a browser; ${NEVER}`],
  [
    { code: "browser-policy-unknown" },
    `refused: the execution policy was never asked about this task, because this node does not know the browser capability; ${NEVER}`,
  ],
  [
    { code: "wall-clock", maxMs: 90_500 },
    "the wall-clock budget of 90500 ms was exhausted before the worker finished; nothing it did was verified; raise the task's budget or re-run it",
  ],
  [{ code: "stopped-during-run" }, "stopped on request before the worker finished; nothing it did was verified"],
  [
    { code: "token-budget", maxTokens: 1000, used: 1500 },
    "the token budget of 1000 was exceeded (the worker used 1500); the run already happened but is not accepted, and can be retried with a higher budget",
  ],
  [{ code: "worker-failed", detail: "spawn ENOENT" }, "the worker could not run: spawn ENOENT"],
  [{ code: "shutting-down" }, "this node is shutting down; the task was not run and can be retried once the node is back"],
  [
    { code: "queue-full", running: 4, waiting: 16 },
    "this node already has 4 task workers running and 16 waiting, which is its limit; the task was not run and can be retried once one finishes",
  ],
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
  it("keeps the English a task records and a peer is sent, word for word, for every dispatcher refusal", () => {
    for (const [reason, sentence] of DISPATCH_REFUSALS) expect(dispatchRefusalMessage(reason), reason.code).toBe(sentence);
  });

  it("is Vietnamese for every reason when no language is named, with no English sentence or raw state left in it", () => {
    for (const reason of [...DISPATCH_REFUSALS.map(([refusal]) => refusal), ...SETTLE_REASONS]) {
      const text = taskSettledText({ message: "unused", reason });
      expect(text, reason.code).toMatch(VIETNAMESE_LETTER);
      expect(text, reason.code).not.toMatch(/\b(refused|the worker|nothing was|the run|the task|unknown|submitted|prepared)\b/u);
      expect(text, reason.code).not.toContain("MODEL_DATA_CLASS_UNAVAILABLE");
    }
  });

  it("has no Vietnamese, internal code or raw state in it for any reason when the owner reads English", () => {
    for (const reason of [...DISPATCH_REFUSALS.map(([refusal]) => refusal), ...SETTLE_REASONS]) {
      const text = taskSettledText({ message: "unused", reason }, "en");
      // An effect's own intent is quoted as written, and these intents are English.
      expect(text, reason.code).not.toMatch(VIETNAMESE_LETTER);
      expect(text, reason.code).not.toContain("MODEL_DATA_CLASS_UNAVAILABLE");
      expect(text, reason.code).not.toMatch(/is still (unknown|submitted|prepared)\b/u);
    }
  });

  it("quotes text the node did not write, in either language, instead of blending it in", () => {
    const quotedDetails: Array<[DispatchRefusal, string]> = [
      [{ code: "worker-failed", detail: "spawn ENOENT" }, "“spawn ENOENT”"],
      [{ code: "model-not-chosen", detail: "routing table is empty" }, "“routing table is empty”"],
      [{ code: "worktree-failed", detail: "fatal: not a git repository" }, "“fatal: not a git repository”"],
      [{ code: "capability-busy", capabilityRef: "project.file.read@1", detail: "lease store unavailable" }, "“lease store unavailable”"],
    ];
    for (const [reason, quote] of quotedDetails) {
      expect(taskSettledText({ message: "", reason }, "en"), reason.code).toContain(quote);
      expect(taskSettledText({ message: "", reason }), reason.code).toContain(quote);
    }
    expect(taskSettledText({ message: "", reason: { code: "worker-failed", detail: "spawn ENOENT" } }, "en")).toBe(
      "the worker could not run: “spawn ENOENT”",
    );
    expect(
      taskSettledText({ message: "", reason: { code: "not-accepted", gate: { kind: "nothing-verified" }, runSummary: "ran the tests" } }, "en"),
    ).toContain("“ran the tests”");
    expect(taskSettledText({ message: "", reason: SETTLE_REASONS[11] as TaskSettleReason }, "en")).toBe(
      "you confirmed “git push origin HEAD” did not take effect; the work stays stopped as you asked",
    );
  });

  it("states the same time budget in both languages", () => {
    const reason: DispatchRefusal = { code: "wall-clock", maxMs: 90_500 };
    expect(taskSettledText({ message: "", reason }, "en")).toContain("90.5 s");
    expect(taskSettledText({ message: "", reason })).toContain("90,5 giây");
  });

  it("words an effect's state rather than naming it", () => {
    expect(taskSettledText({ message: "", reason: { code: "effect-unsettled", effectId: "eff_1", state: "unknown" } }, "en")).toBe(
      "action eff_1 has an unknown outcome; the outcome is undetermined and must be reconciled",
    );
    expect(taskSettledText({ message: "", reason: { code: "effect-unsettled", effectId: "eff_1", state: "submitted" } })).toBe(
      "thao tác eff_1 đã được gửi đi nhưng chưa được xác nhận; kết quả chưa xác định và cần được đối chiếu",
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
