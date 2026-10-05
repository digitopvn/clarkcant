import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, MessageRecord, Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief, type WorkerEvent, type WorkerSessionHandle } from "@clarkcant/pi-adapter";
import { listAuditEvents } from "@clarkcant/storage";

import { carryOutSpokenStop } from "../src/application/stop-turn.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { type ModelTurn, createModelTurn } from "../src/model-turn.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Stopping the reply one conversation is writing.
 *
 * What a stop has to mean is narrow and all of it is observable: the provider is told to stop, nothing it says
 * afterwards reaches the reply, what it had already written is kept with a stopped label rather than turned into a
 * failure, and the conversation carries on with the next message. The route, the typed sentence and the audit row are
 * the same capability seen from three sides.
 */

const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const AT = "2026-09-29T08:00:00.000Z";

/**
 * A provider that writes one piece every few milliseconds until it is told to stop.
 *
 * `lateToken` is what a real provider does on the way out: a token already in flight when the abort lands. It is
 * emitted from inside `abort`, so a reply that contained it would prove the stop let one through.
 */
class SlowAdapter extends FakePiAdapter {
  readonly aborted: string[] = [];
  readonly #listeners = new Map<string, Set<(event: WorkerEvent) => void>>();
  readonly #stopped = new Set<string>();

  /** How many pieces the next reply is written in; a test shortens it to watch a reply run to its end. */
  pieces = 500;

  constructor() {
    super({ script: [] });
  }

  override subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    const release = super.subscribe(sessionId, listener);
    return () => {
      listeners.delete(listener);
      release();
    };
  }

  override async abort(sessionId: string, reason: string): Promise<void> {
    this.aborted.push(reason);
    this.#emit(sessionId, "LATE-TOKEN ");
    this.#stopped.add(sessionId);
  }

  override async prompt(sessionId: string): Promise<void> {
    for (let piece = 1; piece <= this.pieces && !this.#stopped.has(sessionId); piece += 1) {
      this.#emit(sessionId, `piece-${String(piece)} `);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  #emit(sessionId: string, delta: string): void {
    for (const listener of this.#listeners.get(sessionId) ?? []) listener({ type: "text-delta", sessionId, delta });
  }
}

const principal: Principal = {
  principalId: "p_owner" as Principal["principalId"],
  kind: "user",
  nodeId: "n1" as Principal["nodeId"],
};

async function buildTurn(adapter: FakePiAdapter): Promise<ModelTurn> {
  const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
  if (turn === undefined) throw new Error("the model turn was not built");
  return turn;
}

describe("interrupting a model turn", () => {
  it("aborts the provider and keeps what was written before the stop, labelled as stopped", async () => {
    const adapter = new SlowAdapter();
    const turn = await buildTurn(adapter);
    const seen: string[] = [];

    const answering = turn.answer({
      conversationId: "c1" as ConversationId,
      principal,
      text: "viết dài",
      messageId: "msg_1",
      onEvent: (event) => {
        if (event.type === "text-delta") seen.push(event.text);
      },
    });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3));
    expect(turn.running()).toEqual(["c1"]);

    expect(turn.interrupt("c1")).toBe(true);
    const reply = await answering;
    const seenAtStop = seen.length;

    expect(reply.stopped).toBe(true);
    expect(adapter.aborted).toHaveLength(1);
    expect(reply.text).toContain("piece-1");
    // The token that was already on its way when the stop landed is not part of the reply, and nothing was streamed
    // after it either.
    expect(reply.text).not.toContain("LATE-TOKEN");
    expect(seen.join("")).not.toContain("LATE-TOKEN");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.length).toBe(seenAtStop);
    expect(turn.running()).toEqual([]);
  });

  it("answers that nothing was running when there is no turn to stop", async () => {
    const turn = await buildTurn(new SlowAdapter());
    expect(turn.interrupt("c-idle")).toBe(false);
  });

  it("answers the next message on a fresh session after a stop", async () => {
    const adapter = new SlowAdapter();
    const turn = await buildTurn(adapter);
    const first = turn.answer({ conversationId: "c2" as ConversationId, principal, text: "một", messageId: "m1" });
    await vi.waitFor(() => expect(turn.running()).toEqual(["c2"]));
    turn.interrupt("c2");
    expect((await first).stopped).toBe(true);
    adapter.pieces = 3;

    // A short reply this time, run to its end: the conversation is not broken by having been stopped.
    const second = await turn.answer({ conversationId: "c2" as ConversationId, principal, text: "hai", messageId: "m2" });
    expect(second.stopped).toBeUndefined();
    expect(second.text).toBe("piece-1 piece-2 piece-3");
  });
});

describe("the stop route", () => {
  let dir: string;
  let services: NodeServices;
  let deps: GatewayDeps;
  let adapter: SlowAdapter;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-stop-turn-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
    deps = { services, now: () => AT, newConversationId: () => "conv_stop_1" };
    adapter = new SlowAdapter();
    const turn = await buildTurn(adapter);
    // The seats the composition root puts a model turn in: the conductor answers with it, and the turn control
    // is how a route reaches the turn that is running.
    services.conductor.respondWithModel = (input) => turn.answer(input);
    services.turnControl = {
      running: () => turn.running(),
      interrupt: (conversationId) => turn.interrupt(conversationId),
      steer: (conversationId, text) => turn.steer(conversationId, text),
      runInBackground: (input) => turn.runInBackground(input),
    };
  });

  afterEach(() => {
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return handleRequest(deps, {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  }

  function stopAudits() {
    return listAuditEvents(services.runtime.db, services.runtime.identity.ownerPrincipalId).filter(
      (event) => event.kind === "stop",
    );
  }

  it("stops the running turn, keeps the partial reply with its label, and writes down who stopped it", async () => {
    const created = await call("POST", "/conversations", { title: "dừng" });
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const sending = call("POST", `/conversations/${conversationId}/messages`, { text: "viết một đoạn thật dài" });
    await vi.waitFor(() => expect(services.turnControl?.running()).toEqual([conversationId]));

    const stopped = await call("POST", `/conversations/${conversationId}/stop`, { source: "chat" });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: true });

    const sent = await sending;
    expect(sent.status).toBe(200);
    const messages = (sent.body as { timeline: { messages: MessageRecord[] } }).timeline.messages;
    const reply = messages.at(-1);
    expect(reply?.role).toBe("assistant");
    const blocks = (reply?.blocks ?? []) as Record<string, unknown>[];
    expect(blocks.some((block) => block.type === "text" && String(block.content).includes("piece-1"))).toBe(true);
    expect(blocks.some((block) => block.type === "system-card" && block.title === "Đã dừng theo yêu cầu")).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain("Không gọi được model");

    const audits = stopAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toContain("chat");
    expect(audits[0]?.ref).toBe(conversationId);
    expect(audits[0]?.principalId).toBe(services.runtime.identity.ownerPrincipalId);
  });

  it("is a quiet no-op when nothing is running, and writes nothing down", async () => {
    const created = await call("POST", "/conversations", { title: "không có gì" });
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const stopped = await call("POST", `/conversations/${conversationId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: false });
    expect(stopAudits()).toHaveLength(0);
  });

  it("refuses a conversation that does not exist", async () => {
    const stopped = await call("POST", "/conversations/conv_missing/stop");
    expect(stopped.status).toBe(404);
  });

  it("stops a reply on a spoken \"dừng lại\" and records that it was heard, not typed", async () => {
    const created = await call("POST", "/conversations", { title: "nói dừng" });
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const decision = {
      kind: "intent",
      intent: { kind: "turn.stop" },
      requiresConfirmation: false,
      readBack: "Tôi dừng câu trả lời đang chạy nhé.",
    } as const;

    // Nothing running yet: the answer says so, and there is nothing for the page to run.
    expect(carryOutSpokenStop(services, decision, conversationId)).toMatchObject({ kind: "refused" });

    const sending = call("POST", `/conversations/${conversationId}/messages`, { text: "viết dài" });
    await vi.waitFor(() => expect(services.turnControl?.running()).toEqual([conversationId]));
    expect(carryOutSpokenStop(services, decision, conversationId)).toEqual(decision);
    expect((await sending).status).toBe(200);

    const audits = stopAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toContain("voice");
    // The page's own stop that follows finds the reply already ended, and writes nothing more.
    expect((await call("POST", `/conversations/${conversationId}/stop`, { source: "chat" })).body).toEqual({
      stopped: false,
    });
    expect(stopAudits()).toHaveLength(1);
  });

  it("says there was nothing to stop when \"dừng lại\" is typed after the reply has ended", async () => {
    const created = await call("POST", "/conversations", { title: "gõ dừng" });
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const sent = await call("POST", `/conversations/${conversationId}/messages`, { text: "dừng lại" });
    expect(sent.status).toBe(200);
    const body = sent.body as { appIntent: { kind: string; intent?: { kind: string } }; messageId: string };
    expect(body.appIntent.intent?.kind).toBe("turn.stop");
    // No model turn was started for the sentence: the provider was never prompted.
    expect(adapter.allPrompts()).toHaveLength(0);
    const timeline = await call("GET", `/conversations/${conversationId}/timeline`);
    const said = JSON.stringify((timeline.body as { messages: MessageRecord[] }).messages.at(-1));
    expect(said).toContain("Không có câu trả lời nào đang chạy");
  });
});

/** Holds the next model switch until the test lets it go, so a message can arrive while the conversation is set up. */
class HeldSwitchAdapter extends FakePiAdapter {
  handoffs = 0;
  hold: Promise<void> | undefined;

  /** The session cannot be moved in place, so the switch is a successor, which is what is being held here. */
  override async switchModel(): Promise<void> {
    throw new Error("No API key for the model this session was asked to move to");
  }

  override async handoff(sessionId: string, brief: WorkerBrief): Promise<{ successor: WorkerSessionHandle; note: string }> {
    this.handoffs += 1;
    const held = this.hold;
    this.hold = undefined;
    if (held !== undefined) await held;
    return await super.handoff(sessionId, brief);
  }
}

describe("a message sent while a conversation is being set up", () => {
  let dir: string;
  let services: NodeServices;

  afterEach(() => {
    services.runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers both of two quick messages after a model switch, and stops neither", async () => {
    dir = mkdtempSync(join(tmpdir(), "clarkcant-setup-turn-"));
    services = bootNodeServices({ dataDir: dir, label: "test node" });
    const deps: GatewayDeps = { services, now: () => AT, newConversationId: () => "conv_setup_1" };
    const adapter = new HeldSwitchAdapter({ script: ["một", "hai", "ba"] });
    let preferred = { provider: "fake", id: "fake-model" };
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");
    services.conductor.respondWithModel = (input) => turn.answer(input);
    services.turnControl = {
      running: () => turn.running(),
      answering: () => turn.answering(),
      interrupt: (conversationId) => turn.interrupt(conversationId),
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
    const created = await call("POST", "/conversations", { title: "đổi model" });
    const conversationId = (created.body as { conversationId: string }).conversationId;
    expect((await call("POST", `/conversations/${conversationId}/messages`, { text: "một" })).status).toBe(200);

    // The person picks another model and sends two messages in quick succession while the switch is still being made.
    preferred = { provider: "fake-other", id: "fake-other-model" };
    let open: () => void = () => undefined;
    adapter.hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const second = call("POST", `/conversations/${conversationId}/messages`, { text: "hai" });
    await vi.waitFor(() => expect(adapter.handoffs).toBe(1));
    // A Stop reaches the setup, but nothing is answering yet.
    expect(turn.running()).toEqual([conversationId]);
    expect(turn.answering()).toEqual([]);
    const third = call("POST", `/conversations/${conversationId}/messages`, { text: "ba" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    expect((await second).status).toBe(200);
    expect((await third).status).toBeLessThan(300);

    const timeline = await call("GET", `/conversations/${conversationId}/timeline`);
    const messages = (timeline.body as { messages: MessageRecord[] }).messages;
    const said = JSON.stringify(messages.filter((message) => message.role === "assistant"));
    // Both were answered — the third joined the second's reply or had one of its own — and neither was stopped.
    expect(said).toContain("hai");
    expect(said).toMatch(/\bba\b/);
    expect(said).not.toContain("Đã dừng theo yêu cầu");
    expect(said).not.toContain("Không gọi được model");
    expect(adapter.handoffs).toBe(1);
  });
});