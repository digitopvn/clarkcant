import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityDescriptor, type Instant, type MessageRecord, type Notice, inboxResponseSchema } from "@clarkcant/contracts";
import { matchDueSignals, registerCapability } from "@clarkcant/core";
import { allRows, getTask, parseJson } from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService, type AutomationService } from "../src/automation-service.ts";
import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * Standing requests on a running node: set up in the conversation, fired by a signal over the wire, reported back.
 *
 * The node is real — its storage, its gateway, its conversation — and only the worker is replaced by a record of what
 * would have been dispatched, because what is under test is that one fact leads to one piece of work, reported where
 * the person set it up, across a node that stops and starts again.
 */

let dir: string;
let project: string;
let services: NodeServices;
let now: string;
let deps: GatewayDeps;
let service: AutomationService | undefined;
let dispatched: { taskId: string; capabilityRef: string; executionNodeId: string }[];

function boot(): void {
  services = bootNodeServices({ dataDir: dir, label: "automation node" });
  let sequence = 0;
  deps = {
    services,
    now: () => now,
    newConversationId: () => {
      sequence += 1;
      return `conv_auto_${String(sequence)}_${String(Date.now())}`;
    },
  };
  dispatched = [];
  services.conductor.runTask = (input) => {
    dispatched.push(input);
  };
  service = startAutomationService(services, { intervalMs: 3_600_000, now: () => now as Instant });
  services.automation = service;
}

function shutdown(): void {
  service?.stop();
  services.runtime.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-automation-"));
  project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  now = "2026-09-29T08:00:00.000Z";
  boot();
});

afterEach(async () => {
  shutdown();
  await removeTestDirectory(dir);
});

async function request(method: string, path: string, body?: unknown, token = services.runtime.identity.localToken): Promise<GatewayResponse> {
  const request_: GatewayRequest = {
    method,
    path,
    query: {},
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: body === undefined ? "" : JSON.stringify(body),
  };
  return handleRequest(deps, request_);
}

async function createConversation(): Promise<string> {
  const response = await request("POST", "/conversations", { title: "Tự động" });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

function tools(conversationId: string) {
  const list = createAutomationTools({
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId,
    now: () => now as Instant,
    newId: services.conductor.newId,
    ownedRoots: () => [dir],
    kick: () => undefined,
  });
  const byName = (name: string) => {
    const tool = list.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no ${name}`);
    return (params: Record<string, unknown>) => tool.execute(params as never) as Promise<{ text: string }>;
  };
  return { create: byName("create_automation"), list: byName("list_automations"), update: byName("update_automation") };
}

function labeled(label: string, dedupeKey = `delivery-${label}`) {
  return {
    source: { kind: "external", provider: "github", sourceId: "github:owner/repo" },
    topic: "github.issue.labeled",
    subject: { type: "issue", id: "42", refs: { repository: "owner/repo" } },
    payload: { label, number: 42 },
    occurredAt: now,
    dedupeKey,
  };
}

function assistantTexts(conversationId: string): string[] {
  return allRows<{ document: string }>(
    services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence",
    conversationId,
  ).flatMap((row) => {
    const message = parseJson<MessageRecord>(row.document, "messages.document");
    if (message.role !== "assistant") return [];
    return message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : []));
  });
}

/** The automation notices as stored, oldest first, with the key each producer chose. */
function automationNotices(): {
  title: string;
  body: string | null;
  conversation_id: string | null;
  subject: string | null;
  dedup_key: string;
}[] {
  return allRows(
    services.runtime.db,
    "SELECT title, body, conversation_id, subject, dedup_key FROM notifications WHERE source_kind = 'automation' ORDER BY rowid",
  );
}

function codeChange(): CapabilityDescriptor {
  return {
    ref: "project.code.change@1" as CapabilityDescriptor["ref"],
    executionNodeId: services.runtime.identity.nodeId as CapabilityDescriptor["executionNodeId"],
    summary: "Apply a bounded code change",
    resourceKinds: ["workspace"],
    effectCategory: "local-write",
    supportsCancellation: true,
    requiresConnection: false,
    readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
    uiAffordances: [],
  };
}

describe("a signal arrives over the wire", () => {
  it("is recorded once, answered at once, and refused when it is not the sender's to send", async () => {
    const first = await request("POST", "/signals", labeled("ai-handle"));
    expect(first.status).toBe(202);
    const again = await request("POST", "/signals", labeled("ai-handle"));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, signalId: (first.body as { signalId: string }).signalId });

    expect((await request("POST", "/signals", { topic: "x" })).status).toBe(400);
    const timer = await request("POST", "/signals", { ...labeled("x"), source: { kind: "timer", sourceId: "timer:any" } });
    expect(timer.status).toBe(403);
    expect((await request("POST", "/signals", { ...labeled("x"), payload: { blob: "y".repeat(70_000) } })).status).toBe(413);
    expect((await request("POST", "/signals", labeled("z"), "not-the-token")).status).toBe(401);
    expect((await request("GET", "/signals")).status).toBe(405);
  });
});

describe("a reminder set up in the conversation", () => {
  it("is said in that conversation and left in the inbox, once for each fact", async () => {
    const conversationId = await createConversation();
    const { create, list } = tools(conversationId);
    const created = await create({
      summary: "Báo khi có issue gắn nhãn ai-handle",
      topic: "github.issue.labeled",
      match: [{ path: "payload.label", op: "equals", value: "ai-handle" }],
      action: "remind",
      message: "Có issue mới cần xử lý",
    });
    expect(created.text).toContain("Set up.");

    await request("POST", "/signals", labeled("ai-handle"));
    await request("POST", "/signals", labeled("ai-handle"));
    await request("POST", "/signals", labeled("wontfix"));
    service?.tick();
    service?.tick();

    const reminders = assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"));
    expect(reminders).toEqual(["Nhắc bạn — Báo khi có issue gắn nhãn ai-handle: Có issue mới cần xử lý"]);

    const inbox = inboxResponseSchema.parse((await request("GET", "/inbox")).body);
    const notices = inbox.notices.filter((notice) => notice.sourceKind === "automation");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: "Báo khi có issue gắn nhãn ai-handle", conversationId });

    expect((await list({})).text).toContain("last reminded");
    const listed = await request("GET", "/automations");
    expect(listed.status).toBe(200);
    expect((listed.body as { automations: unknown[] }).automations).toHaveLength(1);
  });

  it("fires on its schedule, once per slot", async () => {
    const conversationId = await createConversation();
    await tools(conversationId).create({
      summary: "Nhắc uống nước",
      schedule: { everyMinutes: 30 },
      action: "remind",
      message: "Uống nước",
    });
    service?.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toHaveLength(0);
    now = "2026-09-29T08:31:00.000Z";
    service?.tick();
    service?.tick();
    now = "2026-09-29T09:01:00.000Z";
    service?.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toHaveLength(2);
  });

  it("leaves one notice each time it comes due, pointing at its conversation", async () => {
    const conversationId = await createConversation();
    await tools(conversationId).create({
      summary: "Nhắc họp",
      schedule: { everyMinutes: 30 },
      action: "remind",
      message: "Họp nhóm",
    });

    now = "2026-09-29T08:31:00.000Z";
    service?.tick();
    service?.tick();
    const first = automationNotices();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: "Nhắc họp", body: "Họp nhóm", conversation_id: conversationId });
    expect(JSON.parse(first[0]?.subject ?? "null")).toEqual({ kind: "conversation", conversationId });

    // A tick in the same slot, and a node that stops and starts again, find the same occurrence already reported.
    shutdown();
    boot();
    service?.tick();
    expect(automationNotices()).toEqual(first);

    // The next slot is another occurrence, and another notice with its own key.
    now = "2026-09-29T09:01:00.000Z";
    service?.tick();
    service?.tick();
    const both = automationNotices();
    expect(both).toHaveLength(2);
    expect(new Set(both.map((notice) => notice.dedup_key)).size).toBe(2);
    for (const notice of both) expect(notice.dedup_key).toMatch(/^automation:irun_[^:]+$/);
  });
});

describe("a task set up in the conversation", () => {
  it("starts one task with only the folders and effects it was given, and says so", async () => {
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    const conversationId = await createConversation();
    const created = await tools(conversationId).create({
      summary: "Sửa issue gắn nhãn ai-handle",
      topic: "github.issue.labeled",
      match: [{ path: "payload.label", op: "equals", value: "ai-handle" }],
      action: "task",
      goal: "Fix the issue that was labelled",
      folders: [{ path: project, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    expect(created.text).toContain("Set up.");

    await request("POST", "/signals", labeled("ai-handle"));
    service?.tick();
    service?.tick();

    expect(dispatched).toHaveLength(1);
    const [job] = dispatched;
    expect(job?.capabilityRef).toBe("project.code.change@1");
    const task = getTask(services.runtime.db, job?.taskId ?? "");
    expect(task?.conversationId).toBe(conversationId);
    expect(task?.origin).toMatchObject({ kind: "persistent", allowedCategories: ["read", "local-write"] });
    expect(task?.resources).toEqual([{ kind: "folder", path: project, access: "write" }]);
    expect(assistantTexts(conversationId).some((text) => text.includes(`task ${job?.taskId ?? ""} đang chạy`))).toBe(true);
  });

  it("keeps a signal and its run across a node that stops, and starts the work once", async () => {
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    const conversationId = await createConversation();
    await tools(conversationId).create({
      summary: "Sửa issue",
      topic: "github.issue.labeled",
      action: "task",
      goal: "Fix it",
      folders: [{ path: project, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });

    // Recorded, then the node stops before anything was matched. The node that starts again declares its pack as not
    // loaded yet, so the first tick parks the task and says so, once; when the worker finishes loading, the next tick
    // takes the same task on without being told.
    await request("POST", "/signals", labeled("ai-handle", "before-stop"));
    shutdown();
    boot();
    service?.tick();
    service?.tick();
    expect(dispatched).toHaveLength(0);
    const waiting = assistantTexts(conversationId).filter((text) => text.includes("đang chờ"));
    expect(waiting).toHaveLength(1);
    // Why it waits, in the same language as the sentence around it.
    expect(waiting[0]).toContain("đang chờ capability ");
    expect(waiting[0]).not.toContain("waiting for capability");
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    service?.tick();
    expect(dispatched).toHaveLength(1);
    const firstTask = dispatched[0]?.taskId;

    // Matched into a run, then the node stops before the run started.
    await request("POST", "/signals", labeled("ai-handle", "second"));
    matchDueSignals({
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now: () => now as Instant,
      newId: services.conductor.newId,
    });
    shutdown();
    boot();
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    service?.tick();
    service?.tick();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.taskId).not.toBe(firstTask);
    const tasks = allRows<{ n: number }>(services.runtime.db, "SELECT count(*) AS n FROM tasks");
    expect(tasks[0]?.n).toBe(2);

    // Nothing is left for a third boot to start.
    shutdown();
    boot();
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    service?.tick();
    expect(dispatched).toHaveLength(0);
  });
  it("says it is waiting and then that it started, once each, rather than letting the first swallow the second", async () => {
    const conversationId = await createConversation();
    await tools(conversationId).create({
      summary: "Sửa issue khi có nhãn",
      topic: "github.issue.labeled",
      action: "task",
      goal: "Fix it",
      folders: [{ path: project, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });

    // Nothing here can run it yet: the run parks and says so.
    await request("POST", "/signals", labeled("ai-handle", "parked-then-started"));
    service?.tick();
    service?.tick();
    expect(automationNotices().map((notice) => notice.title)).toEqual(["Việc tự động đang chờ"]);

    // The worker finishes loading; the same run goes on, and that is its own notice.
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    service?.tick();
    service?.tick();
    expect(dispatched).toHaveLength(1);

    const notices = automationNotices();
    expect(notices.map((notice) => notice.title)).toEqual(["Việc tự động đang chờ", "Sửa issue khi có nhãn"]);
    const [waiting, started] = notices;
    const runId = /^automation:(irun_[^:]+)/.exec(started?.dedup_key ?? "")?.[1];
    expect(runId).toBeDefined();
    expect(waiting?.dedup_key).toBe(`automation:${runId ?? ""}:waiting`);
    expect(started?.dedup_key).toBe(`automation:${runId ?? ""}`);
    expect(started?.conversation_id).toBe(conversationId);
    // Both are about the automation, so they can be quieted as that one automation; the one that started names its task.
    const automation = {
      kind: "automation",
      intentId: expect.stringMatching(/^intent_/),
      label: "Sửa issue khi có nhãn",
      conversationId,
    };
    expect(JSON.parse(waiting?.subject ?? "null")).toEqual({ ...automation, taskId: dispatched[0]?.taskId });
    expect(JSON.parse(started?.subject ?? "null")).toEqual({ ...automation, taskId: dispatched[0]?.taskId });
  });

  it("says once, in the inbox and its conversation, when a run that came due was refused", async () => {
    const conversationId = await createConversation();
    await tools(conversationId).create({
      summary: "Sửa issue trong repo",
      topic: "github.issue.labeled",
      action: "task",
      goal: "Fix it",
      // A folder that is not a clone of the repository the signal is about, so the run is refused before a task exists.
      repositories: [project],
      allowedEffects: ["read", "local-write"],
    });

    await request("POST", "/signals", labeled("ai-handle", "refused"));
    service?.tick();
    service?.tick();

    expect(dispatched).toEqual([]);
    const notices = automationNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: "Việc tự động bị từ chối", conversation_id: conversationId });
    expect(notices[0]?.dedup_key).toMatch(/^automation:irun_[^:]+$/);
    expect(JSON.parse(notices[0]?.subject ?? "null")).toEqual({
      kind: "automation",
      intentId: expect.stringMatching(/^intent_/),
      label: "Sửa issue trong repo",
      conversationId,
    });
    expect(assistantTexts(conversationId).filter((text) => text.includes("không chạy cho"))).toHaveLength(1);
  });

  it("says once, pointing at its conversation, when a run that came due could not start, and keeps the automation", async () => {
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, codeChange());
    const conversationId = await createConversation();
    await tools(conversationId).create({
      summary: "Sửa issue khi có nhãn",
      topic: "github.issue.labeled",
      action: "task",
      goal: "Fix it",
      folders: [{ path: project, access: "write" }],
      allowedEffects: ["read", "local-write"],
    });
    // The node cannot write the run's task: the failure is the store's, not the automation's.
    services.runtime.db.exec(
      "CREATE TEMP TRIGGER refuse_tasks BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'disk is full'); END;",
    );

    await request("POST", "/signals", labeled("ai-handle", "could-not-start"));
    service?.tick();
    service?.tick();

    expect(dispatched).toEqual([]);
    const notices = automationNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: "Việc tự động không bắt đầu được", conversation_id: conversationId });
    expect(notices[0]?.body).toContain("“Sửa issue khi có nhãn” không bắt đầu được");
    // The exception is quoted as what it is, a diagnostic, rather than worded into the sentence.
    expect(notices[0]?.body).toContain("Lỗi gặp phải: “disk is full”");
    expect(notices[0]?.body).toContain("bản thân việc tự động vẫn được giữ nguyên");
    expect(notices[0]?.dedup_key).toMatch(/^automation:irun_[^:]+$/);
    expect(JSON.parse(notices[0]?.subject ?? "null")).toEqual({
      kind: "automation",
      intentId: expect.stringMatching(/^intent_/),
      label: "Sửa issue khi có nhãn",
      conversationId,
    });

    // What the notice says was kept is kept: the automation is still there to run the next time.
    const listed = await request("GET", "/automations");
    expect((listed.body as { automations: unknown[] }).automations).toHaveLength(1);
    services.runtime.db.exec("DROP TRIGGER temp.refuse_tasks;");
    await request("POST", "/signals", labeled("ai-handle", "starts-next-time"));
    service?.tick();
    service?.tick();
    expect(dispatched).toHaveLength(1);
  });

  it("refuses what an automation may not be given", async () => {
    const conversationId = await createConversation();
    const { create } = tools(conversationId);
    const base = { summary: "x", topic: "github.issue.labeled", action: "task", goal: "do it" };
    expect((await create(base)).text).toContain("must name the folders");
    expect((await create({ ...base, folders: [{ path: tmpdir(), access: "write" }] })).text).toContain("not inside a folder this node owns");
    expect((await create({ ...base, folders: [{ path: "relative/path", access: "read" }] })).text).toContain("not an absolute path");
    expect(
      (await create({ ...base, folders: [{ path: project, access: "write" }], allowedEffects: ["destructive"] })).text,
    ).toContain("cannot be given to an automation");
    expect((await create({ ...base, topic: "Not A Topic", folders: [{ path: project, access: "read" }] })).text).toContain("Not set up");
  });

  it("pauses, resumes and removes by id", async () => {
    const conversationId = await createConversation();
    const { create, list, update } = tools(conversationId);
    await create({ summary: "Nhắc", topic: "github.issue.labeled", action: "remind", message: "hi" });
    const intentId = /intent_[\w]+/.exec((await list({})).text)?.[0] ?? "";
    expect(intentId).not.toBe("");

    expect((await update({ intentId, change: "pause" })).text).toContain("paused");
    await request("POST", "/signals", labeled("ai-handle", "while-paused"));
    service?.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toHaveLength(0);

    expect((await update({ intentId, change: "resume", message: "hello" })).text).toContain("remind: hello");
    await request("POST", "/signals", labeled("ai-handle", "after-resume"));
    service?.tick();
    expect(assistantTexts(conversationId).filter((text) => text.startsWith("Nhắc bạn"))).toEqual(["Nhắc bạn — Nhắc: hello"]);

    expect((await update({ intentId, change: "remove" })).text).toContain("Removed");
    expect((await list({})).text).toBe("Nothing is set up to happen on its own.");
    expect((await update({ intentId, change: "resume" })).text).toContain("Not changed");
  });
});

describe("quieting an automation's notices", () => {
  it("quiets that one automation, and never another automation or a reminder", async () => {
    const conversationId = await createConversation();
    const { create } = tools(conversationId);
    // Two automations whose folder is not a clone of the repository, so every signal leaves a refusal warning for each,
    // and a reminder on the same signal.
    for (const summary of ["Sửa repo A", "Sửa repo B"]) {
      await create({
        summary,
        topic: "github.issue.labeled",
        action: "task",
        goal: "Fix it",
        repositories: [project],
        allowedEffects: ["read", "local-write"],
      });
    }
    await create({ summary: "Nhắc xem issue", topic: "github.issue.labeled", action: "remind", message: "Có issue mới" });

    const noticesAt = async (at: string) =>
      inboxResponseSchema
        .parse((await request("GET", "/inbox")).body)
        .notices.filter((notice) => notice.sourceKind === "automation" && notice.createdAt === at);
    const labelOf = (notice: Notice): string =>
      notice.subject?.kind === "automation" ? notice.subject.label : (notice.subject?.kind ?? "none");

    await request("POST", "/signals", labeled("ai-handle", "first"));
    service?.tick();
    service?.tick();
    const first = await noticesAt(now);
    expect(first.map(labelOf).sort()).toEqual(["Sửa repo A", "Sửa repo B", "conversation"]);
    const a = first.find((notice) => labelOf(notice) === "Sửa repo A");
    const reminder = first.find((notice) => labelOf(notice) === "conversation");
    expect(reminder?.actions?.map((action) => action.id)).not.toContain("suppress");

    const quieted = await request("POST", `/inbox/notices/${a?.noticeId ?? ""}/suppress`);
    expect(quieted.status).toBe(200);
    const intentA = a?.subject?.kind === "automation" ? a.subject.intentId : "";
    expect((quieted.body as { suppression: unknown }).suppression).toMatchObject({
      scope: `automation:${intentA}`,
      scopeLabel: "Sửa repo A",
    });
    const refused = await request("POST", `/inbox/notices/${reminder?.noticeId ?? ""}/suppress`);
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe("SUPPRESSION_TOO_BROAD");

    // The next signal: A's warning is still written down, but arrives read; B's warning and the reminder arrive unread.
    now = "2026-09-29T09:00:00.000Z";
    await request("POST", "/signals", labeled("ai-handle", "second"));
    service?.tick();
    service?.tick();
    const second = await noticesAt(now);
    const arrivedRead = Object.fromEntries(second.map((notice) => [labelOf(notice), notice.readAt !== undefined]));
    expect(arrivedRead).toEqual({ "Sửa repo A": true, "Sửa repo B": false, conversation: false });
  });
});
