import { describe, expect, it, vi } from "vitest";

/**
 * The send lifecycle, without a browser.
 *
 * The hook runs against a small stand-in for React's hooks that keeps state and refs between renders, so a test can
 * render again and read `busy` from what the hook returns, the way a component would. What matters here is what a send
 * does when it ends: which chips it hands back and whether it touches the busy flag. The browser journeys cover the
 * screen.
 */

const hooks = { states: [] as { value: unknown }[], refs: [] as { current: unknown }[], state: 0, ref: 0 };

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const slot = (hooks.states[hooks.state] ??= { value: initial });
    hooks.state += 1;
    return [slot.value, (value: unknown) => (slot.value = value)];
  },
  useRef: (initial: unknown) => {
    const ref = (hooks.refs[hooks.ref] ??= { current: initial });
    hooks.ref += 1;
    return ref;
  },
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
}));

const { useTurnSend } = await import("../src/use-turn-send.ts");
type Deps = Parameters<typeof useTurnSend>[0];
type Chip = Deps["chips"][number];

/** Each stream waits until the test ends it, so a send can be held in flight across a restart. */
function harness(
  chips: readonly Chip[],
  appIntent: (request: { text: string }) => Promise<unknown> = async () => ({ kind: "none" }),
  options: { firstMessage?: boolean } = {},
) {
  // A first message has no conversation yet: the page learns its id only once the node made it.
  const conversationId = options.firstMessage === true ? undefined : "conv_1";
  hooks.states = [];
  hooks.refs = [];
  const dispatched: unknown[] = [];
  const streams: (() => void)[] = [];
  const asked: unknown[] = [];
  const pending: unknown[] = [];
  const ran: unknown[] = [];
  const notices: string[] = [];
  const cleared: number[] = [];
  const client = {
    sendAppIntent: (request: { text: string }) => {
      asked.push(request);
      return appIntent(request);
    },
    createConversation: async () => ({ conversationId: "conv_1" }),
    streamMessage: async (_target: string, _text: string, handlers: { onDone: (result: unknown) => void }) => {
      await new Promise<void>((done) => streams.push(done));
      handlers.onDone({ resolution: "model", timeline: { messages: [] } });
    },
  };
  const noop = (): void => undefined;
  const render = () => {
    hooks.state = 0;
    hooks.ref = 0;
    return useTurnSend({
      client: client as never,
      conversationId,
      setConversationId: noop,
      onConversationReady: undefined,
      onSessionReset: undefined,
      applyTimeline: noop,
      timeline: undefined,
      setTimeline: noop,
      chips,
      dispatchChips: (action) => dispatched.push(action),
      chosenReferences: [],
      onReferencesSent: noop,
      beginHeroExit: noop,
      resetHero: noop,
      setDatasets: noop,
      setSnapshots: noop,
      setPendingIntent: (decision) => pending.push(decision),
      runIntent: (decision) => ran.push(decision),
      onNotice: (text) => notices.push(text),
      clearDraft: () => cleared.push(1),
      onSendFailed: noop,
      t: (key) => key,
    });
  };
  return { render, dispatched, streams, asked, pending, ran, notices, cleared };
}

const READY: Chip = { id: "chip_1", filename: "a.png", mime: "image/png", sizeBytes: 10, state: "ready", attachmentId: "att_1" };

describe("when a send ends", () => {
  it("hands back exactly the chips it carried, so chips added meanwhile stay", async () => {
    const { render, dispatched, streams } = harness([READY]);
    const sending = render().send("xem ảnh này");
    expect(render().busy).toBe(true);
    streams[0]?.();
    await sending;
    expect(dispatched).toEqual([{ type: "sent", chipIds: ["chip_1"] }]);
    expect(render().busy).toBe(false);
  });

  it("a send from a session the person already left never changes busy for the current one", async () => {
    const { render, dispatched, streams } = harness([READY]);
    const old = render().send("xem ảnh này");
    render().restartSession();
    expect(render().busy).toBe(false);

    // A newer send in the new conversation, still running when the old one ends.
    const newer = render().send("viết một câu trả lời thật dài");
    expect(render().busy).toBe(true);
    streams[0]?.();
    await old;
    expect(render().busy).toBe(true);
    // Nor does the old send hand back chips: the restart already cleared that session's.
    expect(dispatched).toEqual([{ type: "cleared" }]);

    streams[1]?.();
    await newer;
    expect(render().busy).toBe(false);
  });
});

describe("a command typed while a reply is being written", () => {
  it("sends /settings to the node's app-intent decision and runs the Settings it answers", async () => {
    const decision = { kind: "intent", intent: { kind: "settings.tab", tab: "memory" }, requiresConfirmation: false, readBack: "x" };
    const { render, streams, asked, pending, cleared, notices } = harness([], async () => decision);
    const reply = render().send("viết một câu trả lời thật dài");
    expect(render().busy).toBe(true);

    await render().send("/settings bộ nhớ");
    expect(asked).toEqual([{ text: "/settings bộ nhớ", source: "chat", conversationId: "conv_1" }]);
    expect(pending).toEqual([decision]);
    expect(notices).toEqual([]);
    // Once for the reply that started, once for the command the node answered.
    expect(cleared).toHaveLength(2);

    streams[0]?.();
    await reply;
  });

  it("keeps any other slash command in the draft and says why it waits, rather than doing nothing", async () => {
    const { render, streams, pending, cleared, notices } = harness([]);
    const reply = render().send("viết một câu trả lời thật dài");

    await render().send("/thinking high");
    expect(pending).toEqual([]);
    expect(cleared).toHaveLength(1);
    expect(notices).toEqual(["intents.commandWaits"]);

    streams[0]?.();
    await reply;
  });

  it("says the node could not be asked when the lookup fails, and keeps the draft", async () => {
    const { render, streams, cleared, notices } = harness([], async () => {
      throw new Error("offline");
    });
    const reply = render().send("viết một câu trả lời thật dài");

    await render().send("/settings");
    expect(cleared).toHaveLength(1);
    expect(notices).toEqual(["intents.commandLookupFailed"]);

    streams[0]?.();
    await reply;
  });

  it("leaves an ordinary sentence in the draft without a remark", async () => {
    const { render, streams, notices, cleared } = harness([]);
    const reply = render().send("viết một câu trả lời thật dài");

    await render().send("và thêm một ví dụ nữa");
    expect(notices).toEqual([]);
    expect(cleared).toHaveLength(1);

    streams[0]?.();
    await reply;
  });

  it("starts the new conversation on /new at once, then says the node's read-back: the reply goes on in the one left behind", async () => {
    const readBack = "Started a new conversation. Clark is still finishing the reply in the previous one, which is kept; reopen it any time with /sessions.";
    const decision = { kind: "intent", intent: { kind: "nav.home" }, requiresConfirmation: false, readBack };
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((done) => (answer = done));
    const { render, streams, asked, pending, ran, notices } = harness([], async () => {
      await answered;
      return decision;
    });
    const reply = render().send("viết một câu trả lời thật dài");

    await render().send("/new");
    // Gone home before the node has answered, through the one executor, so what is typed next is the new conversation's.
    expect(ran).toEqual([{ kind: "intent", intent: { kind: "nav.home" }, requiresConfirmation: false, readBack: "" }]);
    expect(asked).toEqual([{ text: "/new", source: "chat", conversationId: "conv_1" }]);
    expect(notices).toEqual([]);

    answer();
    // The node's answer is its record and its read-back: said, and not carried out a second time.
    await vi.waitFor(() => expect(notices).toEqual([readBack]));
    expect(ran).toHaveLength(1);
    expect(pending).toEqual([]);

    streams[0]?.();
    await reply;
  });

  it("stays in the new conversation when the node cannot be told about /new, and leaves a trace instead of a remark", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { render, streams, ran, notices } = harness([], async () => {
        throw new Error("offline");
      });
      const reply = render().send("viết một câu trả lời thật dài");

      await render().send("/new");
      expect(ran).toHaveLength(1);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(notices).toEqual([]);

      streams[0]?.();
      await reply;
    } finally {
      warn.mockRestore();
    }
  });

  it("says a slash command waits when the first message is still on its way and there is no conversation yet", async () => {
    const { render, streams, asked, pending, notices, cleared } = harness([], undefined, { firstMessage: true });
    const first = render().send("viết một câu trả lời thật dài");
    expect(render().busy).toBe(true);

    await render().send("/settings");
    expect(asked).toEqual([]);
    expect(pending).toEqual([]);
    expect(cleared).toHaveLength(1);
    expect(notices).toEqual(["intents.commandWaits"]);

    // An ordinary sentence still waits without a remark.
    await render().send("và thêm một ví dụ nữa");
    expect(notices).toEqual(["intents.commandWaits"]);

    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.();
    await first;
  });
});