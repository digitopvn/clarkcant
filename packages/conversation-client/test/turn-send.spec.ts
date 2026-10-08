import { describe, expect, it, vi } from "vitest";

/**
 * The send lifecycle, without a browser.
 *
 * The hook runs against a small stand-in for React's hooks that keeps state and refs between renders, so a test can
 * render again and read `busy` from what the hook returns, the way a component would. What matters here is what a send
 * does when it ends: which chips it hands back and whether it touches the busy flag. The browser journeys cover the
 * screen.
 */

/**
 * Effects run only for a harness that asks for them (`runEffects`), after each render whose dependencies changed, the
 * way React runs them: enough to move the page's own marks when the conversation on screen changes.
 */
const hooks = {
  states: [] as { value: unknown }[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps: readonly unknown[] | undefined }[],
  state: 0,
  ref: 0,
  effect: 0,
  runEffects: false,
};

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
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    const slot = hooks.effects[hooks.effect];
    hooks.effect += 1;
    if (!hooks.runEffects) return;
    const changed = slot === undefined || deps === undefined || slot.deps === undefined || deps.some((value, index) => !Object.is(value, slot.deps?.[index]));
    hooks.effects[hooks.effect - 1] = { deps };
    if (changed) effect();
  },
}));

const { useTurnSend } = await import("../src/use-turn-send.ts");
type Deps = Parameters<typeof useTurnSend>[0];
type Chip = Deps["chips"][number];

/** Each stream waits until the test ends it, so a send can be held in flight across a restart. */
function harness(
  chips: readonly Chip[],
  appIntent: (request: { text: string }) => Promise<unknown> = async () => ({ kind: "none" }),
  options: { firstMessage?: boolean; goHome?: boolean; live?: boolean } = {},
) {
  /**
   * What the page shows. A first message has no conversation yet: the page learns its id only once the node made it.
   * A `live` harness follows the conversation the hook sets and runs effects, as the page does; the others keep the
   * conversation fixed, so a test reads exactly one send at a time.
   */
  const screen = { conversationId: options.firstMessage === true ? undefined : ("conv_1" as string | undefined), chips };
  hooks.states = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.runEffects = options.live === true;
  /** Files stored again in a new conversation after a restart left theirs. */
  const carried: (readonly Chip[])[] = [];
  const dispatched: unknown[] = [];
  const streams: (() => void)[] = [];
  const asked: unknown[] = [];
  const pending: unknown[] = [];
  const ran: unknown[] = [];
  const notices: string[] = [];
  const cleared: number[] = [];
  /** The composer, as the page holds it: a command typed during a reply stays in it while the node reads it. */
  const draft = { value: "" };
  const client = {
    sendAppIntent: (request: { text: string }) => {
      asked.push(request);
      return appIntent(request);
    },
    // A live page's next conversation is a new one; the fixed harness only ever shows one.
    createConversation: async () => ({ conversationId: options.live === true ? "conv_2" : "conv_1" }),
    streamMessage: async (_target: string, _text: string, handlers: { onDone: (result: unknown) => void }) => {
      await new Promise<void>((done) => streams.push(done));
      handlers.onDone({ resolution: "model", timeline: { messages: [] } });
    },
  };
  const noop = (): void => undefined;
  const render = (): ReturnType<typeof useTurnSend> => {
    hooks.state = 0;
    hooks.ref = 0;
    hooks.effect = 0;
    return useTurnSend({
      client: client as never,
      conversationId: screen.conversationId,
      setConversationId: (id) => {
        if (options.live === true) screen.conversationId = id;
      },
      onConversationReady: undefined,
      onSessionReset: undefined,
      applyTimeline: noop,
      timeline: undefined,
      setTimeline: noop,
      chips: screen.chips,
      dispatchChips: (action) => dispatched.push(action),
      readChips: () => screen.chips,
      carryChips: (moving) => carried.push(moving),
      chosenReferences: [],
      onReferencesSent: noop,
      beginHeroExit: noop,
      resetHero: noop,
      setDatasets: noop,
      setSnapshots: noop,
      setPendingIntent: (decision) => pending.push(decision),
      runIntent: (decision) => {
        ran.push(decision);
        // Going home is the restart, as the page's own executor does it.
        if (options.goHome === true && decision.kind === "intent" && decision.intent.kind === "nav.home") render().restartSession();
      },
      onNotice: (text) => notices.push(text),
      clearDraft: () => {
        cleared.push(1);
        draft.value = "";
      },
      readDraft: () => draft.value,
      onSendFailed: (text) => (draft.value = text),
      t: (key) => key,
    });
  };
  /** Another conversation on screen, the way voice, a file on the start screen or `/sessions` puts one there. */
  const open = (id: string): void => {
    screen.conversationId = id;
    render();
  };
  return { render, dispatched, streams, asked, pending, ran, notices, cleared, draft, screen, carried, open };
}

const READY: Chip = { id: "chip_1", filename: "a.png", mime: "image/png", sizeBytes: 10, state: "ready", attachmentId: "att_1" };
/** A file attached for the next message while a command was being read. */
const FILE: Chip = { id: "chip_2", filename: "bao-cao.pdf", mime: "application/pdf", sizeBytes: 20, state: "ready", attachmentId: "att_2" };

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
    const { render, streams, asked, pending, cleared, notices, draft } = harness([], async () => decision);
    const reply = render().send("viết một câu trả lời thật dài");
    expect(render().busy).toBe(true);

    draft.value = "/settings bộ nhớ";
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

  it("stays in the new conversation when the node cannot be told about /new, keeps a trace, and says itself what was kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { render, streams, ran, notices } = harness([], async () => {
        throw new Error("offline");
      });
      const reply = render().send("viết một câu trả lời thật dài");

      await render().send("/new");
      expect(ran).toHaveLength(1);
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      // The node's read-back will not come, so the page says what it knows: leaving did not stop that reply, and the
      // conversation is kept for /sessions. Not "could not ask the node": nothing the person asked for failed.
      expect(notices).toEqual(["intents.newConversationKeptReplying"]);

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
describe("a new conversation asked for during a reply, answered late", () => {
  const HOME = { kind: "intent", intent: { kind: "nav.home" }, requiresConfirmation: false, readBack: "Started a new conversation." } as const;

  /** An app-intent answer the test releases, so the person can act in between. */
  function held<T>(outcome: () => T) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    return { answer: async () => { await gate; return outcome(); }, release };
  }

  it("keeps a draft edited after Enter on a sentence, rather than the late restart emptying it", async () => {
    const node = held(() => HOME);
    const { render, streams, ran, pending, draft } = harness([], node.answer, { goHome: true });
    const reply = render().send("viết một câu trả lời thật dài");

    draft.value = "về trang chủ";
    const asking = render().send("về trang chủ");
    // Before the node has read the sentence, the person starts the next message in the composer.
    draft.value = "câu tiếp theo";
    node.release();
    await asking;

    // Home, through the one executor, and the edited draft is still there after the restart.
    expect(ran).toEqual([HOME]);
    expect(pending).toEqual([]);
    expect(draft.value).toBe("câu tiếp theo");
    expect(render().busy).toBe(false);

    streams[0]?.();
    await reply;
  });

  it("still clears the sentence itself when it was not edited", async () => {
    const node = held(() => HOME);
    const { render, streams, pending, draft } = harness([], node.answer);
    const reply = render().send("viết một câu trả lời thật dài");

    draft.value = "về trang chủ";
    const asking = render().send("về trang chủ");
    node.release();
    await asking;

    expect(draft.value).toBe("");
    expect(pending).toEqual([HOME]);

    streams[0]?.();
    await reply;
  });

  it("drops /new's late read-back once a message was sent in the new conversation, and says only that the one left is kept", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const node = held(() => HOME);
      const { render, streams, notices, screen } = harness([], node.answer, { goHome: true, live: true });
      const reply = render().send("viết một câu trả lời thật dài");

      await render().send("/new");
      expect(render().busy).toBe(false);
      // The person's first message in the new conversation, sent before the node answered /new.
      const next = render().send("câu hỏi mới");
      await vi.waitFor(() => expect(streams).toHaveLength(2));
      expect(screen.conversationId).toBe("conv_2");
      node.release();
      await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
      // Not "Started a new conversation" over the message just sent: where the earlier reply went, which still holds.
      expect(notices).toEqual(["intents.leftConversationKept"]);

      streams[0]?.();
      streams[1]?.();
      await Promise.all([reply, next]);
    } finally {
      info.mockRestore();
    }
  });

  it("drops what the page would say when the node cannot be told, once the person has moved on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const node = held(() => {
        throw new Error("offline");
      });
      const { render, streams, notices } = harness([], node.answer, { goHome: true, live: true });
      const reply = render().send("viết một câu trả lời thật dài");

      await render().send("/new");
      // Another restart (the logo) before the failure lands: the remark belongs to a start the page has left.
      render().restartSession();
      node.release();
      await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(notices).toEqual(["intents.leftConversationKept"]);

      streams[0]?.();
      await reply;
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("still says the read-back while the new conversation is untouched", async () => {
    const node = held(() => HOME);
    const { render, streams, notices, draft } = harness([], node.answer, { goHome: true });
    const reply = render().send("viết một câu trả lời thật dài");

    await render().send("/new");
    // A draft typed but not sent leaves the person on the same start.
    draft.value = "một câu chưa gửi";
    node.release();
    await vi.waitFor(() => expect(notices).toEqual([HOME.readBack]));
    expect(draft.value).toBe("một câu chưa gửi");

    streams[0]?.();
    await reply;
  });

  it("keeps a file attached after Enter along with the kept text, stored again in the new conversation", async () => {
    const node = held(() => HOME);
    const { render, streams, ran, draft, screen, carried } = harness([], node.answer, { goHome: true });
    const reply = render().send("viết một câu trả lời thật dài");

    draft.value = "cuộc trò chuyện mới";
    const asking = render().send("cuộc trò chuyện mới");
    // While the node reads the sentence, the person attaches a file and starts the message about it.
    screen.chips = [FILE];
    draft.value = "xem file này";
    node.release();
    await asking;

    expect(ran).toEqual([HOME]);
    expect(draft.value).toBe("xem file này");
    // The file was stored in the conversation left behind, where the node would refuse it: it goes with the text.
    expect(carried).toEqual([[FILE]]);

    streams[0]?.();
    await reply;
  });

  it("keeps a file attached after Enter even when the sentence was not edited, and clears the sentence", async () => {
    const node = held(() => HOME);
    const { render, streams, ran, pending, draft, screen, carried } = harness([], node.answer, { goHome: true });
    const reply = render().send("viết một câu trả lời thật dài");

    draft.value = "cuộc trò chuyện mới";
    const asking = render().send("cuộc trò chuyện mới");
    screen.chips = [FILE];
    node.release();
    await asking;

    expect(ran).toEqual([HOME]);
    expect(pending).toEqual([]);
    expect(draft.value).toBe("");
    expect(carried).toEqual([[FILE]]);

    streams[0]?.();
    await reply;
  });

  it("carries only the files attached after Enter, and none when the answer did not leave the conversation", async () => {
    const SETTINGS = { kind: "intent", intent: { kind: "settings.open" }, requiresConfirmation: false, readBack: "" } as const;
    const node = held(() => SETTINGS);
    const { render, streams, ran, draft, screen, carried } = harness([READY], node.answer, { goHome: true });
    const reply = render().send("viết một câu trả lời thật dài");

    draft.value = "mở cài đặt";
    const asking = render().send("mở cài đặt");
    screen.chips = [READY, FILE];
    node.release();
    await asking;

    // Settings opened over the same conversation, so the file is still stored where it is, and nothing moves.
    expect(ran).toEqual([SETTINGS]);
    expect(draft.value).toBe("");
    expect(carried).toEqual([]);

    streams[0]?.();
    await reply;
  });
});

describe("a conversation opened another way before /new's late answer", () => {
  const HOME = { kind: "intent", intent: { kind: "nav.home" }, requiresConfirmation: false, readBack: "Started a new conversation." } as const;

  /** `/new` during a reply on a live page, with the node's answer held until the test releases it. */
  function leftDuringReply() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const page = harness([], async () => {
      await gate;
      return HOME;
    }, { goHome: true, live: true });
    // The first render, as the page draws the conversation it starts on.
    page.render();
    return { ...page, release };
  }

  // Voice, a file dropped on the start screen and /sessions all put a conversation on screen the same way: the page sets
  // the conversation it shows, and the hook only sees that id change.
  for (const route of ["voice", "a file", "/sessions"]) {
    it(`says that the conversation left is kept, not the read-back, once ${route} opened another one`, async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      try {
        const { render, streams, notices, screen, open, release } = leftDuringReply();
        const reply = render().send("viết một câu trả lời thật dài");

        await render().send("/new");
        // The page draws the start screen the restart left it on, then the other conversation.
        render();
        expect(screen.conversationId).toBeUndefined();
        open(`conv_${route}`);
        release();
        await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
        expect(notices).toEqual(["intents.leftConversationKept"]);

        streams[0]?.();
        await reply;
      } finally {
        info.mockRestore();
      }
    });
  }

  it("says nothing once /sessions reopened the very conversation left behind", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { render, streams, notices, open, release } = leftDuringReply();
      const reply = render().send("viết một câu trả lời thật dài");

      await render().send("/new");
      render();
      open("conv_1");
      release();
      await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
      // The reply is on screen again, and answers for itself.
      expect(notices).toEqual([]);

      streams[0]?.();
      await reply;
    } finally {
      info.mockRestore();
    }
  });
});