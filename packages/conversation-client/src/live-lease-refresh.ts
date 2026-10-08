/**
 * The conversation's periodic re-claim of a live widget's lease.
 *
 * Kept apart from the surface so its orderings can be driven with a fake clock:
 *
 * - A re-claim that succeeds makes the surface the owner again. Without that, a surface that once found the widget
 *   held elsewhere stayed read-only after the other holder let go, until it was mounted again.
 * - While the surface is handing the widget to a detached window, or the window holds it, no re-claim is sent, and a
 *   re-claim that was already on its way is waited for before the hand-off releases. A re-claim landing after that
 *   release would take the widget back from the window that was about to claim it.
 * - One re-claim at a time. A node slow to answer does not collect a queue of re-claims, and the one on its way is
 *   the only one a hand-off has to wait for.
 */
export interface LiveLeaseRefresh {
  /** Stops the timer. A re-claim already sent still lands; `settled()` says when. */
  stop(): void;
  /**
   * Settles once no re-claim is on its way to the node, or once `withinMs` has passed, whichever is first.
   *
   * Bounded so a node that never answers does not stall the hand-off that waits on it. Past the bound the hand-off
   * goes ahead: a re-claim landing after its release takes the widget back, the detached window's claim is then
   * refused, and the conversation keeps the widget. Nobody ends up as a second owner.
   */
  settled(withinMs?: number): Promise<void>;
}

/** How long a hand-off waits for a re-claim still on its way before it goes ahead. */
export const HANDOFF_WAIT_MS = 5_000;

/**
 * How long one re-claim may take before it counts as failed.
 *
 * Well inside the refresh interval. Re-claims go one at a time, so without a deadline a single re-claim the node never
 * answers would stop every later one, and the lease would lapse while the surface still said it held it. A timed-out
 * re-claim makes nobody the owner; the next tick tries again.
 */
export const RECLAIM_TIMEOUT_MS = 10_000;

export function refreshLiveLease(input: {
  claim: () => Promise<unknown>;
  /** True while the lease is somebody else's to keep: handing off to, or held by, a detached window. */
  paused: () => boolean;
  onOwner: () => void;
  refreshMs: number;
  claimTimeoutMs?: number;
}): LiveLeaseRefresh {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight !== undefined || input.paused()) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      deadline = setTimeout(() => resolve(false), input.claimTimeoutMs ?? RECLAIM_TIMEOUT_MS);
    });
    const answered = input.claim().then(
      () => true,
      () => false,
    );
    const sent = Promise.race([answered, timedOut]).then((claimed) => {
      clearTimeout(deadline);
      // Paused since it was sent: the hand-off decides who owns the widget now, not this answer.
      if (claimed && !stopped && !input.paused()) input.onOwner();
    });
    inFlight = sent.finally(() => {
      inFlight = undefined;
    });
  }, input.refreshMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    settled: (withinMs = HANDOFF_WAIT_MS) => {
      const pending = inFlight;
      if (pending === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const bound = setTimeout(resolve, withinMs);
        void pending.then(() => {
          clearTimeout(bound);
          resolve();
        });
      });
    },
  };
}
