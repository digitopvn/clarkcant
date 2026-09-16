import { type ColorTokens, type ThemeName, THEMES } from "./tokens.ts";

/**
 * WCAG contrast utilities.
 *
 * These exist so the accessibility claim is computed rather than asserted. A palette
 * that "looks fine" is not evidence, and the ratios below are what the test suite checks
 * against the AA thresholds.
 */

/** Parse `#rrggbb` into 0–255 channels. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`${hex} is not a six-digit hex colour`);
  return {
    r: Number.parseInt(match[1]!, 16),
    g: Number.parseInt(match[2]!, 16),
    b: Number.parseInt(match[3]!, 16),
  };
}

/**
 * Relative luminance per WCAG 2.2.
 *
 * The sRGB channels are linearised before weighting, which is the step that makes the
 * result differ from a naive brightness average.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_NON_TEXT = 3;

export interface ContrastPair {
  foreground: string;
  background: string;
  minimum: number;
  purpose: string;
}

/**
 * The pairs this design system guarantees.
 *
 * Every text pair is checked at the normal-text threshold, including the muted, tertiary and
 * status colours, because "secondary text is exempt" is not true: it is still text. Each text
 * tier is checked against every surface it can be drawn on, because a tier that is readable on
 * the canvas and unreadable on a card is a palette that fails on half its screens.
 */
export function requiredPairs(tokens: ColorTokens): ContrastPair[] {
  const surfaces: { color: string; name: string }[] = [
    { color: tokens.canvas, name: "the page" },
    { color: tokens.window, name: "the window" },
    { color: tokens.card, name: "a card" },
    { color: tokens.elevated, name: "an elevated surface" },
    { color: tokens.code, name: "a code block" },
  ];

  const textTiers: { color: string; name: string }[] = [
    { color: tokens.text, name: "body text" },
    { color: tokens.textMuted, name: "caption text" },
    { color: tokens.textTertiary, name: "tertiary text" },
  ];

  const pairs: ContrastPair[] = [];

  for (const tier of textTiers) {
    for (const surface of surfaces) {
      pairs.push({
        foreground: tier.color,
        background: surface.color,
        minimum: AA_NORMAL_TEXT,
        purpose: `${tier.name} on ${surface.name}`,
      });
    }
  }

  pairs.push(
    { foreground: tokens.onAccent, background: tokens.accent, minimum: AA_NORMAL_TEXT, purpose: "label on an accent button" },
    { foreground: tokens.success, background: tokens.card, minimum: AA_NORMAL_TEXT, purpose: "success status text" },
    { foreground: tokens.warning, background: tokens.card, minimum: AA_NORMAL_TEXT, purpose: "warning status text" },
    { foreground: tokens.danger, background: tokens.card, minimum: AA_NORMAL_TEXT, purpose: "error status text" },
    { foreground: tokens.focus, background: tokens.canvas, minimum: AA_NON_TEXT, purpose: "focus ring against the page" },
    { foreground: tokens.focus, background: tokens.card, minimum: AA_NON_TEXT, purpose: "focus ring against a card" },
    { foreground: tokens.focus, background: tokens.elevated, minimum: AA_NON_TEXT, purpose: "focus ring against an elevated surface" },
    { foreground: tokens.border, background: tokens.card, minimum: 1.2, purpose: "hairline separation from a card" },
  );

  return pairs;
}

export interface ContrastAudit {
  theme: ThemeName;
  failures: { purpose: string; ratio: number; minimum: number }[];
  checked: number;
}

/** Audit one theme. Returns every failure rather than stopping at the first. */
export function auditTheme(theme: ThemeName): ContrastAudit {
  const tokens = THEMES[theme];
  const failures: ContrastAudit["failures"] = [];
  for (const pair of requiredPairs(tokens)) {
    const ratio = contrastRatio(pair.foreground, pair.background);
    if (ratio < pair.minimum) {
      failures.push({ purpose: pair.purpose, ratio: Math.round(ratio * 100) / 100, minimum: pair.minimum });
    }
  }
  return { theme, failures, checked: requiredPairs(tokens).length };
}

export function auditAllThemes(): ContrastAudit[] {
  return (Object.keys(THEMES) as ThemeName[]).map(auditTheme);
}

/**
 * Pick the readable foreground for an arbitrary background.
 *
 * Used where a widget supplies its own colour, so a host-rendered label does not become
 * unreadable against it.
 */
export function readableForeground(background: string, tokens: ColorTokens): string {
  return contrastRatio(tokens.text, background) >= contrastRatio(tokens.canvas, background)
    ? tokens.text
    : tokens.canvas;
}
