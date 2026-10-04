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
 * A message the decider would join to the running turn, which that turn will not take.
 *
 * The decider is a model call, so it is replaced here by one that always says "steer": what is under test is what the
 * plain route does when the running turn refuses the join, not what the decider would choose.
 */
vi.mock("../src/jev-decider.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jev-decider.ts")>()),
  decideTurnAction: async () => ({ status: "decided", action: "steer", confidence: 0.9, model: "test-decider" }),
}));

const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const AT = "2026-10-04T08:00:00.000Z";

describe("a steer the running turn refuses on the plain route", () => {
  let dir: string;
  let services: NodeServices;

  afterEach(() => {
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A node whose model turn runs on the fake adapter, with its first run held until `open` is called. */
  async function start() {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-refused-steer-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
    const deps: GatewayDeps = { services, now: () => AT, newConversationId: () => "conv_refused_steer" };
    const adapter = new FakePiAdapter({ script: ["câu trả lời bằng giọng nói", "câu trả lời cho tin gõ"] });
    const steered = vi.spyOn(adapter, "steer");
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => ({ provider: "fake", id: "fake-model" }) });
    if (turn === undefined) throw new Error("the model turn was not built");
    services.conductor.respondWithModel = (input) => turn.answer(input);
    const interrupted = vi.fn((conversationId: string) => turn.interrupt(conversationId));
    services.turnControl = {
      running: () => turn.running(),
      answering: () => turn.answering(),
      interrupt: interrupted,
      steer: (conversationId, text, origin) => turn.steer(conversationId, text, origin),
      runInBackground: (input) => turn.runInBackground(input),
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
    const created = await call("POST", "/conversations", { title: "đang nói" });
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // A spoken turn, held inside the session so it is answering when the typed message arrives.
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
    return { steered, turn, interrupted, call, conversationId, principal, open: () => open() };
  }

  it("waits for a turn of its own and does not cut off the spoken turn it could not join", async () => {
    const { steered, turn, interrupted, call, conversationId, principal, open } = await start();
    const spoken = turn.answer({
      conversationId: conversationId as ConversationId,
      principal,
      text: "kể cho tôi nghe",
      messageId: "msg_spoken",
      channel: "voice",
    });
    await vi.waitFor(() => expect(turn.answering()).toEqual([conversationId]));

    const typed = call("POST", `/conversations/${conversationId}/messages`, { text: "thêm chi tiết nữa" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not joined to the spoken turn, and not put in its place: the spoken turn is still answering.
    expect(steered).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);

    open();
    const reply = await spoken;
    expect(reply.stopped).toBeUndefined();
    expect(reply.text).toBe("câu trả lời bằng giọng nói");
    const answered = await typed;
    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.body)).toContain("câu trả lời cho tin gõ");
    expect(interrupted).not.toHaveBeenCalled();
  });

  it("does not join a message with attachments to the running turn, and stores it with its file", async () => {
    const { steered, turn, interrupted, call, conversationId, principal, open } = await start();
    const uploaded = await call("POST", "/attachments", {
      conversationId,
      filename: "ghi-chu.md",
      mime: "text/markdown",
      contentBase64: Buffer.from("# Ghi chú\n").toString("base64"),
    });
    expect(uploaded.status).toBe(201);
    const { attachmentRef } = uploaded.body as { attachmentRef: { attachmentId: string } };
    // A typed turn of the same origin and channel as the plain route's message, which would take a steer of bare words.
    const first = turn.answer({
      conversationId: conversationId as ConversationId,
      principal,
      text: "kể cho tôi nghe",
      messageId: "msg_first",
      origin: "cli-api",
    });
    await vi.waitFor(() => expect(turn.answering()).toEqual([conversationId]));

    const typed = call("POST", `/conversations/${conversationId}/messages`, {
      text: "xem tệp này",
      attachmentIds: [attachmentRef.attachmentId],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not joined to the running turn, and not put in its place.
    expect(steered).not.toHaveBeenCalled();
    expect(interrupted).not.toHaveBeenCalled();
    expect(turn.answering()).toEqual([conversationId]);

    open();
    expect((await first).stopped).toBeUndefined();
    const answered = await typed;
    expect(answered.status).toBe(200);
    expect(JSON.stringify(answered.body)).toContain("câu trả lời cho tin gõ");
    // Stored as a message of its own, with the file it was sent with.
    const stored = attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId });
    expect(stored.map((ref) => ref.attachmentId)).toEqual([attachmentRef.attachmentId]);
  });
});
