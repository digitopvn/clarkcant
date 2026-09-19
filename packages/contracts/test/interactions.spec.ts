import { describe, expect, it } from "vitest";

import {
  ANSWER_TEXT_LIMIT,
  answerFromUtterance,
  answerNote,
  foldWords,
  isWaiting,
  normalizeAnswer,
  voicePromptFor,
} from "../src/interactions.ts";

/**
 * The shape of a question the host is waiting to have answered.
 *
 * The interesting cases are all refusals and all speech: an answer that names an option nobody offered, a
 * confirmation that is neither yes nor no, a spoken question that has to be intelligible without the screen
 * it is drawn on. Normalising here rather than in each surface is what lets a click and an utterance be the
 * same answer.
 */
const OPTIONS = [
  { id: "staging", label: "Staging" },
  { id: "production", label: "Production" },
];

describe("saying a question out loud", () => {
  it("turns a single choice into a spoken one", () => {
    expect(
      voicePromptFor({ prompt: "Chọn môi trường triển khai.", questionType: "single-choice", options: OPTIONS }),
    ).toBe("Chọn môi trường triển khai. Staging hay Production?");
  });

  it("says which questions take more than one answer", () => {
    expect(voicePromptFor({ prompt: "Chọn môi trường.", questionType: "multi-choice", options: OPTIONS })).toContain(
      "Có thể chọn nhiều",
    );
  });

  it("asks a confirmation as a yes-or-no", () => {
    expect(voicePromptFor({ prompt: "Xoá project cũ?", questionType: "confirm", options: [] })).toBe(
      "Xoá project cũ? Đồng ý hay không?",
    );
  });

  it("prefers the agent's own wording when it gave one", () => {
    expect(
      voicePromptFor({
        prompt: "Chọn môi trường.",
        questionType: "single-choice",
        options: OPTIONS,
        voicePrompt: "Bạn muốn staging hay production?",
      }),
    ).toBe("Bạn muốn staging hay production?");
  });

  it("reads nothing extra into a free-text question", () => {
    expect(voicePromptFor({ prompt: "Tên project là gì?", questionType: "text", options: [] })).toBe(
      "Tên project là gì?",
    );
  });
});

describe("checking an answer against its question", () => {
  it("refuses an empty or oversized free-text answer", () => {
    const empty = normalizeAnswer({ questionType: "text", options: [], allowOther: false }, { text: "   " });
    expect(empty.ok).toBe(false);

    const long = normalizeAnswer(
      { questionType: "text", options: [], allowOther: false },
      { text: "x".repeat(ANSWER_TEXT_LIMIT + 1) },
    );
    expect(long.ok).toBe(false);
  });

  it("keeps a free-text answer verbatim and marks it as spoken when it was", () => {
    const answer = normalizeAnswer({ questionType: "text", options: [], allowOther: false }, { text: " agentkit ", viaVoice: true });
    expect(answer).toEqual({ ok: true, answer: { kind: "text", text: "agentkit", viaVoice: true } });
  });

  it("needs a real yes or no for a confirmation", () => {
    const missing = normalizeAnswer({ questionType: "confirm", options: [], allowOther: false }, { text: "chắc" });
    expect(missing.ok).toBe(false);
    const yes = normalizeAnswer({ questionType: "confirm", options: [], allowOther: false }, { confirmed: true });
    expect(yes).toEqual({ ok: true, answer: { kind: "confirm", confirmed: true } });
  });

  it("takes exactly one option for a single choice", () => {
    const none = normalizeAnswer({ questionType: "single-choice", options: OPTIONS, allowOther: false }, { optionIds: [] });
    expect(none.ok).toBe(false);
    const two = normalizeAnswer(
      { questionType: "single-choice", options: OPTIONS, allowOther: false },
      { optionIds: ["staging", "production"] },
    );
    expect(two.ok).toBe(false);
    const one = normalizeAnswer(
      { questionType: "single-choice", options: OPTIONS, allowOther: false },
      { optionIds: ["production"] },
    );
    expect(one).toEqual({ ok: true, answer: { kind: "single-choice", optionIds: ["production"] } });
  });

  it("refuses an option the question never offered", () => {
    // The case a voice interpretation actually produces: a heard word mapped to an id that is not on the list.
    const answer = normalizeAnswer(
      { questionType: "single-choice", options: OPTIONS, allowOther: false },
      { optionIds: ["stagingg"] },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.message).toContain("stagingg");
  });

  it("accepts several options for a multiple choice, and none of them when the question allows it", () => {
    const many = normalizeAnswer(
      { questionType: "multi-choice", options: OPTIONS, allowOther: true },
      { optionIds: ["staging", "production"] },
    );
    expect(many.ok).toBe(true);
    if (many.ok) expect(many.answer.optionIds).toEqual(["staging", "production"]);

    const noneChosen = normalizeAnswer({ questionType: "multi-choice", options: OPTIONS, allowOther: true }, { optionIds: [] });
    expect(noneChosen.ok).toBe(true);
    if (noneChosen.ok) expect(noneChosen.answer.optionIds).toEqual([]);

    const notAllowed = normalizeAnswer({ questionType: "multi-choice", options: OPTIONS, allowOther: false }, { optionIds: [] });
    expect(notAllowed.ok).toBe(false);
  });
});

describe("the turn an answer becomes", () => {
  it("says what was chosen, in the words the person saw", () => {
    const note = answerNote(
      { questionId: "q_123", prompt: "Chọn môi trường triển khai.", options: OPTIONS },
      { kind: "single-choice", optionIds: ["production"] },
    );
    expect(note).toContain("q_123");
    expect(note).toContain("Chọn môi trường triển khai.");
    expect(note).toContain("Production");
    // Not the id: the model needs the choice, not the wire format.
    expect(note).not.toContain("production.");
  });

  it("reads a confirmation as a sentence", () => {
    expect(answerNote({ questionId: "q_1", prompt: "Xoá?", options: [] }, { kind: "confirm", confirmed: false })).toContain(
      "Không đồng ý",
    );
  });

  it("says so when nothing was chosen", () => {
    expect(
      answerNote({ questionId: "q_1", prompt: "Thêm gì?", options: OPTIONS }, { kind: "multi-choice", optionIds: [] }),
    ).toContain("Không chọn lựa chọn nào");
  });
});

describe("what somebody said, read against the question", () => {
  it("matches an option by its label, however the sentence is wrapped", () => {
    expect(answerFromUtterance({ questionType: "single-choice", options: OPTIONS, allowOther: false }, "production")).toEqual({
      optionIds: ["production"],
    });
    expect(
      answerFromUtterance({ questionType: "single-choice", options: OPTIONS, allowOther: false }, "cho tôi production nhé"),
    ).toEqual({ optionIds: ["production"] });
  });

  it("ignores case and diacritics, because a transcript is not typed", () => {
    const folders = [
      { id: "old", label: "Dự án cũ" },
      { id: "v2", label: "AgentKit V2" },
    ];
    expect(foldWords("Dự  Án CŨ")).toBe("du an cu");
    expect(answerFromUtterance({ questionType: "single-choice", options: folders, allowOther: true }, "du an cu")).toEqual({
      optionIds: ["old"],
    });
  });

  it("prefers the longer label, so one option cannot swallow another", () => {
    const folders = [
      { id: "plain", label: "agentkit" },
      { id: "v2", label: "agentkit-v2" },
    ];
    expect(answerFromUtterance({ questionType: "single-choice", options: folders, allowOther: true }, "agentkit-v2")).toEqual({
      optionIds: ["v2"],
    });
  });

  it("takes several options out of one sentence", () => {
    expect(
      answerFromUtterance({ questionType: "multi-choice", options: OPTIONS, allowOther: true }, "staging và production"),
    ).toEqual({ optionIds: ["staging", "production"] });
  });

  it("answers a confirmation with yes or no, and refuses anything in between", () => {
    const confirm = { questionType: "confirm" as const, options: [], allowOther: false };
    expect(answerFromUtterance(confirm, "đồng ý")).toEqual({ confirmed: true });
    expect(answerFromUtterance(confirm, "yes")).toEqual({ confirmed: true });
    expect(answerFromUtterance(confirm, "không")).toEqual({ confirmed: false });
    expect(answerFromUtterance(confirm, "thôi")).toEqual({ confirmed: false });
    // Both, or neither: a question asked again is recoverable, a misheard decision is not.
    expect(answerFromUtterance(confirm, "chắc")).toBeUndefined();
    expect(answerFromUtterance(confirm, "ừ nhưng mà không")).toBeUndefined();
  });

  it("returns nothing when the words do not fit the question", () => {
    expect(answerFromUtterance({ questionType: "single-choice", options: OPTIONS, allowOther: false }, "cái gì cũng được")).toBeUndefined();
    expect(answerFromUtterance({ questionType: "single-choice", options: OPTIONS, allowOther: false }, "   ")).toBeUndefined();
  });

  it("takes a free-text question verbatim", () => {
    expect(answerFromUtterance({ questionType: "text", options: [], allowOther: false }, "  gọi nó là Bình Minh  ")).toEqual({
      text: "gọi nó là Bình Minh",
    });
  });
});

describe("whether an interaction still wants an answer", () => {
  const now = "2026-09-19T10:00:00.000Z";

  it("is waiting until it is answered", () => {
    expect(isWaiting({ status: "waiting" }, now as never)).toBe(true);
    expect(isWaiting({ status: "answered" }, now as never)).toBe(false);
    expect(isWaiting({ status: "cancelled" }, now as never)).toBe(false);
  });

  it("stops waiting when its deadline has passed", () => {
    expect(isWaiting({ status: "waiting", expiresAt: "2026-09-19T11:00:00.000Z" as never }, now as never)).toBe(true);
    expect(isWaiting({ status: "waiting", expiresAt: "2026-09-19T09:00:00.000Z" as never }, now as never)).toBe(false);
  });
});
