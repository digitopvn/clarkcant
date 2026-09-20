import { describe, expect, it } from "vitest";

import { AA_LARGE_TEXT, AA_NORMAL_TEXT, contrastRatio } from "../src/contrast.ts";
import { THEMES, type ThemeName } from "../src/tokens.ts";

/**
 * Contrast, per theme, as a test rather than as an intention.
 *
 * The pairs below are the ones text is actually rendered on. A palette can look right and still fail: `textMuted`
 * on `elevated` is the pair that goes first, because muted text on a raised surface is the combination nobody
 * checks by eye. The accessibility rules require a real ratio, so this asserts one.
 */

const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/** Surfaces text sits on directly. */
const SURFACES = ["canvas", "window", "card", "elevated", "code"] as const;
/** Text colours, and the floor each has to clear. */
const TEXT = [
  { key: "text", floor: AA_NORMAL_TEXT, why: "body text" },
  { key: "textMuted", floor: AA_NORMAL_TEXT, why: "muted text still has to be readable" },
  { key: "textTertiary", floor: AA_LARGE_TEXT, why: "tertiary text is small labels, held to the large-text floor" },
] as const;

describe("text on the surfaces it is rendered on", () => {
  for (const theme of THEME_NAMES) {
    for (const surface of SURFACES) {
      for (const text of TEXT) {
        it(`${theme}: ${text.key} on ${surface} clears ${String(text.floor)} (${text.why})`, () => {
          const tokens = THEMES[theme];
          const ratio = contrastRatio(tokens[text.key], tokens[surface]);

          expect(ratio).toBeGreaterThanOrEqual(text.floor);
        });
      }
    }
  }
});

describe("accent and focus", () => {
  for (const theme of THEME_NAMES) {
    it(`${theme}: text on the accent is readable`, () => {
      const tokens = THEMES[theme];
      // `onAccent` exists precisely for this pair; if it were dropped the accent would be unreadable.
      expect(contrastRatio(tokens.onAccent, tokens.accent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });

    it(`${theme}: the focus ring is distinguishable from the accent`, () => {
      const tokens = THEMES[theme];

      /*
       * The reason the token exists: a focus ring drawn in the accent colour disappears on an accent-coloured
       * control, which is the keyboard user losing the one signal that says where they are. Asserted as a
       * difference rather than a ratio, because the two are not text and background — they are two colours that
       * must not be mistaken for each other.
       */
      expect(tokens.focus.toLowerCase()).not.toBe(tokens.accent.toLowerCase());
      expect(contrastRatio(tokens.focus, tokens.accent)).toBeGreaterThan(1.1);
    });
  }
});

describe("the palettes are not the same palette", () => {
  it("dark and light actually differ", () => {
    // A light theme that shares the dark theme's surfaces would pass every ratio above and still be the wrong theme.
    expect(THEMES.light.canvas.toLowerCase()).not.toBe(THEMES.dark.canvas.toLowerCase());
    expect(THEMES.light.text.toLowerCase()).not.toBe(THEMES.dark.text.toLowerCase());
  });
});
