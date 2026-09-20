import { type ReactElement, isValidElement } from "react";

import { describe, expect, it } from "vitest";

import { QuestionCardBlock, renderBlock, type BlockActions } from "../src/blocks.tsx";

/**
 * The question card.
 *
 * Three claims matter here, and the third is the one this card's shape exists for.
 *
 * The first is that an answer travels the composer's path: the card hands the chosen option's id to
 * `onQuestionAnswer`, and the conversation records it and opens the next turn. The id rather than the label is
 * deliberate — the label is what the person read and the id is what the host recorded the question in terms of — so
 * a translated or shortened button still answers the question that was asked, and `answerFromUtterance` maps a
 * spoken label back to the same id.
 *
 * The second is that the card stops being answerable once the transcript carries an answer. Messages are never
 * rewritten, so the record the node wrote when the answer arrived is what says otherwise.
 *
 * The third is that the card keeps no state of its own: the selection being composed and the text being typed
 * travel through `onQuestionDraft`, and the question whose answer is in flight arrives as `questionPendingId`. A
 * card holding its own copy would disagree with the conversation exactly when it matters — after a reload, or when
 * the same card appears twice in one snapshot.
 *
 * Called as a plain function and walked, like the other block tests: a `ReactElement` is an ordinary object, and
 * this suite runs in Node with no DOM on purpose.
 */

function findAll(node: unknown, prop: string): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (!isValidElement(current)) return;
    const element = current as ReactElement<Record<string, unknown>>;
    if (prop in element.props) found.push(element);
    walk(element.props.children);
  };
  walk(node);
  return found;
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<Record<string, unknown>>).props.children);
}

const QUESTION = {
  type: "question-card",
  owner: "host",
  questionId: "q_1",
  prompt: "Bạn muốn mở dự án nào?",
  questionType: "single-choice",
  options: [
    { id: "option-1", label: "clarkcant", description: "thư mục hiện tại" },
    { id: "option-2", label: "khác" },
  ],
  allowOther: false,
  voicePrompt: "Bạn muốn mở dự án nào? clarkcant, hay khác?",
  status: "waiting",
  createdAt: "2026-09-20T00:00:00.000Z",
};

function open(actions?: BlockActions): ReturnType<typeof QuestionCardBlock> {
  // Spread rather than passing `undefined`: with exactOptionalPropertyTypes an optional prop may be absent,
  // but may not be explicitly undefined.
  return QuestionCardBlock({ block: QUESTION, ...(actions === undefined ? {} : { actions }) });
}

describe("an open question offers its answers as controls", () => {
  it("draws one control per option, labelled with what the person read", () => {
    const tree = open({ onQuestionAnswer: () => {} });
    const options = findAll(tree, "data-question-option");
    expect(options.map((option) => option.props["data-question-option"])).toEqual(["option-1", "option-2"]);
    // The label first, then the description: what the button says is what the person is choosing between. The
    // whitespace is normalised because the JSX separator between them is a text node of its own.
    expect(options.map((option) => textOf(option.props.children).replace(/\s+/g, " ").trim())).toEqual([
      "clarkcant thư mục hiện tại",
      "khác",
    ]);
  });

  it("hands over the option id, which is what the host recorded the question in terms of", () => {
    const answers: { questionId: string; optionIds?: string[] }[] = [];
    const tree = open({ onQuestionAnswer: (input) => answers.push(input) });
    const second = findAll(tree, "data-question-option")[1];
    (second?.props.onClick as () => void)();

    expect(answers).toEqual([{ questionId: "q_1", optionIds: ["option-2"] }]);
  });

  it("shows the question and each option's description as text", () => {
    const tree = open({ onQuestionAnswer: () => {} });
    const text = textOf(tree);
    expect(text).toContain("Bạn muốn mở dự án nào?");
    expect(text).toContain("clarkcant");
    // The description is part of the readable text, not a tooltip: a reason that only appears on hover is one most
    // people never learn about.
    expect(text).toContain("thư mục hiện tại");
  });

  it("hands a change in the selection to the surface rather than keeping it", () => {
    // The multi-choice draft is the case a card would otherwise have to remember: the answer is only complete when
    // the person presses Gửi, so the selection lives above the card and arrives back as `questionDraft`.
    const multi = { ...QUESTION, questionType: "multi-choice" };
    const drafts: { questionId: string; chosen?: readonly string[] }[] = [];
    const tree = QuestionCardBlock({
      block: multi,
      actions: { onQuestionAnswer: () => {}, onQuestionDraft: (input) => drafts.push(input) },
    });
    const first = findAll(tree, "data-question-option")[0];
    (first?.props.onClick as () => void)();
    expect(drafts).toEqual([{ questionId: "q_1", chosen: ["option-1"] }]);

    // And it renders what it is given: the same card with a draft shows that option as chosen.
    const withDraft = QuestionCardBlock({
      block: multi,
      actions: {
        onQuestionAnswer: () => {},
        questionDraft: { questionId: "q_1", chosen: ["option-2"], text: "" },
      },
    });
    const options = findAll(withDraft, "data-question-option");
    expect(options[1]?.props["data-selected"]).toBe(true);
    expect(options[0]?.props["data-selected"]).toBe(false);
  });
});

describe("a question the conversation has moved past is read-only", () => {
  it("offers no controls once the transcript carries an answer", () => {
    const tree = open({ onQuestionAnswer: () => {}, answeredQuestions: ["q_1"] });
    expect(findAll(tree, "data-question-option")).toHaveLength(0);
    // The options are still readable, which is what makes this card's text alternative the same thing as its
    // control: a snapshot, a screen reader and an answered card read the same list.
    expect(textOf(tree)).toContain("clarkcant");
  });

  it("says the answer was recorded rather than leaving a reader to wonder", () => {
    const tree = open({ onQuestionAnswer: () => {}, answeredQuestions: ["q_1"] });
    expect(textOf(tree)).toContain("Câu trả lời đã được ghi");
  });

  it("stops inviting a second press while the first answer is still travelling", () => {
    // The question the node is still waiting on is the one with no controls at all, and it is said in words rather
    // than left to a disabled look.
    const tree = open({ onQuestionAnswer: () => {}, questionPendingId: "q_1" });
    expect(findAll(tree, "data-question-option")).toHaveLength(0);
    expect(textOf(tree)).toContain("Đang gửi câu trả lời");
    // Still readable, which is the same text alternative an answered card offers.
    expect(textOf(tree)).toContain("clarkcant");
  });

  it("is read-only when there is no handler at all, which is the inline history case", () => {
    // A snapshot in the transcript has no host to talk to, so it renders as the record of what was asked.
    const tree = open(undefined);
    expect(findAll(tree, "data-question-option")).toHaveLength(0);
    expect(textOf(tree)).toContain("clarkcant");
  });
});

describe("a malformed question degrades rather than throwing", () => {
  it("renders nothing for a block that is not host-owned", () => {
    // The same rule every host card follows: provenance is checked before anything is drawn, so a reply that
    // claims to be host chrome cannot become host chrome.
    expect(QuestionCardBlock({ block: { ...QUESTION, owner: "widget" } })).toBeNull();
  });

  it("drops an option with no usable label instead of drawing an empty control", () => {
    const tree = QuestionCardBlock({
      block: { ...QUESTION, options: [{ id: "option-1", label: "ok" }, { id: "option-2" }, "nonsense"] },
      actions: { onQuestionAnswer: () => {} },
    });
    expect(findAll(tree, "data-question-option")).toHaveLength(1);
  });

  it("survives a missing options array", () => {
    const tree = QuestionCardBlock({
      block: { type: "question-card", owner: "host", questionId: "q", prompt: "Chọn?", questionType: "text" },
      actions: { onQuestionAnswer: () => {} },
    });
    expect(findAll(tree, "data-question-option")).toHaveLength(0);
    expect(textOf(tree)).toContain("Chọn?");
  });

  it("is reachable through the block switch, and given the actions", () => {
    /*
     * The switch hands back a React element rather than a rendered tree, so this asserts the dispatch and the
     * props rather than walking inside: the block type resolves to *this* card, and the handlers reach it. That
     * the card then draws its controls is the first describe block's claim, checked by calling it directly.
     */
    const actions: BlockActions = { onQuestionAnswer: () => {}, onQuestionDraft: () => {} };
    // The surface callback is never reached: this block is a host card, not a composed surface. Cast because
    // this file is `.ts` (no JSX) and the parameter is typed as returning an element.
    const surface = (() => null) as unknown as Parameters<typeof renderBlock>[2];
    const element = renderBlock(QUESTION, 0, surface, actions) as unknown as ReactElement<Record<string, unknown>>;
    expect(element.type).toBe(QuestionCardBlock);
    expect(element.props.block).toBe(QUESTION);
    expect(element.props.actions).toBe(actions);
  });
});
