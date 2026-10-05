import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import type { ModelTurnEvent } from "@clarkcant/core";
import { FakePiAdapter, type ModelSwitch, type WorkerBrief, type WorkerSessionHandle } from "@clarkcant/pi-adapter";

import { turnInstructions } from "../src/conditional-instructions.ts";
import { SESSION_POLICY_LIMITS } from "../src/session-policy.ts";
import { createModelTurn, readableLimit, redactLocalPaths, type ViewDescriptor } from "../src/model-turn.ts";

const VIEW: ViewDescriptor = {
  id: "canvas.table@1",
  label: "A table",
  build: () => ({ type: "evidence", kind: "test-output", summary: "rendered by the view", verdict: "verified" }),
};

/** The heading a recap opens with, so a test can tell a briefed prompt from one that is not. */
const RECAP = "Mạch hội thoại trước đó";

/**
 * Changing the model, at the turn boundary.
 *
 * A session that can simply go on is moved to the new model in place (the last two groups of tests below). One that
 * cannot — Pi refuses the switch, or the new model may not receive what the session holds — gets a successor
 * generation instead: the conversation keeps its thread, and a model that has not changed costs nothing at all. The
 * adapter here refuses the in-place switch unless a test turns it on, so the successor path is what most tests hold.
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
  /** Whether a session may be moved to another model in place. Off, a change can only be a successor. */
  inPlace = false;

  /** Text the session's loader would put into its prompt from the machine, offered to the brief's guard as the SDK does. */
  contextFile: string | undefined;

  override async switchModel(sessionId: string, selection: ModelSwitch): Promise<void> {
    if (!this.inPlace) throw new Error("No API key for the model this session was asked to move to");
    await super.switchModel(sessionId, selection);
  }

  override async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    const held = this.#holdCreation;
    this.#holdCreation = undefined;
    if (held !== undefined) await held;
    this.briefs.push(brief);
    if (this.contextFile !== undefined) brief.contextGuard?.({ source: "/work/AGENTS.md", text: this.contextFile });
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
    await expect(failure).rejects.toThrow(/Your message is saved and the conversation is unchanged/);
    await expect(failure).rejects.toThrow(/Retry, or choose another model/);
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

  it("says a failed switch in the person's language, without the local paths in the adapter's reason", async () => {
    const adapter = new CountingAdapter({ script: ["một"] });
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred, language: () => "vi" });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    preferred = OTHER;
    const refused = gate();
    refused.promise.catch(() => undefined);
    refused.fail(new Error("no key in C:\\Users\\an\\.pi\\agent\\auth.json or /home/an/.pi/agent/models.json (see https://example.com/docs/keys)"));
    adapter.holdHandoff = refused.promise;
    const failure = say(turn, "hai", "msg_2");
    await expect(failure).rejects.toThrow(/Không chuyển được cuộc trò chuyện này sang fake-other\/fake-other-model/);
    await expect(failure).rejects.toThrow(/Tin nhắn của bạn đã được lưu/);
    await expect(failure).rejects.toThrow(/Hãy thử lại, hoặc chọn model khác/);
    const message = await failure.catch((cause: Error) => cause.message);
    expect(message).toContain("no key in <path> or <path>");
    expect(message).not.toMatch(/Users|home\/an/);
    // A web address says nothing about this machine, and may be what tells the person where to look.
    expect(message).toContain("https://example.com/docs/keys");
  });

  it("joins only bare words to a running turn: guidance, data, attachments and speech wait for a turn of their own", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai", "ba", "bốn", "năm"] });
    const steered = vi.spyOn(adapter, "steer");
    const held = holdNextPrompt(adapter);
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST });
    if (turn === undefined) throw new Error("the model turn was not built");

    const running = say(turn, "một", "msg_1");
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-1")).toBe(true));
    const base = { conversationId: CONVERSATION, principal: PRINCIPAL };
    const waiting = [
      turn.answer({ ...base, text: "đồng ý", messageId: "msg_note", note: "The person approved the request above." }),
      turn.answer({ ...base, text: "đây là dữ liệu", messageId: "msg_data", data: "a,b\n1,2" }),
      turn.answer({ ...base, text: "xem tệp này", messageId: "msg_file", attached: true }),
      turn.answer({ ...base, text: "nói thêm", messageId: "msg_voice", channel: "voice" }),
    ];
    // Given time to join if they were going to: none does.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(steered).not.toHaveBeenCalled();

    held.open();
    await running;
    const replies = await Promise.all(waiting);
    // Each was answered as a turn of its own, with what it carried in its own prompt.
    expect(replies.map((reply) => reply.steered)).toEqual([undefined, undefined, undefined, undefined]);
    const prompts = adapter.promptsFor("fake-session-1");
    expect(prompts).toHaveLength(5);
    expect(prompts.some((prompt) => prompt.includes("The person approved the request above."))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("a,b"))).toBe(true);
    expect(steered).not.toHaveBeenCalled();
  });

  it("starts no message that was waiting when an emergency stop arrives", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const prompted = vi.spyOn(adapter, "prompt");
    const held = holdNextPrompt(adapter);
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST });
    if (turn === undefined) throw new Error("the model turn was not built");

    const running = say(turn, "một", "msg_1");
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-1")).toBe(true));
    const waiting = turn.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "đồng ý",
      messageId: "msg_2",
      note: "The person approved the request above.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // What the emergency stop does: interrupt every conversation that reports running.
    for (const conversationId of turn.running()) turn.interrupt(conversationId);
    held.open();
    expect((await running).stopped).toBe(true);
    const cancelled = await waiting;
    expect(cancelled.stopped).toBe(true);
    // Its card says it never started, not that the model wrote anything.
    expect(cancelled.stoppedDetail).toMatch(/stopped before it started/);
    expect(cancelled.stoppedDetail).toMatch(/still saved/);
    // Sent before the stop, so never started: only the first message was ever prompted.
    expect(prompted).toHaveBeenCalledTimes(1);
    expect(turn.running()).toEqual([]);

    // A message sent after the stop is answered as usual.
    expect((await say(turn, "ba", "msg_3")).stopped).not.toBe(true);
  });

  it("stops a turn whose model switch is still pending, and lets the successor go when it arrives", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const disposed = vi.spyOn(adapter, "dispose");
    let preferred = FIRST;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    preferred = OTHER;
    const slow = gate();
    adapter.holdHandoff = slow.promise;
    const reply = say(turn, "hai", "msg_2");
    await vi.waitFor(() => expect(adapter.handoffs).toHaveLength(1));
    // Running as far as Stop is concerned, and Stop reaches it without waiting for the provider.
    expect(turn.running()).toEqual([CONVERSATION]);
    expect(turn.runningMs(CONVERSATION)).toBeTypeOf("number");
    expect(turn.interrupt(CONVERSATION)).toBe(true);
    expect((await reply).stopped).toBe(true);
    expect(turn.running()).toEqual([]);

    slow.open();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledWith("fake-session-2"));
    expect(adapter.promptsFor("fake-session-2")).toHaveLength(0);
    // The conversation kept its session, and the next message makes the switch.
    await say(turn, "ba", "msg_3");
    expect(adapter.handoffs).toHaveLength(2);
    expect(adapter.promptsFor("fake-session-3")).toHaveLength(1);
  });

  it("states a turn limit in minutes or seconds, never in milliseconds", () => {
    expect(readableLimit(300_000, "vi")).toBe("5 phút");
    expect(readableLimit(300_000, "en")).toBe("5 minutes");
    expect(readableLimit(60_000, "en")).toBe("1 minute");
    expect(readableLimit(90_000, "vi")).toBe("90 giây");
    expect(readableLimit(150, "en")).toBe("1 s");
  });

  it("ends a setup that never finishes with a clear error, and does not hold the messages behind it", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const disposed = vi.spyOn(adapter, "dispose");
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: { ...ENV, CC_MODEL_MAX_WALL_CLOCK_MS: "150" },
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
    });
    if (turn === undefined) throw new Error("the model turn was not built");
    await say(turn, "một", "msg_1");

    preferred = OTHER;
    const never = gate();
    adapter.holdHandoff = never.promise;
    const stuck = say(turn, "hai", "msg_2");
    await vi.waitFor(() => expect(adapter.handoffs).toHaveLength(1));
    const behind = say(turn, "ba", "msg_3");
    await expect(stuck).rejects.toThrow(/Could not get ready to answer within 1 s/);
    await expect(stuck).rejects.toThrow(/Your message is saved/);
    // The message queued behind it makes its own switch and is answered.
    expect((await behind).text).toBe("hai");
    expect(adapter.handoffs).toHaveLength(2);

    // The second switch created fake-session-2 and answered on it; the stuck successor, when it finally arrives as
    // fake-session-3, is let go rather than adopted.
    expect(adapter.promptsFor("fake-session-2")).toHaveLength(1);
    never.open();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledWith("fake-session-3"));
    expect(disposed.mock.calls.filter(([id]) => id === "fake-session-2")).toHaveLength(0);
  });

  it("answers a steer that lands after Pi's last look at its queue, before the turn ends", async () => {
    const adapter = new CountingAdapter({ script: ["một", "đã thêm"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST });
    if (turn === undefined) throw new Error("the model turn was not built");

    const late = adapter.holdAfterLastCheck("fake-session-1");
    const running = say(turn, "một", "msg_1");
    await late.reached;
    // Pi queues this rather than answering it in the run, because the run has already read its queue for the last time.
    const joined = await say(turn, "và cả phần kia", "msg_2");
    expect(joined.steered).toBe(true);
    expect(adapter.hasQueuedMessages("fake-session-1")).toBe(true);
    late.release();

    const first = await running;
    // The turn ran the session on what was queued, and the answer is part of the reply the person is watching.
    expect(first.text).toContain("[steered: và cả phần kia]");
    expect(first.text).toContain("đã thêm");
    expect(adapter.hasQueuedMessages("fake-session-1")).toBe(false);
    expect(adapter.promptsFor("fake-session-1")).toHaveLength(2);
    expect(turn.running()).toEqual([]);
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

describe("a changed thinking level", () => {
  it("reaches the next turn as a new generation, and a turn with no limit set carries no wall clock", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok"] });
    let level: "low" | "high" | undefined = "low";
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => FIRST,
      thinkingLevel: () => level,
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    expect(adapter.briefs[0]?.thinkingLevel).toBe("low");
    // Unlimited is the default: tokens and Stop bound a turn until the person picks a limit in Settings.
    expect(adapter.briefs[0]?.maxWallClockMs).toBeUndefined();
    expect(turn.turnLimitMs()).toBeUndefined();

    level = "high";
    await say(turn, "hai", "msg_2");
    expect(adapter.handoffs).toHaveLength(1);
    expect(adapter.handoffs[0]?.brief.thinkingLevel).toBe("high");

    await say(turn, "ba", "msg_3");
    expect(adapter.handoffs).toHaveLength(1);
  });

  it("gives the session the limit the person chose", async () => {
    const adapter = new CountingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => FIRST,
      turnLimitMs: () => 15 * 60_000,
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    expect(adapter.briefs[0]?.maxWallClockMs).toBe(15 * 60_000);
  });
});

describe("the edges of a running turn", () => {
  it("keeps the finished reply when running the session on a late message fails, and answers the next on a fresh one", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const prompted = vi.spyOn(adapter, "prompt");
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST });
    if (turn === undefined) throw new Error("the model turn was not built");
    vi.spyOn(adapter, "continueQueued").mockRejectedValueOnce(new Error("the provider dropped the connection"));

    const late = adapter.holdAfterLastCheck("fake-session-1");
    const running = say(turn, "một", "msg_1");
    await late.reached;
    expect((await say(turn, "và cả phần kia", "msg_2")).steered).toBe(true);
    late.release();

    // The reply that had finished is the answer, not an error.
    const first = await running;
    expect(first.text).toContain("một");
    expect(first.stopped).toBeUndefined();
    expect(turn.running()).toEqual([]);
    // The session the drain failed on is not prompted again.
    await say(turn, "hai", "msg_3");
    expect(prompted.mock.calls.map(([sessionId]) => sessionId)).toEqual(["fake-session-1", "fake-session-2"]);
    expect(adapter.disposedWhileStreaming).toEqual([]);
  });

  it("never joins a typed message to a spoken turn: it waits and is answered on its own", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const steered = vi.spyOn(adapter, "steer");
    const held = holdNextPrompt(adapter);
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST });
    if (turn === undefined) throw new Error("the model turn was not built");

    const spoken = turn.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "một", messageId: "msg_1", channel: "voice" });
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-1")).toBe(true));
    const typed = say(turn, "hai", "msg_2");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(steered).not.toHaveBeenCalled();

    held.open();
    expect((await spoken).text).toBe("một");
    const reply = await typed;
    expect(reply.steered).toBeUndefined();
    expect(reply.text).toBe("hai");
    expect(adapter.promptsFor("fake-session-1")).toHaveLength(2);
  });

  it("states the instructions of the message a waiting turn answers, not of the message stored after it", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const held = holdNextPrompt(adapter);
    // What each stored message references; the last one stored is a later message the person sent while the second waited.
    const skillsOf: Record<string, string[]> = { u_1: [], u_2: ["skill-of-the-waiting-message"], u_3: ["skill-of-a-later-message"] };
    const asked: (string | undefined)[] = [];
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => FIRST,
      instructions: turnInstructions({
        instructions: {
          active: (state) =>
            state.skills.map((skill) => ({ id: skill, source: `rules/${skill}.md`, text: `Instruction for ${skill}.`, pin: false })),
        },
        referenced: (_conversationId, messageId) => {
          asked.push(messageId);
          return { places: [], skills: skillsOf[messageId ?? "u_3"] ?? [] };
        },
      }),
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    const spoken = turn.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "một",
      messageId: "msg_1",
      userMessageId: "u_1",
      channel: "voice",
    });
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-1")).toBe(true));
    // Typed during a spoken turn, so it waits for a turn of its own.
    const waiting = turn.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "hai", messageId: "msg_2", userMessageId: "u_2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.open();
    await spoken;
    expect((await waiting).text).toBe("hai");

    expect(asked).toEqual(["u_1", "u_2"]);
    const second = adapter.promptsFor("fake-session-1")[1] ?? "";
    expect(second).toContain("Instruction for skill-of-the-waiting-message.");
    expect(second).not.toContain("skill-of-a-later-message");
  });

  it("starts nothing once the node is shutting down, and stops what was waiting", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai"] });
    const prompted = vi.spyOn(adapter, "prompt");
    const held = holdNextPrompt(adapter);
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST });
    if (turn === undefined) throw new Error("the model turn was not built");

    const running = say(turn, "một", "msg_1");
    await vi.waitFor(() => expect(adapter.isProcessing("fake-session-1")).toBe(true));
    const waiting = turn.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "đồng ý",
      messageId: "msg_2",
      note: "The person approved the request above.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await turn.dispose();
    held.open();
    await running.catch(() => undefined);
    expect((await waiting).stopped).toBe(true);
    expect((await say(turn, "ba", "msg_3")).stopped).toBe(true);
    expect(prompted).toHaveBeenCalledTimes(1);
  });

  it("says a failure to start a conversation's first session in the person's language, without local paths", async () => {
    const adapter = new CountingAdapter({ script: ["một"] });
    vi.spyOn(adapter, "createWorkerSession").mockRejectedValueOnce(
      new Error("cannot read C:\\Users\\An Nguyen\\.pi\\agent\\auth.json"),
    );
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => FIRST, language: () => "vi" });
    if (turn === undefined) throw new Error("the model turn was not built");

    const message = await say(turn, "một", "msg_1").then(
      () => "",
      (cause: Error) => cause.message,
    );
    expect(message).toMatch(/Không bắt đầu được cuộc trò chuyện này trên fake\/fake-model/);
    expect(message).toMatch(/Tin nhắn của bạn đã được lưu/);
    expect(message).toContain("cannot read <path>");
    expect(message).not.toMatch(/Users|Nguyen/);
    // Nothing was left half-made: the next message starts the conversation.
    expect((await say(turn, "một", "msg_2")).text).toBe("một");
  });
});

describe("taking local paths out of a reason", () => {
  it("takes out paths with spaces, quoted paths and file addresses, and leaves web addresses", () => {
    expect(redactLocalPaths("cannot open C:\\Users\\An Nguyen\\.pi\\auth.json now")).toBe("cannot open <path> now");
    expect(redactLocalPaths("cannot open /home/an nguyen/.pi/models.json or later")).toBe("cannot open <path> or later");
    expect(redactLocalPaths('read "C:\\Program Files\\Pi\\cfg.json" failed')).toBe('read "<path>" failed');
    expect(redactLocalPaths("see file:///home/an/.pi/x.json and file://C:/Users/x")).toBe("see <path> and <path>");
    expect(redactLocalPaths("at /a/b (see https://example.com/docs/keys)")).toBe("at <path> (see https://example.com/docs/keys)");
    // A folder named with three words: the words between the separators are taken too.
    expect(redactLocalPaths("cannot open C:\\Users\\Nguyen Van An\\.pi\\agent\\auth.json now")).toBe("cannot open <path> now");
    expect(redactLocalPaths("cannot open /home/Nguyen Van An/.pi/agent/auth.json now")).toBe("cannot open <path> now");
    // Prose after a path is kept, including a word that holds a separator but starts in lower case or is a web address.
    expect(redactLocalPaths("C:\\x\\y was not found, see docs\\setup.md")).toBe("<path> was not found, see docs\\setup.md");
    expect(redactLocalPaths("C:\\x\\y See Https://example.com/a")).toBe("<path> See Https://example.com/a");
  });
});

describe("a changed model the session can keep", () => {
  it("moves the same session to the new model, briefs nothing again, and names the model that answered", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok"] });
    adapter.inPlace = true;
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      history: async () => [{ role: "user", text: "câu hỏi trước đó" }],
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    preferred = OTHER;
    const reply = await say(turn, "hai", "msg_2");

    expect(adapter.handoffs).toHaveLength(0);
    expect(adapter.briefs).toHaveLength(1);
    expect(adapter.modelSwitches).toEqual([{ sessionId: "fake-session-1", selection: { model: OTHER } }]);
    expect(`${reply.provider}/${reply.model}`).toBe("fake-other/fake-other-model");
    // The session already holds the conversation, so the second prompt carries no recap of it.
    expect(adapter.promptsFor("fake-session-1")).toHaveLength(2);
    expect(adapter.promptsFor("fake-session-1")[1]).not.toContain(RECAP);

    // The choice has not changed again: nothing more is switched.
    await say(turn, "ba", "msg_3");
    expect(adapter.modelSwitches).toHaveLength(1);
  });

  it("starts a successor instead when the new model may not receive what the session was sent", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok"] });
    adapter.inPlace = true;
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      // The second model may be sent nothing personal; the first may.
      allowedDataClasses: (model) => (model.id === OTHER.id ? ["public", "internal"] : ["public", "internal", "confidential"]),
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "gửi cho duy@example.com giúp tôi", "msg_1");
    preferred = OTHER;
    await say(turn, "xong chưa", "msg_2");

    // The session holds an address the new model may not read, and a session cannot be narrowed: a new one is made.
    expect(adapter.modelSwitches).toEqual([]);
    expect(adapter.handoffs).toHaveLength(1);
    expect(adapter.promptsFor("fake-session-2").join("\n")).not.toContain("duy@example.com");
  });

  it("starts a successor when the session's loaded context is above the new model's ceiling", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok"] });
    adapter.inPlace = true;
    adapter.contextFile = "Maintainer: duy@example.com";
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      allowedDataClasses: (model) => (model.id === OTHER.id ? ["public", "internal"] : ["public", "internal", "confidential"]),
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    preferred = OTHER;
    await say(turn, "hai", "msg_2");

    // Nothing the person typed is above the new ceiling, but the session's prompt already carries a file that is.
    expect(adapter.modelSwitches).toEqual([]);
    expect(adapter.handoffs).toHaveLength(1);
  });

  it("keeps the session for a model with a lower ceiling when nothing it was sent is above that ceiling", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok"] });
    adapter.inPlace = true;
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      allowedDataClasses: (model) => (model.id === OTHER.id ? ["public", "internal"] : ["public", "internal", "confidential"]),
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    preferred = OTHER;
    await say(turn, "hai", "msg_2");

    expect(adapter.handoffs).toHaveLength(0);
    expect(adapter.modelSwitches).toHaveLength(1);
  });

  it("falls back to a successor when Pi refuses the switch, and the turn is still answered", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok"] });
    let preferred = FIRST;
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    preferred = OTHER;
    const reply = await say(turn, "hai", "msg_2");

    expect(adapter.handoffs).toHaveLength(1);
    expect(reply.text).toBe("ok");
  });
});

describe("a changed thinking level the session can keep", () => {
  it("is set on the same session, and going back to the model's default starts a successor", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok"] });
    adapter.inPlace = true;
    let level: "low" | "high" | undefined = "low";
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => FIRST,
      thinkingLevel: () => level,
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    level = "high";
    await say(turn, "hai", "msg_2");
    expect(adapter.handoffs).toHaveLength(0);
    expect(adapter.modelSwitches).toEqual([{ sessionId: "fake-session-1", selection: { thinkingLevel: "high" } }]);

    // A session cannot be told "whatever your default is": the next one is created without a level.
    level = undefined;
    await say(turn, "ba", "msg_3");
    expect(adapter.handoffs).toHaveLength(1);
    expect(adapter.handoffs[0]?.brief.thinkingLevel).toBeUndefined();
  });
});
