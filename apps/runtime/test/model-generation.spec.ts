import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import type { ModelTurnEvent } from "@clarkcant/core";
import { FakePiAdapter, type WorkerBrief, type WorkerSessionHandle } from "@clarkcant/pi-adapter";

import { SESSION_POLICY_LIMITS } from "../src/session-policy.ts";
import { createModelTurn, type ViewDescriptor } from "../src/model-turn.ts";

const VIEW: ViewDescriptor = {
  id: "canvas.table@1",
  label: "A table",
  build: () => ({ type: "evidence", kind: "test-output", summary: "rendered by the view", verdict: "verified" }),
};

/** The heading a recap opens with, so a test can tell a briefed prompt from one that is not. */
const RECAP = "Mạch hội thoại trước đó";

/**
 * Changing the model, in the only way Pi allows it.
 *
 * Pi resolves a model when a session is created, so a change cannot be applied to the session underneath a running
 * turn. What these tests hold is the answer this code gives instead: the change creates a successor generation at
 * the turn boundary, the conversation keeps its thread, and a model that has not changed costs nothing at all.
 *
 * The fake adapter refuses a prompt on a session that is still answering, as Pi does, so none of this can pass on a
 * path Pi would not allow.
 */
class CountingAdapter extends FakePiAdapter {
  readonly handoffs: { sessionId: string; brief: WorkerBrief }[] = [];
  readonly briefs: WorkerBrief[] = [];
  /** Sessions disposed while they were still answering a prompt: always a bug. */
  readonly disposedWhileStreaming: string[] = [];
  /**
   * Set to hold the next handoff's successor creation until the promise settles; a rejection fails it. Held inside the
   * creation, after the source session was checked, which is the order the real adapter uses.
   */
  holdHandoff: Promise<void> | undefined;
  #holdCreation: Promise<void> | undefined;

  override async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    const held = this.#holdCreation;
    this.#holdCreation = undefined;
    if (held !== undefined) await held;
    this.briefs.push(brief);
    return await super.createWorkerSession(brief);
  }

  override async handoff(
    sessionId: string,
    brief: WorkerBrief,
  ): Promise<{ successor: WorkerSessionHandle; note: string }> {
    this.handoffs.push({ sessionId, brief });
    this.#holdCreation = this.holdHandoff;
    this.holdHandoff = undefined;
    return await super.handoff(sessionId, brief);
  }

  override async dispose(sessionId: string): Promise<void> {
    if (this.isProcessing(sessionId)) this.disposedWhileStreaming.push(sessionId);
    await super.dispose(sessionId);
  }
}

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void; fail: (cause: Error) => void } {
  let open: () => void = () => undefined;
  let fail: (cause: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

/** Holds the next prompt inside the session (so it counts as answering) until the gate opens. */
function holdNextPrompt(adapter: CountingAdapter): ReturnType<typeof gate> {
  const held = gate();
  const original = adapter.run.bind(adapter);
  vi.spyOn(adapter, "run").mockImplementationOnce(async (sessionId, text) => {
    await held.promise;
    return await original(sessionId, text);
  });
  return held;
}

const PRINCIPAL: Principal = {
  principalId: "p_owner" as Principal["principalId"],
  kind: "user",
  nodeId: "n1" as Principal["nodeId"],
};
const CONVERSATION = "c1" as ConversationId;
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const FIRST = { provider: "fake", id: "fake-model" };
const OTHER = { provider: "fake-other", id: "fake-other-model" };

type Turn = NonNullable<Awaited<ReturnType<typeof createModelTurn>>>;

async function say(turn: Turn, text: string, messageId: string, conversationId: string = CONVERSATION) {
  return await turn.answer({ conversationId: conversationId as ConversationId, principal: PRINCIPAL, text, messageId });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a changed model", () => {
  it("becomes a new generation at the turn boundary, and the brief travels with it", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok", "ok"] });
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    // Nothing changed, so nothing happened: a handoff per turn would throw away a warm session every message.
    expect(adapter.handoffs).toHaveLength(0);

    preferred = OTHER;
    await say(turn, "hai", "msg_2");

    expect(adapter.handoffs).toHaveLength(1);
    // The successor runs the model the person chose, and carries the same goal — a generation is a new session, not
    // a new assistant with a new job.
    expect(adapter.handoffs[0]?.brief.model).toEqual(OTHER);
    expect(adapter.handoffs[0]?.brief.goal).toBe("Answer the user in this conversation.");
  });

  it("hands off once, not once per turn, while the choice stays the same", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok", "ok", "ok"] });
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    preferred = OTHER;
    await say(turn, "hai", "msg_2");
    await say(turn, "ba", "msg_3");

    expect(adapter.handoffs).toHaveLength(1);
  });

  it("gives the live turn the tool activity and the view after a handoff, briefs the successor once and lets the previous session go once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T08:00:00Z"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const adapter = new CountingAdapter({
      script: ["một", { callTool: { name: "show_view", params: { view: VIEW.id } }, reply: "đây" }, "ba", "bốn"],
    });
    // The fake reports no context size; a large one is what makes a later rebuild worth it.
    vi.spyOn(adapter, "usage").mockImplementation(() => ({ turns: 1, contextTokens: SESSION_POLICY_LIMITS.largeContextTokens * 2 }));
    const disposed = vi.spyOn(adapter, "dispose");
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      views: () => [VIEW],
      history: async () => [{ role: "user", text: "câu hỏi trước đó" }],
      sessionPolicy: { mode: "rebuild" },
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");

    preferred = OTHER;
    const events: ModelTurnEvent[] = [];
    const reply = await turn.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "cơ sở dữ liệu SQLite",
      messageId: "msg_2",
      onEvent: (event) => events.push(event),
    });

    expect(adapter.handoffs).toHaveLength(1);
    const previous = adapter.handoffs[0]!.sessionId;
    const successor = "fake-session-2";
    // The tool the successor called reports to the turn the person is watching, and its view lands in that reply.
    expect(events.filter((event) => event.type === "tool-start").map((event) => (event as { name: string }).name)).toEqual([
      "show_view",
    ]);
    expect(reply.segments.some((segment) => segment.kind === "block")).toBe(true);
    // The successor knows nothing of the thread, so its first prompt carries the recap.
    expect(adapter.promptsFor(successor)[0]).toContain(RECAP);
    // The previous generation is let go, once, rather than kept alive for as long as the process runs.
    expect(disposed.mock.calls.filter(([id]) => id === previous)).toHaveLength(1);

    // The turn after it is not briefed again: the successor already has the thread.
    await say(turn, "SQLite migrations", "msg_3");
    expect(adapter.promptsFor(successor)).toHaveLength(2);
    expect(adapter.promptsFor(successor)[1]).not.toContain(RECAP);

    // Ten minutes on, about something else: the policy rebuilds, and the rebuilt session has this generation's tools
    // and model, not the first generation's.
    vi.setSystemTime(new Date("2026-10-04T08:10:00Z"));
    await say(turn, "thời tiết Hà Nội cuối tuần", "msg_4");
    expect(adapter.briefs).toHaveLength(3);
    const [, handedOff, rebuilt] = adapter.briefs;
    expect(rebuilt!.model).toEqual(OTHER);
    expect(rebuilt!.customTools).toBe(handedOff!.customTools);
    expect(disposed.mock.calls.filter(([id]) => id === successor)).toHaveLength(1);
    // The rebuild recorded the model it ran, so the next turn hands nothing off.
    await say(turn, "thời tiết Đà Nẵng", "msg_5");
    expect(adapter.handoffs).toHaveLength(1);
    expect(adapter.disposedWhileStreaming).toEqual([]);
  });

  it("steers a message that arrives mid-turn into the running turn, and hands off only at the next turn", async () => {
    const adapter = new CountingAdapter({ script: ["một", "ba"] });
    const disposed = vi.spyOn(adapter, "dispose");
    const held = holdNextPrompt(adapter);
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");

    const running = say(turn, "một", "msg_1");
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-1")).toBe(true));
    preferred = OTHER;
    const joined = await say(turn, "hai", "msg_2");

    // Steered, not prompted a second time: Pi would refuse that, and one conversation has one reply running.
    expect(joined.steered).toBe(true);
    expect(adapter.handoffs).toHaveLength(0);
    expect(disposed).not.toHaveBeenCalled();
    // The joining message does not end the turn it joined: the first reply is still running.
    expect(turn.running()).toEqual([CONVERSATION]);

    held.open();
    const first = await running;
    expect(first.text).toContain("[steered: hai]");

    // The next turn to start is the boundary, and the change is made there.
    await say(turn, "ba", "msg_3");
    expect(adapter.handoffs).toHaveLength(1);
    expect(adapter.disposedWhileStreaming).toEqual([]);
  });

  it("serialises two messages sent while a slow handoff is pending: one hands off, the other is steered into it", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    preferred = OTHER;
    const slow = gate();
    adapter.holdHandoff = slow.promise;
    const held = holdNextPrompt(adapter);
    const second = say(turn, "hai", "msg_2");
    const third = say(turn, "ba", "msg_3");
    await vi.waitFor(() => expect(adapter.handoffs).toHaveLength(1));
    slow.open();
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-2")).toBe(true));

    const steered = await third;
    held.open();
    const answered = await second;

    // One handoff from one session, both messages succeed, and nothing is disposed while it answers.
    expect(adapter.handoffs.map((handoff) => handoff.sessionId)).toEqual(["fake-session-1"]);
    expect(steered.steered).toBe(true);
    expect(answered.text).toContain("[steered: ba]");
    expect(adapter.disposedWhileStreaming).toEqual([]);
  });

  it("lets the successor go and starts afresh when idle eviction took the turn during the handoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T08:00:00Z"));
    const adapter = new CountingAdapter();
    const disposed = vi.spyOn(adapter, "dispose");
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    // Long idle, then the person changes the model and writes; another conversation starts while the handoff waits.
    vi.setSystemTime(new Date("2026-10-04T08:31:00Z"));
    preferred = OTHER;
    const slow = gate();
    adapter.holdHandoff = slow.promise;
    const reply = say(turn, "hai", "msg_2");
    await vi.waitFor(() => expect(adapter.handoffs).toHaveLength(1));
    await say(turn, "khác", "msg_other", "c2");
    // The other conversation's new session evicted this idle one.
    expect(disposed).toHaveBeenCalledWith("fake-session-1");
    slow.open();
    await reply;

    // The successor (fake-session-3) belonged to nothing, so it went; the message ran on a fresh session instead.
    expect(disposed.mock.calls.filter(([id]) => id === "fake-session-1")).toHaveLength(1);
    expect(disposed.mock.calls.filter(([id]) => id === "fake-session-3")).toHaveLength(1);
    expect(adapter.promptsFor("fake-session-4")).toHaveLength(1);
    expect(adapter.briefs.at(-1)?.model).toEqual(OTHER);
  });

  it("says what failed when a handoff fails, and keeps the previous session and its tools intact", async () => {
    const adapter = new CountingAdapter({
      script: ["một", { callTool: { name: "show_view", params: { view: VIEW.id } }, reply: "ba" }],
    });
    const disposed = vi.spyOn(adapter, "dispose");
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      views: () => [VIEW],
    });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    preferred = OTHER;
    const refused = gate();
    refused.promise.catch(() => undefined);
    refused.fail(new Error("the provider refused the session"));
    adapter.holdHandoff = refused.promise;
    const failure = say(turn, "hai", "msg_2");
    // Not silently answered on the old model: the person chose another one, and they hear what happened.
    await expect(failure).rejects.toThrow(/Could not switch this conversation to fake-other\/fake-other-model/);
    await expect(failure).rejects.toThrow(/the provider refused the session/);
    await expect(failure).rejects.toThrow(/The conversation is kept as it was/);
    await expect(failure).rejects.toThrow(/retry, or choose another model/);
    expect(disposed).not.toHaveBeenCalled();
    expect(turn.running()).toEqual([]);

    // Choosing the first model again answers on the session that was kept, with its tools still reaching the turn.
    preferred = FIRST;
    const events: ModelTurnEvent[] = [];
    await turn.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "ba",
      messageId: "msg_3",
      onEvent: (event) => events.push(event),
    });
    expect(adapter.promptsFor("fake-session-1")).toHaveLength(2);
    expect(events.some((event) => event.type === "tool-start")).toBe(true);
  });

  it("keeps the recap for the next turn when preparing the first prompt after a handoff fails", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    let preferred = FIRST;
    let failReferences = false;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      history: async () => [{ role: "user", text: "câu hỏi trước đó" }],
      references: {
        briefFor: async () => {
          if (failReferences) throw new Error("the reference store is unavailable");
          return "";
        },
      },
    });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    preferred = OTHER;
    failReferences = true;
    await expect(say(turn, "hai", "msg_2")).rejects.toThrow(/reference store/);
    failReferences = false;
    await say(turn, "ba", "msg_3");

    // Nothing was sent on the failed turn, so the successor's first prompt is the one that is briefed.
    expect(adapter.promptsFor("fake-session-2")).toHaveLength(1);
    expect(adapter.promptsFor("fake-session-2")[0]).toContain(RECAP);
  });

  it("does nothing when nobody has expressed a preference", async () => {
    // A node with no pool runs the configured model, and "no preference" is not a change to apply.
    const adapter = new CountingAdapter({ script: ["ok", "ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => undefined });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    await say(turn, "hai", "msg_2");
    expect(adapter.handoffs).toHaveLength(0);
  });
});
