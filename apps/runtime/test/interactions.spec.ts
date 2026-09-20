import { describe, expect, it } from "vitest";

import type { Instant, MessageBlock } from "@clarkcant/contracts";

import {
  QUESTION_TTL_MS,
  SECRET_REQUEST_MESSAGE,
  type InteractionDeps,
  answerQuestion,
  cancelQuestion,
  createQuestion,
  expireQuestions,
  pendingForConversation,
} from "../src/interactions.ts";

/**
 * The interaction manager.
 *
 * Two properties carry the design, and both are asserted here rather than described: raising a question ends
 * the turn that asked (nothing in this module waits for anybody), and the transcript is the durable state, so
 * "answered" survives a restart without a table and cannot disagree with what a person is looking at.
 */
const CONVERSATION = "conv_1";
const START = "2026-09-19T10:00:00.000Z";

function fixture(): {
  deps: InteractionDeps;
  blocks: MessageBlock[];
  advance: (ms: number) => void;
} {
  const blocks: MessageBlock[] = [];
  let nowMs = Date.parse(START);
  let counter = 0;
  const deps: InteractionDeps = {
    conversationId: CONVERSATION,
    now: () => new Date(nowMs).toISOString() as Instant,
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
    blocks: () => blocks,
    append: ({ blocks: appended }) => {
      blocks.push(...appended);
    },
  };
  return {
    deps,
    blocks,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

const SINGLE = {
  question: "Chọn môi trường triển khai.",
  kind: "single-choice" as const,
  options: [
    { id: "staging", label: "Staging" },
    { id: "production", label: "Production" },
  ],
};

describe("raising a question", () => {
  it("writes one waiting card and says it out loud from the options it offers", () => {
    const { deps, blocks } = fixture();
    const created = createQuestion(deps, SINGLE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(blocks).toHaveLength(1);
    const card = created.block;
    expect(card.type).toBe("question-card");
    if (card.type !== "question-card") return;
    expect(card.status).toBe("waiting");
    expect(card.voicePrompt).toContain("Staging hay Production");
    expect(card.expiresAt).toBeDefined();
  });

  it("refuses a question that asks for a secret, without asking a model", () => {
    const { deps, blocks } = fixture();
    const refused = createQuestion(deps, { question: "What is your OpenAI API key?", kind: "text" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("SECRET_REQUEST");
    expect(refused.message).toBe(SECRET_REQUEST_MESSAGE);
    // Nothing is written: a question that will never be accepted must not leave a card behind.
    expect(blocks).toHaveLength(0);
  });

  it("refuses a choice with nothing to choose, and a free-text question with options", () => {
    const { deps } = fixture();
    const noOptions = createQuestion(deps, { question: "Chọn gì?", kind: "single-choice" });
    expect(noOptions.ok).toBe(false);
    if (!noOptions.ok) expect(noOptions.code).toBe("INVALID_QUESTION");

    const textWithOptions = createQuestion(deps, { question: "Tên gì?", kind: "text", options: [{ id: "a", label: "A" }] });
    expect(textWithOptions.ok).toBe(false);
  });

  it("refuses a question that is not shaped like one at all", () => {
    const { deps } = fixture();
    expect(createQuestion(deps, { question: "Thiếu kind" }).ok).toBe(false);
    expect(createQuestion(deps, "chọn đi").ok).toBe(false);
  });
});

describe("answering one", () => {
  it("records the answer as a turn the model can continue from", () => {
    const { deps, blocks } = fixture();
    createQuestion(deps, SINGLE);
    const questionId = pendingForConversation(deps)[0]?.questionId ?? "";

    const answered = answerQuestion(deps, questionId, { optionIds: ["production"] });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.note).toContain("Production");

    // The record the model reads, and the record that makes the answer findable later.
    const tool = blocks.find((block) => block.type === "tool-activity");
    expect(tool?.type).toBe("tool-activity");
    if (tool?.type !== "tool-activity") return;
    expect(tool.name).toBe("ask_user_question");
    expect(tool.args.questionId).toBe(questionId);
    expect(tool.args.decision).toBe("answered");
    expect(tool.args.optionIds).toEqual(["production"]);

    // And it stops being something the node is waiting on.
    expect(pendingForConversation(deps)).toHaveLength(0);
  });

  it("carries the fact that the answer was spoken rather than clicked", () => {
    const { deps } = fixture();
    createQuestion(deps, SINGLE);
    const questionId = pendingForConversation(deps)[0]?.questionId ?? "";
    answerQuestion(deps, questionId, { optionIds: ["staging"], viaVoice: true });
    const tool = deps.blocks().find((block) => block.type === "tool-activity");
    if (tool?.type !== "tool-activity") throw new Error("no record");
    expect(tool.args.viaVoice).toBe(true);
  });

  it("refuses an answer that names something the question never offered", () => {
    const { deps, blocks } = fixture();
    createQuestion(deps, SINGLE);
    const questionId = pendingForConversation(deps)[0]?.questionId ?? "";
    const before = blocks.length;

    const refused = answerQuestion(deps, questionId, { optionIds: ["stagingg"] });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("INVALID_ANSWER");
    // Still waiting: a refused answer is not an answer.
    expect(blocks).toHaveLength(before);
    expect(pendingForConversation(deps)).toHaveLength(1);
  });

  it("refuses a second answer to the same question", () => {
    const { deps } = fixture();
    createQuestion(deps, SINGLE);
    const questionId = pendingForConversation(deps)[0]?.questionId ?? "";
    answerQuestion(deps, questionId, { optionIds: ["staging"] });

    const again = answerQuestion(deps, questionId, { optionIds: ["production"] });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("QUESTION_CLOSED");
  });

  it("refuses an answer to a question that does not exist", () => {
    const { deps } = fixture();
    const missing = answerQuestion(deps, "q_nope", { text: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("QUESTION_NOT_FOUND");
  });

  it("takes a confirmation as a yes or a no, and nothing else", () => {
    const { deps } = fixture();
    createQuestion(deps, { question: "Xoá project cũ?", kind: "confirm" });
    const questionId = pendingForConversation(deps)[0]?.questionId ?? "";

    expect(answerQuestion(deps, questionId, { text: "chắc" }).ok).toBe(false);
    const yes = answerQuestion(deps, questionId, { confirmed: true });
    expect(yes.ok).toBe(true);
    if (yes.ok) expect(yes.note).toContain("Đồng ý");
  });
});

describe("what is still waiting", () => {
  it("returns only the questions without an answer", () => {
    const { deps } = fixture();
    createQuestion(deps, SINGLE);
    createQuestion(deps, { question: "Tên project là gì?", kind: "text" });
    const first = pendingForConversation(deps)[0]?.questionId ?? "";
    answerQuestion(deps, first, { optionIds: ["staging"] });

    const pending = pendingForConversation(deps);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.questionType).toBe("text");
  });

  it("stops waiting once the deadline has passed, and closes it lazily", () => {
    const { deps, advance, blocks } = fixture();
    createQuestion(deps, SINGLE);
    advance(QUESTION_TTL_MS + 1);

    // Lazy on purpose: a question that expired while the node was down is the case a timer cannot cover.
    expect(pendingForConversation(deps)).toHaveLength(0);
    const expired = expireQuestions(deps);
    expect(expired).toHaveLength(1);
    expect(blocks.some((block) => block.type === "tool-activity" && block.args.decision === "expired")).toBe(true);

    const late = answerQuestion(deps, expired[0] ?? "", { optionIds: ["staging"] });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.code).toBe("QUESTION_CLOSED");
  });

  it("drops a question that was cancelled, and keeps the fact that it was asked", () => {
    const { deps, blocks } = fixture();
    createQuestion(deps, SINGLE);
    const questionId = pendingForConversation(deps)[0]?.questionId ?? "";

    expect(cancelQuestion(deps, questionId)).toBe(true);
    expect(pendingForConversation(deps)).toHaveLength(0);
    expect(blocks.some((block) => block.type === "tool-activity" && block.args.decision === "cancelled")).toBe(true);

    // A cancelled question cannot be answered afterwards, and an unknown one cannot be cancelled.
    expect(answerQuestion(deps, questionId, { optionIds: ["staging"] }).ok).toBe(false);
    expect(cancelQuestion(deps, "q_nope")).toBe(false);
    expect(cancelQuestion(deps, questionId)).toBe(false);
  });
});
