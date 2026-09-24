import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Instant, inboxResponseSchema, inboxSummarySchema } from "@clarkcant/contracts";
import { requestApproval } from "@clarkcant/core";
import { appendMessage, nextMessageSequence } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { createQuestion } from "../src/interactions.ts";
import { readInbox } from "../src/inbox.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { createReadInboxTool } from "../src/read-inbox-tool.ts";
import { interactionDepsFor } from "../src/routes/conversations.ts";
import { commandDigest } from "../src/run-command.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

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
function proposeCommand(conversationId: string, command: string, ttlMs = 900_000, messageAt = now) {
  const approval = requestApproval(
    {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now: () => now as never,
      newId: services.conductor.newId,
    },
    {
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

describe("what is waiting for the person", () => {
  it("lists a command approval from another conversation, with the command it would run", async () => {
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
    expect(created.ok).toBe(true);

    const inbox = await readInboxOverHttp();
    expect(inbox.waiting).toHaveLength(1);
    expect(inbox.waiting[0]).toMatchObject({ kind: "question", conversationId, prompt: "Chọn môi trường triển khai." });

    now = new Date(Date.parse(AT) + 16 * 60_000).toISOString();
    expect((await readInboxOverHttp()).waiting).toEqual([]);
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
  it("leaves one notice pointing at its conversation when the worker finishes", async () => {
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
    expect((await readInboxOverHttp()).notices[0]).toMatchObject({ severity: "error", body: "hết hạn mức model" });
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

  it("says plainly when there is nothing", async () => {
    const { text } = await createReadInboxTool(() => readInbox(services, now as Instant)).execute({});
    expect(text).toContain("Nothing is waiting for the user's decision.");
    expect(text).toContain("No notices.");
  });

  it("reports a read that failed as a failure, not as an empty inbox", async () => {
    const { text } = await createReadInboxTool(() => {
      throw new Error("database is locked");
    }).execute({});
    expect(text).toBe("Could not read the inbox: database is locked. Nothing was changed.");
  });
});
