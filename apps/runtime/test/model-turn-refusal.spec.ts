import { describe, expect, it } from "vitest";

import { type ConversationId, type DataClass, type Principal, ContractViolation } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief, type WorkerEvent, type WorkerSessionHandle } from "@clarkcant/pi-adapter";

import { createModelTurn } from "../src/model-turn.ts";

/**
 * A turn the provider refused, told the way a person can act on — and answered on another model when one is usable.
 *
 * Pi settles a refused turn as it settles an answer and reports the refusal as an error event. The runtime must name the
 * model that actually ran, carry the provider's reason, and either answer on a fallback (saying so on the reply) or, when
 * nothing else can answer, say that the message is kept and what to do next.
 */
class RefusingAdapter extends FakePiAdapter {
  readonly #listeners = new Map<string, ((event: WorkerEvent) => void)[]>();
  readonly #models = new Map<string, string>();
  /** The models whose provider refuses every turn, by `provider/id`, with what it says. */
  readonly refusing = new Map<string, string>();
  /** Every model a turn was prompted on, in order. */
  readonly prompted: string[] = [];

  override async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    const handle = await super.createWorkerSession(brief);
    this.#models.set(handle.sessionId, brief.model === undefined ? "" : `${brief.model.provider}/${brief.model.id}`);
    return handle;
  }

  override subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    this.#listeners.set(sessionId, [...(this.#listeners.get(sessionId) ?? []), listener]);
    return super.subscribe(sessionId, listener);
  }

  override async prompt(sessionId: string, text: string): Promise<void> {
    const model = this.#models.get(sessionId) ?? "";
    this.prompted.push(model);
    const refusal = this.refusing.get(model);
    if (refusal === undefined) return await super.prompt(sessionId, text);
    // Settled with nothing written, as Pi does after a refusal; the refusal arrives as an event.
    for (const listener of this.#listeners.get(sessionId) ?? []) listener({ type: "error", sessionId, message: refusal });
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

async function build(options: {
  env?: NodeJS.ProcessEnv;
  language?: "vi" | "en";
  fallbacks?: readonly { provider: string; id: string }[];
  chooseAfterBoot?: boolean;
  allowed?: (model: { provider: string; id: string }) => readonly DataClass[];
}) {
  const adapter = new RefusingAdapter({ script: ["ok"] });
  let preferred: typeof CHOSEN | undefined = options.chooseAfterBoot === true ? undefined : CHOSEN;
  const turn = await createModelTurn({
    env: options.env ?? BOOT,
    cwd: process.cwd(),
    adapter,
    model: () => preferred,
    ...(options.fallbacks === undefined ? {} : { fallbackModels: async () => options.fallbacks ?? [] }),
    ...(options.language === undefined ? {} : { language: () => options.language ?? "en" }),
    ...(options.allowed === undefined ? {} : { allowedDataClasses: options.allowed }),
  });
  if (turn === undefined) throw new Error("the model turn was not built");
  // Chosen after the node started: what the person sees must follow the choice, not the boot configuration.
  preferred = CHOSEN;
  const ask = async (text = "xin chào") =>
    await turn.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text, messageId: `msg_${text}` });
  const failure = async (): Promise<string> =>
    await ask().then(
      () => {
        throw new Error("a refused turn was reported as an answer");
      },
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
  return { adapter, ask, failure };
}

describe("a turn the provider refused", () => {
  it("names the model that ran and carries the provider's reason when nothing else can answer", async () => {
    // The environment names the same model, so there is nowhere to fall back to.
    const { adapter, failure } = await build({
      env: { CC_MODEL_PROVIDER: "anthropic", CC_MODEL_ID: "claude-opus-5-5" },
      chooseAfterBoot: true,
    });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    const message = await failure();

    expect(message).toContain("anthropic/claude-opus-5-5 could not answer this message");
    expect(message).toContain("version 2.1.280 or newer is required");
    // What was preserved and what happens next.
    expect(message).toContain("Your message is saved");
    expect(message).toContain("choose another model in Settings");
  });

  it("says it in the person's language", async () => {
    const { adapter, failure } = await build({
      env: { CC_MODEL_PROVIDER: "anthropic", CC_MODEL_ID: "claude-opus-5-5" },
      language: "vi",
    });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    const message = await failure();

    expect(message).toContain("anthropic/claude-opus-5-5 không trả lời được tin nhắn này");
    expect(message).toContain("Tin nhắn của bạn đã được lưu");
  });
});

describe("falling back when the chosen model refuses", () => {
  it("answers the same message on the environment's model and says so on the reply", async () => {
    const { adapter, ask } = await build({ chooseAfterBoot: true });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    const reply = await ask();

    expect(reply.text).toBe("ok");
    expect(`${reply.provider}/${reply.model}`).toBe("deepseek/deepseek-v4-flash");
    expect(reply.fallback).toEqual({ from: "anthropic/claude-opus-5-5", reason: REFUSAL });
    expect(adapter.prompted).toEqual(["anthropic/claude-opus-5-5", "deepseek/deepseek-v4-flash"]);
  });

  it("prefers the pool's fallbacks, best first, over the environment's model", async () => {
    const { adapter, ask } = await build({ fallbacks: [{ provider: "openai", id: "gpt-6" }] });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    const reply = await ask();

    expect(`${reply.provider}/${reply.model}`).toBe("openai/gpt-6");
    expect(reply.fallback?.from).toBe("anthropic/claude-opus-5-5");
  });

  it("passes over a model that just refused instead of asking it again on every message", async () => {
    const { adapter, ask } = await build({});
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    await ask("first");
    const second = await ask("second");

    expect(adapter.prompted).toEqual([
      "anthropic/claude-opus-5-5",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-flash",
    ]);
    // Still said: the person's choice is not what answered.
    expect(second.fallback?.from).toBe("anthropic/claude-opus-5-5");
  });

  it("names every model it tried when none could answer", async () => {
    const { adapter, failure } = await build({ fallbacks: [{ provider: "openai", id: "gpt-6" }] });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    adapter.refusing.set("openai/gpt-6", "quota exceeded (HTTP 429)");
    adapter.refusing.set("deepseek/deepseek-v4-flash", "insufficient balance (HTTP 402)");
    const message = await failure();

    expect(message).toContain("No model could answer this message");
    expect(message).toContain(`anthropic/claude-opus-5-5: ${REFUSAL}`);
    expect(message).toContain("openai/gpt-6: quota exceeded (HTTP 429)");
    expect(message).toContain("deepseek/deepseek-v4-flash: insufficient balance (HTTP 402)");
    expect(message).toContain("Your message is saved");
  });
});

describe("falling back to a model that may not receive the message", () => {
  it("does not send it there, and says both why the chosen model did not answer and why the fallback was not sent it", async () => {
    const { adapter, ask } = await build({
      fallbacks: [{ provider: "openai", id: "gpt-6" }],
      // The fallback may not receive confidential data, and the message carries an email address.
      allowed: (model) => (model.provider === "openai" ? ["public", "internal"] : ["public", "internal", "confidential"]),
    });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    const cause = await ask("gửi báo cáo cho duy@example.com").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(cause).toBeInstanceOf(ContractViolation);
    const contract = (cause as ContractViolation).contract;
    expect(contract.code).toBe("MODEL_DATA_CLASS_UNAVAILABLE");
    expect(contract.detail).toMatchObject({ dataClass: "confidential", model: "openai/gpt-6", sent: false });
    expect((cause as Error).message).toContain("The chosen model did not answer");
    expect((cause as Error).message).toContain(REFUSAL);
    expect((cause as Error).message).toContain("openai/gpt-6 may not receive confidential data");
    // Only the chosen model was prompted; the fallback never was, and nothing fell further past the boundary.
    expect(adapter.prompted).toEqual(["anthropic/claude-opus-5-5"]);
  });

  it("answers an ordinary message on a fallback whose list names only public data", async () => {
    const { adapter, ask } = await build({
      fallbacks: [{ provider: "openai", id: "gpt-6" }],
      // Routing would pass this model over for internal work; the send boundary holds back only confidential and secret.
      allowed: (model) => (model.provider === "openai" ? ["public"] : ["public", "internal", "confidential"]),
    });
    adapter.refusing.set("anthropic/claude-opus-5-5", REFUSAL);
    const reply = await ask();
    expect(reply.fallback?.from).toBe("anthropic/claude-opus-5-5");
    expect(adapter.prompted).toEqual(["anthropic/claude-opus-5-5", "openai/gpt-6"]);
  });
});
