import {
  conversationDeleteRequestSchema,
  effectReconcileRequestSchema,
  inboxReadRequestSchema,
  noticeOperationRequestSchema,
  widgetDevFolderForgetSchema,
} from "@clarkcant/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLARK_VERSION_MAX, GatewayClient, NODE_VIEW_UNREADABLE, NodeViewUnreadable } from "../src/api.ts";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { nodeViewRefusalText } from "../src/node-view-refusal.ts";
import { developStartRefused } from "../src/use-block-actions.ts";

/**
 * An app older than the node it talks to (on another machine, updated separately) keeps reading every answer whose top
 * level binds nothing when the node added a field to it, and still refuses a newer field inside what binds: an approval,
 * a decision, what Clark may still reach, a value it does not know. A refusal says which Clark each side runs and what
 * to do, never the schema's own text.
 */

const en = (key: MessageKey): string => CATALOGS.en[key];
const vi_ = (key: MessageKey): string => CATALOGS.vi[key];
const AT = "2026-10-08T10:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const notice = { noticeId: "ntc_1", sourceKind: "background", category: "result", severity: "info", title: "Xong", createdAt: AT };
const approval = {
  kind: "command-approval",
  approvalId: "appr_1",
  conversationId: "conv_1",
  description: "Chạy lệnh",
  operationDigest: DIGEST,
  requestedAt: AT,
  expiresAt: AT,
};
const inbox = { waiting: [approval], notices: [notice], unread: 1, readAt: AT };
const memory = { memoryId: "mem_1", kind: "preference", scope: "node", text: "Thích tiếng Việt", sourceConversationId: "conv_1", at: AT };
const memories = { items: [memory], counts: { preference: 1, "project-fact": 0, decision: 0 } };
const suggestion = { suggestionId: "sug_1", label: "Tiếp tục", text: "Tiếp tục việc hôm qua", source: "conversation", sourceLabel: "từ phiên hôm qua", at: AT };
const composer = {
  trigger: "@",
  query: "",
  suggestions: [{ key: "conversation:conv_1", trigger: "@", kind: "conversation", label: "Phiên cũ", ref: { kind: "conversation", conversationId: "conv_1", label: "Phiên cũ" } }],
};
const reconciled = { effectId: "eff_1", taskId: "task_1", outcome: "confirmed", taskState: "succeeded", settled: "succeeded", remainingUnknown: 0 };
const operation = { noticeId: "ntc_1", action: "dismiss", outcome: "done" };
const attachmentRef = { attachmentId: "att_1", filename: "a.txt", mime: "text/plain", kind: "text", sizeBytes: 3, sha256: DIGEST, blobRef: `${"a".repeat(32)}.txt` };
const artifactRef = { v: 1, artifactId: "art_1", kind: "finalized", mimeType: "text/plain", sizeBytes: 3, name: "a.txt", digest: DIGEST };
const job = { jobId: "job_1", status: "running", resultRefs: [], createdAt: AT };
const deleted = { deleted: true, conversationId: "conv_1", attachments: 0, artifacts: 0, pendingFiles: 0, readBack: "Đã xoá." };
const forgot = { root: "/home/me/timer", forgotten: true };

/** A node that answers every route but `/node` with `body`, and `/node` with the Clark version it runs. */
function nodeAnswering(body: unknown, options: { nodeVersion?: string; appVersion?: string; status?: number } = {}): GatewayClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname === "/node") {
      return Response.json(options.nodeVersion === undefined ? { nodeId: "node_1" } : { nodeId: "node_1", clarkVersion: options.nodeVersion });
    }
    return Response.json(body, { status: options.status ?? 200 });
  }) as typeof fetch;
  return new GatewayClient({
    baseUrl: "http://127.0.0.1:8765",
    token: "tok",
    fetchImpl,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
  });
}

async function refusal(promise: Promise<unknown>): Promise<NodeViewUnreadable> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(NodeViewUnreadable);
  return error as NodeViewUnreadable;
}

// A refusal logs the schema's issues for whoever debugs it; the tests do not need them on the console.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("answers whose top level binds nothing, from a newer node", () => {
  it("reads the inbox without the fields it does not know, and says so", async () => {
    const read = await nodeAnswering({ ...inbox, digestAt: AT, notices: [{ ...notice, pinned: true }], snoozed: [{ ...notice, noticeId: "ntc_2", pinned: true }] }).inbox();
    expect(read.notices).toEqual([notice]);
    expect(read.snoozed).toEqual([{ ...notice, noticeId: "ntc_2" }]);
    expect(read.waiting).toEqual([approval]);
    expect(read).not.toHaveProperty("digestAt");
    expect(read.unreadFields).toEqual({ count: 2, names: ["digestAt", "pinned"] });
    expect(read).not.toHaveProperty("unreadable");
  });

  it("says nothing was left out of an inbox it fully reads", async () => {
    expect(await nodeAnswering(inbox).inbox()).not.toHaveProperty("unreadFields");
  });

  it("reads the inbox counts", async () => {
    expect(await nodeAnswering({ waiting: 1, unread: 2, muted: 3 }).inboxSummary()).toEqual({ waiting: 1, unread: 2 });
  });

  it("reads what a notice action and a reconcile did", async () => {
    expect(await nodeAnswering({ ...operation, undoUntil: AT }).actOnNotice("ntc_1", "dismiss")).toEqual(operation);
    expect(await nodeAnswering({ ...reconciled, recordedBy: "person" }).reconcileEffect("eff_1", "confirmed", "click")).toEqual(reconciled);
  });

  it("reads the memory list and every record, and says what it left out", async () => {
    const answer = await nodeAnswering({ ...memories, total: 1, items: [{ ...memory, pinned: true }] }).listMemories();
    expect(answer).toEqual({ ok: true, items: [memory], counts: memories.counts, unreadFields: { count: 2, names: ["total", "pinned"] } });
    expect(await nodeAnswering(memories).listMemories()).toEqual({ ok: true, items: [memory], counts: memories.counts });
  });

  it("reads the suggestion chips and the composer's picker", async () => {
    expect(await nodeAnswering({ items: [{ ...suggestion, icon: "spark" }], generatedAt: AT }).suggestions()).toEqual([suggestion]);
    expect(await nodeAnswering({ ...composer, tookMs: 4 }).composerSuggestions({ trigger: "@", query: "" })).toEqual(composer);
  });

  it("reads an attachment a widget's file became, and a widget's jobs", async () => {
    const attached = await nodeAnswering({ artifactRef, attachmentRef: { ...attachmentRef, thumbnail: "t" } }).attachArtifact("conv_1", "winst_1", "art_1");
    expect(attached.attachmentRef).toEqual(attachmentRef);
    expect(await nodeAnswering({ job: { ...job, priority: 1 } }).getWidgetJob("conv_1", "winst_1", "job_1")).toEqual(job);
    expect(await nodeAnswering({ jobs: [{ ...job, priority: 1 }] }).listWidgetJobs("conv_1", "winst_1")).toEqual([job]);
  });
});

describe("what binds stays strict", () => {
  it("leaves out a waiting item the node added a field to, as it leaves out any item it cannot read", async () => {
    const read = await nodeAnswering({ ...inbox, waiting: [{ ...approval, autoApprove: true }] }).inbox();
    expect(read.waiting).toEqual([]);
    expect(read.unreadable).toBe(1);
  });

  it("leaves out a notice whose actions or reach carry a field it does not know", async () => {
    const actions = [{ id: "dismiss", placement: "primary", confirm: true }];
    const read = await nodeAnswering({ ...inbox, notices: [{ ...notice, actions }] }).inbox();
    expect(read.notices).toEqual([]);
    expect(read.unreadable).toBe(1);
  });

  it("refuses a value it does not know in a field it does", async () => {
    await refusal(nodeAnswering({ ...operation, outcome: "deferred" }).actOnNotice("ntc_1", "dismiss"));
    await refusal(nodeAnswering({ ...reconciled, settled: "partly" }).reconcileEffect("eff_1", "confirmed", "click"));
    await refusal(nodeAnswering({ ...inbox, unread: -1 }).inbox());
    await refusal(nodeAnswering({ waiting: "1", unread: 0 }).inboxSummary());
    const answer = await nodeAnswering({ ...memories, counts: { ...memories.counts, habit: 1 } }).listMemories();
    expect(answer.ok === false && answer.cause).toBeInstanceOf(NodeViewUnreadable);
    await refusal(nodeAnswering({ items: [{ ...suggestion, source: "calendar" }] }).suggestions());
    await expect(nodeAnswering({ job: { ...job, status: "paused" } }).getWidgetJob("conv_1", "winst_1", "job_1")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("refuses a picker row with a field it does not know, because the row's reference is sent back as it is", async () => {
    const row = { ...composer.suggestions[0], ref: { ...composer.suggestions[0]?.ref, scope: "all" } };
    await refusal(nodeAnswering({ ...composer, suggestions: [row] }).composerSuggestions({ trigger: "@", query: "" }));
  });

  it("refuses a whole list when one item does not read, rather than showing fewer jobs", async () => {
    const jobs = [job, { ...job, jobId: "job_2", progress: { current: 1, eta: 3 } }];
    await expect(nodeAnswering({ jobs }).listWidgetJobs("conv_1", "winst_1")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("keeps the folder-forget answer and a conversation delete strict, since they say what Clark reaches and what was decided", async () => {
    await refusal(nodeAnswering({ ...forgot, alsoForgot: ["/home/me"] }).forgetWidgetDevFolder("/home/me/timer"));
    await refusal(nodeAnswering({ ...deleted, keptFiles: 1 }).deleteConversation("conv_1"));
    expect(await nodeAnswering(forgot).forgetWidgetDevFolder("/home/me/timer")).toEqual(forgot);
    // A refusal the node sent with a status of its own is not a version question.
    await expect(nodeAnswering({ code: "BUSY" }, { status: 409 }).deleteConversation("conv_1")).rejects.toMatchObject({ code: "DELETE_UNCONFIRMED" });
  });

  it("keeps every request this app sends strict", () => {
    expect(noticeOperationRequestSchema.safeParse({ source: "click", force: true }).success).toBe(false);
    expect(effectReconcileRequestSchema.safeParse({ outcome: "confirmed", note: "x" }).success).toBe(false);
    expect(inboxReadRequestSchema.safeParse({ noticeIds: ["ntc_1"], all: true }).success).toBe(false);
    expect(widgetDevFolderForgetSchema.safeParse({ root: "/home/me", recursive: true }).success).toBe(false);
    expect(conversationDeleteRequestSchema.safeParse({ purge: true }).success).toBe(false);
  });
});

describe("a refused answer says which Clark each side runs", () => {
  it("names a newer node and asks to update the app", async () => {
    const error = await refusal(nodeAnswering({ ...operation, outcome: "deferred" }, { nodeVersion: "0.3.0", appVersion: "0.2.1" }).actOnNotice("ntc_1", "dismiss"));
    expect(error.code).toBe(NODE_VIEW_UNREADABLE);
    expect(error).toMatchObject({ nodeVersion: "0.3.0", appVersion: "0.2.1", nodeNewer: true });
    expect(error.message).not.toMatch(/invalid|expected|zod/i);
    expect(nodeViewRefusalText(error, en, "shell.nodeView.answered")).toBe(
      "The node answered, but this app can't read what it did. The node runs Clark 0.3.0, which is newer than this app (Clark 0.2.1). Update the app to read it.",
    );
    expect(nodeViewRefusalText(error, vi_, "shell.nodeView.read")).toBe(
      "Ứng dụng này không đọc được câu trả lời của node; chưa có gì thay đổi. Node đang chạy Clark 0.3.0, mới hơn ứng dụng này (Clark 0.2.1). Hãy cập nhật ứng dụng để đọc được.",
    );
  });

  it("does not blame the version when the app is as new as the node", async () => {
    const error = await refusal(nodeAnswering({ waiting: "1", unread: 0 }, { nodeVersion: "0.3.0", appVersion: "0.3.0" }).inboxSummary());
    expect(error.nodeNewer).toBe(false);
    expect(nodeViewRefusalText(error, en, "shell.nodeView.read")).toContain("so the app is not out of date");
  });

  it("says the node is probably newer when either version is not known", async () => {
    for (const versions of [{ appVersion: "0.2.1" }, { nodeVersion: "0.3.0" }, { nodeVersion: "unknown", appVersion: "0.2.1" }]) {
      const error = await refusal(nodeAnswering({ waiting: "1", unread: 0 }, versions).inboxSummary());
      expect(error.nodeNewer).toBeUndefined();
      expect(nodeViewRefusalText(error, en, "shell.nodeView.read")).toBe(
        "This app can't read the node's answer; nothing was changed. The node is probably newer than this app. Update the app to read it.",
      );
    }
  });

  /** A client whose node answers `/node` with each of `versions` in turn (a number is that status), and refuses the rest. */
  function nodeRunning(versions: (string | number)[]): { client: GatewayClient; asked: () => number } {
    let asked = 0;
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      appVersion: "0.2.1",
      fetchImpl: (async (input: string | URL | Request) => {
        if (new URL(String(input)).pathname !== "/node") return Response.json({ waiting: "1", unread: 0 });
        const answer = versions[Math.min(asked, versions.length - 1)];
        asked += 1;
        return typeof answer === "number" ? Response.json({ code: "BUSY", message: "busy" }, { status: answer }) : Response.json({ clarkVersion: answer });
      }) as typeof fetch,
    });
    return { client, asked: () => asked };
  }

  it("asks again on a later refusal, so a node that updated itself at the same address is named as it is now", async () => {
    const node = nodeRunning(["0.2.1", "0.3.0"]);
    expect((await refusal(node.client.inboxSummary())).nodeNewer).toBe(false);
    expect((await refusal(node.client.inboxSummary())).nodeNewer).toBe(true);
    expect(node.asked()).toBe(2);
  });

  it("does not keep a failed lookup", async () => {
    const node = nodeRunning([503, "0.3.0"]);
    expect(await node.client.nodeVersion()).toBeUndefined();
    expect(await node.client.nodeVersion()).toBe("0.3.0");
    // A version that read is kept for whoever asks without a refusal.
    expect(await node.client.nodeVersion()).toBe("0.3.0");
    expect(node.asked()).toBe(2);
  });

  it("shares one lookup between refusals that arrive together", async () => {
    const node = nodeRunning(["0.3.0"]);
    const errors = await Promise.all([refusal(node.client.inboxSummary()), refusal(node.client.inboxSummary())]);
    expect(errors.map((error) => error.nodeNewer)).toEqual([true, true]);
    expect(node.asked()).toBe(1);
  });

  it("treats a version longer than it would put into a sentence as not known", async () => {
    const long = `1.0.0-${"a".repeat(CLARK_VERSION_MAX)}`;
    const error = await refusal(nodeRunning([long]).client.inboxSummary());
    expect(error.nodeNewer).toBeUndefined();
    expect(error.nodeVersion).toBeUndefined();
    expect(nodeViewRefusalText(error, en, "shell.nodeView.read")).not.toContain(long);
  });
  it("leaves every other failure to its own words", () => {
    expect(nodeViewRefusalText(new Error("offline"), en, "shell.nodeView.read")).toBeUndefined();
  });
});

describe("the /develop card after a start this app cannot read", () => {
  it("says the session started rather than that it failed, and never with the schema's text", async () => {
    const started = nodeAnswering({ sessionId: "wdev_1", status: "hibernating", root: "/home/me/timer", startedAt: AT, activation: { state: "none" }, showingLastKnownGood: false }, { nodeVersion: "0.3.0", appVersion: "0.2.1" });
    const error = await refusal(started.startWidgetDevSession({ root: "/home/me/timer" }));
    expect(developStartRefused(error, en)).toEqual({
      status: "done",
      message: "The session started, but this app can't read its state. The node runs Clark 0.3.0, which is newer than this app (Clark 0.2.1). Update the app to read it.",
    });
    expect(developStartRefused(error, vi_)).toMatchObject({ status: "done", message: expect.stringMatching(/^Phiên đã bắt đầu/) });
  });

  it("still reports a start the node refused as failed", () => {
    expect(developStartRefused(new Error("FOLDER_NOT_CHOSEN: choose the folder first"), en)).toEqual({ status: "failed", message: "FOLDER_NOT_CHOSEN: choose the folder first" });
  });
});
