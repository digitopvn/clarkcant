/**
 * What a widget says it shows, sent to the node once it stops changing — and sent before a press the widget makes.
 *
 * A widget may publish on every keystroke, so publishes settle: only the last of a burst is sent, once the burst has
 * been quiet for `settleMs`. A press can read that description (an `agent` button's `selection:` and `widget:` context),
 * so before such a press runs, `flush` sends whatever is still settling and waits until the node has answered it.
 *
 * - **Order.** Every description gets a sequence number. One send is in flight at a time, and at most one more waits
 *   behind it — the newest; an older one waiting is dropped. So an older description can never land after a newer one,
 *   and a retry only ever re-sends the newest description there is.
 * - **Bounds.** Each send is aborted after `sendTimeoutMs`, so one stalled request cannot hold back the sends after it,
 *   and `flush` gives up after `flushTimeoutMs`, so it cannot hold a press for ever.
 * - **Failure.** When the newest description failed, `flush` tries it once more. When that fails too, or the wait runs
 *   out, `flush` rejects: the press should not run against a description the node may not hold.
 * - **What a press waits for.** `owes()` says whether the frame still has something to deliver that nothing is
 *   delivering: a description settling, or a newest one that failed. `pending()` says whether a send is on its way. A
 *   press that reads the description waits for either; any other press waits only for what is owed, so a slow send it
 *   does not read cannot hold it up.
 */

export interface SemanticSettlerOptions<T> {
  settleMs: number;
  /** How long one send may take before it is aborted and counted as failed. */
  sendTimeoutMs?: number;
  /** How long `flush` waits in all before it rejects. */
  flushTimeoutMs?: number;
  /** Send one description to the node. Rejects when the node did not take it; should stop when `signal` aborts. */
  send: (proposal: T, signal: AbortSignal) => Promise<void>;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface SemanticSettler<T> {
  /** A new description; it is sent once publishes have been quiet for the settle period. */
  publish(proposal: T): void;
  /** Whether a description is settling, or the newest one sent failed: something still to deliver. */
  owes(): boolean;
  /** Whether a send is on its way to the node, or waiting behind one that is. */
  pending(): boolean;
  /**
   * Send what is still settling now, and resolve once the node holds the description that was newest when `flush` was
   * called, or a newer one. Descriptions published after that are sent as usual but not waited for.
   */
  flush(): Promise<void>;
  /** Drop anything still settling or waiting, and abort the send in flight. */
  dispose(): void;
}

/** Why a send or a flush gave up: the node did not answer in time. */
export class SemanticFlushTimeout extends Error {
  constructor() {
    super("the widget's description was not answered in time");
    this.name = "SemanticFlushTimeout";
  }
}

export const SEMANTIC_SEND_TIMEOUT_MS = 5_000;
export const SEMANTIC_FLUSH_TIMEOUT_MS = 8_000;

interface Entry<T> {
  seq: number;
  proposal: T;
}

export function createSemanticSettler<T>(options: SemanticSettlerOptions<T>): SemanticSettler<T> {
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const sendTimeoutMs = options.sendTimeoutMs ?? SEMANTIC_SEND_TIMEOUT_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? SEMANTIC_FLUSH_TIMEOUT_MS;

  let seq = 0;
  let settleTimer: unknown;
  let settling: Entry<T> | undefined;
  let inFlight: { entry: Entry<T>; controller: AbortController } | undefined;
  let queued: Entry<T> | undefined;
  /** The answer for the newest description sent so far. Older answers never overwrite it. */
  let answered: { entry: Entry<T>; ok: boolean; error?: unknown } | undefined;
  let answerWaiters: (() => void)[] = [];
  let disposed = false;

  const idle = (): boolean => inFlight === undefined && queued === undefined;

  const notifyAnswered = (): void => {
    const waiters = answerWaiters;
    answerWaiters = [];
    for (const wake of waiters) wake();
  };

  const record = (entry: Entry<T>, ok: boolean, error?: unknown): void => {
    if (answered !== undefined && answered.entry.seq > entry.seq) return;
    answered = ok ? { entry, ok } : { entry, ok, error };
  };

  const start = (entry: Entry<T>): void => {
    const controller = new AbortController();
    inFlight = { entry, controller };
    const timer = setTimer(() => controller.abort(new SemanticFlushTimeout()), sendTimeoutMs);
    // Bounded even when `send` ignores the signal: the abort settles this race, and the next send can start.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    Promise.race([Promise.resolve().then(() => options.send(entry.proposal, controller.signal)), aborted])
      .then(
        () => record(entry, true),
        (error: unknown) => record(entry, false, error),
      )
      .finally(() => {
        clearTimer(timer);
        inFlight = undefined;
        const next = queued;
        queued = undefined;
        if (next !== undefined && !disposed) start(next);
        notifyAnswered();
      });
  };

  const enqueue = (entry: Entry<T>): void => {
    if (disposed) return;
    if (inFlight === undefined) start(entry);
    // Only the newest waits behind the one in flight; an older one waiting would only be overwritten by it.
    else if (queued === undefined || queued.seq < entry.seq) queued = entry;
  };

  const sendSettling = (): void => {
    if (settleTimer !== undefined) clearTimer(settleTimer);
    settleTimer = undefined;
    const next = settling;
    settling = undefined;
    if (next !== undefined) enqueue(next);
  };

  const nextAnswer = (): Promise<void> => new Promise<void>((resolve) => answerWaiters.push(resolve));

  /** The newest description failed, and nothing newer exists: the one case worth a retry. */
  const newestFailed = (): Entry<T> | undefined =>
    answered !== undefined && !answered.ok && answered.entry.seq === seq ? answered.entry : undefined;

  /**
   * Wait until the node holds description `target` or a newer one. Publishes made after the flush began are not waited
   * for: they only count when they happen to be what answers `target`, so a widget that keeps publishing cannot keep a
   * press waiting.
   */
  const drain = async (target: number): Promise<void> => {
    let retried = false;
    for (;;) {
      if (answered !== undefined && answered.ok && answered.entry.seq >= target) return;
      if (disposed) throw new Error("the frame went away");
      const onItsWay =
        (inFlight !== undefined && inFlight.entry.seq >= target) || (queued !== undefined && queued.seq >= target);
      if (onItsWay) {
        await nextAnswer();
        continue;
      }
      // Still settling: `target` itself, or a newer description that replaced it before it was sent.
      if (settling !== undefined) {
        sendSettling();
        continue;
      }
      // Nothing at or after `target` is on its way, so the newest answer for it failed (or nothing was published).
      if (answered === undefined || answered.entry.seq < target) return;
      if (retried) {
        const error = answered.error;
        throw error instanceof Error ? error : new Error(String(error));
      }
      retried = true;
      enqueue(answered.entry);
    }
  };

  return {
    publish(proposal) {
      if (disposed) return;
      seq += 1;
      settling = { seq, proposal };
      if (settleTimer !== undefined) clearTimer(settleTimer);
      settleTimer = setTimer(sendSettling, options.settleMs);
    },
    owes() {
      return settling !== undefined || newestFailed() !== undefined;
    },
    pending() {
      return !idle();
    },
    flush() {
      let deadline: unknown;
      const timedOut = new Promise<never>((_, reject) => {
        deadline = setTimer(() => reject(new SemanticFlushTimeout()), flushTimeoutMs);
      });
      return Promise.race([drain(seq), timedOut]).finally(() => clearTimer(deadline));
    },
    dispose() {
      disposed = true;
      if (settleTimer !== undefined) clearTimer(settleTimer);
      settleTimer = undefined;
      settling = undefined;
      queued = undefined;
      inFlight?.controller.abort(new Error("the frame went away"));
    },
  };
}

/**
 * Whether a press must wait for the widget's description before it runs.
 *
 * A press that reads the description (its binding names `contextRefs`) waits while anything is owed or on its way, so
 * it never runs against an older description than the one published before it. Any other press waits only while
 * something is owed — settling, or failed last — and not for a send already on its way, which it does not read.
 */
export function pressMustWait(settler: Pick<SemanticSettler<unknown>, "owes" | "pending">, readsContext: boolean): boolean {
  return settler.owes() || (readsContext && settler.pending());
}

/**
 * Run a press once the widget's description is where the press needs it, or refuse it with `refusal` when that cannot
 * be done in time. The refusal is the host's own localized sentence; the transport's reason is not shown to the person.
 */
export async function gatePress<R>(
  settler: Pick<SemanticSettler<unknown>, "owes" | "pending" | "flush">,
  readsContext: boolean,
  run: () => Promise<R>,
  refusal: () => R,
): Promise<R> {
  if (pressMustWait(settler, readsContext)) {
    try {
      await settler.flush();
    } catch {
      return refusal();
    }
  }
  return run();
}
