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
function harness(chips: readonly Chip[]) {
  hooks.states = [];
  hooks.refs = [];
  const dispatched: unknown[] = [];
  const streams: (() => void)[] = [];
  const client = {
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
      conversationId: "conv_1",
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
      setPendingIntent: noop,
      clearDraft: noop,
      onSendFailed: noop,
      t: (key) => key,
    });
  };
  return { render, dispatched, streams };
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
