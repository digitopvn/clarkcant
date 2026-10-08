import { describe, expect, it, vi } from "vitest";

/**
 * The send lifecycle, without a browser.
 *
 * The hook is run once against a stand-in for React's hooks that records every state write, because what matters here
 * is what a send does when it ends: which chips it hands back and whether it touches the busy flag. A real render adds
 * nothing to either; the browser journeys cover the screen.
 */

const writes: { name: string; value: unknown }[] = [];
let stateIndex = 0;
const STATE_NAMES = ["busy", "error", "chipsKept", "pendingUser", "live"];

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const name = STATE_NAMES[stateIndex] ?? `state${stateIndex}`;
    stateIndex += 1;
    return [initial, (value: unknown) => writes.push({ name, value })];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
}));

const { useTurnSend } = await import("../src/use-turn-send.ts");
type Deps = Parameters<typeof useTurnSend>[0];
type Chip = Deps["chips"][number];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(chips: readonly Chip[], streamEnds: Promise<void>) {
  writes.length = 0;
  stateIndex = 0;
  const dispatched: unknown[] = [];
  const client = {
    createConversation: async () => ({ conversationId: "conv_1" }),
    streamMessage: async (
      _target: string,
      _text: string,
      handlers: { onDone: (result: unknown) => void },
    ): Promise<void> => {
      await streamEnds;
      handlers.onDone({ resolution: "model", timeline: { messages: [] } });
    },
  };
  const noop = (): void => undefined;
  const state = useTurnSend({
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
  return { state, dispatched };
}

const busyWrites = (): unknown[] => writes.filter((entry) => entry.name === "busy").map((entry) => entry.value);

const READY: Chip = { id: "chip_1", filename: "a.png", mime: "image/png", sizeBytes: 10, state: "ready", attachmentId: "att_1" };

describe("when a send ends", () => {
  it("hands back exactly the attachment ids it carried, so chips added meanwhile stay", async () => {
    const stream = deferred();
    const { state, dispatched } = render([READY], stream.promise);
    const sending = state.send("xem ảnh này");
    stream.resolve();
    await sending;
    expect(dispatched).toEqual([{ type: "sent", attachmentIds: ["att_1"] }]);
    expect(busyWrites()).toEqual([true, false]);
  });

  it("a send from a session the person already left never changes busy for the current one", async () => {
    const stream = deferred();
    const { state, dispatched } = render([READY], stream.promise);
    const sending = state.send("xem ảnh này");
    // Let the send reach the stream before the person starts over.
    await Promise.resolve();
    await Promise.resolve();
    state.restartSession();
    const afterRestart = busyWrites();
    expect(afterRestart).toEqual([true, false]);

    stream.resolve();
    await sending;
    // The restart ended the old send's busy state; a newer send may now be running, and the old one leaves it alone.
    expect(busyWrites()).toEqual(afterRestart);
    // Nor does it hand back chips: the restart already cleared that session's.
    expect(dispatched).toEqual([{ type: "cleared" }]);
  });
});
