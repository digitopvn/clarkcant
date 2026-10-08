import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";

import { attachmentRefsForLastUserMessage, attachmentRefsForMessage } from "../src/attachments.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { createModelTurn } from "../src/model-turn.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A message with files on the plain and streaming message routes: while a turn is answering, and when its words are a
 * command the host answers.
 *
 * The decider is a model call, so it is replaced here by one whose answer each test sets: what is under test is what the
 * route does with the message's files for each answer, not what the decider would choose.
 */
const decision: { action: "steer" | "interrupt" | "background" } = { action: "steer" };
vi.mock("../src/jev-decider.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jev-decider.ts")>()),
  decideTurnAction: async () => ({ status: "decided", action: decision.action, confidence: 0.9, model: "test-decider" }),
}));

const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const AT = "2026-10-07T08:00:00.000Z";
const FILE_TEXT = "Nội dung chỉ tệp này mang theo.";

let dir: string;
let services: NodeServices;

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A node whose model turn runs on the fake adapter, wired the way the node wires it. */
async function node(script: readonly string[]) {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-route-attachments-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  const deps: GatewayDeps = { services, now: () => AT, newConversationId: () => "conv_route_attachments" };
  const adapter = new FakePiAdapter({ script: [...script] });
  const turn = await createModelTurn({
    env: ENV,
    cwd: process.cwd(),
    adapter,
    model: () => ({ provider: "fake", id: "fake-model" }),
    attachments: {
      dataDir: dir,
      refsFor: (id, messageId) =>
        messageId === undefined
          ? attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId: id })
          : attachmentRefsForMessage({ db: services.runtime.db, conversationId: id, messageId }),
    },
  });
  if (turn === undefined) throw new Error("the model turn was not built");
  services.conductor.respondWithModel = (input) => turn.answer(input);
  const steered = vi.fn((conversationId: string, text: string, origin?: Parameters<typeof turn.steer>[2]) =>
    turn.steer(conversationId, text, origin),
  );
  const interrupted = vi.fn((conversationId: string) => turn.interrupt(conversationId));
  const backgrounded = vi.fn((input: Parameters<typeof turn.runInBackground>[0]) => turn.runInBackground(input));
  services.turnControl = {
    running: () => turn.running(),
    answering: () => turn.answering(),
    interrupt: interrupted,
    steer: steered,
    runInBackground: backgrounded,
    runningMs: (conversationId) => turn.runningMs(conversationId),
  };
  const call = (method: string, path: string, body?: unknown) =>
    handleRequest(deps, {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  const created = await call("POST", "/conversations", { title: "tệp đính kèm" });
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const upload = async (): Promise<string> => {
    const uploaded = await call("POST", "/attachments", {
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: Buffer.from(`# Ghi chú\n${FILE_TEXT}\n`).toString("base64"),
    });
    expect(uploaded.status).toBe(201);
    return (uploaded.body as { attachmentRef: { attachmentId: string } }).attachmentRef.attachmentId;
  };
  const send = (body: Record<string, unknown>) => call("POST", `/conversations/${conversationId}/messages`, body);
  /** The streaming route the composer uses: its status, and the frames it sends when it streams. */
  const sendStreamed = async (body: Record<string, unknown>) => {
    const response = await call("POST", `/conversations/${conversationId}/messages/stream`, body);
    const chunks: string[] = [];
    await response.stream?.run((chunk) => chunks.push(chunk));
    const frames = chunks.map((chunk) => {
      const lines = chunk.split("\n");
      const event = (lines.find((line) => line.startsWith("event: ")) ?? "event: unknown").slice(7).trim();
      const data = (lines.find((line) => line.startsWith("data: ")) ?? "data: {}").slice(6);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
    return {
      status: response.status,
      body: response.body,
      deltas: frames.filter((frame) => frame.event === "delta").map((frame) => frame.data.text),
      done: frames.find((frame) => frame.event === "done")?.data,
    };
  };
  const storedFiles = () =>
    attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId }).map((ref) => ref.attachmentId);
  return { adapter, turn, steered, interrupted, backgrounded, conversationId, upload, send, sendStreamed, storedFiles };
}

describe("a message's files on the plain route while a turn is answering", () => {
  /** A node with a first typed turn held answering until `open` is called. */
  async function start(action: (typeof decision)["action"]) {
    decision.action = action;
    const built = await node(["câu trả lời đầu", "câu trả lời cho tin có tệp"]);
    let open: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const run = built.adapter.run.bind(built.adapter);
    vi.spyOn(built.adapter, "run").mockImplementationOnce(async (sessionId, text) => {
      await held;
      return await run(sessionId, text);
    });
    const principal: Principal = {
      principalId: services.runtime.identity.ownerPrincipalId,
      kind: "user",
      nodeId: services.runtime.identity.nodeId,
    };
    // A typed turn of the same origin as the plain route's message, which would take a steer of bare words.
    const first = built.turn.answer({
      conversationId: built.conversationId as ConversationId,
      principal,
      text: "kể cho tôi nghe",
      messageId: "msg_first",
      origin: "cli-api",
    });
    await vi.waitFor(() => expect(built.turn.answering()).toEqual([built.conversationId]));
    return { ...built, first, open: () => open() };
  }

  it("refuses an attachment list that is not a list without joining the running turn", async () => {
    const { steered, interrupted, turn, conversationId, send, first, open } = await start("steer");
    const sent = await send({ text: "thêm nữa", attachmentIds: "tep" });
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    expect(steered).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);
    open();
    expect((await first).stopped).toBeUndefined();
  });

  it("refuses a file that is not available without cutting off the running answer", async () => {
    const { interrupted, turn, conversationId, send, first, open } = await start("interrupt");
    const sent = await send({ text: "làm cái này thay đi", attachmentIds: ["att_khong_co"] });
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);
    open();
    expect((await first).stopped).toBeUndefined();
  });

  it("answers a message with files in a turn of its own instead of sending it to the background", async () => {
    const { adapter, backgrounded, interrupted, turn, conversationId, upload, send, storedFiles, first, open } =
      await start("background");
    const file = await upload();

    const typed = send({ text: "xem tệp này", attachmentIds: [file] });
    // Stored with its file once the route has decided, which is before it waits for the running turn.
    await vi.waitFor(() => expect(storedFiles()).toEqual([file]));
    // Not run beside the turn without its file, and not put in the running turn's place.
    expect(backgrounded).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);

    open();
    expect((await first).stopped).toBeUndefined();
    const answered = await typed;
    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.body)).toContain("câu trả lời cho tin có tệp");
    // The turn it waited for reads the file.
    const prompt = adapter.allPrompts().find((text) => text.includes("xem tệp này")) ?? "";
    expect(prompt).toContain(FILE_TEXT);
  });

  it.each(["plain", "streaming"] as const)(
    "stops the running turn at once for a typed stop sent with files on the %s route",
    async (route) => {
      const { adapter, send, sendStreamed, upload, storedFiles, first, open } = await start("steer");
      const file = await upload();
      const body = { text: "dừng lại", attachmentIds: [file] };
      let ended = false;
      void first.finally(() => {
        ended = true;
      });
      const sending = route === "plain" ? send(body) : sendStreamed(body);
      try {
        // The running turn ends because it was stopped, not because it was let go.
        await vi.waitFor(() => expect(ended).toBe(true));
      } finally {
        open();
      }
      expect((await first).stopped).toBeDefined();
      // Answered by the host as the stop it is, not held as a turn behind the one it stopped.
      const sent = await sending;
      expect(sent.status).toBe(200);
      const decision = route === "plain" ? sent.body : (sent as { done?: unknown }).done;
      expect(decision).toMatchObject({ appIntent: { kind: "intent", intent: { kind: "turn.stop" } } });
      // No turn follows the stop, and the files are attached to no message.
      expect(adapter.allPrompts().some((prompt) => prompt.includes("dừng lại"))).toBe(false);
      expect(storedFiles()).toEqual([]);
    },
  );

  it.each(["plain", "streaming"] as const)(
    "keeps a host command the host turns down, sent with files, as its refusal on the %s route",
    async (route) => {
      const { adapter, interrupted, turn, conversationId, send, sendStreamed, upload, storedFiles, first, open } =
        await start("interrupt");
      const file = await upload();
      const body = { text: "xoá hội thoại này", attachmentIds: [file] };
      let answered = false;
      const sending = route === "plain" ? send(body) : sendStreamed(body);
      void sending.finally(() => {
        answered = true;
      });
      try {
        // Answered at once: a delete while a reply is running is refused by the host, never decided as a turn.
        await vi.waitFor(() => expect(answered).toBe(true));
      } finally {
        open();
      }
      const sent = await sending;
      expect(sent.status).toBe(200);
      const decided = route === "plain" ? sent.body : (sent as { done?: unknown }).done;
      expect(decided).toMatchObject({ appIntent: { kind: "refused" } });
      expect(interrupted).not.toHaveBeenCalled();
      expect((await first).stopped).toBeUndefined();
      expect(adapter.allPrompts().some((prompt) => prompt.includes("xoá hội thoại này"))).toBe(false);
      expect(storedFiles()).toEqual([]);
      expect(turn.answering()).not.toContain(conversationId);
    },
  );

  it("still sends bare words the decider chose for the background to the background", async () => {
    const { backgrounded, interrupted, turn, conversationId, send, first, open } = await start("background");
    const sent = await send({ text: "tra giúp thời tiết mai" });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ accepted: true, resolution: "background" });
    expect(backgrounded).toHaveBeenCalledTimes(1);
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);
    open();
    expect((await first).stopped).toBeUndefined();
    await vi.waitFor(() => expect(backgrounded.mock.results[0]?.value).toBeDefined());
    await backgrounded.mock.results[0]?.value.catch(() => undefined);
  });
});

describe("a message with files whose words the host would answer", () => {
  it("answers /background with files as a turn that reads them, not as a background run without them", async () => {
    const { adapter, backgrounded, upload, send, storedFiles } = await node(["đã đọc tệp"]);
    const file = await upload();
    const sent = await send({ text: "/background tóm tắt tệp này", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ resolution: "model" });
    expect(backgrounded).not.toHaveBeenCalled();
    expect(storedFiles()).toEqual([file]);
    expect(adapter.allPrompts().join("\n")).toContain(FILE_TEXT);
  });

  it("answers a typed app command sent with files as the host command it is", async () => {
    const { adapter, upload, send, storedFiles } = await node(["không dùng tới"]);
    const file = await upload();
    const sent = await send({ text: "mở settings", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ accepted: true, appIntent: { kind: "intent", intent: { kind: "settings.open" } } });
    expect(adapter.allPrompts()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("answers a slash command other than /background sent with files as the host command it is", async () => {
    const { adapter, upload, send, storedFiles } = await node(["không dùng tới"]);
    const file = await upload();
    const sent = await send({ text: "/thinking", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ accepted: true, messageId: expect.any(String) });
    expect(sent.body).not.toHaveProperty("resolution");
    expect(adapter.allPrompts()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("answers a command-shaped sentence the host cannot place, sent with files, as a turn that reads them", async () => {
    const { adapter, upload, send, storedFiles } = await node(["đã đọc tệp"]);
    const file = await upload();
    const sent = await send({ text: "chuyển sang tiếng Anh", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ resolution: "model" });
    expect(storedFiles()).toEqual([file]);
    expect(adapter.allPrompts().join("\n")).toContain(FILE_TEXT);
  });

  it("refuses a slash command or app command naming a file that is not available", async () => {
    const { backgrounded, send } = await node(["không dùng tới"]);
    for (const text of ["/background tóm tắt tệp này", "mở settings"]) {
      const sent = await send({ text, attachmentIds: ["att_khong_co"] });
      expect(sent.status, text).toBe(400);
      expect(sent.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    }
    expect(backgrounded).not.toHaveBeenCalled();
  });
});

describe("a bare /background sent with files", () => {
  it.each(["plain", "streaming"] as const)("is answered with its usage hint on the %s route", async (route) => {
    const { adapter, backgrounded, upload, send, sendStreamed, storedFiles } = await node(["không dùng tới"]);
    const file = await upload();
    const body = { text: "/background", attachmentIds: [file] };
    const sent = route === "plain" ? await send(body) : await sendStreamed(body);
    expect(sent.status).toBe(200);
    if (route === "plain") {
      expect(sent.body).toMatchObject({ accepted: true, messageId: expect.any(String) });
      expect(sent.body).not.toHaveProperty("resolution");
    } else {
      expect((sent as { done?: unknown }).done).toMatchObject({ resolution: "app-intent" });
      expect((sent as { deltas: unknown[] }).deltas).toEqual([expect.stringContaining("/background")]);
    }
    expect(backgrounded).not.toHaveBeenCalled();
    expect(adapter.allPrompts()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });
});

describe("a message with files on the streaming route the composer uses", () => {
  it("answers /background with files as a turn that reads them, not as a background run without them", async () => {
    const { adapter, backgrounded, upload, sendStreamed, storedFiles } = await node(["đã đọc tệp"]);
    const file = await upload();
    const sent = await sendStreamed({ text: "/background tóm tắt tệp này", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.done).toMatchObject({ resolution: "model" });
    expect(backgrounded).not.toHaveBeenCalled();
    expect(storedFiles()).toEqual([file]);
    expect(adapter.allPrompts().join("\n")).toContain(FILE_TEXT);
  });

  it("answers a typed app command sent with files as the host command it is", async () => {
    const { adapter, upload, sendStreamed, storedFiles } = await node(["không dùng tới"]);
    const file = await upload();
    const sent = await sendStreamed({ text: "mở settings", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.done).toMatchObject({ resolution: "app-intent", appIntent: { kind: "intent", intent: { kind: "settings.open" } } });
    expect(adapter.allPrompts()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("answers a slash command other than /background sent with files as the host command it is", async () => {
    const { adapter, upload, sendStreamed, storedFiles } = await node(["không dùng tới"]);
    const file = await upload();
    const sent = await sendStreamed({ text: "/thinking", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.done).toMatchObject({ resolution: "app-intent", messageIds: [expect.any(String)] });
    expect(adapter.allPrompts()).toEqual([]);
    expect(storedFiles()).toEqual([]);
  });

  it("answers a command-shaped sentence the host cannot place, sent with files, as a turn that reads them", async () => {
    const { adapter, upload, sendStreamed, storedFiles } = await node(["đã đọc tệp"]);
    const file = await upload();
    const sent = await sendStreamed({ text: "chuyển sang tiếng Anh", attachmentIds: [file] });
    expect(sent.status).toBe(200);
    expect(sent.done).toMatchObject({ resolution: "model" });
    expect(storedFiles()).toEqual([file]);
    expect(adapter.allPrompts().join("\n")).toContain(FILE_TEXT);
  });

  it("still answers a command-shaped sentence the host cannot place, without files, as not understood", async () => {
    const { adapter, sendStreamed } = await node(["không dùng tới"]);
    const sent = await sendStreamed({ text: "chuyển sang tiếng Anh" });
    expect(sent.done).toMatchObject({ resolution: "app-intent", appIntent: { kind: "refused" } });
    expect(adapter.allPrompts()).toEqual([]);
  });

  it("refuses a slash command or app command naming a file that is not available", async () => {
    const { backgrounded, sendStreamed } = await node(["không dùng tới"]);
    for (const text of ["/background tóm tắt tệp này", "mở settings"]) {
      const sent = await sendStreamed({ text, attachmentIds: ["att_khong_co"] });
      expect(sent.status, text).toBe(400);
      expect(sent.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    }
    expect(backgrounded).not.toHaveBeenCalled();
  });

  it("still answers a slash command or app command without files as the host", async () => {
    const { adapter, sendStreamed } = await node(["không dùng tới"]);
    const slash = await sendStreamed({ text: "/thinking" });
    expect(slash.done).toMatchObject({ resolution: "app-intent", messageIds: [expect.any(String)] });
    expect(slash.deltas).toEqual([expect.stringMatching(/\S/)]);
    const intent = await sendStreamed({ text: "mở settings" });
    expect(intent.done).toMatchObject({
      resolution: "app-intent",
      messageIds: [expect.any(String)],
      appIntent: { kind: "intent", intent: { kind: "settings.open" } },
    });
    expect(intent.deltas).toEqual([expect.stringMatching(/\S/)]);
    expect(adapter.allPrompts()).toEqual([]);
  });
});