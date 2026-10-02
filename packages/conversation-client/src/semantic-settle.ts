/**
 * What a widget says it shows, sent to the node once it stops changing — and sent before any press the widget makes.
 *
 * A widget may publish on every keystroke, so publishes settle: only the last of a burst is sent, once the burst has
 * been quiet for `settleMs`. A press can read that description (an `agent` button's `selection:` and `widget:` context),
 * so before a press runs, `flush` sends whatever is still settling and waits until every send has been answered. Sends
 * go one at a time, in order, so an older description can never land after a newer one. When the last one failed it is
 * tried once more; when that fails too, `flush` rejects and the press should not run against a description the node
 * does not hold.
 */

export interface SemanticSettlerOptions<T> {
  settleMs: number;
  /** Send one description to the node. Rejects when the node did not take it. */
  send: (proposal: T) => Promise<void>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface SemanticSettler<T> {
  /** A new description; it is sent once publishes have been quiet for the settle period. */
  publish(proposal: T): void;
  /** Send what is still settling now, and resolve once the node holds the latest description. */
  flush(): Promise<void>;
  /** Drop anything still settling. Sends already started are left to finish. */
  dispose(): void;
}

export function createSemanticSettler<T>(options: SemanticSettlerOptions<T>): SemanticSettler<T> {
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let waiting: { proposal: T } | undefined;
  /** The last description handed to `send`, and whether the node took it. */
  let last: { proposal: T; ok: boolean } | undefined;
  let chain: Promise<void> = Promise.resolve();

  const sendInOrder = (proposal: T): Promise<void> => {
    const sent = chain.then(async () => {
      try {
        await options.send(proposal);
        last = { proposal, ok: true };
      } catch (cause) {
        last = { proposal, ok: false };
        throw cause;
      }
    });
    // The chain itself never rejects, so one failed send does not stop the ones after it.
    chain = sent.catch(() => undefined);
    return sent;
  };

  const sendWaiting = (): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const next = waiting;
    waiting = undefined;
    if (next !== undefined) void sendInOrder(next.proposal).catch(() => undefined);
  };

  return {
    publish(proposal) {
      waiting = { proposal };
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(sendWaiting, options.settleMs);
    },
    async flush() {
      sendWaiting();
      await chain;
      if (last !== undefined && !last.ok) await sendInOrder(last.proposal);
    },
    dispose() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      waiting = undefined;
    },
  };
}
