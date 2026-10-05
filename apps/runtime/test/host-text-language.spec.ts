import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { hostText } from "../src/host-text.ts";
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
    ];
    for (const sample of samples) expect(sample).not.toMatch(VIETNAMESE_LETTER);
  });

  it("keeps the Vietnamese words the node wrote before", () => {
    const vi = hostText();
    expect(vi.tasks.stopped("task_1")).toBe("Đã dừng task task_1. Không có việc nào đang chạy nên không còn gì đang chờ.");
    expect(vi.automation.signal("issues.opened", "", "acme/widgets")).toBe("issues.opened ở acme/widgets");
    expect(vi.duration(90_000)).toBe("2 phút");
  });
});
