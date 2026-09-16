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
      expect(contrastRatio(theme.text, theme.surface)).toBeGreaterThan(
        contrastRatio(theme.textMuted, theme.surface),
      );
    }
  });

  it("meets AA for the light theme's body text specifically", () => {
    expect(contrastRatio(LIGHT.text, LIGHT.canvas)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(LIGHT.textMuted, LIGHT.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("picks a readable foreground for an arbitrary widget colour", () => {
    expect(readableForeground("#111111", THEMES.dark)).toBe(THEMES.dark.text);
    expect(readableForeground("#fefefe", THEMES.dark)).toBe(THEMES.dark.canvas);
  });

  it("keeps the type scale monotonic", () => {
    const values = Object.values(TYPE_SCALE).map((value) => Number.parseFloat(value));
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});
