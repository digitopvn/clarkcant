import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ConversationId,
  type DataClass,
  type Principal,
  ContractViolation,
  DEFAULT_ALLOWED_DATA_CLASSES,
  MODEL_DATA_CLASS_UNAVAILABLE,
} from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";

import type { ContextSource } from "../src/context-bundle.ts";
import { type HistoryMessage, createModelTurn } from "../src/model-turn.ts";

/**
 * A model's data-class ceiling is a limit on what is sent to it, not a routing preference.
 *
 * What has to hold: whichever path chose the model — the person's choice, a handoff to a new one, a rebuilt session, a
 * fallback after a provider refusal, a background route or its fallback — a request carrying a class that model may not
 * receive is not sent; the outcome is typed `MODEL_DATA_CLASS_UNAVAILABLE` and says nothing was sent; the person's
 * choice of model is left as it was; and what is said about it names the class and the model, never the text.
 */

const OWNER: Principal = { principalId: "p_owner" as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };
const CONVERSATION = "c1" as ConversationId;
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const EVERY: readonly DataClass[] = ["public", "internal", "confidential", "secret"];
/** Assembled from parts, so a secret scanner reading this file sees no credential. */
const SECRET_VALUE = ["hunter", "22x"].join("");
const SECRET = `dùng ${["pass", "word"].join("")}: ${SECRET_VALUE} để đăng nhập`;

/** Records every brief and prompt, because a background session is disposed once it answers and the fake forgets it. */
class RecordingAdapter extends FakePiAdapter {
  readonly briefs: WorkerBrief[] = [];
  readonly prompts: string[] = [];
  /** What each tool call answered the model with. */
  readonly results: string[] = [];
  override async createWorkerSession(brief: WorkerBrief): ReturnType<FakePiAdapter["createWorkerSession"]> {
    this.briefs.push(brief);
    return await super.createWorkerSession(brief);
  }
  override async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push(text);
    await super.prompt(sessionId, text);
  }
  override async callToolResult(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): ReturnType<FakePiAdapter["callToolResult"]> {
    const result = await super.callToolResult(sessionId, toolName, params);
    this.results.push(result.text);
    return result;
  }
}

let blocked: string[] = [];

beforeEach(() => {
  blocked = [];
  const write = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.includes('"model-send-blocked"')) {
      blocked.push(chunk);
      return true;
    }
    return (write as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The typed outcome a refused send failed with, or a test failure when it did not fail that way. */
async function notSent(attempt: Promise<unknown>): Promise<ContractViolation> {
  const cause = await attempt.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(cause instanceof ContractViolation)) throw new Error(`the send was not refused as a typed outcome: ${String(cause)}`);
  expect(cause.contract.code).toBe(MODEL_DATA_CLASS_UNAVAILABLE);
  expect(cause.contract.detail).toMatchObject({ sent: false });
  return cause;
}

/** Every stderr line the boundary wrote names the class and the model and never the text. */
function expectBlockedSaid(dataClass: DataClass, model: string): void {
  expect(blocked.length).toBeGreaterThan(0);
  for (const line of blocked) {
    expect(line).not.toContain(SECRET_VALUE);
    expect(line).not.toContain("duy@example.com");
  }
  expect(blocked.some((line) => line.includes(`"dataClass":"${dataClass}"`) && line.includes(`"model":"${model}"`))).toBe(true);
}

describe("a conversation's turn", () => {
  it("is not sent when the message carries a class the chosen model may not receive, and keeps the choice", async () => {
    const adapter = new RecordingAdapter({ script: ["ok", "ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, language: () => "en" });
    const ask = (text: string, id: string) => turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text, messageId: id });

    const cause = await notSent(ask(SECRET, "m1"));
    expect(cause.contract.detail).toMatchObject({ dataClass: "secret", model: "test-provider/test-model" });
    expect(cause.message).toContain("carries secret data");
    expect(cause.message).toContain("nothing was sent to the model");
    expect(cause.message).toContain("Your message is saved and your choice of model is unchanged");
    expect(cause.message).toContain("Settings → AI & Routing");
    expect(cause.message).not.toContain(SECRET_VALUE);
    expect(adapter.prompts).toEqual([]);
    expectBlockedSaid("secret", "test-provider/test-model");

    // The choice is unchanged, and the next message goes to the same model.
    expect(turn!.configuredModel()).toMatchObject({ provider: "test-provider", id: "test-model" });
    const reply = await ask("tóm tắt cuộc họp hôm nay", "m2");
    expect(reply.model).toBe("test-model");
    expect(adapter.prompts).toHaveLength(1);
  });

  it("is said in the person's language", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, language: () => "vi" });
    const cause = await notSent(turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: SECRET, messageId: "m1" }));
    expect(cause.message).toContain("Tin nhắn này có dữ liệu mức secret");
    expect(cause.message).toContain("không có gì được gửi tới model");
    expect(cause.message).toContain("Cài đặt → AI & Định tuyến");
  });

  it("is sent to a model that may receive the class", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, allowedDataClasses: () => EVERY });
    await turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: SECRET, messageId: "m1" });
    expect(adapter.prompts[0]).toContain(SECRET_VALUE);
    expect(blocked).toEqual([]);
  });

  it("checks every class present, not only the most sensitive", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    // A list that names secret but leaves out confidential.
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      allowedDataClasses: () => ["public", "internal", "secret"],
    });
    const cause = await notSent(
      turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: `${SECRET}, gửi cho duy@example.com`, messageId: "m1" }),
    );
    expect(cause.contract.detail).toMatchObject({ dataClass: "confidential" });
    expect(adapter.prompts).toEqual([]);
  });

  it("holds when what was retrieved, or a conditional instruction, ignores the ceiling it was given", async () => {
    const sources: Array<{ name: string; extra: Partial<Parameters<typeof createModelTurn>[0]> }> = [
      { name: "memory", extra: { memoryBrief: () => `[Ghi nhớ]\n${SECRET}` } },
      {
        name: "instructions",
        extra: { instructions: () => ({ text: `[Hướng dẫn dự án]\n${SECRET}`, stated: ["rule"] }) },
      },
      {
        name: "recap",
        // The fixed recap, with the planner off, is not narrowed: the check is what holds.
        extra: { history: async () => [{ role: "user", text: SECRET }] satisfies HistoryMessage[] },
      },
    ];
    for (const { name, extra } of sources) {
      blocked = [];
      const adapter = new RecordingAdapter({ script: ["ok"] });
      const turn = await createModelTurn({ ...extra, env: ENV, cwd: process.cwd(), adapter });
      const cause = await notSent(
        turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: "tiếp tục việc hôm qua", messageId: `m-${name}` }),
      );
      expect(cause.contract.detail, name).toMatchObject({ dataClass: "secret" });
      expect(adapter.prompts, name).toEqual([]);
      expectBlockedSaid("secret", "test-provider/test-model");
    }
  });

  it("states the instructions again on the next turn when the one that carried them was not sent", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      instructions: ({ stated }) => (stated.has("rule") ? { text: "", stated: [] } : { text: "[Hướng dẫn dự án] viết ngắn gọn", stated: ["rule"] }),
    });
    await notSent(turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: SECRET, messageId: "m1" }));
    await turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: "tóm tắt cuộc họp", messageId: "m2" });
    expect(adapter.prompts[0]).toContain("viết ngắn gọn");
  });

  it("is not sent to the model a person switched to when the new session's recap carries a class it may not receive", async () => {
    let preferred = { provider: "local", id: "llama" };
    const transcript: HistoryMessage[] = [];
    const adapter = new RecordingAdapter({ script: ["ok", "ok"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      history: async () => transcript,
      allowedDataClasses: (model) => (model.provider === "local" ? EVERY : DEFAULT_ALLOWED_DATA_CLASSES),
    });
    const ask = async (text: string, id: string) => {
      const reply = await turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text, messageId: id });
      transcript.push({ role: "user", text });
      return reply;
    };
    // Sent to the model on this machine, which may receive it.
    await ask(SECRET, "m1");
    expect(adapter.prompts[0]).toContain(SECRET_VALUE);

    preferred = { provider: "cloud", id: "big" };
    const cause = await notSent(ask("tiếp tục nhé", "m2"));
    expect(cause.contract.detail).toMatchObject({ dataClass: "secret", model: "cloud/big" });
    // The handoff created the successor; nothing was prompted on it.
    expect(adapter.briefs.at(-1)?.model).toMatchObject({ provider: "cloud", id: "big" });
    expect(adapter.prompts).toHaveLength(1);
    expect(turn!.configuredModel()).toMatchObject({ provider: "cloud", id: "big" });
    expectBlockedSaid("secret", "cloud/big");
  });

  it("is not sent on a rebuilt session whose recap carries a message that was itself never sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T08:00:00Z"));
      const adapter = new RecordingAdapter({ script: ["một", "hai", "ba"] });
      vi.spyOn(adapter, "usage").mockImplementation(() => ({ turns: 1, contextTokens: 1_000_000 }));
      const transcript: HistoryMessage[] = [];
      const turn = await createModelTurn({
        env: ENV,
        cwd: process.cwd(),
        adapter,
        history: async () => transcript,
        sessionPolicy: { mode: "rebuild" },
      });
      const ask = async (text: string, id: string) => {
        // Stored before it is answered, as the conductor does: a refused message stays in the conversation.
        transcript.push({ role: "user", text });
        return await turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text, messageId: id });
      };
      await ask("cơ sở dữ liệu SQLite", "m1");
      await notSent(ask(`SQLite ${SECRET}`, "m2"));
      await ask("SQLite migrations", "m3");
      expect(adapter.prompts).toHaveLength(2);
      // Ten minutes on, about something new: a rebuild, and the fresh session's recap carries the refused message.
      vi.setSystemTime(new Date("2026-10-04T08:10:00Z"));
      const cause = await notSent(ask("thời tiết Hà Nội cuối tuần", "m4"));
      expect(cause.contract.detail).toMatchObject({ dataClass: "secret" });
      expect(adapter.briefs.length).toBeGreaterThan(1);
      expect(adapter.prompts).toHaveLength(2);
      expect(adapter.prompts.join("\n")).not.toContain(SECRET_VALUE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a sentence steered into a running turn reach a model that may not receive it", async () => {
    let started: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new RecordingAdapter({ script: [{ callTool: { name: "wait", params: {} }, reply: "ok" }] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      extraTools: () => [
        {
          name: "wait",
          label: "Wait",
          description: "wait",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            started();
            await gate;
            return { text: "xong" };
          },
        },
      ],
    });
    const answering = turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: "chờ một chút", messageId: "m1" });
    await reached;
    expect(await turn!.steer(CONVERSATION, SECRET)).toBe(false);
    expect(await turn!.steer(CONVERSATION, "thêm một ý nữa")).toBe(true);
    release();
    const reply = await answering;
    expect(reply.text).toContain("thêm một ý nữa");
    expect(reply.text).not.toContain(SECRET_VALUE);
    expectBlockedSaid("secret", "test-provider/test-model");
  });

  it("withholds a tool result the model may not receive, and keeps it in the person's transcript", async () => {
    const adapter = new RecordingAdapter({ script: [{ callTool: { name: "read_env", params: {} }, reply: "ok" }] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      extraTools: () => [
        {
          name: "read_env",
          label: "Read",
          description: "read",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ text: SECRET }),
        },
      ],
    });
    const reply = await turn!.answer({ conversationId: CONVERSATION, principal: OWNER, text: "đọc cấu hình", messageId: "m1" });
    expect(adapter.results).toHaveLength(1);
    expect(adapter.results[0]).not.toContain(SECRET_VALUE);
    expect(adapter.results[0]).toContain("carries secret data, which test-provider/test-model may not receive");
    const activity = reply.segments.flatMap((segment) =>
      segment.kind === "block" && segment.block.type === "tool-activity" ? [segment.block] : [],
    );
    expect(activity[0]?.result).toBe(SECRET);
    expectBlockedSaid("secret", "test-provider/test-model");
  });
});

describe("a background run", () => {
  const CONFIDENTIAL = "tổng hợp đơn hàng, gửi kết quả cho duy@example.com";
  const NARROW: readonly DataClass[] = ["public", "internal"];

  it("does not start when no model it could run on may receive what it carries", async () => {
    const adapter = new RecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, allowedDataClasses: () => NARROW, language: () => "en" });
    const cause = await notSent(turn!.runInBackground({ conversationId: CONVERSATION, principal: OWNER, text: CONFIDENTIAL }));
    expect(cause.contract.detail).toMatchObject({ dataClass: "confidential", model: "test-provider/test-model" });
    expect(cause.message).toContain("This background request carries confidential data");
    expect(adapter.briefs).toEqual([]);
    expect(adapter.prompts).toEqual([]);
    expectBlockedSaid("confidential", "test-provider/test-model");

    // A dispatched task's worker is refused the same way, before it is started.
    await notSent(turn!.workerModel({ dataClass: "confidential" }));
  });

  it("does not widen what the configured model may receive when routing fails", async () => {
    const adapter = new RecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      allowedDataClasses: () => NARROW,
      backgroundModel: async () => {
        throw new Error("pool unreadable");
      },
    });
    await notSent(turn!.runInBackground({ conversationId: CONVERSATION, principal: OWNER, text: CONFIDENTIAL }));
    await notSent(turn!.workerModel({ dataClass: "confidential" }));
    expect(adapter.briefs).toEqual([]);
  });

  it("runs on the routed model when it may receive the work and the configured one may not", async () => {
    const adapter = new RecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      allowedDataClasses: (model) => (model.provider === "local" ? EVERY : NARROW),
      backgroundModel: async () => ({ provider: "local", id: "llama" }),
    });
    await expect(turn!.runInBackground({ conversationId: CONVERSATION, principal: OWNER, text: CONFIDENTIAL })).resolves.toBe("xong");
    expect(adapter.briefs[0]?.model).toMatchObject({ provider: "local", id: "llama" });
    await expect(turn!.workerModel({ dataClass: "confidential" })).resolves.toMatchObject({ provider: "local", via: "routed" });
  });

  it("falls back to the configured model, with the reason, when the routed one may not receive the work", async () => {
    const adapter = new RecordingAdapter({ script: ["xong"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      allowedDataClasses: (model) => (model.provider === "cheap" ? NARROW : DEFAULT_ALLOWED_DATA_CLASSES),
      // A router that offers a model above its ceiling is caught by the check, not trusted.
      backgroundModel: async () => ({ provider: "cheap", id: "small" }),
    });
    await expect(turn!.runInBackground({ conversationId: CONVERSATION, principal: OWNER, text: CONFIDENTIAL })).resolves.toBe("xong");
    expect(adapter.briefs[0]?.model).toMatchObject({ provider: "test-provider", id: "test-model" });
    await expect(turn!.workerModel({ dataClass: "confidential" })).resolves.toMatchObject({
      provider: "test-provider",
      via: "configured",
      fallback: { reason: "data-class", dataClass: "confidential" },
    });
  });

  it("is not sent retrieved context above the ceiling, and withholds an item read above it", async () => {
    const leaky = (listing: string, item: string): ContextSource => ({
      dataClass: "internal",
      items: 1,
      // Ignores the ceiling it is given: the check is what holds.
      readerFor: () => ({ items: 1, answer: (request) => ({ kind: "done", text: (request as { item?: string }).item === undefined ? listing : item }) }),
    });
    const refused = new RecordingAdapter({ script: ["xong"] });
    const blockedRun = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter: refused,
      backgroundContext: async () => leaky(`c1 · ${SECRET}`, SECRET),
    });
    const cause = await notSent(blockedRun!.runInBackground({ conversationId: CONVERSATION, principal: OWNER, text: "tổng hợp ghi chú" }));
    expect(cause.contract.detail).toMatchObject({ dataClass: "secret" });
    expect(refused.briefs).toEqual([]);

    const adapter = new RecordingAdapter({ script: ["xong"] });
    const run = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      backgroundContext: async () => leaky("c1 · ghi chú về cấu hình", SECRET),
    });
    await run!.runInBackground({ conversationId: CONVERSATION, principal: OWNER, text: "tổng hợp ghi chú" });
    const tool = adapter.briefs[0]?.customTools?.[0];
    const read = await tool!.execute({ item: "c1" });
    expect(read.text).not.toContain(SECRET_VALUE);
    expect(read.text).toContain("carries secret data");
  });
});
