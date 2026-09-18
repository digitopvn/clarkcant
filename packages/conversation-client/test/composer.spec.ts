import { describe, expect, it } from "vitest";

import { COMPOSER_MAX_LINES, composerTextareaHeight } from "../src/composer-height.ts";
import {
  EMPTY_TYPEWRITER,
  TYPEWRITER_TIMING,
  nextTypewriterStep,
  typewriterText,
  type TypewriterState,
} from "../src/typewriter.ts";

/**
 * The composer's two machines.
 *
 * Both are pure so that what they decide can be read back without a browser, a clock or a fake timer.
 * The typewriter in particular is a thing that is easy to get wrong in a way nobody notices for a
 * while — a phrase that never erases, an empty phrase that holds forever — and every one of those is
 * a step of a function that can simply be asked.
 */

const PHRASES = ["có cập nhật gì mới không?", "cần làm gì hôm nay?"] as const;

/** Run the machine forward until it does something interesting, or until the budget runs out. */
function run(state: TypewriterState, steps: number, phrases: readonly string[] = PHRASES): TypewriterState[] {
  const seen: TypewriterState[] = [state];
  let current = state;
  for (let index = 0; index < steps; index += 1) {
    current = nextTypewriterStep(current, phrases);
    seen.push(current);
  }
  return seen;
}

describe("the composer's typing placeholder", () => {
  it("builds a phrase one character at a time", () => {
    const states = run(EMPTY_TYPEWRITER, 3);
    expect(states.map((state) => typewriterText(state, PHRASES))).toEqual(["", "c", "có", "có "]);
  });

  it("stops at the end of the phrase and holds it", () => {
    const phrase = PHRASES[0];
    let state = EMPTY_TYPEWRITER;
    for (let index = 0; index < phrase.length; index += 1) state = nextTypewriterStep(state, PHRASES);
    expect(typewriterText(state, PHRASES)).toBe(phrase);

    const holding = nextTypewriterStep(state, PHRASES);
    expect(holding.phase).toBe("holding");
    expect(holding.delayMs).toBe(TYPEWRITER_TIMING.holdMs);
    // Held, not extended: a step that added a character here would type past the end of the string.
    expect(typewriterText(holding, PHRASES)).toBe(phrase);
  });

  it("erases what it typed, and moves to the next phrase", () => {
    const states = run({ index: 0, length: 2, phase: "holding", delayMs: 0 }, 5);
    const phases = states.map((state) => state.phase);
    expect(phases).toEqual(["holding", "erasing", "erasing", "pausing", "typing", "typing"]);
    // The phrase after the pause is the next one, and it starts empty rather than mid-word.
    expect(states[4]?.index).toBe(1);
    expect(typewriterText(states[4] as TypewriterState, PHRASES)).toBe("");
  });

  it("comes back to the first phrase, so the list is a cycle", () => {
    // The index moves when the pause is over, so this is the step that follows it.
    const state = nextTypewriterStep({ index: PHRASES.length - 1, length: 0, phase: "pausing", delayMs: 0 }, PHRASES);
    expect(state.index).toBe(0);
    expect(state.phase).toBe("typing");
  });

  it("does not hold on an empty phrase, which would be a placeholder that never changes", () => {
    const state = nextTypewriterStep({ index: 0, length: 0, phase: "holding", delayMs: 0 }, [""]);
    expect(state.phase).toBe("typing");
    expect(state.length).toBe(0);
  });

  it("survives an empty list, which is how a caller disables it", () => {
    const state = nextTypewriterStep(EMPTY_TYPEWRITER, []);
    expect(typewriterText(state, [])).toBe("");
    expect(Number.isFinite(state.delayMs)).toBe(true);
  });

  it("never waits a negative or infinite time, whatever state it is handed", () => {
    // The delay is a timer in the hook, so a state that produced a negative one would spin the
    // browser as fast as it could render.
    for (const phase of ["typing", "holding", "erasing", "pausing"] as const) {
      for (const index of [0, 1, 5]) {
        for (const length of [0, 1, 40]) {
          const next = nextTypewriterStep({ index, length, phase, delayMs: 0 }, PHRASES);
          expect(next.delayMs).toBeGreaterThan(0);
          expect(Number.isFinite(next.delayMs)).toBe(true);
        }
      }
    }
  });
});

describe("the composer's growing input", () => {
  const LINE = 24;

  it("holds one line while there is one line to hold", () => {
    expect(composerTextareaHeight(LINE, LINE)).toEqual({ height: LINE, scrolls: false });
    // Half a line of slack is not a reason to show a scrollbar.
    expect(composerTextareaHeight(LINE + 0.5, LINE)).toEqual({ height: LINE + 0.5, scrolls: false });
  });

  it("grows with the content up to the ceiling", () => {
    expect(composerTextareaHeight(LINE * 3, LINE)).toEqual({ height: LINE * 3, scrolls: false });
    const atCeiling = composerTextareaHeight(LINE * COMPOSER_MAX_LINES, LINE);
    expect(atCeiling.height).toBe(LINE * COMPOSER_MAX_LINES);
    expect(atCeiling.scrolls).toBe(false);
  });

  it("stops at five lines and scrolls instead", () => {
    const past = composerTextareaHeight(LINE * 9, LINE);
    expect(past.height).toBe(LINE * COMPOSER_MAX_LINES);
    expect(past.scrolls).toBe(true);
  });

  it("does not collapse when the line height could not be read", () => {
    // `getComputedStyle` returns an empty string for `line-height: normal` in some environments, and
    // a composer of zero height is a field the user cannot see or click.
    const unreadable = composerTextareaHeight(120, Number.NaN);
    expect(unreadable.height).toBe(120);
    expect(unreadable.scrolls).toBe(false);
  });
});
