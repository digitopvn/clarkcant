import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type CapabilityRef,
  type Instant,
  type Principal,
  NOTICE_SNOOZE_MAX_MS,
  inboxResponseSchema,
  inboxSummarySchema,
  redactSecrets,
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
import {
  DISMISS_UNDO_WINDOW_MS,
  appendMessage,
  countUnreadNotifications,
  getNotification,
  getTask,
  listNotifications,
  markNotificationsRead,
  nextMessageSequence,
  oneRow,
  recordNotification,
} from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { QUESTION_TTL_MS, answerQuestion, createQuestion } from "../src/interactions.ts";
import { readInbox } from "../src/inbox.ts";
import { conversationOf } from "../src/notice-actions.ts";
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
  /** Whether a notice was written already read, which is what a quieted kind does to it. */
  function arrivedRead({ notificationId }: { notificationId: string }): boolean {
    return getNotification(services.runtime.db, services.runtime.identity.ownerPrincipalId, notificationId)?.notice.readAt !== undefined;
  }

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

  it("marks a read notice unread again, and refuses an unread request without ids", async () => {
    const shown = notice("background:bg_1");
    await request("POST", "/inbox/read", {});
    expect((await readInboxOverHttp()).unread).toBe(0);

    const marked = await request("POST", "/inbox/unread", { noticeIds: [shown.notificationId] });
    expect(marked.body).toEqual({ marked: 1 });
    const inbox = await readInboxOverHttp();
    expect(inbox.unread).toBe(1);
    expect(inbox.notices[0]?.readAt).toBeUndefined();

    expect((await request("POST", "/inbox/unread", {})).status).toBe(400);
    expect((await request("POST", "/inbox/unread", { noticeIds: [] })).status).toBe(400);
  });

  it("undoes a dismissal while it is recent, and refuses once the window has passed", async () => {
    const first = notice("background:bg_1");
    const second = notice("background:bg_2");
    await request("POST", `/inbox/notices/${first.notificationId}/dismiss`);
    await request("POST", `/inbox/notices/${second.notificationId}/dismiss`);

    now = new Date(Date.parse(AT) + 10_000).toISOString();
    expect((await request("POST", `/inbox/notices/${first.notificationId}/restore`)).body).toEqual({ restored: true });
    expect((await readInboxOverHttp()).notices.map((item) => item.noticeId)).toEqual([first.notificationId]);

    now = new Date(Date.parse(AT) + DISMISS_UNDO_WINDOW_MS + 1_000).toISOString();
    const late = await request("POST", `/inbox/notices/${second.notificationId}/restore`);
    expect(late.status).toBe(409);
    expect((late.body as { code: string }).code).toBe("UNDO_EXPIRED");
    expect((await request("GET", `/inbox/notices/${first.notificationId}/restore`)).status).toBe(405);
  });

  it("changes nothing that belongs to another principal", async () => {
    const theirs = recordNotification(services.runtime.db, {
      notificationId: "ntf_theirs",
      principalId: "someone_else",
      sourceKind: "background",
      category: "result",
      severity: "success",
      title: "Not yours",
      dedupKey: "background:theirs",
      at: now as Instant,
    });
    markNotificationsRead(services.runtime.db, { principalId: "someone_else", at: now as Instant });

    expect((await request("POST", "/inbox/unread", { noticeIds: [theirs.notificationId] })).body).toEqual({ marked: 0 });
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/dismiss`)).status).toBe(404);
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/restore`)).status).toBe(404);
    expect(countUnreadNotifications(services.runtime.db, "someone_else")).toBe(0);
    expect(listNotifications(services.runtime.db, "someone_else")).toHaveLength(1);
  });

  it("gives each notice the actions its subject and state allow, worked out when it is read", async () => {
    const conversationId = await createConversation();
    recordNodeNotice(services, {
      sourceKind: "background",
      category: "result",
      severity: "success",
      title: "Việc nền đã xong",
      conversationId,
      subject: { kind: "background-work", workId: "work_1", conversationId },
      dedupKey: "background:work_1",
      at: now as Instant,
    });
    recordNodeNotice(services, {
      sourceKind: "worker",
      category: "result",
      severity: "error",
      title: "Việc chạy nền không xong",
      conversationId,
      subject: { kind: "task", taskId: "task_gone", conversationId },
      dedupKey: "worker:task_gone",
      at: now as Instant,
    });
    recordNodeNotice(services, {
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật: demo",
      subject: { kind: "package", packageId: "demo", version: "2.0.0" },
      dedupKey: "update:npm:demo@2.0.0",
      at: now as Instant,
    });
    recordNodeNotice(services, {
      sourceKind: "system",
      category: "alert",
      severity: "info",
      title: "Câu hỏi đã hết hạn",
      conversationId: "conv_deleted",
      dedupKey: "expired:question_1",
      at: now as Instant,
    });

    const byTitle = new Map((await readInboxOverHttp()).notices.map((item) => [item.title, item.actions]));
    // Something that went well is something to go and look at.
    expect(byTitle.get("Việc nền đã xong")).toEqual([
      { id: "open", placement: "primary" },
      { id: "ask-clark", placement: "secondary" },
      { id: "add-to-context", placement: "menu" },
      { id: "mark-read", placement: "menu" },
      { id: "snooze", placement: "menu" },
      { id: "dismiss", placement: "menu" },
      { id: "suppress", placement: "menu" },
    ]);
    // Something that went wrong is something to act on; its task is gone, but its conversation still opens.
    expect(byTitle.get("Việc chạy nền không xong")?.slice(0, 2)).toEqual([
      { id: "ask-clark", placement: "primary" },
      { id: "open", placement: "secondary" },
    ]);
    // An update belongs to no conversation, so there is nothing to open.
    expect(byTitle.get("Có bản cập nhật: demo")).toEqual([
      { id: "ask-clark", placement: "primary" },
      { id: "dismiss", placement: "secondary" },
      { id: "add-to-context", placement: "menu" },
      { id: "mark-read", placement: "menu" },
      { id: "snooze", placement: "menu" },
      { id: "suppress", placement: "menu" },
      // It names a version of a package this node does not run, so there is nothing to update.
      { id: "update", placement: "menu", unavailable: "package-gone" },
    ]);
    // A notice whose conversation is gone says so instead of offering a button that fails.
    expect(byTitle.get("Câu hỏi đã hết hạn")).toContainEqual({ id: "open", placement: "menu", unavailable: "conversation-gone" });
    expect(byTitle.get("Câu hỏi đã hết hạn")?.[0]).toEqual({ id: "ask-clark", placement: "primary" });
    // A system notice names nothing narrower than "the node", so quieting its kind is not offered at all.
    expect(byTitle.get("Câu hỏi đã hết hạn")?.map((action) => action.id)).not.toContain("suppress");
  });

  it("resolves an automation run that started a task exactly as it would a notice about that task", async () => {
    const home = await createConversation();
    const principal: Principal = { principalId: "user_inbox_test", kind: "user", nodeId: services.runtime.identity.nodeId as never };
    const taskDeps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as Instant, newId: services.conductor.newId };
    const task = createTask(taskDeps, { conversationId: home as never, goal: "dọn repo", principal });
    const common = { sourceKind: "automation", category: "message", severity: "info", conversationId: "conv_gone", at: now as Instant } as const;
    recordNodeNotice(services, {
      ...common,
      title: "Theo task",
      subject: { kind: "task", taskId: task.taskId, conversationId: "conv_gone" },
      dedupKey: "automation:run_task",
    });
    recordNodeNotice(services, {
      ...common,
      title: "Theo việc tự động",
      subject: { kind: "automation", intentId: "int_1", label: "Dọn repo", taskId: task.taskId, conversationId: "conv_gone" },
      dedupKey: "automation:run_automation",
    });

    const byTitle = new Map((await readInboxOverHttp()).notices.map((item) => [item.title, item]));
    const bySubject = (title: string) => byTitle.get(title)?.actions?.filter((action) => action.id !== "suppress");
    // "Open" leads to where the task now is, not to the conversation the notice was written against, in both.
    expect(bySubject("Theo việc tự động")).toEqual(bySubject("Theo task"));
    expect(bySubject("Theo task")?.[0]).toEqual({ id: "open", placement: "primary" });
    const theNotice = byTitle.get("Theo việc tự động");
    const theTaskNotice = byTitle.get("Theo task");
    if (theNotice === undefined || theTaskNotice === undefined) throw new Error("the notices were not listed");
    expect(conversationOf(services.runtime.db, theNotice)).toBe(home);
    expect(conversationOf(services.runtime.db, theTaskNotice)).toBe(home);
    // Only the one that names its automation can be quieted.
    expect(byTitle.get("Theo việc tự động")?.actions).toContainEqual({ id: "suppress", placement: "menu" });
    expect(byTitle.get("Theo task")?.actions?.map((action) => action.id)).not.toContain("suppress");
  });

  it("refuses with 409 to quiet a notice whose kind would also quiet reminders and other automations", async () => {
    const reminder = recordNodeNotice(services, {
      sourceKind: "automation",
      category: "message",
      severity: "info",
      title: "Họp lúc 3 giờ",
      conversationId: "conv_elsewhere",
      subject: { kind: "conversation", conversationId: "conv_elsewhere" },
      dedupKey: "automation:run_reminder",
      at: now as Instant,
    });
    const delegated = recordNodeNotice(services, {
      sourceKind: "automation",
      category: "message",
      severity: "info",
      title: "Việc một node khác giao",
      dedupKey: "delegation:task_x",
      at: now as Instant,
    });
    for (const { notificationId } of [reminder, delegated]) {
      const refused = await request("POST", `/inbox/notices/${notificationId}/suppress`);
      expect(refused.status).toBe(409);
      const body = refused.body as { code: string; message: string };
      expect(body.code).toBe("SUPPRESSION_TOO_BROAD");
      expect(body.message).toContain("lời nhắc");
    }
    const inbox = await readInboxOverHttp();
    expect(inbox.suppressions).toEqual([]);
    for (const item of inbox.notices) expect(item.actions?.map((action) => action.id)).not.toContain("suppress");
  });

  it("quiets one automation's warnings without touching another automation's, or any reminder", async () => {
    const warning = (intentId: string, label: string, dedupKey: string) =>
      recordNodeNotice(services, {
        sourceKind: "automation",
        category: "alert",
        severity: "warning",
        title: "Việc tự động bị từ chối",
        conversationId: "conv_elsewhere",
        subject: { kind: "automation", intentId, label, conversationId: "conv_elsewhere" },
        dedupKey,
        at: now as Instant,
      });
    const first = warning("int_a", "Dọn repo A", "automation:run_1");
    const answer = await request("POST", `/inbox/notices/${first.notificationId}/suppress`);
    expect(answer.status).toBe(200);
    expect((answer.body as { suppression: unknown }).suppression).toMatchObject({ scope: "automation:int_a", scopeLabel: "Dọn repo A" });

    expect(arrivedRead(warning("int_a", "Dọn repo A", "automation:run_2"))).toBe(true);
    expect(arrivedRead(warning("int_b", "Báo cáo tuần", "automation:run_3"))).toBe(false);
    const reminder = recordNodeNotice(services, {
      sourceKind: "automation",
      category: "message",
      severity: "info",
      title: "Họp lúc 3 giờ",
      subject: { kind: "conversation", conversationId: "conv_elsewhere" },
      dedupKey: "automation:run_4",
      at: now as Instant,
    });
    expect(arrivedRead(reminder)).toBe(false);
  });

  it("quiets one repository's polling failures without touching another repository's", async () => {
    const failing = (repository: string, dedupKey: string) =>
      recordNodeNotice(services, {
        sourceKind: "automation",
        category: "alert",
        severity: "warning",
        title: `Chưa theo dõi được ${repository}`,
        subject: { kind: "signal-source", sourceKey: `github:${repository}`, label: repository },
        dedupKey,
        at: now as Instant,
      });
    const x = failing("acme/x", "github-poll:x:1");
    expect((await request("POST", `/inbox/notices/${x.notificationId}/suppress`)).status).toBe(200);
    expect(arrivedRead(failing("acme/x", "github-poll:x:2"))).toBe(true);
    expect(arrivedRead(failing("acme/y", "github-poll:y:1"))).toBe(false);
    expect((await readInboxOverHttp()).suppressions[0]).toMatchObject({ scope: "source:github:acme/x", scopeLabel: "acme/x" });
  });

  it("snoozes a notice out of the list and the count, and it comes back unread when the time passes", async () => {
    const snoozed = notice("background:bg_1");
    const other = notice("background:bg_2");
    await request("POST", "/inbox/read", {});
    const until = new Date(Date.parse(AT) + 60 * 60_000).toISOString();

    const answer = await request("POST", `/inbox/notices/${snoozed.notificationId}/snooze`, { until });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ snoozedUntil: until });

    const aside = await readInboxOverHttp();
    expect(aside.notices.map((item) => item.noticeId)).toEqual([other.notificationId]);
    expect(aside.snoozed.map((item) => item.noticeId)).toEqual([snoozed.notificationId]);
    expect(aside.snoozed[0]?.snoozedUntil).toBe(until);
    // The one thing to do with a snoozed notice is bring it back.
    expect(aside.snoozed[0]?.actions).toEqual([{ id: "unsnooze", placement: "primary" }]);
    expect(aside.unread).toBe(0);
    expect((await request("GET", "/inbox/summary")).body).toEqual({ waiting: 0, unread: 0 });

    // No timer: the next read after its time finds it back, unread, at the top.
    now = until;
    const back = await readInboxOverHttp();
    expect(back.notices.map((item) => item.noticeId)).toEqual([snoozed.notificationId, other.notificationId]);
    expect(back.notices[0]?.readAt).toBeUndefined();
    expect(back.snoozed).toEqual([]);
    expect(back.unread).toBe(1);
  });

  it("stores a snooze time given without milliseconds in the node's one form, so it is compared correctly", async () => {
    const { notificationId } = notice("background:bg_1");
    // Half a second after the whole second the person asked for: as text, "…T08:00:00Z" sorts after
    // "…T08:00:00.500Z", so a stored "Z"-only time would read as still ahead after it had passed.
    const answer = await request("POST", `/inbox/notices/${notificationId}/snooze`, { until: "2026-09-24T08:00:00Z" });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ snoozedUntil: "2026-09-24T08:00:00.000Z" });
    now = "2026-09-24T08:00:00.500Z";
    const back = await readInboxOverHttp();
    expect(back.notices.map((item) => item.noticeId)).toEqual([notificationId]);
    expect(back.snoozed).toEqual([]);
  });

  it("brings a snoozed notice back early, and refuses a time that is past, too far, or not a time", async () => {
    const { notificationId } = notice("background:bg_1");
    const inAnHour = new Date(Date.parse(AT) + 60 * 60_000).toISOString();
    await request("POST", `/inbox/notices/${notificationId}/snooze`, { until: inAnHour });

    expect((await request("POST", `/inbox/notices/${notificationId}/unsnooze`)).body).toEqual({ unsnoozed: true });
    const inbox = await readInboxOverHttp();
    expect(inbox.notices.map((item) => item.noticeId)).toEqual([notificationId]);
    expect(inbox.unread).toBe(1);
    // A second press: it is already back, which is what was asked for.
    expect((await request("POST", `/inbox/notices/${notificationId}/unsnooze`)).status).toBe(200);

    // A read notice snoozed and taken back (the panel's Undo) is still read: taking a snooze back changes nothing.
    await request("POST", "/inbox/read", {});
    await request("POST", `/inbox/notices/${notificationId}/snooze`, { until: inAnHour });
    await request("POST", `/inbox/notices/${notificationId}/unsnooze`);
    const undone = await readInboxOverHttp();
    expect(undone.unread).toBe(0);
    expect(undone.notices[0]?.readAt).toBeDefined();

    const past = await request("POST", `/inbox/notices/${notificationId}/snooze`, { until: AT });
    expect(past.status).toBe(400);
    expect((past.body as { code: string }).code).toBe("SNOOZE_OUT_OF_RANGE");
    const tooFar = new Date(Date.parse(AT) + NOTICE_SNOOZE_MAX_MS + 60_000).toISOString();
    expect((await request("POST", `/inbox/notices/${notificationId}/snooze`, { until: tooFar })).status).toBe(400);
    expect((await request("POST", `/inbox/notices/${notificationId}/snooze`, { until: "tối nay" })).status).toBe(400);
    expect((await request("POST", "/inbox/notices/ntf_missing/snooze", { until: inAnHour })).status).toBe(404);
    expect((await request("GET", `/inbox/notices/${notificationId}/snooze`)).status).toBe(405);
  });

  it("quiets a kind of notice for this principal: later ones are listed read, and it can be undone two ways", async () => {
    const first = notice("background:bg_1");
    const suppressed = await request("POST", `/inbox/notices/${first.notificationId}/suppress`);
    expect(suppressed.status).toBe(200);
    const { suppression } = suppressed.body as { suppression: { suppressionId: string; example: string } };
    expect(suppression.example).toBe("Việc nền đã xong: tóm tắt báo cáo");

    // The menu now offers the reverse, and the kind is listed where it can be undone without any notice left.
    let inbox = await readInboxOverHttp();
    expect(inbox.suppressions.map((item) => item.suppressionId)).toEqual([suppression.suppressionId]);
    expect(inbox.notices[0]?.actions).toContainEqual({ id: "unsuppress", placement: "menu" });
    expect(inbox.notices[0]?.actions).not.toContainEqual({ id: "suppress", placement: "menu" });

    // A later notice of the same kind is still written and listed, but already read: nothing new to count.
    const quiet = notice("background:bg_2");
    inbox = await readInboxOverHttp();
    expect(inbox.notices.find((item) => item.noticeId === quiet.notificationId)?.readAt).toBe(now);
    expect(inbox.unread).toBe(1);

    // Undone from the notice…
    expect((await request("POST", `/inbox/notices/${quiet.notificationId}/unsuppress`)).body).toEqual({ unsuppressed: true });
    expect((await readInboxOverHttp()).suppressions).toEqual([]);
    const loud = notice("background:bg_3");
    inbox = await readInboxOverHttp();
    expect(inbox.notices.some((item) => item.noticeId === loud.notificationId && item.readAt === undefined)).toBe(true);

    // …or from the list, for a kind with no notice left to act from.
    await request("POST", `/inbox/notices/${first.notificationId}/suppress`);
    const listed = (await readInboxOverHttp()).suppressions[0]?.suppressionId ?? "";
    expect((await request("DELETE", `/inbox/suppressions/${listed}`)).body).toEqual({ removed: true });
    expect((await request("DELETE", `/inbox/suppressions/${listed}`)).status).toBe(404);
    expect((await request("POST", `/inbox/suppressions/${listed}`)).status).toBe(405);
  });

  it("keeps snoozes and quieted kinds to the node's owner", async () => {
    const theirs = recordNotification(services.runtime.db, {
      notificationId: "ntf_theirs",
      principalId: "someone_else",
      sourceKind: "background",
      category: "result",
      severity: "success",
      title: "Not yours",
      dedupKey: "background:theirs",
      at: now as Instant,
    });
    const until = new Date(Date.parse(AT) + 60 * 60_000).toISOString();
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/snooze`, { until })).status).toBe(404);
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/unsnooze`)).status).toBe(404);
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/suppress`)).status).toBe(404);
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/unsuppress`)).status).toBe(404);
    expect(listNotifications(services.runtime.db, "someone_else")).toHaveLength(1);
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
      // Redacted on the way out, so a temp dir under a home directory (Windows' default) reads as redacted here.
      `task approval for task ${task.taskId} (local-write): ${redactSecrets(approval.operationDescription)} (conversation ${conversationId}) (expires ${approval.expiresAt})`,
    );
    // Never the capability ref or the approval id - those stay in the structured fields the inbox panel reads,
    // not in the sentence a model would repeat back to the person.
    expect(text).not.toContain(approval.approvalId);
  });

  it("says plainly when there is nothing", async () => {
    const { text } = await createReadInboxTool(() => readInbox(services, now as Instant)).execute({});
    expect(text).toContain("Nothing is waiting for the user's decision.");
    expect(text).toContain("No notices.");
    expect(text).not.toContain("snoozed");
  });

  it("lists what the user snoozed apart from the notices, with its id and the one action it offers", async () => {
    const { notificationId } = recordNodeNotice(services, {
      sourceKind: "background",
      category: "result",
      severity: "success",
      title: "Việc để sau",
      dedupKey: "background:later",
      at: now as Instant,
    });
    const until = new Date(Date.parse(AT) + 60 * 60_000).toISOString();
    await request("POST", `/inbox/notices/${notificationId}/snooze`, { until });
    const { text } = await createReadInboxTool(() => readInbox(services, now as Instant)).execute({});
    // Not among the notices the user sees now: under its own heading, so the model does not report it as current.
    expect(text).toContain("No notices.");
    expect(text).toContain("Snoozed by the user (1); each returns to the inbox on its own at its time:");
    expect(text).toContain(`- [snoozed until ${until}] Việc để sau (notice ${notificationId}; actions: unsnooze)`);
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
