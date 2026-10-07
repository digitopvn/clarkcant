import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";

import { attachmentRefsForLastUserMessage } from "../src/attachments.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { createModelTurn } from "../src/model-turn.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A message with files, sent on the plain route while a turn is answering.
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

describe("a message's files on the plain route while a turn is answering", () => {
  let dir: string;
  let services: NodeServices;

  afterEach(() => {
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A node whose model turn runs on the fake adapter, with a first turn held answering until `open` is called. */
  async function start(action: (typeof decision)["action"]) {
    decision.action = action;
    dir = mkdtempSync(join(tmpdir(), "clarkcant-route-attachments-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
    const deps: GatewayDeps = { services, now: () => AT, newConversationId: () => "conv_route_attachments" };
    const adapter = new FakePiAdapter({ script: ["câu trả lời đầu", "câu trả lời cho tin có tệp"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => ({ provider: "fake", id: "fake-model" }) });
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

    let open: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const run = adapter.run.bind(adapter);
    vi.spyOn(adapter, "run").mockImplementationOnce(async (sessionId, text) => {
      await held;
      return await run(sessionId, text);
    });
    const principal: Principal = {
      principalId: services.runtime.identity.ownerPrincipalId,
      kind: "user",
      nodeId: services.runtime.identity.nodeId,
    };
    // A typed turn of the same origin as the plain route's message, which would take a steer of bare words.
    const first = turn.answer({
      conversationId: conversationId as ConversationId,
      principal,
      text: "kể cho tôi nghe",
      messageId: "msg_first",
      origin: "cli-api",
    });
    await vi.waitFor(() => expect(turn.answering()).toEqual([conversationId]));
    return { steered, interrupted, backgrounded, turn, call, conversationId, first, open: () => open() };
  }

  it("refuses an attachment list that is not a list without joining the running turn", async () => {
    const { steered, interrupted, turn, call, conversationId, first, open } = await start("steer");
    const sent = await call("POST", `/conversations/${conversationId}/messages`, { text: "thêm nữa", attachmentIds: "tep" });
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    expect(steered).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);
    open();
    expect((await first).stopped).toBeUndefined();
  });

  it("refuses a file that is not available without cutting off the running answer", async () => {
    const { interrupted, turn, call, conversationId, first, open } = await start("interrupt");
    const sent = await call("POST", `/conversations/${conversationId}/messages`, {
      text: "làm cái này thay đi",
      attachmentIds: ["att_khong_co"],
    });
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "ATTACHMENT_NOT_AVAILABLE" });
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);
    open();
    expect((await first).stopped).toBeUndefined();
  });

  it("answers a message with files in a turn of its own instead of sending it to the background", async () => {
    const { backgrounded, interrupted, turn, call, conversationId, first, open } = await start("background");
    const uploaded = await call("POST", "/attachments", {
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: Buffer.from("# Ghi chú\n").toString("base64"),
    });
    expect(uploaded.status).toBe(201);
    const { attachmentRef } = uploaded.body as { attachmentRef: { attachmentId: string } };

    const typed = call("POST", `/conversations/${conversationId}/messages`, {
      text: "xem tệp này",
      attachmentIds: [attachmentRef.attachmentId],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not run beside the turn without its file, and not put in the running turn's place.
    expect(backgrounded).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);

    open();
    expect((await first).stopped).toBeUndefined();
    const answered = await typed;
    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.body)).toContain("câu trả lời cho tin có tệp");
    // Stored as a message of its own, with the file it was sent with.
    const stored = attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId });
    expect(stored.map((ref) => ref.attachmentId)).toEqual([attachmentRef.attachmentId]);
  });
});
