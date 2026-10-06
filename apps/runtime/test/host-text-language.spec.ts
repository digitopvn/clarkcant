import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant, PeerEnvelope } from "@clarkcant/contracts";
import { applyTaskEvent, createTask } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { artifactIntakeDeps, peerDelegationHandlers } from "../src/delegation-handlers.ts";
import { hostText } from "../src/host-text.ts";
import { QUESTION_TTL_MS, createQuestion, expireQuestions } from "../src/interactions.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { tellStuck } from "../src/peer-skip.ts";
import { interactionDepsFor } from "../src/routes/conversations.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * What the node itself writes into a conversation follows the person's interface language.
 *
 * `experience.language` is the preference the settings panel's Language control writes; setting it over the wire is
 * exactly what a person switching the interface to English does. A sample turn answers without any model, so every
 * word in its reply is the host's: the card that labels it as sample data and the widget's titles, labels and rows.
 */

const AT = "2026-10-05T04:00:00.000Z";

/** Any letter only Vietnamese writes. */
const VIETNAMESE_LETTER = /[ăâđêôơưạảãàáậầấẩẫặằắẳẵẹẻẽèéệềếểễịỉĩìíọỏõòóộồốổỗợờớởỡụủũùúựừứửữỵỷỹỳýĐ]/iu;

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-host-text-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  let sequence = 0;
  deps = {
    services,
    now: () => AT,
    newConversationId: () => {
      sequence += 1;
      return `conv_lang_${sequence}`;
    },
  };
});

afterEach(() => {
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

interface SampleTurn {
  resolution: string;
  timeline: {
    messages: { role: string; blocks: Record<string, unknown>[] }[];
    instances: { definitionId: string; props: Record<string, unknown> }[];
  };
}

/** One demo turn, answered from a sample recipe; returns what the node wrote, without the person's own message. */
async function sampleTurn(text: string): Promise<{ blocks: Record<string, unknown>[]; instances: SampleTurn["timeline"]["instances"] }> {
  const created = await request("POST", "/conversations", { title: "Language" });
  expect(created.status).toBe(201);
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const sent = await request("POST", `/conversations/${conversationId}/messages`, { text, demo: true });
  expect(sent.status).toBe(202);
  const turn = sent.body as SampleTurn;
  expect(turn.resolution).toBe("sample");
  const blocks = turn.timeline.messages.filter((message) => message.role === "assistant").flatMap((message) => message.blocks);
  expect(blocks.length).toBeGreaterThan(0);
  expect(turn.timeline.instances.length).toBeGreaterThan(0);
  return { blocks, instances: turn.timeline.instances };
}

/** The start screen's three sample chips, as they send, and the bar-chart variant of the first. */
const SAMPLES = ["cho tui xem biểu đồ", "tạo note nhanh cho tui", "cho tui xem bảng dữ liệu", "cho tui xem biểu đồ cột"];

describe("a sample turn's host-written words follow the interface language", () => {
  it("writes no Vietnamese anywhere in the reply when the interface is English", async () => {
    const written = await request("PUT", "/preferences/experience.language", { value: "en" });
    expect(written.status).toBe(200);

    for (const text of SAMPLES) {
      const { blocks, instances } = await sampleTurn(text);
      const card = blocks.find((block) => block.type === "system-card");
      expect(card, text).toMatchObject({ title: "Sample data / interactive demo" });
      expect(JSON.stringify(blocks), text).not.toMatch(VIETNAMESE_LETTER);
      expect(JSON.stringify(instances.map((instance) => instance.props)), text).not.toMatch(VIETNAMESE_LETTER);
    }
  });

  it("titles the sample chart in English when the interface is English", async () => {
    await request("PUT", "/preferences/experience.language", { value: "en" });

    const { instances } = await sampleTurn("cho tui xem biểu đồ");
    expect(JSON.stringify(instances[0]?.props)).toContain("Runs per week");
  });

  it("stays Vietnamese when the interface is Vietnamese", async () => {
    const written = await request("PUT", "/preferences/experience.language", { value: "vi" });
    expect(written.status).toBe(200);

    const { blocks, instances } = await sampleTurn("cho tui xem biểu đồ");
    expect(blocks.find((block) => block.type === "system-card")).toMatchObject({ title: "Dữ liệu mẫu / demo tương tác" });
    expect(JSON.stringify(instances.map((instance) => instance.props))).toMatch(VIETNAMESE_LETTER);
  });

  it("stays Vietnamese when no language was ever chosen", async () => {
    const { blocks } = await sampleTurn("cho tui xem bảng");
    expect(blocks.find((block) => block.type === "system-card")).toMatchObject({ title: "Dữ liệu mẫu / demo tương tác" });
  });
});

/** Make a task in a fresh conversation, stop it over the wire, and return what the node wrote back there. */
async function stopReceipt(): Promise<{ taskId: string; said: string }> {
  const created = await request("POST", "/conversations", { title: "Stop" });
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const { runtime } = services;
  const owner = { principalId: runtime.identity.ownerPrincipalId, kind: "user" as const, nodeId: runtime.identity.nodeId as never };
  const task = createTask(
    { db: runtime.db, nodeId: runtime.identity.nodeId, now: () => AT as never, newId: services.conductor.newId },
    { conversationId: conversationId as never, goal: "write the weekly report", principal: owner },
  );
  const stopped = await request("POST", `/tasks/${task.taskId}/cancel`);
  expect(stopped.status).toBe(200);
  expect((stopped.body as { confirmed: boolean }).confirmed).toBe(true);
  const timeline = await request("GET", `/conversations/${conversationId}/timeline`);
  const messages = (timeline.body as { messages: { role: string; blocks: { type: string; content?: string }[] }[] }).messages;
  const said = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.blocks)
    .map((block) => (block.type === "text" ? String(block.content) : ""))
    .join("\n");
  return { taskId: task.taskId, said };
}

/** The blocks the node wrote into a conversation, read back over the wire. */
async function writtenBlocks(conversationId: string): Promise<Record<string, unknown>[]> {
  const timeline = await request("GET", `/conversations/${conversationId}/timeline`);
  const messages = (timeline.body as { messages: { role: string; blocks: Record<string, unknown>[] }[] }).messages;
  return messages.filter((message) => message.role === "assistant").flatMap((message) => message.blocks);
}

async function newConversation(): Promise<string> {
  const created = await request("POST", "/conversations", { title: "Language" });
  return (created.body as { conversationId: string }).conversationId;
}

/** A question asked in a fresh conversation and closed by the node's own expiry, through the node's wiring. */
async function expiredQuestionRow(): Promise<Record<string, unknown> | undefined> {
  const conversationId = await newConversation();
  const asked = createQuestion(interactionDepsFor(services, conversationId), { question: "Which branch?", kind: "text" });
  expect(asked.ok).toBe(true);
  const later = new Date(Date.now() + QUESTION_TTL_MS + 60_000).toISOString() as Instant;
  expect(expireQuestions({ ...interactionDepsFor(services, conversationId), now: () => later })).toHaveLength(1);
  return (await writtenBlocks(conversationId)).find(
    (block) => block.type === "tool-activity" && (block.args as { decision?: string }).decision === "expired",
  );
}

/** A task this node handed to a peer, and that peer's word that it is now running there, through the node's handlers. */
async function handOffStatusLine(): Promise<{ taskId: string; said: string }> {
  const conversationId = await newConversation();
  const { runtime } = services;
  const coordination = { db: runtime.db, nodeId: runtime.identity.nodeId, now: () => AT as never, newId: services.conductor.newId };
  const owner = { principalId: runtime.identity.ownerPrincipalId, kind: "user" as const, nodeId: runtime.identity.nodeId as never };
  const task = createTask(coordination, { conversationId: conversationId as never, goal: "write the weekly report", principal: owner });
  expect(applyTaskEvent(coordination, task.taskId, "resolve.start").ok).toBe(true);
  expect(applyTaskEvent(coordination, task.taskId, "resolve.ready", { executionNodeId: "node_peer" }).ok).toBe(true);
  const envelope: PeerEnvelope = {
    protocol: "agent.nodelink",
    version: 1,
    messageId: "msg_status_1",
    correlationId: task.taskId,
    senderNodeId: "node_peer",
    recipientNodeId: runtime.identity.nodeId,
    kind: "status",
    taskId: task.taskId,
    sourceSequence: 1,
    sentAt: AT as Instant,
    payload: { taskState: "running", taskRevision: 2 },
  };
  const answered = peerDelegationHandlers(services, () => AT as Instant).status(envelope);
  expect(answered).toMatchObject({ accepted: true, told: true });
  const said = (await writtenBlocks(conversationId))
    .map((block) => (block.type === "text" ? String(block.content) : ""))
    .join("\n");
  return { taskId: task.taskId, said };
}

describe("what the node writes outside any turn follows its owner's interface language", () => {
  it("labels a question its expiry closed in English when the interface is English", async () => {
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);

    const row = await expiredQuestionRow();
    expect(row).toMatchObject({ label: "The question expired", result: "The question expired without an answer." });
  });

  it("labels it in the same Vietnamese as before when no language was ever chosen", async () => {
    const row = await expiredQuestionRow();
    expect(row).toMatchObject({ label: "Câu hỏi đã hết hạn", result: "Câu hỏi hết hạn mà không có câu trả lời." });
  });

  it("writes a peer's word on a handed-over task in English when the interface is English", async () => {
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);

    const { taskId, said } = await handOffStatusLine();
    expect(said).toContain(`The owner of node_peer approved it; task ${taskId} is running on node_peer again.`);
    expect(said).not.toMatch(VIETNAMESE_LETTER);
  });

  it("words the files a peer brings back in the owner's language, read when they are said", async () => {
    const intake = artifactIntakeDeps(services, () => AT as Instant);
    expect(intake.words().receivedLater("notes.md", "node_peer", "task_1")).toBe("Đã nhận tệp notes.md từ node_peer cho task task_1.");
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);
    expect(intake.words().receivedLater("notes.md", "node_peer", "task_1")).toBe("Received the file notes.md from node_peer for task task_1.");
  });

  it("writes it in the same Vietnamese as before when no language was ever chosen", async () => {
    const { taskId, said } = await handOffStatusLine();
    expect(said).toContain(`Chủ của node_peer đã duyệt; task ${taskId} tiếp tục chạy trên node_peer.`);
  });

  it("says a stopped task in English when the interface is English", async () => {
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);

    const { taskId, said } = await stopReceipt();
    expect(said).toContain(hostText("en").tasks.stopped(taskId));
    expect(said).not.toMatch(VIETNAMESE_LETTER);
  });

  it("says it in the same Vietnamese as before when no language was ever chosen", async () => {
    const { taskId, said } = await stopReceipt();
    expect(said).toContain(`Đã dừng task ${taskId}. Không có việc nào đang chạy nên không còn gì đang chờ.`);
  });
});

describe("the start screen's chips follow the owner's interface language", () => {
  type Chip = { source: string; label: string; text: string; sourceLabel?: string };

  async function chips(): Promise<Chip[]> {
    await newConversation();
    const response = await request("GET", "/suggestions");
    expect(response.status).toBe(200);
    return (response.body as { items: Chip[] }).items;
  }

  it("writes them in English when the interface is English", async () => {
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);

    const offered = await chips();
    expect(offered.find((chip) => chip.source === "conversation")).toMatchObject({
      label: "Reopen the last session",
      sourceLabel: "carry on where you left off",
    });
    expect(JSON.stringify(offered)).not.toMatch(VIETNAMESE_LETTER);
  });

  it("writes them in the same Vietnamese as before when no language was ever chosen", async () => {
    const offered = await chips();
    expect(offered.find((chip) => chip.source === "conversation")).toMatchObject({
      label: "Mở lại phiên gần nhất",
      sourceLabel: "tiếp tục từ chỗ đã dừng",
    });
  });
});

describe("an inbox notice the node records follows its owner's interface language, read when it is recorded", () => {
  type Notice = { title: string; body?: string };

  /** Tell the owner a pairing is stuck, through the node's own path, and read the inbox back over the wire. */
  async function stuckNotice(peer: string): Promise<Notice | undefined> {
    tellStuck(services, peer, AT as Instant);
    const inbox = await request("GET", "/inbox");
    expect(inbox.status).toBe(200);
    return (inbox.body as { notices: (Notice & { subject?: { nodeId?: string } })[] }).notices.find((notice) => notice.subject?.nodeId === peer);
  }

  it("words it in English when the interface is English", async () => {
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);

    const notice = await stuckNotice("node_peer_en");
    expect(notice?.title).toBe("The pairing with another device is stuck");
    expect(`${notice?.title ?? ""} ${notice?.body ?? ""}`).not.toMatch(VIETNAMESE_LETTER);
  });

  it("words it in the same Vietnamese as before when no language was ever chosen", async () => {
    const notice = await stuckNotice("node_peer_vi");
    expect(notice?.title).toBe("Ghép cặp với thiết bị khác đang bị kẹt");
  });

  /** Record a notice whose title cleans down to nothing, as one a paired node sent can, and read its title back. */
  async function untitledNotice(dedupKey: string): Promise<string | undefined> {
    recordNodeNotice(services, { sourceKind: "worker", category: "result", severity: "info", title: " \n\t ", dedupKey, at: AT as Instant });
    const inbox = await request("GET", "/inbox");
    expect(inbox.status).toBe(200);
    return (inbox.body as { notices: { title: string }[] }).notices.find((notice) => notice.title.startsWith("("))?.title;
  }

  it("gives a notice with no title of its own the owner's word for untitled", async () => {
    expect((await request("PUT", "/preferences/experience.language", { value: "en" })).status).toBe(200);
    expect(await untitledNotice("untitled:en")).toBe("(untitled)");
  });

  it("keeps the Vietnamese word for untitled when no language was ever chosen", async () => {
    expect(await untitledNotice("untitled:vi")).toBe("(không có tiêu đề)");
  });
});

describe("the host's catalog", () => {
  it("has English words with no Vietnamese in them for every report the node writes outside a turn", () => {
    const en = hostText("en");
    const samples = [
      en.background.dequeued("Weekly report"),
      en.background.failedReply("timeout"),
      en.background.deadline(en.duration(90_000)),
      en.background.queueFull(2, 4),
      en.background.rebootRerun("Weekly report", true),
      en.background.rebootLost("Weekly report", false),
      en.tasks.stopped("task_1"),
      en.tasks.stopRequested("task_1"),
      en.tasks.approvalExpired,
      en.tasks.approvalDenied,
      en.tasks.approvalRerunning,
      en.tasks.approvalNotRerun,
      en.tasks.settled("uncertain", "task_1", "ok"),
      en.tasks.waitingApproval("task_1", "ok"),
      en.tasks.worktreeKept("task_1", [{ path: "/tmp/w", branch: "work/1" }]),
      en.tasks.worktreeKeptNoticeTitle,
      en.tasks.worktreeKeptNoticeBody("task_1"),
      en.tasks.capabilityReady("project.work", "task_1", "node_a"),
      en.tasks.effectRecorded("task_1", "“push”", true, 2, false),
      en.tasks.commandInterrupted("build", true),
      en.tasks.taskInterrupted("ship it"),
      en.tasks.projectSessionOpened("clarkcant", "www/clarkcant", "node", "package.json"),
      en.automation.refused("Triage", en.automation.timer, "no grant"),
      en.automation.notStarted(undefined, en.automation.anySignal, "boom"),
      en.automation.parked("Triage", en.automation.signal("issues.opened", " (issue 7)", "acme/widgets"), "busy", "task_1"),
      en.automation.started("Triage", en.automation.timer, "task_1", "node_a"),
      en.automation.deadSignal("issues.opened", "boom"),
      en.miniApp.templateSummary(en.miniApp.templateTitle.overview, 3, 1),
      en.miniApp.layoutTitle,
      en.questions.expired,
      en.questions.answered("Which branch?"),
      en.delegation.waitingApproval("task_1", "node_b", "“push”"),
      en.delegation.waitingCapability("task_1", "node_b", "project.work"),
      en.delegation.approvedThere("task_1", "node_b"),
      en.delegation.notAllowed("node_b", "“triage”"),
      en.delegation.handedOverRunning("node_b", "“triage”", "task_1"),
      en.delegation.resultLost("node_b"),
      en.files.summary([en.files.received("notes.md"), en.files.notTaken("big.bin", undefined)].join("; ")),
      en.files.receivedLater("notes.md", "node_b", "task_1"),
      en.files.receivedEvidence("notes.md", 12, "node_b"),
      en.confirmations.declined,
      ...Object.values(en.confirmations.failed),
    ];
    expect(en.files.receivedEvidence("notes.md", 12, "node_b")).toBe("notes.md (12 bytes) from node_b, matching the offered digest");
    for (const sample of samples) expect(sample).not.toMatch(VIETNAMESE_LETTER);
  });

  it("keeps the Vietnamese words the node wrote before", () => {
    const vi = hostText();
    expect(vi.tasks.stopped("task_1")).toBe("Đã dừng task task_1. Không có việc nào đang chạy nên không còn gì đang chờ.");
    expect(vi.automation.signal("issues.opened", "", "acme/widgets")).toBe("issues.opened ở acme/widgets");
    expect(vi.duration(90_000)).toBe("2 phút");
    expect(vi.questions.expired).toBe("Câu hỏi đã hết hạn");
    expect(vi.files.summary(vi.files.received("notes.md"))).toBe("Tệp: đã nhận notes.md.");
    expect(vi.toolLabel("run_command", "Chạy một lệnh")).toBe("Chạy một lệnh");
  });

  it("counts one task in the singular in English", () => {
    const en = hostText("en");
    expect(en.miniApp.describeTrend(1)).toBe("Daily trend, 1 task completed in the period.");
    expect(en.miniApp.templateSummary("Overview", 1, 0)).toBe("Overview: 1 task completed, 0 open in the period.");
    expect(en.miniApp.templateSummary("Overview", 2, 0)).toBe("Overview: 2 tasks completed, 0 open in the period.");
  });

  it("names every tool the node defines in English, and keeps a name it does not know as defined", () => {
    // Every tool definition in the runtime's sources: a `name` followed by its literal `label` on the next line.
    const sources = join(import.meta.dirname, "..", "src");
    const defined = new Set<string>();
    for (const file of readdirSync(sources, { recursive: true, encoding: "utf8" })) {
      // The scripted fixtures name their own form fields this way and are not tools.
      if (!file.endsWith(".ts") || file.startsWith("test-support")) continue;
      const text = readFileSync(join(sources, file), "utf8");
      for (const match of text.matchAll(/name: (?:"([a-z_]+)"|(SHOW_VIEW_TOOL|READ_CONTEXT_TOOL)),\n\s*label: "/g)) {
        defined.add(match[1] ?? (match[2] === "SHOW_VIEW_TOOL" ? "show_view" : "read_context"));
      }
    }
    expect(defined.size).toBeGreaterThan(20);
    const en = hostText("en");
    for (const name of defined) expect(en.toolLabel(name, "?"), name).not.toBe("?");
    expect(en.toolLabel("a_package_tool", "Its own label")).toBe("Its own label");
  });
});
