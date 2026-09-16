import { describe, expect, it } from "vitest";

import {
  AA_NORMAL_TEXT,
  LIGHT,
  THEMES,
  TYPE_SCALE,
  auditAllThemes,
  contrastRatio,
  parseHex,
  readableForeground,
  relativeLuminance,
} from "../src/index.ts";

describe("contrast maths", () => {
  it("matches the known ratios for black and white", () => {
    expect(Math.round(contrastRatio("#000000", "#ffffff"))).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });

  it("linearises sRGB rather than averaging channels", () => {
    // A naive brightness average of mid-grey would suggest a much higher ratio.
    const ratio = contrastRatio("#808080", "#ffffff");
    expect(ratio).toBeGreaterThan(3.9);
    expect(ratio).toBeLessThan(4.0);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#123456", "#abcdef")).toBeCloseTo(contrastRatio("#abcdef", "#123456"), 10);
  });

  it("rejects a malformed colour instead of guessing", () => {
    expect(() => parseHex("#abc")).toThrow(/six-digit/);
    expect(() => parseHex("red")).toThrow(/six-digit/);
  });

  it("orders luminance black < white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
  });
});

describe("palette accessibility (WCAG AA)", () => {
  it("passes every required pair in every theme", () => {
    const audits = auditAllThemes();
    const failures = audits.flatMap((audit) =>
      audit.failures.map((f) => `${audit.theme}: ${f.purpose} is ${f.ratio}:1 but needs ${f.minimum}:1`),
    );
    expect(failures).toEqual([]);
  });

  it("checks a non-trivial number of pairs, so a passing audit means something", () => {
    for (const audit of auditAllThemes()) {
      expect(audit.checked).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps text and muted text distinguishable from each other", () => {
    for (const theme of Object.values(THEMES)) {
      expect(contrastRatio(theme.text, theme.card)).toBeGreaterThan(
        contrastRatio(theme.textMuted, theme.card),
      );
    }
  });

  it("orders the three text tiers, so tertiary is not quietly the same as muted", () => {
    for (const theme of Object.values(THEMES)) {
      const primary = contrastRatio(theme.text, theme.card);
      const secondary = contrastRatio(theme.textMuted, theme.card);
      const tertiary = contrastRatio(theme.textTertiary, theme.card);
      expect(primary).toBeGreaterThan(secondary);
      expect(secondary).toBeGreaterThan(tertiary);
    }
  });

  it("meets AA for the light theme's body text specifically", () => {
    expect(contrastRatio(LIGHT.text, LIGHT.canvas)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(LIGHT.textMuted, LIGHT.card)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("checks the same pairs in both themes, so neither is audited less than the other", () => {
    const [dark, light] = auditAllThemes();
    expect(dark!.checked).toBe(light!.checked);
  });

  it("picks a readable foreground for an arbitrary widget colour", () => {
    expect(readableForeground("#111111", THEMES.dark)).toBe(THEMES.dark.text);
    expect(readableForeground("#fefefe", THEMES.dark)).toBe(THEMES.dark.canvas);
  });

  it("keeps the type scale monotonic", () => {
    // The scale is authored largest first, which is the convention for a type scale. This
    // asserts that the order it is written in is the order it is meant to be read in: a scale
    // that jumps 0.875 then 1.125 is a mistake in the table, not a decision about leading.
    const values = Object.values(TYPE_SCALE).map((value) => Number.parseFloat(value.size));
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("never lets a line height fall below its own font size", () => {
    // A leading smaller than the size is how a display style ends up with its ascenders cut
    // off, and it is invisible in a token table read as two independent lists.
    for (const [name, value] of Object.entries(TYPE_SCALE)) {
      const size = Number.parseFloat(value.size);
      const leading = Number.parseFloat(value.lineHeight);
      expect(leading, `${name} leading ${value.lineHeight} vs size ${value.size}`).toBeGreaterThanOrEqual(size);
    }
  });
});
