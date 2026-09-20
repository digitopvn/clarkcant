import { type ReactElement, isValidElement } from "react";

import { describe, expect, it } from "vitest";

import { QuestionCardBlock, renderBlock, type BlockActions } from "../src/blocks.tsx";

/**
 * The question card.
 *
 * Two claims matter here, and both are about what happens when the user is not looking at a fresh card.
 *
 * The first is that an answer travels the composer's path. The card does not invent a route into the agent; it
 * hands the chosen label to `onQuestionAnswer`, and the conversation sends it as the user's own message. That is
 * what makes a click and a typed reply the same act, and it is why this test asserts the handler receives the
 * label rather than an id.
 *
 * The second is that the card stops being answerable once the conversation has moved past it. The transcript is
 * immutable, so a card that stayed live would offer a second answer to a question the node already received one
 * for — and the node would take it as a second message nobody meant to send.
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
  question: "Bạn muốn mở dự án nào?",
  options: [
    { id: "option-1", label: "clarkcant", detail: "thư mục hiện tại" },
    { id: "option-2", label: "khác" },
  ],
};

function open(actions?: BlockActions): ReturnType<typeof QuestionCardBlock> {
  // Spread rather than passing `undefined`: with exactOptionalPropertyTypes an optional prop may be absent,
  // but may not be explicitly undefined.
  return QuestionCardBlock({ block: QUESTION, ...(actions === undefined ? {} : { actions }) });
}

describe("an open question offers its answers as controls", () => {
  it("draws one button per option, labelled with what the agent will receive", () => {
    const tree = open({ onQuestionAnswer: () => {}, openQuestionIds: ["q_1"] });
    const buttons = findAll(tree, "data-question-answer");
    expect(buttons.map((button) => button.props["data-question-answer"])).toEqual(["option-1", "option-2"]);
    // The label is the answer: what is on the button is what the user's message will say.
    expect(buttons.map((button) => textOf(button.props.children))).toEqual(["clarkcant", "khác"]);
  });

  it("hands over the label rather than the option id", () => {
    /*
     * The id is this card's business; the label is what the user chose and what the agent must read. Sending the
     * id instead would put "option-2" into the transcript, and the agent would have to be told what that meant.
     */
    const answers: { questionId: string; answer: string }[] = [];
    const tree = open({ onQuestionAnswer: (input) => answers.push(input), openQuestionIds: ["q_1"] });
    const second = findAll(tree, "data-question-answer")[1];
    (second?.props.onClick as () => void)();

    expect(answers).toEqual([{ questionId: "q_1", answer: "khác" }]);
  });

  it("shows the question and each option's detail as text", () => {
    const tree = open({ onQuestionAnswer: () => {}, openQuestionIds: ["q_1"] });
    const text = textOf(tree);
    expect(text).toContain("Bạn muốn mở dự án nào?");
    expect(text).toContain("clarkcant");
    // The detail is part of the readable text, not a tooltip: a reason that only appears on hover is one most
    // people never learn about.
    expect(text).toContain("thư mục hiện tại");
  });
});

describe("a question the conversation has moved past is read-only", () => {
  it("offers no controls when the id is not open", () => {
    const tree = open({ onQuestionAnswer: () => {}, openQuestionIds: [] });
    expect(findAll(tree, "data-question-answer")).toHaveLength(0);
    // The options are still readable, which is what makes this card's text alternative the same thing as its
    // control: a snapshot, a screen reader and an answered card read the same list.
    expect(findAll(tree, "data-question-option")).toHaveLength(2);
    expect(textOf(tree)).toContain("clarkcant");
  });

  it("says why the controls are gone rather than leaving a reader to wonder", () => {
    const tree = open({ onQuestionAnswer: () => {}, openQuestionIds: [] });
    expect(findAll(tree, "data-question-closed")).toHaveLength(1);
    expect(textOf(tree)).toContain("không còn nhận câu trả lời");
  });

  it("is read-only when there is no handler at all, which is the inline history case", () => {
    // A snapshot in the transcript has no host to talk to, so it renders as the record of what was asked.
    const tree = open(undefined);
    expect(findAll(tree, "data-question-answer")).toHaveLength(0);
    expect(findAll(tree, "data-question-option")).toHaveLength(2);
  });
});

describe("a malformed question degrades rather than throwing", () => {
  it("renders nothing for a block that is not host-owned", () => {
    // The same rule every host card follows: provenance is checked before anything is drawn, so a reply that
    // claims to be host chrome cannot become host chrome.
    expect(QuestionCardBlock({ block: { ...QUESTION, owner: "widget" } })).toBeNull();
  });

  it("drops an option with no usable label instead of drawing an empty button", () => {
    const tree = QuestionCardBlock({
      block: { ...QUESTION, options: [{ id: "option-1", label: "ok" }, { id: "option-2" }, "nonsense"] },
      actions: { onQuestionAnswer: () => {}, openQuestionIds: ["q_1"] },
    });
    expect(findAll(tree, "data-question-answer")).toHaveLength(1);
  });

  it("survives a missing options array", () => {
    const tree = QuestionCardBlock({
      block: { type: "question-card", owner: "host", questionId: "q", question: "Chọn?" },
      actions: { onQuestionAnswer: () => {}, openQuestionIds: ["q"] },
    });
    expect(findAll(tree, "data-question-answer")).toHaveLength(0);
    expect(textOf(tree)).toContain("Chọn?");
  });

  it("is reachable through the block switch, and given the actions", () => {
    /*
     * The switch hands back a React element rather than a rendered tree, so this asserts the dispatch and the
     * props rather than walking inside: the block type resolves to *this* card, and the handler reaches it. That
     * the card then draws its buttons is the first describe block's claim, checked by calling it directly.
     */
    const actions: BlockActions = { onQuestionAnswer: () => {}, openQuestionIds: ["q_1"] };
    // The surface callback is never reached: this block is a host card, not a composed surface. Cast because
    // this file is `.ts` (no JSX) and the parameter is typed as returning an element.
    const surface = (() => null) as unknown as Parameters<typeof renderBlock>[2];
    const element = renderBlock(QUESTION, 0, surface, actions) as unknown as ReactElement<Record<string, unknown>>;
    expect(element.type).toBe(QuestionCardBlock);
    expect(element.props.block).toBe(QUESTION);
    expect(element.props.actions).toBe(actions);
  });
});
