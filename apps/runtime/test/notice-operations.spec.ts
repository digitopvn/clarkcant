import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Instant, type Notice, type Platform, inboxResponseSchema } from "@clarkcant/contracts";
import type { InstalledPackageView } from "@clarkcant/core";
import {
  claimWorkRunRetry,
  getNotification,
  getWorkRun,
  latestMessages,
  listNotifications,
  recordNotification,
  recordWorkRun,
  type WorkRunRecord,
} from "@clarkcant/storage";

import { sweepExpired } from "../src/expiry-notices.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { QUESTION_TTL_MS, answerQuestion, createQuestion } from "../src/interactions.ts";
import { noticeActionsFor } from "../src/notice-actions.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { interactionDepsFor } from "../src/routes/conversations.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { checkForUpdates, type UpdateCandidate } from "../src/update-checks.ts";
import { createWorkJournal } from "../src/work-journal.ts";
import { configureNodeWork, createWorkSupervisor, nodeWork, type WorkSupervisor } from "../src/work-supervisor.ts";

/**
 * What a notice lets a person do about the thing it reports, over the wire.
 *
 * Each operation is offered from the thing's state now, not from what the notice said when it was written, and the
 * route that carries it out checks that state again: the inbox must never draw a button whose route then fails, and a
 * second press, a second surface or a stale list must be told what already happened rather than doing it twice.
 */

let dir: string;
let services: NodeServices;
let now: string;
let deps: GatewayDeps;
let previousWork: WorkSupervisor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-notice-ops-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  now = new Date().toISOString();
  let sequence = 0;
  deps = {
    services,
    now: () => now,
    newConversationId: () => {
      sequence += 1;
      return `conv_ops_${sequence}`;
    },
  };
  previousWork = nodeWork();
});

afterEach(() => {
  configureNodeWork(previousWork);
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function createConversation(): Promise<string> {
  const response = await request("POST", "/conversations", { title: "Thao tác từ hộp thư" });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

async function inbox() {
  const response = await request("GET", "/inbox");
  expect(response.status).toBe(200);
  return inboxResponseSchema.parse(response.body);
}

async function actionsOf(noticeId: string) {
  return (await inbox()).notices.find((item) => item.noticeId === noticeId)?.actions;
}

const owner = () => services.runtime.identity.ownerPrincipalId;

/** A supervisor that writes `work_runs` the way the node's does, so a run outlives its promise and can be retried. */
function journaledWork(options: { backgroundLimit?: number; queueLimit?: number } = {}): void {
  configureNodeWork(
    createWorkSupervisor({
      journal: createWorkJournal({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId, machineBootId: undefined }),
      backgroundLimit: () => options.backgroundLimit ?? 2,
      ...(options.queueLimit === undefined ? {} : { queueLimit: options.queueLimit }),
    }),
  );
}

function seedRun(overrides: Partial<WorkRunRecord>, options: { wordless?: true } = {}): WorkRunRecord {
  const seeded: WorkRunRecord = {
    workId: "bg-seeded",
    nodeId: services.runtime.identity.nodeId,
    kind: "background",
    conversationId: "conv_missing",
    title: "đọc log",
    requestText: "đọc log",
    nodeBootId: "boot-earlier",
    state: "failed",
    effectful: false,
    attempt: 0,
    startedAt: now as Instant,
    endedAt: now as Instant,
    ...overrides,
  };
  const { requestText: _dropped, ...withoutWords } = seeded;
  const run: WorkRunRecord = options.wordless === true ? withoutWords : seeded;
  recordWorkRun(services.runtime.db, run);
  return run;
}

function backgroundNotice(workId: string, conversationId: string, severity: Notice["severity"] = "error") {
  return recordNodeNotice(services, {
    sourceKind: "background",
    category: "result",
    severity,
    title: `Việc nền không xong: ${workId}`,
    conversationId,
    subject: { kind: "background-work", workId, conversationId },
    dedupKey: `background:${workId}`,
    at: now as Instant,
  });
}

describe("trying background work again", () => {
  it("offers Try again on a failed run, runs the same words as new work once, and reports the new run", async () => {
    journaledWork();
    const conversationId = await createConversation();
    let calls = 0;
    const asked: string[] = [];
    services.turnControl = {
      running: () => [],
      interrupt: () => false,
      steer: async () => false,
      runInBackground: async ({ text }) => {
        calls += 1;
        asked.push(text);
        if (calls === 1) throw new Error("hết hạn mức model");
        return "Đã đọc xong log.";
      },
    };

    expect((await request("POST", "/background-sessions", { conversationId, text: "đọc log hôm qua" })).status).toBeLessThan(300);
    await vi.waitFor(async () => expect((await inbox()).notices).toHaveLength(1));
    const [failed] = (await inbox()).notices;
    if (failed?.subject?.kind !== "background-work") throw new Error("the failure was not reported against its work");
    const failedWorkId = failed.subject.workId;
    await vi.waitFor(() => expect(getWorkRun(services.runtime.db, failedWorkId)?.state).toBe("failed"));

    // What the notice is for leads, ahead of asking Clark and opening the conversation.
    expect((await actionsOf(failed.noticeId))?.slice(0, 3)).toEqual([
      { id: "retry", placement: "primary" },
      { id: "ask-clark", placement: "secondary" },
      { id: "open", placement: "menu" },
    ]);

    const retried = await request("POST", `/work/${failedWorkId}/retry`);
    expect(retried.status).toBe(202);
    const body = retried.body as { accepted: boolean; workId: string; retriedFrom: string; state: string };
    expect(body).toMatchObject({ accepted: true, retriedFrom: failedWorkId, state: "running" });
    expect(body.workId).not.toBe(failedWorkId);
    expect(getWorkRun(services.runtime.db, failedWorkId)?.retriedAs).toBe(body.workId);

    // The old notice is stale now: the new run reports for itself, into the same conversation, with the same words.
    await vi.waitFor(async () => {
      const notices = (await inbox()).notices;
      expect(notices.map((item) => item.noticeId)).not.toContain(failed.noticeId);
      expect(notices.find((item) => item.subject?.kind === "background-work" && item.subject.workId === body.workId)?.severity).toBe(
        "success",
      );
    });
    expect(asked).toEqual(["đọc log hôm qua", "đọc log hôm qua"]);
    const said = latestMessages(services.runtime.db, conversationId, 20).flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : [])),
    );
    expect(said.some((text) => text.startsWith("Đang chạy lại việc nền"))).toBe(true);

    // Once per run: a second press, or a second surface, is told it already happened.
    const again = await request("POST", `/work/${failedWorkId}/retry`);
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe("ALREADY_RETRIED");
    // A run that finished has nothing to try again.
    const done = await request("POST", `/work/${body.workId}/retry`);
    expect(done.status).toBe(409);
    expect((done.body as { code: string }).code).toBe("WORK_NOT_RETRYABLE");
  });

  it("stops offering Try again once the run was retried from anywhere", async () => {
    const conversationId = await createConversation();
    seedRun({ workId: "bg-retried", conversationId });
    const notice = backgroundNotice("bg-retried", conversationId);
    expect((await actionsOf(notice.notificationId))?.[0]).toEqual({ id: "retry", placement: "primary" });
    // Retried from somewhere else: another window, the CLI, a second press that raced this list.
    expect(claimWorkRunRetry(services.runtime.db, "bg-retried", "bg-newer")).toBe(true);
    expect(claimWorkRunRetry(services.runtime.db, "bg-retried", "bg-newest")).toBe(false);
    expect((await actionsOf(notice.notificationId))?.map((action) => action.id)).not.toContain("retry");
  });

  it("says the run is gone when the node no longer keeps it, and offers nothing on one that went well", async () => {
    const conversationId = await createConversation();
    const failed = backgroundNotice("bg-pruned", conversationId);
    expect(await actionsOf(failed.notificationId)).toContainEqual({ id: "retry", placement: "menu", unavailable: "work-gone" });
    const succeeded = backgroundNotice("bg-pruned-ok", conversationId, "success");
    expect((await actionsOf(succeeded.notificationId))?.map((action) => action.id)).not.toContain("retry");
    expect((await request("POST", "/work/bg-pruned/retry")).status).toBe(404);
  });

  it("refuses a run that is not background work, is still going, kept no words, or whose conversation is gone", async () => {
    const conversationId = await createConversation();
    seedRun({ workId: "cmd-1", kind: "command", conversationId, effectful: true });
    seedRun({ workId: "bg-running", conversationId, state: "running" });
    seedRun({ workId: "bg-wordless", conversationId }, { wordless: true });
    seedRun({ workId: "bg-orphan", conversationId: "conv_deleted" });
    for (const workId of ["cmd-1", "bg-running", "bg-wordless"]) {
      const refused = await request("POST", `/work/${workId}/retry`);
      expect(refused.status).toBe(409);
      expect((refused.body as { code: string }).code).toBe("WORK_NOT_RETRYABLE");
      expect((await actionsOf(backgroundNotice(workId, conversationId).notificationId))?.map((action) => action.id)).not.toContain("retry");
    }
    const orphan = await request("POST", "/work/bg-orphan/retry");
    expect(orphan.status).toBe(409);
    expect((orphan.body as { code: string }).code).toBe("CONVERSATION_GONE");
    expect((await actionsOf(backgroundNotice("bg-orphan", "conv_deleted").notificationId))?.map((action) => action.id)).not.toContain("retry");
    expect(getWorkRun(services.runtime.db, "bg-orphan")?.retriedAs).toBeUndefined();
  });

  it("gives the claim back when the node is too busy to take the new run, so it can be tried again later", async () => {
    journaledWork({ backgroundLimit: 1, queueLimit: 0 });
    const conversationId = await createConversation();
    services.turnControl = { running: () => [], interrupt: () => false, steer: async () => false, runInBackground: async () => "ok" };
    seedRun({ workId: "bg-busy", conversationId });
    const holding = nodeWork().submitBackground({
      conversationId,
      title: "đang chạy",
      requestText: "x",
      run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error))),
    });
    expect(holding.accepted).toBe(true);

    const busy = await request("POST", "/work/bg-busy/retry");
    expect(busy.status).toBe(429);
    expect((busy.body as { code: string }).code).toBe("BACKGROUND_BUSY");
    expect(getWorkRun(services.runtime.db, "bg-busy")?.retriedAs).toBeUndefined();
    if (holding.accepted) nodeWork().cancel(holding.workId);
  });

  it("is only for the node's owner, over POST", async () => {
    expect((await request("GET", "/work/bg-x/retry")).status).toBe(405);
    const anonymous = await handleRequest(deps, { method: "POST", path: "/work/bg-x/retry", query: {}, headers: {}, body: "" });
    expect(anonymous.status).toBe(401);
  });
});

const HOST: Platform = "linux-x64";
const PACKAGE_ID = "com.example.demo";

function installPackageGeneration(version: string): void {
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

function updateNotice(version: string, source: "npm" | "git" | "local" = "npm") {
  return recordNodeNotice(services, {
    sourceKind: "package",
    category: "update",
    severity: "info",
    title: `Có bản cập nhật: ${PACKAGE_ID}`,
    subject: { kind: "package", packageId: PACKAGE_ID, version, source },
    dedupKey: `update:${source}:${PACKAGE_ID}@${version}`,
    at: now as Instant,
  });
}

function installed(version: string): InstalledPackageView {
  return {
    packageId: PACKAGE_ID,
    version,
    digest: "sha256:installed",
    codeGeneration: "gen-1",
    activatedAt: now as Instant,
    source: { sourceTier: "curated-registry", rationale: "npm", artifactUrl: `npm:${PACKAGE_ID}@${version}` },
    lane: "isolated-ui",
    consentedDigest: "sha256:installed",
    lock: undefined,
    previousVersion: undefined,
  };
}

function candidate(version: string): UpdateCandidate {
  return {
    packageId: PACKAGE_ID,
    version,
    sourceKind: "npm",
    lane: "isolated-ui",
    digest: `sha256:directory-${version}`,
    hostApi: { min: 1, max: 1 },
    platforms: [HOST],
  };
}

describe("an update notice", () => {
  it("offers Update and Review first while the package runs an older version, and Skip this version behind More", async () => {
    installPackageGeneration("1.0.0");
    const notice = updateNotice("1.1.0");
    const actions = await actionsOf(notice.notificationId);
    expect(actions?.slice(0, 2)).toEqual([
      { id: "update", placement: "primary" },
      { id: "review-update", placement: "secondary" },
    ]);
    expect(actions).toContainEqual({ id: "ask-clark", placement: "menu" });
    expect(actions).toContainEqual({ id: "skip-version", placement: "menu" });
    // Pushed off the buttons, Dismiss keeps its usual place in More: after Add to context, not ahead of it.
    const ids = actions?.map((action) => action.id) ?? [];
    expect(ids.filter((id) => id === "dismiss")).toHaveLength(1);
    expect(ids.indexOf("add-to-context")).toBeLessThan(ids.indexOf("dismiss"));
  });

  it("offers only Review for a version from a local folder, which cannot be installed by id and version alone", async () => {
    installPackageGeneration("1.0.0");
    const actions = await actionsOf(updateNotice("1.1.0", "local").notificationId);
    expect(actions?.[0]).toEqual({ id: "review-update", placement: "primary" });
    expect(actions?.map((action) => action.id)).not.toContain("update");
    expect(actions).toContainEqual({ id: "skip-version", placement: "menu" });
  });

  it("says the package is already at that version, or no longer installed, instead of offering an update that fails", async () => {
    installPackageGeneration("1.1.0");
    const current = updateNotice("1.1.0");
    expect(await actionsOf(current.notificationId)).toContainEqual({ id: "update", placement: "menu", unavailable: "already-current" });
    expect((await actionsOf(current.notificationId))?.map((action) => action.id)).not.toContain("skip-version");

    services.runtime.db.prepare("UPDATE package_generations SET superseded_at = ? WHERE package_id = ?").run(now, PACKAGE_ID);
    expect(await actionsOf(current.notificationId)).toContainEqual({ id: "update", placement: "menu", unavailable: "package-gone" });
  });

  it("skips the version the notice named and anything older, keeps telling about newer ones, and takes it back", async () => {
    installPackageGeneration("1.0.0");
    const notice = updateNotice("1.2.0");
    const skipped = await request("POST", `/inbox/notices/${notice.notificationId}/skip-version`);
    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({ skipped: true, subjectKind: "package", name: PACKAGE_ID, version: "1.2.0" });
    expect((await inbox()).notices.map((item) => item.noticeId)).not.toContain(notice.notificationId);

    const check = (versions: string[]) =>
      checkForUpdates({
        services,
        installedPackages: [installed("1.0.0")],
        directory: versions.map(candidate),
        now: () => now as Instant,
        platform: HOST,
      });
    // 1.1.0 is newer than what runs but older than what was skipped: not worth a notice.
    expect(check(["1.1.0"]).packageUpdates).toBe(0);
    expect(check(["1.3.0"]).packageUpdates).toBe(1);

    const undone = await request("POST", `/inbox/notices/${notice.notificationId}/unskip-version`);
    expect(undone.body).toEqual({ skipped: false, restored: true });
    expect((await inbox()).notices.map((item) => item.noticeId)).toContain(notice.notificationId);
    expect(check(["1.1.0"]).packageUpdates).toBe(1);
  });

  it("still lets a Pi SDK update notice from before be skipped, and offers no update for it", async () => {
    const pi = recordNodeNotice(services, {
      sourceKind: "pi",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật cho Pi SDK",
      subject: { kind: "pi-update", packageName: "@earendil-works/pi-coding-agent", version: "1.2.0" },
      dedupKey: "update:pi:@earendil-works/pi-coding-agent@1.2.0",
      at: now as Instant,
    });
    const listed = (await inbox()).notices.find((item) => item.noticeId === pi.notificationId);
    expect(listed?.actions).toContainEqual({ id: "skip-version", placement: "menu" });
    expect(listed?.actions?.map((action) => action.id)).not.toContain("update");

    const skipped = await request("POST", `/inbox/notices/${pi.notificationId}/skip-version`);
    expect(skipped.body).toMatchObject({ skipped: true, subjectKind: "pi", version: "1.2.0" });
  });

  it("lists every skipped version for review, newest first, and takes one back from the list", async () => {
    installPackageGeneration("1.0.0");
    const first = updateNotice("1.1.0");
    await request("POST", `/inbox/notices/${first.notificationId}/skip-version`);
    now = new Date(Date.parse(now) + 1_000).toISOString();
    const pi = recordNodeNotice(services, {
      sourceKind: "pi",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật cho Pi SDK",
      subject: { kind: "pi-update", packageName: "@scope/pi-sdk", version: "2.0.0" },
      dedupKey: "update:pi:@scope/pi-sdk@2.0.0",
      at: now as Instant,
    });
    await request("POST", `/inbox/notices/${pi.notificationId}/skip-version`);
    expect((await inbox()).skippedVersions).toEqual([
      { subjectKind: "pi", name: "@scope/pi-sdk", version: "2.0.0", skippedAt: now },
      { subjectKind: "package", name: PACKAGE_ID, version: "1.1.0", skippedAt: expect.any(String) },
    ]);

    // Named in the path as the client encodes it: a package name may hold "@" and "/".
    const path = `/inbox/skipped-versions/pi/${encodeURIComponent("@scope/pi-sdk")}/2.0.0`;
    expect((await request("DELETE", path)).body).toEqual({ removed: true });
    expect((await inbox()).skippedVersions.map((skip) => skip.name)).toEqual([PACKAGE_ID]);
    expect((await request("DELETE", path)).status).toBe(404);
    expect((await request("GET", path)).status).toBe(405);
    expect((await request("DELETE", `/inbox/skipped-versions/other/x/1.0.0`)).status).toBe(400);
    expect((await request("DELETE", `/inbox/skipped-versions/pi/%E0%A4%A/1.0.0`)).status).toBe(400);
  });

  it("skips only what the stored notice names, only for its owner, and only for an update", async () => {
    const other = recordNodeNotice(services, {
      sourceKind: "background",
      category: "result",
      severity: "success",
      title: "Việc nền đã xong",
      dedupKey: "background:bg-any",
      at: now as Instant,
    });
    const notAnUpdate = await request("POST", `/inbox/notices/${other.notificationId}/skip-version`);
    expect(notAnUpdate.status).toBe(409);
    expect((notAnUpdate.body as { code: string }).code).toBe("NOT_AN_UPDATE");

    const theirs = recordNotification(services.runtime.db, {
      notificationId: "ntf_theirs",
      principalId: "someone_else",
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Not yours",
      subject: { kind: "package", packageId: PACKAGE_ID, version: "9.0.0" },
      dedupKey: "update:npm:theirs",
      at: now as Instant,
    });
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/skip-version`)).status).toBe(404);
    expect((await request("POST", `/inbox/notices/${theirs.notificationId}/unskip-version`)).status).toBe(404);
    expect(getNotification(services.runtime.db, "someone_else", theirs.notificationId)?.dismissed).toBe(false);
    expect((await request("GET", `/inbox/notices/${other.notificationId}/skip-version`)).status).toBe(405);

    // A dismissed notice is not skipped from again; the body is never read for what to skip.
    installPackageGeneration("1.0.0");
    const notice = updateNotice("1.1.0");
    const once = await request("POST", `/inbox/notices/${notice.notificationId}/skip-version`, { packageId: "evil", version: "99.0.0" });
    expect(once.body).toMatchObject({ name: PACKAGE_ID, version: "1.1.0" });
    expect((await request("POST", `/inbox/notices/${notice.notificationId}/skip-version`)).status).toBe(404);
  });
});

describe("asking an expired question again", () => {
  const TWENTY_MINUTES = 20 * 60_000;

  function askedLongAgo(conversationId: string): string {
    const past = new Date(Date.now() - TWENTY_MINUTES).toISOString() as Instant;
    const created = createQuestion(
      { ...interactionDepsFor(services, conversationId), now: () => past },
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
    return created.interaction.questionId;
  }

  function expiredNotice(conversationId: string) {
    const notice = listNotifications(services.runtime.db, owner()).find(
      (item) => item.sourceKind === "system" && item.conversationId === conversationId,
    );
    if (notice === undefined) throw new Error("the expiry was not reported");
    return notice;
  }

  it("offers Ask again on the expiry notice, puts the same question back once, and clears the notice", async () => {
    expect(TWENTY_MINUTES).toBeGreaterThan(QUESTION_TTL_MS);
    const conversationId = await createConversation();
    const questionId = askedLongAgo(conversationId);
    sweepExpired(services, now as Instant);
    const notice = expiredNotice(conversationId);
    expect(notice.subject).toEqual({ kind: "question", questionId, conversationId });
    expect((await actionsOf(notice.noticeId))?.[0]).toEqual({ id: "ask-again", placement: "primary" });

    const asked = await request("POST", `/conversations/${conversationId}/questions/${questionId}/ask-again`);
    expect(asked.status).toBe(200);
    const newId = (asked.body as { questionId: string }).questionId;
    expect(newId).not.toBe(questionId);
    const cards = latestMessages(services.runtime.db, conversationId, 50).flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === "question-card" ? [block] : [])),
    );
    expect(cards.map((card) => card.questionId)).toEqual([questionId, newId]);
    expect(cards[1]).toMatchObject({ prompt: "Chọn môi trường triển khai." });
    // The new question is the thing waiting now; the notice about the old one is gone.
    const after = await inbox();
    expect(after.notices.map((item) => item.noticeId)).not.toContain(notice.noticeId);
    expect(after.waiting.some((item) => item.kind === "question" && item.questionId === newId)).toBe(true);

    const twice = await request("POST", `/conversations/${conversationId}/questions/${questionId}/ask-again`);
    expect(twice.status).toBe(409);
    expect((twice.body as { code: string }).code).toBe("ALREADY_ASKED_AGAIN");
    // A notice brought back after it was asked again no longer offers it.
    await request("POST", `/inbox/notices/${notice.noticeId}/restore`);
    expect((await actionsOf(notice.noticeId))?.map((action) => action.id)).not.toContain("ask-again");
  });

  it("refuses a question still waiting, one answered, and one that does not exist", async () => {
    const conversationId = await createConversation();
    const open = createQuestion(interactionDepsFor(services, conversationId), { question: "Tiếp tục không?", kind: "confirm" });
    if (!open.ok) throw new Error("the question was not created");
    const waiting = await request("POST", `/conversations/${conversationId}/questions/${open.interaction.questionId}/ask-again`);
    expect(waiting.status).toBe(409);
    expect((waiting.body as { code: string }).code).toBe("QUESTION_OPEN");

    expect(answerQuestion(interactionDepsFor(services, conversationId), open.interaction.questionId, { confirmed: true }).ok).toBe(true);
    const closed = await request("POST", `/conversations/${conversationId}/questions/${open.interaction.questionId}/ask-again`);
    expect(closed.status).toBe(409);
    expect((closed.body as { code: string }).code).toBe("QUESTION_CLOSED");

    expect((await request("POST", `/conversations/${conversationId}/questions/q_missing/ask-again`)).status).toBe(404);
    expect((await request("GET", `/conversations/${conversationId}/questions/q_missing/ask-again`)).status).toBe(405);
  });

  it("finds the expired question behind a long stretch of later messages, reading only the ones that name it", async () => {
    const conversationId = await createConversation();
    const questionId = askedLongAgo(conversationId);
    sweepExpired(services, now as Instant);
    const notice = expiredNotice(conversationId);
    const deps = interactionDepsFor(services, conversationId);
    for (let index = 0; index < 30; index += 1) {
      deps.append({ at: now as Instant, blocks: [{ type: "text", format: "plain", content: `tin ${index}`, streaming: false }] });
    }
    const stored = getNotification(services.runtime.db, owner(), notice.noticeId);
    if (stored === undefined) throw new Error("the expiry notice was not stored");
    expect(stored.notice.subject).toEqual({ kind: "question", questionId, conversationId });
    const parse = vi.spyOn(JSON, "parse");
    const actions = noticeActionsFor(services.runtime.db, owner(), stored.notice, {
      nodeId: services.runtime.identity.nodeId,
      now: now as Instant,
    });
    const parsedMessages = parse.mock.calls.filter(([text]) => typeof text === "string" && text.includes('"messageId":'));
    parse.mockRestore();
    expect(actions[0]).toEqual({ id: "ask-again", placement: "primary" });
    // The question's card and its expiry record, not the thirty messages after them.
    expect(parsedMessages.length).toBeGreaterThan(0);
    expect(parsedMessages.length).toBeLessThanOrEqual(2);
  });

  it("offers nothing to ask when the question's conversation is gone", async () => {
    const notice = recordNodeNotice(services, {
      sourceKind: "system",
      category: "alert",
      severity: "info",
      title: "Câu hỏi đã hết hạn, không có ai trả lời",
      conversationId: "conv_deleted",
      subject: { kind: "question", questionId: "q_old", conversationId: "conv_deleted" },
      dedupKey: "expired:q_old",
      at: now as Instant,
    });
    const actions = await actionsOf(notice.notificationId);
    expect(actions?.map((action) => action.id)).not.toContain("ask-again");
    expect(actions).toContainEqual({ id: "open", placement: "menu", unavailable: "conversation-gone" });
  });
});
