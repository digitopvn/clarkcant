import { describe, expect, it } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerEvent } from "@clarkcant/pi-adapter";

import { createModelTurn } from "../src/model-turn.ts";

/**
 * A turn the provider refused, told the way a person can act on.
 *
 * Pi settles a refused turn as it settles an answer and reports the refusal as an error event. The reply must carry
 * that refusal and name the model that actually ran — not the model the node booted with — and say the message is kept
 * and what to do next.
 */
class RefusingAdapter extends FakePiAdapter {
  readonly #listeners = new Map<string, ((event: WorkerEvent) => void)[]>();
  refusal: string | undefined;

  override subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    this.#listeners.set(sessionId, [...(this.#listeners.get(sessionId) ?? []), listener]);
    return super.subscribe(sessionId, listener);
  }

  override async prompt(sessionId: string, text: string): Promise<void> {
    if (this.refusal === undefined) return await super.prompt(sessionId, text);
    // Settled with nothing written, as Pi does after a refusal; the refusal arrives as an event.
    for (const listener of this.#listeners.get(sessionId) ?? []) {
      listener({ type: "error", sessionId, message: this.refusal });
    }
  }
}

const PRINCIPAL: Principal = {
  principalId: "p_owner" as Principal["principalId"],
  kind: "user",
  nodeId: "n1" as Principal["nodeId"],
};
const CONVERSATION = "c1" as ConversationId;
const BOOT = { CC_MODEL_PROVIDER: "deepseek", CC_MODEL_ID: "deepseek-v4-flash" } satisfies NodeJS.ProcessEnv;
const CHOSEN = { provider: "anthropic", id: "claude-opus-5-5" };
const REFUSAL = "the model's provider refused the turn: version 2.1.280 or newer is required (HTTP 400)";

async function refusedReply(options: { language?: "vi" | "en"; chooseAfterBoot: boolean }): Promise<string> {
  const adapter = new RefusingAdapter({ script: ["ok"] });
  let preferred: typeof CHOSEN | undefined = options.chooseAfterBoot ? undefined : CHOSEN;
  const turn = await createModelTurn({
    env: BOOT,
    cwd: process.cwd(),
    adapter,
    model: () => preferred,
    ...(options.language === undefined ? {} : { language: () => options.language ?? "en" }),
  });
  if (turn === undefined) throw new Error("the model turn was not built");
  // Chosen after the node started: what the person sees must follow the choice, not the boot configuration.
  preferred = CHOSEN;
  adapter.refusal = REFUSAL;
  const failed = await turn
    .answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "xin chào", messageId: "msg_1" })
    .then(
      () => undefined,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
  if (failed === undefined) throw new Error("a refused turn was reported as an answer");
  return failed;
}

describe("a turn the provider refused", () => {
  it("names the model that ran and carries the provider's reason, not the boot model and an empty reply", async () => {
    const message = await refusedReply({ chooseAfterBoot: true });

    expect(message).toContain("anthropic/claude-opus-5-5");
    expect(message).not.toContain("deepseek");
    expect(message).toContain("version 2.1.280 or newer is required");
    expect(message).not.toContain("without producing any text");
    // What was preserved and what happens next.
    expect(message).toContain("Your message is saved");
    expect(message).toContain("choose another model in Settings");
  });

  it("says it in the person's language", async () => {
    const message = await refusedReply({ language: "vi", chooseAfterBoot: false });

    expect(message).toContain("anthropic/claude-opus-5-5 không trả lời được tin nhắn này");
    expect(message).toContain("Tin nhắn của bạn đã được lưu");
  });
});
