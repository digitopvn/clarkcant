/**
 * The conversation's periodic re-claim of a live widget's lease.
 *
 * Kept apart from the surface so its two orderings can be driven with a fake clock:
 *
 * - A re-claim that succeeds makes the surface the owner again. Without that, a surface that once found the widget
 *   held elsewhere stayed read-only after the other holder let go, until it was mounted again.
 * - While the surface is handing the widget to a detached window, or the window holds it, no re-claim is sent, and a
 *   re-claim that was already on its way is waited for before the hand-off releases. A re-claim landing after that
 *   release would take the widget back from the window that was about to claim it.
 */
export interface LiveLeaseRefresh {
  /** Stops the timer. A re-claim already sent still lands; `settled()` says when. */
  stop(): void;
  /** Settles once no re-claim is on its way to the node. */
  settled(): Promise<void>;
}

export function refreshLiveLease(input: {
  claim: () => Promise<unknown>;
  /** True while the lease is somebody else's to keep: handing off to, or held by, a detached window. */
  paused: () => boolean;
  onOwner: () => void;
  refreshMs: number;
}): LiveLeaseRefresh {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || input.paused()) return;
    inFlight = input.claim().then(
      () => {
        // Paused since it was sent: the hand-off decides who owns the widget now, not this answer.
        if (!stopped && !input.paused()) input.onOwner();
      },
      () => undefined,
    );
  }, input.refreshMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    settled: () => inFlight,
  };
}
