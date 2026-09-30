import {
  RESOLVED_COLOR_SCHEMES,
  type AppearanceIdentity,
  type ColorTokenName,
  type ProtectedCheck,
  type ResolvedColorScheme,
  type ThemeProtectedFailureView,
} from "@clarkcant/contracts";

import { AA_NORMAL_TEXT, contrastRatio, parseHex } from "./contrast.ts";
import { SURFACE_EFFECT_OVERLAY } from "./identity.ts";
import type { ColorTokens } from "./tokens.ts";

/**
 * The protected-semantics audit: the states a theme must leave distinguishable, measured rather than trusted.
 *
 * The contrast audit asks "can this be read?". This one asks "can these be told apart?": a theme can pass every
 * contrast pair and still draw danger, warning and success in one colour, or a focus ring in the colour of every other
 * edge. Each state also carries a glyph, a word or a shape the host draws and no theme can remove; these checks keep
 * the colour a genuine second signal.
 *
 * Distances are OKLab ΔE × 100 — a perceptual distance, where about 2 is the smallest difference most people see side
 * by side. Every minimum below is set under Clark Default's own measurement, with room, and a test holds Clark to them.
 */

/** A colour in OKLab. */
interface Lab {
  l: number;
  a: number;
  b: number;
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex to OKLab (Björn Ottosson's matrices). */
export function oklab(hex: string): Lab {
  const { r: r8, g: g8, b: b8 } = parseHex(hex);
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** The perceptual distance between two colours, as OKLab ΔE × 100. */
export function colorDistance(first: string, second: string): number {
  const x = oklab(first);
  const y = oklab(second);
  return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b) * 100;
}

/**
 * `over` composited onto `base` at `alpha`, as a browser composites a translucent layer: in encoded sRGB.
 *
 * Exported so the audit's worst-case surface is inspectable in a test.
 */
export function composite(base: string, over: string, alpha: number): string {
  const x = parseHex(base);
  const y = parseHex(over);
  const mix = (from: number, to: number): string =>
    Math.round(from * (1 - alpha) + to * alpha)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(x.r, y.r)}${mix(x.g, y.g)}${mix(x.b, y.b)}`;
}

/** The minimum distance per check. */
export const PROTECTED_MINIMUMS: Readonly<Record<Exclude<ProtectedCheck, "surface-readable">, number>> = {
  // Clark Default measures 9.56 at its closest (warning and success, light).
  "status-distinct": 6,
  // Clark: 18.47 (success and text, dark).
  "status-vs-text": 10,
  // Clark: 46.01 (light).
  "focus-vs-border": 15,
  // Clark: 29.88 (dark).
  "disabled-distinct": 8,
  // Clark: 5.49 (the light border against the light page).
  "edge-visible": 2.5,
};

interface DistancePair {
  check: Exclude<ProtectedCheck, "surface-readable">;
  first: ColorTokenName;
  second: ColorTokenName;
}

/** The pairs every theme must keep apart. */
export const PROTECTED_PAIRS: readonly DistancePair[] = [
  // Deny, warn and done, and the accent that marks information, selection and the one primary action of a card.
  { check: "status-distinct", first: "danger", second: "warning" },
  { check: "status-distinct", first: "danger", second: "success" },
  { check: "status-distinct", first: "warning", second: "success" },
  { check: "status-distinct", first: "accent", second: "danger" },
  { check: "status-distinct", first: "accent", second: "warning" },
  { check: "status-distinct", first: "accent", second: "success" },
  { check: "status-vs-text", first: "danger", second: "text" },
  { check: "status-vs-text", first: "warning", second: "text" },
  { check: "status-vs-text", first: "success", second: "text" },
  { check: "focus-vs-border", first: "focus", second: "border" },
  { check: "disabled-distinct", first: "textTertiary", second: "text" },
  // The host's approval, credential and connection cards keep this edge whatever a card recipe says.
  { check: "edge-visible", first: "border", second: "card" },
  { check: "edge-visible", first: "border", second: "canvas" },
];

const round = (value: number): number => Math.round(value * 100) / 100;

/** One scheme's palette and identity, audited. Returns every failure. */
export function auditProtected(scheme: ResolvedColorScheme, colors: ColorTokens, identity: AppearanceIdentity): ThemeProtectedFailureView[] {
  const failures: ThemeProtectedFailureView[] = [];
  for (const pair of PROTECTED_PAIRS) {
    const value = colorDistance(colors[pair.first], colors[pair.second]);
    const minimum = PROTECTED_MINIMUMS[pair.check];
    if (value < minimum) failures.push({ scheme, check: pair.check, first: pair.first, second: pair.second, value: round(value), minimum });
  }

  /*
   * A surface effect overlays the card, the modal and the composer. The text on them is measured against the worst
   * case the stylesheet can draw — the overlay at its strongest point — at the same threshold the contrast audit
   * holds the bare surfaces to.
   */
  const { kind, intensity } = identity.effects.surface;
  if (kind !== "none") {
    const overlay = SURFACE_EFFECT_OVERLAY[kind];
    for (const surface of ["card", "elevated"] as const) {
      const background = composite(colors[surface], colors[overlay.token], overlay.alpha * intensity);
      for (const text of ["text", "textMuted", "textTertiary"] as const) {
        const ratio = contrastRatio(colors[text], background);
        if (ratio < AA_NORMAL_TEXT) {
          failures.push({ scheme, check: "surface-readable", first: text, second: surface, value: round(ratio), minimum: AA_NORMAL_TEXT });
        }
      }
    }
  }
  return failures;
}

/** Every scheme's palette and one identity, audited. */
export function auditProtectedSchemes(
  palettes: Readonly<Record<ResolvedColorScheme, ColorTokens>>,
  identity: AppearanceIdentity,
): ThemeProtectedFailureView[] {
  return RESOLVED_COLOR_SCHEMES.flatMap((scheme) => auditProtected(scheme, palettes[scheme], identity));
}
