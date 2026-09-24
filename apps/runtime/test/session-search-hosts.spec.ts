import { HOST_OWNED_BLOCK_TYPES, instantSchema, type MessageBlock } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { textOfBlock, textOfMessage } from "../src/session-search.ts";

/**
 * Every host card, in text.
 *
 * A rich card is a thing some readers cannot see: somebody reading a transcript as text, a search index, a voice
 * session reading the turn back. What each card says in that situation is `textOfBlock`, and a card type that is
 * missing from it is not "rendered plainly" — it is invisible, with nothing to indicate anything was there.
 *
 * So this suite is keyed by the host-owned list rather than by the cases in the projection. A new card type fails
 * here until it has both a fixture and a sentence, which is the only way the two cannot drift apart again: the
 * renderer and the contract had already drifted once, each knowing card types the other did not.
 *
 * The fixtures are a matrix per widget in the sense the phase means: one representative block each, minimal
 * rather than exhaustive, because what is being asserted is that text exists and is about the right thing.
 */

/*
 * Timestamps are parsed rather than written as literals: `Instant` is a branded string, so a fixture that spells
 * one out is not a fixture that typechecks, and the test would be asserting against a shape the product cannot
 * produce.
 */
const AT = instantSchema.parse("2026-09-19T17:00:00.000Z");
const EXPIRES = instantSchema.parse("2026-09-19T17:15:00.000Z");

/**
 * One representative block per host-owned card type, carrying the fields that mean something to a reader.
 *
 * Minimal on purpose, and cast at the point of use: these fixtures exist to exercise what the projection says, not
 * to re-assert each schema, which has its own tests. Pinning them to the exact union would spend this suite's
 * budget on required fields that have nothing to do with text, and would have to be edited every time a card
 * gains one.
 */
const asBlock = (block: Record<string, unknown>): MessageBlock => block as unknown as MessageBlock;

const FIXTURES = {
  "system-card": {
    type: "system-card",
    owner: "host",
    cardId: "card_1",
    subject: "task",
    title: "Cần một capability chưa cài",
    status: "blocked",
    detail: "Chưa có capability nào đang dùng được trên node này.",
    fields: [],
    cancellable: true,
    updatedAt: AT,
  },
  "approval-card": {
    type: "approval-card",
    owner: "host",
    approvalId: "ap_1",
    operation: "run_command",
    operationDescription: "chạy pnpm verify trong packages/core",
    operationDigest: "sha256:abc",
    risk: "medium",
    expiresAt: EXPIRES,
    requestedAt: AT,
  },
  "credential-card": {
    type: "credential-card",
    owner: "host",
    requestId: "req_1",
    purpose: "đăng nhập vào nhà cung cấp model",
    destination: "provider-page",
    fields: [{ name: "apiKey", label: "API key" }],
    requestedAt: AT,
  },
  "connection-card": {
    type: "connection-card",
    owner: "host",
    connectionRef: "conn_1",
    provider: "google-calendar",
    status: "connected",
    updatedAt: AT,
  },
  "task-progress-card": {
    type: "task-progress-card",
    owner: "host",
    cardId: "card_2",
    taskId: "task_1",
    goal: "sửa lỗi đăng nhập",
    status: "working",
    steps: [],
    startedAt: AT,
    updatedAt: AT,
    cancellable: true,
  },
  "task-summary-card": {
    type: "task-summary-card",
    owner: "host",
    cardId: "card_3",
    taskId: "task_1",
    goal: "sửa lỗi đăng nhập",
    outcome: "succeeded",
    evidence: "verified",
    durationMs: 1200,
    changes: [],
    at: AT,
  },
  "task-overview-card": {
    type: "task-overview-card",
    owner: "host",
    cardId: "card_4",
    conversationId: "conv_1",
    tasks: [{ taskId: "task_1", goal: "sửa lỗi đăng nhập", status: "working", updatedAt: AT }],
    updatedAt: AT,
  },
  "code-diff-card": {
    type: "code-diff-card",
    owner: "host",
    cardId: "card_5",
    summary: "Đổi cách task được đánh dấu là đã dừng",
    files: [{ path: "packages/core/src/task-service.ts", additions: 2, deletions: 1, hunks: [] }],
    truncated: false,
    updatedAt: AT,
  },
  "project-picker-card": {
    type: "project-picker-card",
    owner: "host",
    cardId: "card_6",
    prompt: "Chọn dự án để mở",
    roots: [{ rootId: "root_1", label: "clarkcant", path: "D:/orca/clarkcant", readOnly: false }],
    allowManualEntry: true,
    updatedAt: AT,
  },
  "reconnect-card": {
    type: "reconnect-card",
    owner: "host",
    cardId: "card_7",
    nodeId: "node_b",
    nodeLabel: "máy văn phòng",
    status: "reconnecting",
    attempt: 2,
    lastSeenAt: AT,
  },
  "question-card": {
    type: "question-card",
    owner: "host",
    questionId: "q_1",
    prompt: "Bạn muốn tôi mở dự án nào?",
    questionType: "single-choice",
    options: [
      { id: "option-1", label: "Dự án hiện tại" },
      { id: "option-2", label: "Dự án khác" },
    ],
    allowOther: false,
    voicePrompt: "Bạn muốn tôi mở dự án nào? Dự án hiện tại, hay dự án khác?",
    status: "waiting",
    createdAt: AT,
  },
  "form-card": {
    type: "form-card",
    owner: "host",
    formId: "form_1",
    title: "Cho tôi biết vài thông tin",
    fields: [{ id: "field-1", label: "Tên dự án", kind: "text", required: true }],
  },
  "browser-session-card": {
    type: "browser-session-card",
    owner: "host",
    cardId: "card_8",
    sessionId: "cs_1",
    label: "đang mở form thanh toán",
    driver: "agent",
    status: "running",
    leaseEpoch: 0,
    updatedAt: AT,
  },
  "computer-session-card": {
    type: "computer-session-card",
    owner: "host",
    cardId: "card_9",
    sessionId: "cs_2",
    label: "đang sửa bảng tính",
    driver: "user",
    status: "running",
    leaseEpoch: 1,
    preview: "needs-permission",
    previewReason: "ứng dụng chưa được cấp quyền ghi màn hình",
    updatedAt: AT,
  },
  "terminal-session-card": {
    type: "terminal-session-card",
    owner: "host",
    cardId: "card_10",
    terminalId: "term_1",
    title: "clarkcant",
    cwd: "/home/user/clarkcant",
    prefill: "pnpm test",
    createdAt: AT,
  },
  "marketplace-results": {
    type: "marketplace-results",
    owner: "host",
    cardId: "market-1",
    query: "dashboard",
    directory: "/tmp/cc-directory.json",
    results: [
      {
        packageId: "com.acme.dashboard",
        version: "1.0.0",
        displayName: "Dashboard",
        description: "biểu đồ",
        source: { kind: "local", path: "/tmp/dashboard" },
        digest: "sha256:aaaa",
        riskTier: "isolated-ui",
        facets: ["ui"],
        platforms: ["linux-x64"],
      },
    ],
  },
};

describe("the text of every host card", () => {
  it("has a fixture for every host-owned card type, so a new one cannot arrive untested", () => {
    // Keyed by the list rather than by the projections's cases: a card added to the contract without a fixture
    // fails here rather than quietly rendering nothing.
    expect(Object.keys(FIXTURES).sort()).toEqual([...HOST_OWNED_BLOCK_TYPES].sort());
  });

  it("says something for each of them", () => {
    for (const type of HOST_OWNED_BLOCK_TYPES) {
      const text = textOfBlock(asBlock(FIXTURES[type]));
      expect(text.length, `${type} produced no text`).toBeGreaterThan(0);
    }
  });

  it("says what the card was about, not what type it is", () => {
    // The point of a text alternative is the content: a reader learns which project was offered, not that a
    // "project-picker-card" was rendered.
    expect(textOfBlock(asBlock(FIXTURES["question-card"]))).toContain("Dự án hiện tại");
    expect(textOfBlock(asBlock(FIXTURES["project-picker-card"]))).toContain("clarkcant");
    expect(textOfBlock(asBlock(FIXTURES["code-diff-card"]))).toContain("Đổi cách task được đánh dấu");
    expect(textOfBlock(asBlock(FIXTURES["task-overview-card"]))).toContain("sửa lỗi đăng nhập");
    expect(textOfBlock(asBlock(FIXTURES["browser-session-card"]))).toContain("agent");
    expect(textOfBlock(asBlock(FIXTURES["computer-session-card"]))).toContain("bạn");
    expect(textOfBlock(asBlock(FIXTURES["terminal-session-card"]))).toContain("/home/user/clarkcant");
  });

  it("names the answers a question offered, not only the question", () => {
    // Somebody who cannot press a button still needs to know what was on it, because the answer is what the
    // conversation turns on.
    const text = textOfBlock(asBlock(FIXTURES["question-card"]));

    expect(text).toContain("Bạn muốn tôi mở dự án nào?");
    expect(text).toContain("Dự án hiện tại / Dự án khác");
  });

  it("keeps what a card cannot say out of the text rather than inventing it", () => {
    // An unknown block contributes nothing. That is the honest outcome for a type this projection has not been
    // taught, and the fixture test above is what makes sure no host-owned type is in that position.
    const unknown = { type: "attachment", attachment: { attachmentId: "at_1" } } as unknown as MessageBlock;

    expect(textOfBlock(unknown)).toBe("");
    expect(textOfMessage({ blocks: [unknown] })).toBe("");
  });

  it("joins a turn's blocks in the order they were produced", () => {
    const text = textOfMessage({
      blocks: [
        { type: "text", format: "plain", content: "Đây là kết quả.", streaming: false },
        asBlock(FIXTURES["task-progress-card"]),
      ] as MessageBlock[],
    });

    expect(text.split("\n")).toEqual(["Đây là kết quả.", "sửa lỗi đăng nhập — working"]);
  });
});
