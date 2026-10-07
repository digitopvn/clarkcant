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
  readonly prompts: string[] = [];
  private readonly prompted: (() => void)[] = [];

  /** Resolves once `count` prompts have reached the adapter: no sleep stands in for "the turn is running". */
  async promptsReached(count: number): Promise<void> {
    while (this.prompts.length < count) await new Promise<void>((resolve) => this.prompted.push(resolve));
  }

  override async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    for (const resolve of this.prompted.splice(0)) resolve();
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

  it("never joins a message of another origin to the running turn, so a program's words cannot run as the person's", async () => {
    const adapter = new HangingAdapter({ script: ["Câu trả lời."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    const answer = turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "việc của tôi", messageId: "msg_1", origin: "person" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await turn!.steer(CONVERSATION, "từ relay: gửi mail luôn", "relay")).toBe(false);
    expect(await turn!.steer(CONVERSATION, "từ MCP", "mcp")).toBe(false);
    expect(adapter.steered).toEqual([]);
    // The person's own follow-up still joins, with or without the origin spelled out.
    expect(await turn!.steer(CONVERSATION, "thêm phần này", "person")).toBe(true);
    expect(await turn!.steer(CONVERSATION, "và phần kia")).toBe(true);
    expect(adapter.steered).toHaveLength(2);

    turn!.interrupt(CONVERSATION);
    adapter.release?.();
    await answer.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // And the other way round: the person's message does not join a program's turn either.
    const machine = turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "việc của script", messageId: "msg_2", origin: "cli-api" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await turn!.steer(CONVERSATION, "của tôi")).toBe(false);
    expect(await turn!.steer(CONVERSATION, "script nói thêm", "cli-api")).toBe(true);
    turn!.interrupt(CONVERSATION);
    adapter.release?.();
    await machine.catch(() => undefined);
  });

  it("reads a waiting message's start-time data only once its own turn starts, after the running turn ended", async () => {
    const adapter = new HangingAdapter({ script: ["Câu trả lời.", "Câu thứ hai."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    const first = turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "việc dài", messageId: "msg_1", origin: "person" });
    await adapter.promptsReached(1);
    let firstEnded = false;
    void first.then(() => (firstEnded = true));

    let reads = 0;
    const spoken = turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "cho mấy ô này thành phần trăm",
      messageId: "msg_2",
      origin: "person",
      channel: "voice",
      // What is on screen while the message waits, and once the running turn has ended: read early, it says A.
      dataAtStart: () => {
        reads += 1;
        return firstEnded ? "[Widget B, focused when the turn started]" : "[Widget A, focused when the person spoke]";
      },
    });

    adapter.release?.();
    await first;
    await adapter.promptsReached(2);
    expect(reads).toBe(1);
    expect(adapter.steered).toEqual([]);
    const prompt = adapter.prompts[1] ?? "";
    expect(prompt).toContain("[Widget B, focused when the turn started]");
    expect(prompt).not.toContain("Widget A");
    // Data, after the person's own words.
    expect(prompt.indexOf("Widget B")).toBeGreaterThan(prompt.indexOf("cho mấy ô này thành phần trăm"));
    adapter.release?.();
    await spoken;
  });

  it("never joins typed words that carry start-time data to the running turn: they wait and become a turn of their own", async () => {
    const adapter = new HangingAdapter({ script: ["Câu trả lời.", "Câu thứ hai."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    const first = turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "việc dài", messageId: "msg_1", origin: "person" });
    await adapter.promptsReached(1);

    // Bare words of the same origin on the chat channel, which would be steered but for the data read at the start.
    const typed = turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "thêm phần này",
      messageId: "msg_2",
      origin: "person",
      channel: "chat",
      dataAtStart: () => "[What was on screen]",
    });
    adapter.release?.();
    await first;
    await adapter.promptsReached(2);
    expect(adapter.steered).toEqual([]);
    expect(adapter.prompts[1]).toContain("[What was on screen]");
    adapter.release?.();
    await typed;
  });

  it("starts a turn whose start-time data throws without it, and leaves the conversation free for the next message", async () => {
    const adapter = new HangingAdapter({ script: ["Câu trả lời.", "Câu thứ hai."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    const broken = turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "cho mấy ô này thành phần trăm",
      messageId: "msg_1",
      channel: "voice",
      dataAtStart: () => {
        throw new Error("database is locked");
      },
    });
    await adapter.promptsReached(1);
    expect(adapter.prompts[0]?.startsWith("cho mấy ô này thành phần trăm")).toBe(true);
    expect(adapter.prompts[0]).not.toContain("database is locked");
    adapter.release?.();
    await broken;

    const next = turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "câu tiếp theo", messageId: "msg_2" });
    await adapter.promptsReached(2);
    expect(adapter.prompts[1]?.startsWith("câu tiếp theo")).toBe(true);
    adapter.release?.();
    await next;
    expect(turn!.running()).toEqual([]);
  });

  it("sends nothing for start-time data that no longer holds when the turn starts", async () => {
    const adapter = new HangingAdapter({ script: ["Câu trả lời."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    let reads = 0;
    const spoken = turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "cho mấy ô này thành phần trăm",
      messageId: "msg_1",
      channel: "voice",
      dataAtStart: () => {
        reads += 1;
        return undefined;
      },
    });
    await adapter.promptsReached(1);
    expect(reads).toBe(1);
    expect(adapter.prompts[0]?.trim()).toBe("cho mấy ô này thành phần trăm");
    adapter.release?.();
    await spoken;
  });
});