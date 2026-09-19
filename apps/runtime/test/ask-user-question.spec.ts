import { describe, expect, it } from "vitest";

import type { Instant, MessageBlock } from "@clarkcant/contracts";

import { createAskUserQuestionTool } from "../src/ask-user-question.ts";
import { SECRET_REQUEST_MESSAGE, type InteractionDeps, pendingForConversation } from "../src/interactions.ts";

/**
 * The tool an agent asks with.
 *
 * The property under test is a refusal to wait. `execute` has to return in the same turn, because the
 * alternative — holding the call until a person answers — parks a provider call and an HTTP stream on somebody's
 * decision. So what is asserted is that the call resolves with a card and a "your turn is over" message, that
 * nothing was answered, and that the question is on record waiting.
 */
function fixture(): { deps: InteractionDeps; blocks: MessageBlock[] } {
  const blocks: MessageBlock[] = [];
  let counter = 0;
  const deps: InteractionDeps = {
    conversationId: "conv_1",
    now: () => "2026-09-19T10:00:00.000Z" as Instant,
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
    blocks: () => blocks,
    append: ({ blocks: appended }) => {
      blocks.push(...appended);
    },
  };
  return { deps, blocks };
}

describe("asking the user a question", () => {
  it("writes a card, ends the turn, and does not wait for anybody", async () => {
    const { deps } = fixture();
    const tool = createAskUserQuestionTool(deps);
    const answer = await tool.execute({
      question: "Chọn môi trường triển khai.",
      kind: "single-choice",
      options: [
        { id: "staging", label: "Staging" },
        { id: "production", label: "Production" },
      ],
    });

    // A card, and a message that tells the model its turn is over rather than that it has an answer.
    expect(answer.hostBlocks?.map((block) => block.type)).toEqual(["question-card"]);
    expect(answer.text).toContain("lượt này kết thúc");
    expect(answer.text).not.toContain("Production");

    // And the question really is waiting: the answer arrives later, on its own request.
    expect(pendingForConversation(deps)).toHaveLength(1);
  });

  it("refuses to ask for a secret, and names the tool that can", async () => {
    const { deps, blocks } = fixture();
    const tool = createAskUserQuestionTool(deps);
    const answer = await tool.execute({ question: "API key của bạn là gì?", kind: "text" });

    expect(answer.text).toBe(SECRET_REQUEST_MESSAGE);
    expect(answer.hostBlocks).toBeUndefined();
    // Nothing is written, so there is no card a person could type a key into.
    expect(blocks).toHaveLength(0);
  });

  it("refuses a choice with nothing to choose, in the same turn", async () => {
    const { deps } = fixture();
    const tool = createAskUserQuestionTool(deps);
    const answer = await tool.execute({ question: "Chọn gì?", kind: "single-choice" });
    expect(answer.hostBlocks).toBeUndefined();
    expect(answer.text).toContain("ít nhất một lựa chọn");
  });
});
