import type { MediaPlaybackState } from "@clarkcant/contracts";

export type PlaybackWriteReason = "playing" | "timeupdate" | "pause" | "seek" | "ended" | "flush";

/** Coalesce frequent media clock events while flushing state transitions immediately. */
export function createPlaybackCoalescer(input: {
  write: (state: MediaPlaybackState) => void;
  now?: () => number;
  intervalMs?: number;
}): (state: MediaPlaybackState, reason: PlaybackWriteReason) => void {
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? 3_000;
  let lastWritten: MediaPlaybackState | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;

  return (state, reason) => {
    const safe: MediaPlaybackState = {
      status: state.status,
      position: finiteNonNegative(state.position),
      duration: finiteNonNegative(state.duration),
    };
    const transition = lastWritten !== undefined && lastWritten.status !== safe.status;
    const forced = reason === "pause" || reason === "seek" || reason === "ended" || reason === "flush" || (reason === "playing" && transition);
    const changed = lastWritten === undefined || lastWritten.status !== safe.status || lastWritten.position !== safe.position || lastWritten.duration !== safe.duration;
    if (!changed || (!forced && now() - lastWriteAt < intervalMs)) return;
    lastWritten = safe;
    lastWriteAt = now();
    input.write(safe);
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
