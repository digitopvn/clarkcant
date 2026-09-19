import { describe, expect, it } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";

import { createModelTurn } from "../src/model-turn.ts";

/**
 * A session is dropped when a turn fails, because a session that failed a turn is the thing that is broken.
 * What must not be dropped is the thread, so a session created afterwards is briefed on the conversation
 * instead of waking up amnesiac - which, from the outside, is a person being told about work they already
 * watched happen.
 */
class RecordingAdapter extends FakePiAdapter {
  readonly prompts: string[] = [];
  failNext = false;

  override async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("the provider went away");
    }
    await super.prompt(sessionId, text);
  }
}

const PRINCIPAL: Principal = {
  principalId: "p_owner" as Principal["principalId"],
  kind: "user",
  nodeId: "n1" as Principal["nodeId"],
};
const CONVERSATION = "c1" as ConversationId;
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

const history = async (): Promise<readonly { role: "user" | "assistant"; text: string }[]> => [
  { role: "user", text: "cho tui chạy git log" },
  { role: "assistant", text: "Lệnh đã được duyệt và đã chạy xong." },
];

describe("a session created for a conversation that already has one", () => {
  it("is briefed once, on the turn that opens it", async () => {
    const adapter = new RecordingAdapter({ script: ["Câu trả lời một.", "Câu trả lời hai."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, history });
    expect(turn).toBeDefined();

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "tiếp đi", messageId: "msg_1" });
    expect(adapter.prompts[0]).toContain("Mạch hội thoại trước đó");
    expect(adapter.prompts[0]).toContain("git log");
    expect(adapter.prompts[0]).toContain("tiếp đi");

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "còn gì nữa", messageId: "msg_2" });
    // The second turn already has the first in its context, and a brief repeated every turn would push the
    // conversation out with its own summary.
    expect(adapter.prompts[1]).not.toContain("Mạch hội thoại trước đó");
    expect(adapter.prompts[1]).toContain("còn gì nữa");
  });

  it("carries the turn's own instruction after the brief, not instead of it", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, history });

    await turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "tóm tắt giúp",
      messageId: "msg_1",
      note: "Trả lời thật ngắn.",
    });

    const prompt = adapter.prompts[0] ?? "";
    expect(prompt).toContain("Mạch hội thoại trước đó");
    expect(prompt).toContain("Trả lời thật ngắn.");
    // The brief is the context the instruction is read in, so it comes first.
    expect(prompt.indexOf("Mạch hội thoại trước đó")).toBeLessThan(prompt.indexOf("Trả lời thật ngắn."));
  });

  it("briefs the session that replaces one a failed turn dropped", async () => {
    const adapter = new RecordingAdapter({ script: ["Câu trả lời một.", "Câu trả lời sau khi hỏng."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, history });

    adapter.failNext = true;
    await expect(
      turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "câu hỏi hỏng", messageId: "msg_1" }),
    ).rejects.toThrow();

    // The session that failed is gone; the message after it must still know what the conversation was about.
    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "thử lại", messageId: "msg_2" });
    expect(adapter.prompts[1]).toContain("Mạch hội thoại trước đó");
  });

  it("says nothing when the node has no transcript to offer", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "xin chào", messageId: "msg_1" });
    expect(adapter.prompts[0]).not.toContain("Mạch hội thoại");
    expect(adapter.prompts[0]).toContain("xin chào");
  });
});
