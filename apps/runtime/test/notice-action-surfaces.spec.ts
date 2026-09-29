import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type AppIntentSource,
  type Instant,
  inboxResponseSchema,
  noticeOperationResponseSchema,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, setPreference, writeRegisteredPreference } from "@clarkcant/core";
import { allRows, claimWorkRunRetry, getNotification, listNotifications, recordNotification, recordWorkRun } from "@clarkcant/storage";

import { createActOnNoticeTool, describeNoticeOperation } from "../src/act-on-notice-tool.ts";
import { decideAppIntent, mintConfirmation } from "../src/app-intents.ts";
import { sweepExpired } from "../src/expiry-notices.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { readInbox } from "../src/inbox.ts";
import { createQuestion } from "../src/interactions.ts";
import { performNoticeOperation } from "../src/notice-operations.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { createReadInboxTool } from "../src/read-inbox-tool.ts";
import { interactionDepsFor } from "../src/routes/conversations.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createWorkJournal } from "../src/work-journal.ts";
import { configureNodeWork, createWorkSupervisor, nodeWork, type WorkSupervisor } from "../src/work-supervisor.ts";

/**
 * One notice action, whichever surface asks for it.
 *
 * The inbox panel, a typed or spoken sentence, the main and the voice agent's `act_on_notice`, MCP and `clarkcant api`
 * all reach `performNoticeOperation`. What these assert is the property that makes that safe: the node reads the notice
 * and works out what it offers now before anything changes, so a caller that names a stale notice, an action the notice
 * does not offer, an action only the person's screen can carry out, or the person's own answer about an effect is
 * refused — in the same words on every surface — and nothing is changed.
 */

let dir: string;
let services: NodeServices;
let now: string;
let deps: GatewayDeps;
let previousWork: WorkSupervisor;
let previousIndex: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-notice-surfaces-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  now = new Date().toISOString();
  let sequence = 0;
  deps = {
    services,
    now: () => now,
    newConversationId: () => {
      sequence += 1;
      return `conv_surfaces_${sequence}`;
    },
  };
  previousWork = nodeWork();
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  delete process.env["CC_DIRECTORY_INDEX"];
});

afterEach(() => {
  if (previousIndex === undefined) delete process.env["CC_DIRECTORY_INDEX"];
  else process.env["CC_DIRECTORY_INDEX"] = previousIndex;
  configureNodeWork(previousWork);
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown, raw?: string): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: raw ?? (body === undefined ? "" : JSON.stringify(body)),
  });
}

const act = (noticeId: string, action: string, body?: unknown) =>
  request("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/actions/${encodeURIComponent(action)}`, body);

const codeOf = (response: GatewayResponse) => (response.body as { code?: string }).code;

async function inbox() {
  const response = await request("GET", "/inbox");
  expect(response.status).toBe(200);
  return inboxResponseSchema.parse(response.body);
}

async function createConversation(): Promise<string> {
  const response = await request("POST", "/conversations", { title: "Thông báo" });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

const owner = () => services.runtime.identity.ownerPrincipalId;
const isUnread = (noticeId: string) => getNotification(services.runtime.db, owner(), noticeId)?.notice.readAt === undefined;

function resultNotice(dedupKey: string, title = "Việc nền đã xong: tóm tắt báo cáo") {
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

function automationWarning(dedupKey: string) {
  return recordNodeNotice(services, {
    sourceKind: "automation",
    category: "alert",
    severity: "warning",
    title: "Việc tự động bị từ chối",
    subject: { kind: "automation", intentId: "int_a", label: "Dọn repo", conversationId: "conv_elsewhere" },
    dedupKey,
    at: now as Instant,
  });
}

function failedBackgroundNotice(workId: string, conversationId: string) {
  recordWorkRun(services.runtime.db, {
    workId,
    nodeId: services.runtime.identity.nodeId,
    kind: "background",
    conversationId,
    title: "đọc log",
    requestText: "đọc log hôm qua",
    nodeBootId: "boot-earlier",
    state: "failed",
    effectful: false,
    attempt: 0,
    startedAt: now as Instant,
    endedAt: now as Instant,
  });
  return recordNodeNotice(services, {
    sourceKind: "background",
    category: "result",
    severity: "error",
    title: `Việc nền không xong: ${workId}`,
    conversationId,
    subject: { kind: "background-work", workId, conversationId },
    dedupKey: `background:${workId}`,
    at: now as Instant,
  });
}

const PACKAGE_ID = "com.example.surfaces";

function installGeneration(version: string): void {
  const generationId = `gen_${version}`;
  services.runtime.db
    .prepare(
      `INSERT INTO package_generations
         (generation_id, package_id, version, digest, node_id, code_generation, activated_at, superseded_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      generationId,
      PACKAGE_ID,
      version,
      "sha256:installed",
      services.runtime.identity.nodeId,
      "code-1",
      now,
      JSON.stringify({
        generationId,
        packageId: PACKAGE_ID,
        version,
        digest: "sha256:installed",
        nodeId: services.runtime.identity.nodeId,
        codeGeneration: "code-1",
        activatedAt: now,
        uiOnlyFacets: [],
        grantedCapabilities: [],
      }),
    );
}

function updateNotice(version: string) {
  return recordNodeNotice(services, {
    sourceKind: "package",
    category: "update",
    severity: "info",
    title: `Có bản cập nhật: ${PACKAGE_ID}`,
    subject: { kind: "package", packageId: PACKAGE_ID, version, source: "npm" },
    dedupKey: `update:npm:${PACKAGE_ID}@${version}`,
    at: now as Instant,
  });
}

/** A directory listing `version` of the package, so an install gets as far as the execution policy. */
function listInDirectory(version: string): void {
  const packageRoot = join(dir, "package");
  mkdirSync(packageRoot, { recursive: true });
  const indexPath = join(dir, "directory.json");
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        packageId: PACKAGE_ID,
        version,
        displayName: "Surfaces fixture",
        description: "A package whose update notice is acted on.",
        source: { kind: "local", path: packageRoot },
        publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
        preview: {},
        facets: ["ui"],
        isolations: [{ facetKind: "ui", isolation: "isolated-ui" }],
        platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"],
        hostApi: { min: 1, max: 1 },
        permissionsSummary: [],
        riskTier: "isolated-ui",
        sizeBytes: 512,
        digest: "sha256:surfaces-digest",
      },
    ]),
  );
  process.env["CC_DIRECTORY_INDEX"] = indexPath;
}

function askBeforeInstalling(): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => now as Instant },
    {
      principalId: owner(),
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "local-write", decision: "ask" }] },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

function expiredQuestionNotice(conversationId: string) {
  const past = new Date(Date.parse(now) - 20 * 60_000).toISOString() as Instant;
  const created = createQuestion(
    { ...interactionDepsFor(services, conversationId), now: () => past },
    { question: "Chọn môi trường triển khai.", kind: "confirm" },
  );
  if (!created.ok) throw new Error("the question was not created");
  sweepExpired(services, now as Instant);
  const questionId = created.interaction.questionId;
  const listed = listNotifications(services.runtime.db, owner()).find(
    (item) => item.subject?.kind === "question" && item.subject.questionId === questionId,
  );
  if (listed === undefined) throw new Error("the expiry was not reported");
  return { noticeId: listed.noticeId, questionId };
}

describe("POST /inbox/notices/:noticeId/actions/:action", () => {
  it("marks read and unread, snoozes and brings back, and dismisses, answering what it did", async () => {
    const { notificationId } = resultNotice("background:bg_1");

    const read = await act(notificationId, "mark-read");
    expect(read.status).toBe(200);
    expect(noticeOperationResponseSchema.parse(read.body)).toEqual({ noticeId: notificationId, action: "mark-read", outcome: "done" });
    expect(isUnread(notificationId)).toBe(false);
    expect((await act(notificationId, "mark-unread")).status).toBe(200);
    expect(isUnread(notificationId)).toBe(true);

    const until = new Date(Date.parse(now) + 2 * 60 * 60_000).toISOString();
    const snoozed = await act(notificationId, "snooze", { until });
    expect(snoozed.status).toBe(200);
    expect(snoozed.body).toMatchObject({ action: "snooze", outcome: "done", snoozedUntil: until });
    expect((await inbox()).snoozed.map((item) => item.noticeId)).toEqual([notificationId]);
    // A snoozed notice offers one thing, bringing it back, so snoozing it again is not something it offers.
    const twice = await act(notificationId, "snooze", { until });
    expect(twice.status).toBe(409);
    expect(codeOf(twice)).toBe("ACTION_NOT_OFFERED");

    expect((await act(notificationId, "unsnooze")).status).toBe(200);
    expect((await inbox()).notices.map((item) => item.noticeId)).toEqual([notificationId]);

    expect((await act(notificationId, "dismiss")).status).toBe(200);
    expect((await inbox()).notices).toEqual([]);
    // A stale second press, from another window or an agent, is told the notice is gone.
    const again = await act(notificationId, "dismiss");
    expect(again.status).toBe(404);
    expect(codeOf(again)).toBe("RESOURCE_NOT_FOUND");
  });

  it("quiets a notice's kind and turns it back on, and refuses to quiet a kind too broad to quiet", async () => {
    const warning = automationWarning("automation:run_1");
    expect((await act(warning.notificationId, "suppress")).status).toBe(200);
    expect((await inbox()).suppressions.map((item) => item.scope)).toEqual(["automation:int_a"]);
    expect((await act(warning.notificationId, "unsuppress")).status).toBe(200);
    expect((await inbox()).suppressions).toEqual([]);

    const reminder = recordNodeNotice(services, {
      sourceKind: "automation",
      category: "message",
      severity: "info",
      title: "Họp lúc 3 giờ",
      subject: { kind: "conversation", conversationId: "conv_elsewhere" },
      dedupKey: "automation:run_reminder",
      at: now as Instant,
    });
    const refused = await act(reminder.notificationId, "suppress");
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe("ACTION_NOT_OFFERED");
    expect((await inbox()).suppressions).toEqual([]);
  });

  it("refuses an unknown name, an action only the person's screen carries out, and the person's answer about an effect", async () => {
    const { notificationId } = resultNotice("background:bg_1");

    const unknown = await act(notificationId, "explode");
    expect(unknown.status).toBe(400);
    expect(codeOf(unknown)).toBe("UNKNOWN_ACTION");
    for (const surfaceAction of ["open", "ask-clark", "add-to-context", "review-update"]) {
      const refused = await act(notificationId, surfaceAction);
      expect(refused.status).toBe(409);
      expect(codeOf(refused)).toBe("SURFACE_ACTION");
    }
    for (const answer of ["reconcile-confirmed", "reconcile-failed"]) {
      const refused = await act(notificationId, answer);
      expect(refused.status).toBe(403);
      expect(codeOf(refused)).toBe("PERSON_ONLY");
    }
    // Nothing above changed the notice.
    expect(isUnread(notificationId)).toBe(true);
    expect((await inbox()).notices.map((item) => item.noticeId)).toEqual([notificationId]);
  });

  it("refuses an action the notice does not offer now, and names why when it is offered but not possible", async () => {
    const success = resultNotice("background:bg_ok");
    const notOffered = await act(success.notificationId, "retry");
    expect(notOffered.status).toBe(409);
    expect(codeOf(notOffered)).toBe("ACTION_NOT_OFFERED");
    expect(codeOf(await act(success.notificationId, "skip-version"))).toBe("ACTION_NOT_OFFERED");
    expect(codeOf(await act(success.notificationId, "ask-again"))).toBe("ACTION_NOT_OFFERED");

    // An update for a package this node does not run: offered, with the reason it cannot be taken.
    const gone = updateNotice("2.0.0");
    const unavailable = await act(gone.notificationId, "update");
    expect(unavailable.status).toBe(409);
    expect(unavailable.body).toMatchObject({ code: "ACTION_UNAVAILABLE", reason: "package-gone" });

    installGeneration("2.0.0");
    const current = await act(gone.notificationId, "update");
    expect(current.body).toMatchObject({ code: "ACTION_UNAVAILABLE", reason: "already-current" });
    expect((await inbox()).notices.map((item) => item.noticeId)).toContain(gone.notificationId);
  });

  it("retries failed background work once, and a second request finds the notice gone", async () => {
    configureNodeWork(
      createWorkSupervisor({
        journal: createWorkJournal({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId, machineBootId: undefined }),
        backgroundLimit: () => 2,
      }),
    );
    services.turnControl = { running: () => [], interrupt: () => false, steer: async () => false, runInBackground: async () => "ok" };
    const conversationId = await createConversation();
    const notice = failedBackgroundNotice("bg-failed", conversationId);

    const retried = await act(notice.notificationId, "retry");
    expect(retried.status).toBe(200);
    const body = noticeOperationResponseSchema.parse(retried.body);
    expect(body).toMatchObject({ action: "retry", outcome: "done", state: "running" });
    expect(body.workId).toMatch(/^bg-/);
    expect(body.workId).not.toBe("bg-failed");

    const again = await act(notice.notificationId, "retry");
    expect(again.status).toBe(404);
  });

  it("does not retry work that was already retried from somewhere else, even though its notice is still listed", async () => {
    const conversationId = await createConversation();
    const notice = failedBackgroundNotice("bg-raced", conversationId);
    expect(claimWorkRunRetry(services.runtime.db, "bg-raced", "bg-elsewhere")).toBe(true);

    const stale = await act(notice.notificationId, "retry");
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe("ACTION_NOT_OFFERED");
    expect((await inbox()).notices.map((item) => item.noticeId)).toContain(notice.notificationId);
  });

  it("asks an expired question again once, and skips the version an update notice names", async () => {
    const conversationId = await createConversation();
    const expired = expiredQuestionNotice(conversationId);
    const asked = await act(expired.noticeId, "ask-again");
    expect(asked.status).toBe(200);
    const questionId = noticeOperationResponseSchema.parse(asked.body).questionId;
    expect(questionId).toBeDefined();
    expect(questionId).not.toBe(expired.questionId);
    expect((await act(expired.noticeId, "ask-again")).status).toBe(404);

    installGeneration("1.0.0");
    const update = updateNotice("1.2.0");
    const skipped = await act(update.notificationId, "skip-version");
    expect(skipped.body).toEqual({ noticeId: update.notificationId, action: "skip-version", outcome: "done", version: "1.2.0" });
    const after = await inbox();
    expect(after.notices.map((item) => item.noticeId)).not.toContain(update.notificationId);
    expect(after.skippedVersions).toMatchObject([{ subjectKind: "package", name: PACKAGE_ID, version: "1.2.0" }]);
  });

  it("installs an update only through the ordinary install, whose refusal and whose approval pass through unchanged", async () => {
    installGeneration("1.0.0");
    const notice = updateNotice("1.1.0");

    // No directory configured: the install's own refusal, and the notice is still there to try again.
    const refused = await act(notice.notificationId, "update");
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe("NO_DIRECTORY");
    expect((await inbox()).notices.map((item) => item.noticeId)).toContain(notice.notificationId);

    // A policy that asks first: the approval is raised and left for the person; nothing is installed.
    listInDirectory("1.1.0");
    askBeforeInstalling();
    const asked = await act(notice.notificationId, "update");
    expect(asked.body).toMatchObject({ outcome: "approval-required" });
    expect(asked.status).toBe(202);
    const body = noticeOperationResponseSchema.parse(asked.body);
    expect(body).toMatchObject({ action: "update", outcome: "approval-required", version: "1.1.0" });
    const pending = allRows<{ approval_id: string; decision: string }>(
      services.runtime.db,
      "SELECT approval_id, decision FROM approvals WHERE approval_id = ?",
      body.approvalId,
    );
    expect(pending).toEqual([{ approval_id: body.approvalId, decision: "pending" }]);
    const generations = allRows<{ version: string }>(services.runtime.db, "SELECT version FROM package_generations WHERE package_id = ?", PACKAGE_ID);
    expect(generations.map((row) => row.version)).toEqual(["1.0.0"]);
    expect((await inbox()).notices.map((item) => item.noticeId)).toContain(notice.notificationId);
  });

  it("checks what it is sent: a snooze's time, the body's shape, the path's encoding, the method and the token", async () => {
    const { notificationId } = resultNotice("background:bg_1");

    const missing = await act(notificationId, "snooze");
    expect(missing.status).toBe(400);
    expect(codeOf(missing)).toBe("INVALID_SCHEMA");
    const past = await act(notificationId, "snooze", { until: new Date(Date.parse(now) - 60_000).toISOString() });
    expect(past.status).toBe(400);
    expect(codeOf(past)).toBe("SNOOZE_OUT_OF_RANGE");
    expect((await act(notificationId, "snooze", { until: 5 })).status).toBe(400);
    expect((await request("POST", `/inbox/notices/${notificationId}/actions/dismiss`, undefined, "[1]")).status).toBe(400);
    expect((await request("POST", `/inbox/notices/%E0%A4%A/actions/dismiss`)).status).toBe(400);
    expect((await request("GET", `/inbox/notices/${notificationId}/actions/dismiss`)).status).toBe(405);
    const anonymous = await handleRequest(deps, {
      method: "POST",
      path: `/inbox/notices/${notificationId}/actions/dismiss`,
      query: {},
      headers: {},
      body: "",
    });
    expect(anonymous.status).toBe(401);
    expect((await inbox()).notices.map((item) => item.noticeId)).toEqual([notificationId]);
  });

  it("does not find another principal's notice", async () => {
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
    for (const action of ["mark-read", "dismiss", "suppress"]) {
      const refused = await act(theirs.notificationId, action);
      expect(refused.status).toBe(404);
    }
    expect(getNotification(services.runtime.db, "someone_else", theirs.notificationId)).toMatchObject({ dismissed: false });
  });
});

describe("act_on_notice, the main and the voice agent's tool", () => {
  const tool = (channel: "voice" | "chat" = "chat") =>
    createActOnNoticeTool({
      services: () => services,
      now: () => now as Instant,
      conversationId: "conv_agent",
      channel: () => channel,
    });

  const lastIntent = () =>
    allRows<{ document: string }>(services.runtime.db, "SELECT document FROM events WHERE kind = 'app.intent' ORDER BY rowid DESC LIMIT 1").map(
      (row) => JSON.parse(row.document) as { source: string; kind: string; noticeId?: string; noticeAction?: string },
    );

  it("dismisses through the same operation as the route, and audits the voice agent as itself", async () => {
    const { notificationId } = resultNotice("background:bg_1");
    const { text } = await tool("voice").execute({ noticeId: notificationId, action: "dismiss" });
    expect(text).toBe("Done: the notice is dismissed; the user can undo it from the inbox for a short while.");
    expect((await inbox()).notices).toEqual([]);
    expect(lastIntent()).toEqual([expect.objectContaining({ source: "voice-agent", kind: "notice.act", noticeId: notificationId, noticeAction: "dismiss" })]);

    const second = await tool().execute({ noticeId: notificationId, action: "dismiss" });
    expect(second.text).toContain("Not done:");
    expect(second.text).toContain("[RESOURCE_NOT_FOUND]");
    expect(lastIntent()[0]?.source).toBe("agent");
  });

  it("snoozes for the hours asked, and refuses hours out of range without changing anything", async () => {
    const { notificationId } = resultNotice("background:bg_1");
    const refused = await tool().execute({ noticeId: notificationId, action: "snooze", snoozeHours: 0 });
    expect(refused.text).toContain("Nothing was changed");
    expect((await inbox()).snoozed).toEqual([]);

    const { text } = await tool().execute({ noticeId: notificationId, action: "snooze", snoozeHours: 3 });
    const until = new Date(Date.parse(now) + 3 * 60 * 60_000).toISOString();
    expect(text).toContain(`snoozed until ${until}`);
    expect((await inbox()).snoozed[0]?.snoozedUntil).toBe(until);
  });

  it("refuses what is not a node operation, including the person's answers, before recording anything", async () => {
    const { notificationId } = resultNotice("background:bg_1");
    for (const action of ["open", "reconcile-confirmed", "approve"]) {
      const { text } = await tool().execute({ noticeId: notificationId, action });
      expect(text).toContain("is not a notice action");
    }
    expect((await tool().execute({ action: "dismiss" })).text).toContain("noticeId");
    expect(lastIntent()).toEqual([]);
    expect(isUnread(notificationId)).toBe(true);
  });

  it("tells the model an update waits for the person's approval, not that it was installed", () => {
    expect(
      describeNoticeOperation({
        ok: true,
        response: { noticeId: "ntf_1", action: "update", outcome: "approval-required", version: "1.1.0", approvalId: "appr_1" },
      }),
    ).toBe("Not installed: the user's execution mode asks for approval before installing 1.1.0, so nothing was installed. Only the user can approve it.");
    expect(
      describeNoticeOperation({ ok: false, status: 409, code: "ACTION_UNAVAILABLE", message: "update cannot be taken now: package-gone", reason: "package-gone" }),
    ).toBe("Not done: update cannot be taken now: package-gone (package-gone) [ACTION_UNAVAILABLE]. Nothing was changed.");
  });

  it("is told each notice's id and the actions it can take on it by read_inbox", async () => {
    const conversationId = await createConversation();
    const update = updateNotice("3.0.0");
    const failed = failedBackgroundNotice("bg-listed", conversationId);
    const { text } = await createReadInboxTool(() => readInbox(services, now as Instant)).execute({});
    expect(text).toContain(`(notice ${failed.notificationId}; actions: retry, mark-read, snooze, dismiss`);
    expect(text).toContain(`(notice ${update.notificationId}; actions: `);
    expect(text).toContain("not possible now: update (package-gone)");
    expect(text).toContain("use act_on_notice");
    // Surface-only actions are the person's screen's and are never offered to the model.
    expect(text).not.toMatch(/actions: [^)]*\bopen\b/);
  });
});

describe("a typed or spoken notice action names its notice on the node", () => {
  const intentDeps = () => ({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => now as Instant, newId: services.conductor.newId });
  const decide = (text: string, source: AppIntentSource = "chat") =>
    decideAppIntent(intentDeps(), { principalId: owner(), request: { text, source } }, (intent) =>
      mintConfirmation(intentDeps(), { principalId: owner(), intent, source }),
    );
  const inEnglish = () =>
    setPreference(
      { db: services.runtime.db, now: () => now as Instant },
      { principalId: owner(), key: "experience.language", scope: "global", value: "en", source: "user" },
    );

  it("targets the newest notice for dismiss, reading the notice's title back, in Vietnamese and English", () => {
    resultNotice("background:bg_old", "Việc cũ");
    now = new Date(Date.parse(now) + 1_000).toISOString();
    const newest = resultNotice("background:bg_new", "Việc mới");
    expect(decide("Bỏ thông báo mới nhất")).toEqual({
      kind: "intent",
      intent: { kind: "notice.act", noticeId: newest.notificationId, noticeAction: "dismiss" },
      requiresConfirmation: false,
      readBack: "Tôi bỏ thông báo “Việc mới” khỏi hộp thư nhé. Bạn có thể hoàn tác trong hộp thư trong vài phút.",
    });
    inEnglish();
    expect(decide("dismiss the latest notification", "voice")).toMatchObject({
      kind: "intent",
      intent: { kind: "notice.act", noticeId: newest.notificationId, noticeAction: "dismiss" },
      readBack: "Dismissing the notice “Việc mới”. You can undo it from the inbox for a few minutes.",
    });
    // Decided, not done: the page carries it out through the node's action route.
    expect(getNotification(services.runtime.db, owner(), newest.notificationId)?.dismissed).toBe(false);
  });

  it("targets the newest notice that can be retried, past newer ones that cannot", async () => {
    const conversationId = await createConversation();
    const failed = failedBackgroundNotice("bg-target", conversationId);
    now = new Date(Date.parse(now) + 1_000).toISOString();
    resultNotice("background:bg_newer");
    expect(decide("Chạy lại việc nền bị lỗi")).toMatchObject({
      kind: "intent",
      intent: { kind: "notice.act", noticeId: failed.notificationId, noticeAction: "retry" },
    });
  });

  it("refuses rather than guesses when no notice offers the action, and says why a named one cannot", () => {
    expect(decide("dismiss the latest notification")).toEqual({
      kind: "refused",
      say: "Lúc này không có thông báo nào trong hộp thư để bỏ thông báo, nên tôi chưa làm gì cả.",
    });
    const gone = updateNotice("4.0.0");
    inEnglish();
    expect(decide("install the latest update")).toMatchObject({ kind: "refused", say: expect.stringContaining("No notice in your inbox lets me install its update") });

    const clicked = decideAppIntent(
      intentDeps(),
      { principalId: owner(), request: { source: "click" }, intent: { kind: "notice.act", noticeId: gone.notificationId, noticeAction: "update" } },
      (intent) => mintConfirmation(intentDeps(), { principalId: owner(), intent, source: "click" }),
    );
    expect(clicked).toEqual({
      kind: "refused",
      say: `The notice “Có bản cập nhật: ${PACKAGE_ID}” does not let me install its update right now because that package is no longer installed, so I have not done anything.`,
    });
    const missing = decideAppIntent(
      intentDeps(),
      { principalId: owner(), request: { source: "click" }, intent: { kind: "notice.act", noticeId: "ntf_missing", noticeAction: "dismiss" } },
      (intent) => mintConfirmation(intentDeps(), { principalId: owner(), intent, source: "click" }),
    );
    expect(missing).toEqual({ kind: "refused", say: "That notice is no longer in your inbox, so I have not done anything." });
  });

  it("brings back the snoozed notice due soonest", async () => {
    const later = resultNotice("background:bg_later", "Để sau");
    const sooner = resultNotice("background:bg_sooner", "Sắp tới");
    await act(later.notificationId, "snooze", { until: new Date(Date.parse(now) + 5 * 60 * 60_000).toISOString() });
    await act(sooner.notificationId, "snooze", { until: new Date(Date.parse(now) + 60 * 60_000).toISOString() });
    inEnglish();
    expect(decide("bring back the snoozed notification")).toMatchObject({
      kind: "intent",
      intent: { kind: "notice.act", noticeId: sooner.notificationId, noticeAction: "unsnooze" },
    });
  });
});

describe("performNoticeOperation", () => {
  it("reports an install that throws as the operation's own failure to its caller, not as success", async () => {
    installGeneration("1.0.0");
    const notice = updateNotice("1.1.0");
    listInDirectory("1.1.0");
    // A listing that cannot be read at all is the install's refusal, never a thrown error the route would turn into 500.
    writeFileSync(process.env["CC_DIRECTORY_INDEX"] ?? "", "{not json");
    const outcome = await performNoticeOperation(services, { noticeId: notice.notificationId, action: "update" }, () => now as Instant);
    expect(outcome).toMatchObject({ ok: false, code: "DIRECTORY_UNREADABLE" });
    expect(getNotification(services.runtime.db, owner(), notice.notificationId)?.dismissed).toBe(false);
  });
});
