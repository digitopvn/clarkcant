/**
 * Whether a pinned live surface keeps running when it is scrolled out of view.
 *
 * Out of view means suspended: the frame is unmounted and its live subscription released. The one exception is a
 * frame whose package was granted a profile with authorized playback, and which the person chose, in host chrome, to
 * keep running. Never the widget's own choice and never the default; while it runs out of view the host says so, with
 * a Stop beside it.
 */

export interface OffscreenPlaybackInput {
  /** Whether the surface is near the viewport. */
  inView: boolean;
  /** Whether the person pressed "Keep playing when scrolled away" for this surface. */
  keepPlaying: boolean;
  /** Whether the surface is an isolated frame, the only kind that can be granted playback. */
  isolatedFrame: boolean;
  /** What the frame's granted profile says it does out of view; absent when the node did not say. */
  offscreen: "suspend" | "authorized-playback" | undefined;
}

export interface OffscreenPlayback {
  /** The profile allows playback, so the host offers the toggle. */
  playbackAllowed: boolean;
  /** The frame stays mounted and subscribed. */
  active: boolean;
  /** It is running while out of view, so the host shows that it is, with a Stop. */
  playingOffscreen: boolean;
}

export function offscreenPlayback(input: OffscreenPlaybackInput): OffscreenPlayback {
  const playbackAllowed = input.isolatedFrame && input.offscreen === "authorized-playback";
  const keptRunning = input.keepPlaying && playbackAllowed;
  return { playbackAllowed, active: input.inView || keptRunning, playingOffscreen: keptRunning && !input.inView };
}
