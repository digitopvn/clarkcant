import { describe, expect, it } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";

import { createModelTurn } from "../src/model-turn.ts";

/**
 * A turn that stays open until it is released, so "is anything running" can be asked while something is.
 *
 * Without the pause the question is unanswerable: the fake adapter resolves immediately, and a test that only ever
 * sees the state after the turn has finished would pass whether the tracking worked or not. This is also the test
 * that found the first attempt's defect - the marker was kept in a map beside the turn and survived the abort path.
 */
class HangingAdapter extends FakePiAdapter {
  release: (() => void) | undefined;
  readonly steered: { sessionId: string; text: string }[] = [];

  override async prompt(sessionId: string, text: string): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await super.prompt(sessionId, text);
  }

  override async steer(sessionId: string, text: string): Promise<void> {
    this.steered.push({ sessionId, text });
  }
}

const PRINCIPAL: Principal = {
  principalId: "p_owner" as Principal["principalId"],
  kind: "user",
  nodeId: "n1" as Principal["nodeId"],
};
const CONVERSATION = "c1" as ConversationId;
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

describe("what is running while a message arrives", () => {
  it("answers honestly when nothing is", async () => {
    // The negative answers are the ones a caller acts on: "there was nothing to steer" is what makes it start a
    // background worker instead, and a method that optimistically said yes would make that decision impossible.
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter: new FakePiAdapter({ script: ["ok"] }) });
    expect(turn!.running()).toEqual([]);
    expect(turn!.interrupt(CONVERSATION)).toBe(false);
    expect(await turn!.steer(CONVERSATION, "thêm đi")).toBe(false);
  });

  it("knows a conversation has a turn running, and can join it or stop it", async () => {
    const adapter = new HangingAdapter({ script: ["Câu trả lời."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });

    const answer = turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "việc dài",
      messageId: "msg_1",
    });
    // Until the adapter is inside its prompt.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(turn!.running()).toEqual([CONVERSATION]);
    expect(await turn!.steer(CONVERSATION, "nhớ kiểm tra cả phần thanh toán")).toBe(true);
    expect(adapter.steered).toHaveLength(1);
    expect(adapter.steered[0]?.text).toContain("thanh toán");

    expect(turn!.interrupt(CONVERSATION)).toBe(true);
    adapter.release?.();
    await answer.catch(() => undefined);
    // A turn settles through more than one path, so give the finally a moment before asking whether it ran.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // And the marker is gone afterwards, so the next message does not think something is still running.
    expect(turn!.running()).toEqual([]);
  });
});
