import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type CapabilityRef,
  type Instant,
  type Principal,
  inboxResponseSchema,
  inboxSummarySchema,
} from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  advanceResolving,
  applyTaskEvent,
  createTask,
  registerCapability,
  requestApproval,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { appendMessage, getTask, nextMessageSequence, oneRow } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { QUESTION_TTL_MS, answerQuestion, createQuestion } from "../src/interactions.ts";
import { readInbox } from "../src/inbox.ts";
import { recordNodeNotice, tryRecordNodeNotice, workerSettledNotice } from "../src/notices.ts";
import { createReadInboxTool } from "../src/read-inbox-tool.ts";
import { interactionDepsFor } from "../src/routes/conversations.ts";
import { commandDigest } from "../src/run-command.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createTaskDispatcher } from "../src/task-dispatch.ts";
import type { WorkerProcessResult } from "../src/worker-process.ts";

/**
 * The inbox, over the wire.
 *
 * What is worth asserting is that the inbox never disagrees with the thing it points at: an approval decided on its
 * card is gone from the inbox on the next read, one that ran out of time is gone without anybody deciding it, and a
 * question answered or expired is gone the same way. A list that could hold a stale "waiting" would be a list of
 * buttons that fail, which is worse than no list.
 */

const AT = "2026-09-24T07:00:00.000Z";

let dir: string;
let services: NodeServices;
let now: string;
let deps: GatewayDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-inbox-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  now = AT;
  let sequence = 0;
  deps = {
    services,
    now: () => now,
    newConversationId: () => {
      sequence += 1;
      return `conv_inbox_${sequence}`;
    },
  };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  const request_: GatewayRequest = {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  };
  return handleRequest(deps, request_);
}

async function createConversation(): Promise<string> {
  const response = await request("POST", "/conversations", { title: "Hộp thư" });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

async function readInboxOverHttp() {
  const response = await request("GET", "/inbox");
  expect(response.status).toBe(200);
  return inboxResponseSchema.parse(response.body);
}

/** The card a model turn would have produced, written the way the node writes a message. */
function proposeCommand(conversationId: string, command: string, ttlMs = 900_000, messageAt = now, taskId?: string) {
  const approval = requestApproval(
    {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now: () => now as never,
      newId: services.conductor.newId,
    },
    {
      ...(taskId === undefined ? {} : { taskId }),
      operationDigest: commandDigest(command, dir),
      operationDescription: `Chạy lệnh trong ${dir}`,
      effectCategory: "local-write",
      ttlMs,
    },
  );
  const message = {
    messageId: services.conductor.newId("msg"),
    conversationId,
    role: "assistant" as const,
    blocks: [
      {
        type: "approval-card",
        owner: "host",
        approvalId: approval.approvalId,
        operationDescription: approval.operationDescription,
        operationDigest: approval.operationDigest,
        effectCategory: "local-write",
        expiresAt: approval.expiresAt,
        decider: "user",
        decision: "pending",
        payload: JSON.stringify({ command, cwd: dir }),
      },
    ],
    authorNodeId: services.runtime.identity.nodeId,
    createdAt: messageAt,
    delivery: "accepted" as const,
  };
  appendMessage(services.runtime.db, message as never, nextMessageSequence(services.runtime.db, conversationId));
  return approval;
}

/** Plain messages, so a conversation is longer than the page a reader's timeline shows. */
function chatter(conversationId: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    appendMessage(
      services.runtime.db,
      {
        messageId: services.conductor.newId("msg"),
        conversationId,
        role: index % 2 === 0 ? "user" : "assistant",
        blocks: [{ type: "text", format: "plain", content: `tin nhắn ${index}`, streaming: false }],
        authorNodeId: services.runtime.identity.nodeId,
        createdAt: now,
        delivery: "accepted",
      } as never,
      nextMessageSequence(services.runtime.db, conversationId),
    );
  }
}

/**
 * A task approval as the execution-policy gate in `task-dispatch.ts` raises it: a real task actually parked
 * `waiting_approval` (the state `pendingTaskApprovals` requires before it offers one), and an approval bound to
 * it directly by `taskId` rather than through a card, which task approvals never have.
 */
function raiseTaskApproval(conversationId: string) {
  const principal: Principal = { principalId: "user_inbox_test", kind: "user", nodeId: services.runtime.identity.nodeId as never };
  const taskDeps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as Instant, newId: services.conductor.newId };
  const task = createTask(taskDeps, { conversationId: conversationId as never, goal: "chạy lệnh git status", principal });
  applyTaskEvent(taskDeps, task.taskId, "resolve.start");
  advanceResolving(taskDeps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
  applyTaskEvent(taskDeps, task.taskId, "dispatch.acknowledged");
  const parked = applyTaskEvent(taskDeps, task.taskId, "run.needs_approval");
  if (!parked.ok) throw new Error(`test setup: could not park the task waiting for approval (${parked.message})`);
  const approval = requestApproval(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as never, newId: services.conductor.newId },
    {
      taskId: task.taskId,
      operationDigest: `sha256:task-effect:${task.taskId}:demo.write@1`,
      operationDescription: `Chạy lệnh trong ${dir}`,
      effectCategory: "local-write",
      ttlMs: 900_000,
    },
  );
  return { task: parked.task, approval };
}

function askQuestion(conversationId: string) {
  const created = createQuestion(
    { ...interactionDepsFor(services, conversationId), now: () => now as Instant },
    {
      question: "Chọn môi trường triển khai.",
      kind: "single-choice",
      options: [
        { id: "staging", label: "Staging" },
        { id: "production", label: "Production" },
      ],
    },
  );
  if (!created.ok) throw new Error("the question was not created");
  return created;
}

describe("what is waiting for the person", () => {
  it("lists a command approval with the conversation it belongs to and the command it would run", async () => {
    const conversationId = await createConversation();
    const approval = proposeCommand(conversationId, "git status");

    const inbox = await readInboxOverHttp();
    expect(inbox.waiting).toHaveLength(1);
    expect(inbox.waiting[0]).toMatchObject({
      kind: "command-approval",
      approvalId: approval.approvalId,
      conversationId,
      command: "git status",
      operationDigest: approval.operationDigest,
    });
    expect(inbox.readAt).toBe(AT);

    const summary = inboxSummarySchema.parse((await request("GET", "/inbox/summary")).body);
    expect(summary).toEqual({ waiting: 1, unread: 0 });
  });

  it("finds the card although its turn stamped the message before the approval was requested", async () => {
    // A real turn writes its message with the turn's time and raises the approval a moment later, so the card is
    // older than the row it carries. Looking for it only from the approval's own time onward misses it.
    const conversationId = await createConversation();
    const approval = proposeCommand(conversationId, "git status", 900_000, "2026-09-24T06:59:59.990Z");

    const inbox = await readInboxOverHttp();
    expect(inbox.waiting.map((item) => (item.kind === "command-approval" ? item.approvalId : ""))).toEqual([
      approval.approvalId,
    ]);
  });

  it("drops the approval once it is decided on its card, through the one decide route", async () => {
    const conversationId = await createConversation();
    const approval = proposeCommand(conversationId, "git status");

    const decided = await request("POST", `/conversations/${conversationId}/approvals/${approval.approvalId}/decide`, {
      decision: "denied",
      digest: approval.operationDigest,
    });
    expect(decided.status).toBe(200);
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("drops the approval once it has run out of time, without anybody deciding it", async () => {
    const conversationId = await createConversation();
    proposeCommand(conversationId, "git status", 60_000);
    expect((await readInboxOverHttp()).waiting).toHaveLength(1);

    now = new Date(Date.parse(AT) + 61_000).toISOString();
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("does not offer an approval whose card it cannot find, since deciding it could only fail", async () => {
    requestApproval(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as never, newId: services.conductor.newId },
      { operationDigest: "sha256:mo-coi", operationDescription: "Không có card", effectCategory: "local-write", ttlMs: 900_000 },
    );
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("lists a question the agent is waiting on, and drops it once it expires", async () => {
    const conversationId = await createConversation();
    askQuestion(conversationId);

    const inbox = await readInboxOverHttp();
    expect(inbox.waiting).toHaveLength(1);
    expect(inbox.waiting[0]).toMatchObject({ kind: "question", conversationId, prompt: "Chọn môi trường triển khai." });

    now = new Date(Date.parse(AT) + QUESTION_TTL_MS + 60_000).toISOString();
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("drops a question once it is answered", async () => {
    const conversationId = await createConversation();
    const created = askQuestion(conversationId);
    expect((await readInboxOverHttp()).waiting).toHaveLength(1);

    const answered = answerQuestion(
      { ...interactionDepsFor(services, conversationId), now: () => now as Instant },
      created.interaction.questionId,
      { optionIds: ["staging"] },
    );
    expect(answered.ok).toBe(true);
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("offers an approval a dispatched task raised, without a card, pointing at its own conversation", async () => {
    const conversationId = await createConversation();
    const { task, approval } = raiseTaskApproval(conversationId);

    const inbox = await readInboxOverHttp();
    expect(inbox.waiting).toHaveLength(1);
    expect(inbox.waiting[0]).toMatchObject({
      kind: "task-approval",
      approvalId: approval.approvalId,
      taskId: task.taskId,
      conversationId,
      description: approval.operationDescription,
      operationDigest: approval.operationDigest,
      effectCategory: "local-write",
      expiresAt: approval.expiresAt,
    });
  });

  it("decides a task approval through its own route, and it is gone from the inbox once decided", async () => {
    const conversationId = await createConversation();
    const { task, approval } = raiseTaskApproval(conversationId);
    expect((await readInboxOverHttp()).waiting).toHaveLength(1);

    const decided = await request("POST", `/tasks/${task.taskId}/approvals/${approval.approvalId}/decide`, {
      decision: "denied",
      digest: approval.operationDigest,
    });
    expect(decided.status).toBe(200);
    expect((decided.body as { decision: string; redispatched: boolean }).decision).toBe("denied");
    expect((decided.body as { redispatched: boolean }).redispatched).toBe(false);
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("grants a task approval over HTTP and actually re-dispatches the task, driven through a real dispatcher", async () => {
    const conversationId = await createConversation();
    const principal: Principal = { principalId: "user_inbox_test", kind: "user", nodeId: services.runtime.identity.nodeId as never };
    const capabilityRef = "demo.write@1" as CapabilityRef;

    registerCapability(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
      {
        ref: capabilityRef,
        executionNodeId: services.runtime.identity.nodeId,
        summary: "ghi một file demo",
        resourceKinds: [],
        effectCategory: "local-write",
        supportsCancellation: false,
        requiresConnection: false,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
        uiAffordances: [],
      },
    );
    const preference = writeRegisteredPreference(
      { db: services.runtime.db, now: () => now as Instant },
      {
        principalId: principal.principalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
        source: "user",
      },
    );
    if (!preference.ok) throw new Error(preference.message);

    const taskDeps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as Instant, newId: services.conductor.newId };
    const task = createTask(taskDeps, { conversationId: conversationId as never, goal: "ghi file demo", principal });
    applyTaskEvent(taskDeps, task.taskId, "resolve.start");
    advanceResolving(taskDeps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
    applyTaskEvent(taskDeps, task.taskId, "dispatch.acknowledged");

    let workerCalled = false;
    const fakeResult: WorkerProcessResult = {
      adapter: "fake",
      adapterVersion: "fake-1.0.0",
      stopReason: "settled",
      withheldCapabilities: [],
      record: {
        runId: "run_fake",
        taskId: task.taskId,
        taskRevision: task.revision,
        executionNodeId: services.runtime.identity.nodeId,
        leaseEpoch: 1,
        startedAt: now as Instant,
        endedAt: now as Instant,
        evidence: [{ kind: "file-diff", summary: "đã ghi file", verdict: "verified", observedAt: now as Instant }],
      },
    };
    // Wired onto the node's own services, exactly as `bootstrap/runtime-bootstrap.ts` wires the real dispatcher -
    // this is what makes the HTTP route below the same code path production uses, not a stand-in for it.
    services.taskDispatch = createTaskDispatcher({
      conductor: services.conductor,
      projectRoots: () => [],
      ownedRoots: () => [],
      ownerPrincipalId: () => principal.principalId,
      onSettled: () => undefined,
      runWorker: async () => {
        workerCalled = true;
        return fakeResult;
      },
    });

    services.taskDispatch.dispatch({ taskId: task.taskId, capabilityRef, executionNodeId: services.runtime.identity.nodeId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(workerCalled).toBe(false);
    expect(getTask(services.runtime.db, task.taskId)?.state).toBe("waiting_approval");

    const raised = oneRow<{ approval_id: string; operation_digest: string }>(
      services.runtime.db,
      "SELECT approval_id, operation_digest FROM approvals WHERE task_id = ? AND decision = 'pending'",
      task.taskId,
    );
    if (raised === undefined) throw new Error("test setup: no pending approval was raised for this task");

    const decided = await request("POST", `/tasks/${task.taskId}/approvals/${raised.approval_id}/decide`, {
      decision: "granted",
      digest: raised.operation_digest,
    });
    expect(decided.status).toBe(200);
    expect((decided.body as { decision: string; redispatched: boolean }).decision).toBe("granted");
    expect((decided.body as { redispatched: boolean }).redispatched).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(workerCalled).toBe(true);
    expect(getTask(services.runtime.db, task.taskId)?.state).toBe("succeeded");
    expect((await readInboxOverHttp()).waiting).toEqual([]);
  });

  it("maps a wrong digest, an already-decided approval, an expired approval and a task no longer waiting each to their own 409", async () => {
    const conversationId = await createConversation();

    // Wrong digest: refused before anything is written.
    const { task: taskA, approval: approvalA } = raiseTaskApproval(conversationId);
    const wrongDigest = await request("POST", `/tasks/${taskA.taskId}/approvals/${approvalA.approvalId}/decide`, {
      decision: "granted",
      digest: "sha256:mot-thu-khac",
    });
    expect(wrongDigest.status).toBe(409);
    expect((wrongDigest.body as { code: string }).code).toBe("APPROVAL_FORGED");

    // Already decided: the second decision on the same approval finds nothing left `pending`.
    const decidedOnce = await request("POST", `/tasks/${taskA.taskId}/approvals/${approvalA.approvalId}/decide`, {
      decision: "denied",
      digest: approvalA.operationDigest,
    });
    expect(decidedOnce.status).toBe(200);
    // The task left `waiting_approval` the moment it was denied, so a second decision - even with the right
    // digest - is refused for the task no longer waiting, before the approval's own already-decided state is
    // ever reached.
    const decidedTwice = await request("POST", `/tasks/${taskA.taskId}/approvals/${approvalA.approvalId}/decide`, {
      decision: "granted",
      digest: approvalA.operationDigest,
    });
    expect(decidedTwice.status).toBe(409);
    expect((decidedTwice.body as { code: string }).code).toBe("TASK_NOT_WAITING");

    // Expired: nobody decided before the approval's own deadline passed.
    const { task: taskB, approval: approvalB } = raiseTaskApproval(conversationId);
    now = new Date(new Date(approvalB.expiresAt).getTime() + 1000).toISOString();
    const expired = await request("POST", `/tasks/${taskB.taskId}/approvals/${approvalB.approvalId}/decide`, {
      decision: "granted",
      digest: approvalB.operationDigest,
    });
    expect(expired.status).toBe(409);
    expect((expired.body as { code: string }).code).toBe("APPROVAL_EXPIRED");
    expect(getTask(services.runtime.db, taskB.taskId)?.state).toBe("failed");
  });

  it("finds what is open at the end of a conversation longer than a timeline page, and can decide it", async () => {
    // A reader's timeline is the first 200 messages. What is still open sits at the other end, so the inbox and the
    // routes that answer it must read from the end - or the inbox offers a card the decide route cannot find, and
    // the grant is spent on an operation that never runs.
    const conversationId = await createConversation();
    chatter(conversationId, 210);
    askQuestion(conversationId);
    const command = `node -e "process.stdout.write('chay-duoc')"`;
    const approval = proposeCommand(conversationId, command);

    const inbox = await readInboxOverHttp();
    expect(inbox.waiting.map((item) => item.kind).sort()).toEqual(["command-approval", "question"]);

    const decided = await request("POST", `/conversations/${conversationId}/approvals/${approval.approvalId}/decide`, {
      decision: "granted",
      digest: approval.operationDigest,
    });
    expect(decided.status).toBe(200);
    expect(JSON.stringify(decided.body)).toContain("chay-duoc");
  });

  it("leaves the approval undecided when its operation cannot be found, rather than spending it", async () => {
    const conversationId = await createConversation();
    const approval = requestApproval(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as never, newId: services.conductor.newId },
      { operationDigest: "sha256:khong-co-card", operationDescription: "Không có card", effectCategory: "local-write", ttlMs: 900_000 },
    );

    const decided = await request("POST", `/conversations/${conversationId}/approvals/${approval.approvalId}/decide`, {
      decision: "granted",
      digest: approval.operationDigest,
    });
    expect(decided.status).toBe(409);
    expect((decided.body as { code: string }).code).toBe("APPROVAL_PAYLOAD_MISSING");
    const row = services.runtime.db.prepare("SELECT decision FROM approvals WHERE approval_id = ?").get(approval.approvalId) as {
      decision: string;
    };
    expect(row.decision).toBe("pending");
  });
});

describe("notices", () => {
  function notice(dedupKey: string, title = "Việc nền đã xong: tóm tắt báo cáo") {
    return recordNodeNotice(services, {
      sourceKind: "background",
      category: "result",
      severity: "success",
      title,
      conversationId: "conv_elsewhere",
      dedupKey,
      at: now as Instant,
    });
  }

  it("marks read only the ids the surface showed, then dismisses one", async () => {
    const shown = notice("background:bg_1");
    notice("background:bg_2");
    expect((await readInboxOverHttp()).unread).toBe(2);

    const marked = await request("POST", "/inbox/read", { noticeIds: [shown.notificationId] });
    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({ marked: 1 });
    expect((await readInboxOverHttp()).unread).toBe(1);

    const dismissed = await request("POST", `/inbox/notices/${shown.notificationId}/dismiss`);
    expect(dismissed.status).toBe(200);
    expect((await readInboxOverHttp()).notices.map((item) => item.noticeId)).not.toContain(shown.notificationId);

    const again = await request("POST", `/inbox/notices/${shown.notificationId}/dismiss`);
    expect(again.status).toBe(404);
  });

  it("marks everything read when no ids are sent, and refuses a body that is not a list of ids", async () => {
    notice("background:bg_1");
    notice("background:bg_2");
    expect((await request("POST", "/inbox/read", {})).body).toEqual({ marked: 2 });
    expect((await readInboxOverHttp()).unread).toBe(0);

    expect((await request("POST", "/inbox/read", { noticeIds: "tat-ca" })).status).toBe(400);
  });

  it("answers a wrong method honestly rather than falling through to another family", async () => {
    expect((await request("POST", "/inbox")).status).toBe(405);
    expect((await request("GET", "/inbox/read")).status).toBe(405);
    expect((await request("GET", "/inbox/nothing-here")).status).toBe(404);
  });

  it("is behind the gateway's bearer check", async () => {
    const response = await handleRequest(deps, { method: "GET", path: "/inbox", query: {}, headers: {}, body: "" });
    expect(response.status).toBe(401);
  });
});

describe("background work reports into the inbox", () => {
  it("leaves one notice pointing at its conversation when a background run finishes", async () => {
    const conversationId = await createConversation();
    services.turnControl = {
      running: () => [],
      interrupt: () => false,
      steer: async () => false,
      runInBackground: async () => "Báo cáo tuần đã tóm tắt xong.",
    };

    const started = await request("POST", "/background-sessions", { conversationId, text: "tóm tắt báo cáo tuần" });
    expect(started.status).toBeLessThan(300);

    await vi.waitFor(async () => {
      expect((await readInboxOverHttp()).notices).toHaveLength(1);
    });
    const [only] = (await readInboxOverHttp()).notices;
    expect(only).toMatchObject({
      sourceKind: "background",
      category: "result",
      severity: "success",
      conversationId,
      body: "Báo cáo tuần đã tóm tắt xong.",
    });
    expect(only?.title).toContain("tóm tắt báo cáo tuần");
  });

  it("reports a failed worker as an error notice, not a silent one", async () => {
    const conversationId = await createConversation();
    services.turnControl = {
      running: () => [],
      interrupt: () => false,
      steer: async () => false,
      runInBackground: async () => {
        throw new Error("hết hạn mức model");
      },
    };

    await request("POST", "/background-sessions", { conversationId, text: "đọc log" });
    await vi.waitFor(async () => {
      expect((await readInboxOverHttp()).notices).toHaveLength(1);
    });
    // The body is what the conversation was told, so it carries the reason the run failed.
    const [notice] = (await readInboxOverHttp()).notices;
    expect(notice).toMatchObject({ severity: "error" });
    expect(notice?.body).toContain("hết hạn mức model");
  });
});

describe("a dispatched task reports into the inbox", () => {
  it("maps each way a task settles to a severity a person reads the right way", () => {
    const settle = (outcome: "succeeded" | "failed" | "cancelled" | "uncertain") =>
      workerSettledNotice({ taskId: "task_7", conversationId: "conv_7", outcome, message: "xong phần việc", at: AT as Instant });
    expect(settle("succeeded").severity).toBe("success");
    expect(settle("failed").severity).toBe("error");
    // The effect may or may not have happened, which is worth a look.
    expect(settle("uncertain").severity).toBe("warning");
    // The person cancelled it; nothing went wrong.
    expect(settle("cancelled").severity).toBe("info");
    for (const outcome of ["succeeded", "failed", "cancelled", "uncertain"] as const) {
      const notice = settle(outcome);
      expect(notice).toMatchObject({ sourceKind: "worker", conversationId: "conv_7", dedupKey: "worker:task_7", body: "xong phần việc" });
      // The task id is a handle for the node, not something to read.
      expect(notice.title).not.toContain("task_7");
    }
  });

  it("records a settled task once, however often it is reported", async () => {
    const notice = workerSettledNotice({ taskId: "task_8", conversationId: "conv_8", outcome: "failed", message: "lỗi", at: AT as Instant });
    expect(recordNodeNotice(services, notice).created).toBe(true);
    expect(recordNodeNotice(services, notice).created).toBe(false);
    expect((await readInboxOverHttp()).notices).toHaveLength(1);
  });

  it("does not fail the producer when the inbox cannot be written", () => {
    const broken = {
      runtime: {
        db: {
          prepare: () => {
            throw new Error("database is locked");
          },
        } as never,
        identity: { ownerPrincipalId: "owner" },
      },
      conductor: { newId: (prefix: string) => `${prefix}_1` },
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() =>
        tryRecordNodeNotice(
          broken,
          workerSettledNotice({ taskId: "task_9", conversationId: "conv_9", outcome: "succeeded", message: "ok", at: AT as Instant }),
        ),
      ).not.toThrow();
      expect(String(stderr.mock.calls[0]?.[0])).toContain("could not record a worker notice");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("the agent reads the inbox", () => {
  it("reports what the panel would show, and changes nothing", async () => {
    const conversationId = await createConversation();
    proposeCommand(conversationId, "git status");
    recordNodeNotice(services, {
      sourceKind: "background",
      category: "result",
      severity: "error",
      title: "Việc nền không xong: đọc log",
      body: "hết hạn mức model",
      conversationId,
      dedupKey: "background:bg_agent",
      at: now as Instant,
    });

    const tool = createReadInboxTool(() => readInbox(services, now as Instant));
    const { text } = await tool.execute({});
    expect(text).toContain(`command approval in conversation ${conversationId}: git status`);
    expect(text).toContain("only the user can answer these");
    expect(text).toContain("[unread] error from background");
    expect(text).toContain("hết hạn mức model");
    expect(text).toContain("control_app kind inbox.open");

    // Reading is not seeing: the person has not looked, so nothing is marked read and nothing is decided.
    const after = await readInboxOverHttp();
    expect(after.unread).toBe(1);
    expect(after.waiting).toHaveLength(1);
  });

  it("reports a task approval as its own kind of line, in the plain words the gate raised it with", async () => {
    const conversationId = await createConversation();
    const { task, approval } = raiseTaskApproval(conversationId);

    const tool = createReadInboxTool(() => readInbox(services, now as Instant));
    const { text } = await tool.execute({});
    expect(text).toContain(
      `task approval for task ${task.taskId} (local-write): ${approval.operationDescription} (conversation ${conversationId}) (expires ${approval.expiresAt})`,
    );
    // Never the capability ref or the approval id - those stay in the structured fields the inbox panel reads,
    // not in the sentence a model would repeat back to the person.
    expect(text).not.toContain(approval.approvalId);
  });

  it("says plainly when there is nothing", async () => {
    const { text } = await createReadInboxTool(() => readInbox(services, now as Instant)).execute({});
    expect(text).toContain("Nothing is waiting for the user's decision.");
    expect(text).toContain("No notices.");
  });

  it("reports a read that failed as a failure, not as an empty inbox", async () => {
    const { text } = await createReadInboxTool(() => {
      throw new Error("database is locked");
    }).execute({});
    expect(text).toContain("Could not read the inbox");
    expect(text).toContain("Nothing was changed");
    expect(text).not.toContain("Nothing is waiting");
    // The cause is a storage detail the agent would only repeat to the person, and it can carry a path.
    expect(text).not.toContain("database is locked");
  });
});
