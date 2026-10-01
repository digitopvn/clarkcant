import { MEDIA_PLAYBACK_WRITE_INTERVAL_MS, type MediaPlaybackState } from "@clarkcant/contracts";

/** `leave` is the flush sent as the page goes away: it must not wait behind anything, because nothing after it runs. */
export type PlaybackWriteReason = "playing" | "timeupdate" | "pause" | "seek" | "ended" | "flush" | "leave";

export interface PlaybackCoalescer {
  /** Says where the player is; written at once for a transition, otherwise at most once an interval. */
  report: (state: MediaPlaybackState, reason: PlaybackWriteReason) => void;
  /**
   * Forgets what was last written, after the node refused a write: what it holds is no longer what this page sent, so
   * the next report is written even when it matches the refused one. Nothing is resent here, so a node that keeps
   * refusing (offline, a binding withdrawn) is not asked again until the player has something new to say.
   */
  forget: () => void;
}

/** Coalesce frequent media clock events while flushing state transitions immediately. */
export function createPlaybackCoalescer(input: {
  write: (state: MediaPlaybackState, options: { leaving: boolean }) => void;
  now?: () => number;
  intervalMs?: number;
}): PlaybackCoalescer {
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? MEDIA_PLAYBACK_WRITE_INTERVAL_MS;
  let lastWritten: MediaPlaybackState | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;

  return {
    report: (state, reason) => {
      const safe: MediaPlaybackState = {
        status: state.status,
        position: finiteNonNegative(state.position),
        duration: finiteNonNegative(state.duration),
      };
      const transition = lastWritten !== undefined && lastWritten.status !== safe.status;
      const forced =
        reason === "pause" || reason === "seek" || reason === "ended" || reason === "flush" || reason === "leave" || (reason === "playing" && transition);
      const changed = lastWritten === undefined || lastWritten.status !== safe.status || lastWritten.position !== safe.position || lastWritten.duration !== safe.duration;
      if (!changed || (!forced && now() - lastWriteAt < intervalMs)) return;
      lastWritten = safe;
      lastWriteAt = now();
      input.write(safe, { leaving: reason === "leave" });
    },
    forget: () => {
      lastWritten = undefined;
      lastWriteAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** A player that is going away stops where it is: "playing" becomes "paused" at the same place; "ended" stays. */
export function settledPlayback(state: MediaPlaybackState): MediaPlaybackState {
  return state.status === "playing" ? { ...state, status: "paused" } : state;
}

/**
 * Writes where the player is when the page stops being looked at or goes away, so the node is not left holding a
 * "playing" from a player that no longer exists. Hiding the page writes the player as it is (a hidden tab may keep
 * playing); leaving the page, or the player being removed (the returned function), writes it settled. Leaving is
 * reported as "leave", which the host sends at once and with `keepalive` rather than behind a write still in flight.
 * Each is best-effort: a page that is unloading may still not finish the request, which is why the node also stops
 * believing an old "playing" on its own after `MEDIA_PLAYING_FRESH_MS`.
 *
 * `read` returns undefined until the player has reported anything, so a player nobody touched writes nothing.
 */
export function flushPlaybackOnLeave(input: {
  page: EventTarget;
  document: EventTarget & { readonly visibilityState: string };
  read: () => MediaPlaybackState | undefined;
  report: PlaybackCoalescer["report"];
}): () => void {
  const flush = (settle: boolean, reason: PlaybackWriteReason = "flush"): void => {
    const state = input.read();
    if (state !== undefined) input.report(settle ? settledPlayback(state) : state, reason);
  };
  const onVisibility = (): void => {
    if (input.document.visibilityState === "hidden") flush(false);
  };
  const onPageHide = (): void => flush(true, "leave");
  input.document.addEventListener("visibilitychange", onVisibility);
  input.page.addEventListener("pagehide", onPageHide);
  return () => {
    input.document.removeEventListener("visibilitychange", onVisibility);
    input.page.removeEventListener("pagehide", onPageHide);
    flush(true);
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
