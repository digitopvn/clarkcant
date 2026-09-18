import { useEffect, useState } from "react";

/**
 * The composer's placeholder, typed and erased one sample phrase at a time.
 *
 * The placeholder is the one piece of copy in the interface that is allowed to move, and it earns
 * that by doing work: an empty composer says nothing about what it accepts, and a sentence being
 * typed says both what it accepts and that it is waiting.
 *
 * The machine below is a pure function of its state so the timing can be tested without a clock, a
 * browser or a fake timer. The hook is a thin timer around it. One state change per character rather
 * than per frame, because a re-render every 16 ms to animate text would be a re-render of the whole
 * conversation every 16 ms.
 */

/** How long each phase lasts. Named, so the pace is one decision rather than four constants. */
export const TYPEWRITER_TIMING = {
  /** Per character while typing. Fast enough to read as typing, slow enough to read as text. */
  typeMs: 62,
  /** How long a finished phrase stays up. Long enough to read a short question. */
  holdMs: 1800,
  /** Per character while erasing. Erasing is faster than typing, as it is in the real thing. */
  eraseMs: 26,
  /** The beat between phrases, so one does not run into the next. */
  pauseMs: 420,
} as const;

export type TypewriterPhase = "typing" | "holding" | "erasing" | "pausing";

export interface TypewriterState {
  /** Which phrase is on screen. */
  index: number;
  /** How many characters of it are visible. */
  length: number;
  phase: TypewriterPhase;
  /** How long the state that produced this one should be shown. */
  delayMs: number;
}

export const EMPTY_TYPEWRITER: TypewriterState = { index: 0, length: 0, phase: "typing", delayMs: TYPEWRITER_TIMING.typeMs };

/**
 * The next state, and how long to wait before asking for the one after it.
 *
 * `delayMs` belongs to the state being returned: the caller shows this state, waits that long, then
 * asks again. Putting the delay on the state that follows would need the caller to know which state
 * it is about to enter, which is the same information twice.
 */
export function nextTypewriterStep(current: TypewriterState, phrases: readonly string[]): TypewriterState {
  const phrase = phrases[current.index] ?? "";
  switch (current.phase) {
    case "typing": {
      if (current.length < phrase.length) {
        return { ...current, length: current.length + 1, delayMs: TYPEWRITER_TIMING.typeMs };
      }
      return { ...current, phase: "holding", delayMs: TYPEWRITER_TIMING.holdMs };
    }
    case "holding":
      // Only reachable with a phrase on screen: an empty phrase holds for nothing and moves on, so a
      // blank entry in the list cannot become a placeholder that never changes.
      return phrase.length === 0 || current.length === 0
        ? { index: nextIndex(current.index, phrases.length), length: 0, phase: "typing", delayMs: TYPEWRITER_TIMING.pauseMs }
        : { ...current, phase: "erasing", length: current.length - 1, delayMs: TYPEWRITER_TIMING.eraseMs };
    case "erasing":
      return current.length > 0
        ? { ...current, length: current.length - 1, delayMs: TYPEWRITER_TIMING.eraseMs }
        : { ...current, length: 0, phase: "pausing", delayMs: TYPEWRITER_TIMING.pauseMs };
    case "pausing":
      return { index: nextIndex(current.index, phrases.length), length: 0, phase: "typing", delayMs: TYPEWRITER_TIMING.typeMs };
  }
}

function nextIndex(index: number, count: number): number {
  return count === 0 ? 0 : (index + 1) % count;
}

/** What a state looks like on screen. */
export function typewriterText(state: TypewriterState, phrases: readonly string[]): string {
  return (phrases[state.index] ?? "").slice(0, state.length);
}

/**
 * A placeholder that types itself, or nothing when it is not wanted.
 *
 * `active` is false once the conversation has started, and it is also false while the user is
 * typing: the placeholder is invisible behind a draft, and animating something nobody can see is
 * both wasted work and a source of surprise when the field is cleared again.
 *
 * Reduced motion gets the first phrase and no movement. A user who has asked the system not to
 * animate has asked for this too, and a placeholder that types at them is exactly the kind of
 * decoration that request exists to turn off.
 */
export function useTypewriterPlaceholder(phrases: readonly string[], active: boolean): string {
  const [state, setState] = useState<TypewriterState>(EMPTY_TYPEWRITER);
  const still = prefersReducedMotion();

  useEffect(() => {
    if (!active || still || phrases.length === 0) return;
    const timer = window.setTimeout(() => {
      setState((current) => nextTypewriterStep(current, phrases));
    }, state.delayMs);
    return () => window.clearTimeout(timer);
  }, [active, still, phrases, state.delayMs]);

  if (!active) return "";
  return still ? (phrases[0] ?? "") : typewriterText(state, phrases);
}

/** Whether the user has asked for less motion. Read at the moment it is asked for, not cached. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
