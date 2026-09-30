import {
  RESOLVED_COLOR_SCHEMES,
  type AppearanceIdentity,
  type ColorTokenName,
  type ProtectedCheck,
  type ResolvedColorScheme,
  type ThemeOrb,
  type ThemeProtectedFailureView,
} from "@clarkcant/contracts";

import { contrastRatio, parseHex, requiredPairs } from "./contrast.ts";
import {
  BACKDROP_STRENGTH,
  MODAL_SCRIM_ALPHA,
  SURFACE_EFFECT_OVERLAY,
  backdropCoverage,
  backdropLitAlpha,
} from "./identity.ts";
import { orbLitColors, themeOrbPalette } from "./orb.ts";
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

/** A check measured as a distance between two colours. */
type DistanceCheck = Exclude<ProtectedCheck, "surface-readable" | "orb-visible">;

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
  /*
   * The light the Orb adds to the page, at its brightest channel. Clark's Orb and every shipped preset, on Clark's
   * pages, measure well above this (a test holds them to it); a palette of black measures 0 on a dark page.
   */
  "orb-visible": 15,
};

interface DistancePair {
  check: DistanceCheck;
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

/** A surface an effect finishes, and one colour it can take once finished. */
export interface FinishedSurface {
  surface: "canvas" | "card" | "elevated";
  color: string;
}

/**
 * Every colour the effects can leave a text-bearing surface in, at their strongest.
 *
 *   - The page under the backdrop: the pattern in the tertiary colour, and the lit copy in the accent over it where the
 *     pointer is, each averaged over the share of the page the pattern paints (see `backdropCoverage`).
 *   - Cards and the composer under a surface effect: the overlay at full strength, or for glass the frosted tint.
 *   - The modal under a surface effect: the overlay at full strength, or for glass the translucent fill over its scrim,
 *     over both the darkest and the brightest page the scrim can cover — what is behind a modal is not known here.
 *
 * Exported so a test can see what the audit measures against.
 */
export function finishedSurfaces(colors: ColorTokens, identity: AppearanceIdentity): FinishedSurface[] {
  const finished: FinishedSurface[] = [];
  const coverage = backdropCoverage(identity);
  if (coverage > 0) {
    const pattern = composite(colors.canvas, colors.textTertiary, identity.effects.backdrop.intensity * BACKDROP_STRENGTH.alpha * coverage);
    finished.push({ surface: "canvas", color: pattern });
    finished.push({ surface: "canvas", color: composite(pattern, colors.accent, backdropLitAlpha(identity) * coverage) });
  }

  const { kind, intensity } = identity.effects.surface;
  if (kind === "none") return finished;
  const overlay = SURFACE_EFFECT_OVERLAY[kind];
  const alpha = overlay.alpha * intensity;
  finished.push({ surface: "card", color: composite(colors.card, colors[overlay.token], alpha) });
  if (kind === "glass") {
    for (const behind of ["#000000", "#FFFFFF"]) {
      const scrim = composite(behind, colors.code, MODAL_SCRIM_ALPHA);
      finished.push({ surface: "elevated", color: composite(scrim, colors.elevated, 1 - alpha) });
    }
  } else {
    finished.push({ surface: "elevated", color: composite(colors.elevated, colors[overlay.token], alpha) });
  }
  return finished;
}

/**
 * One scheme's palette, identity and Orb default audited. Returns every failure.
 *
 * `orb` is the theme's Orb suggestion; without one, Clark's own Orb is measured, because that is what the page draws.
 */
export function auditProtected(
  scheme: ResolvedColorScheme,
  colors: ColorTokens,
  identity: AppearanceIdentity,
  orb?: ThemeOrb,
): ThemeProtectedFailureView[] {
  const failures: ThemeProtectedFailureView[] = [];
  for (const pair of PROTECTED_PAIRS) {
    const value = colorDistance(colors[pair.first], colors[pair.second]);
    const minimum = PROTECTED_MINIMUMS[pair.check];
    if (value < minimum) failures.push({ scheme, check: pair.check, first: pair.first, second: pair.second, value: round(value), minimum });
  }

  /*
   * An effect changes the colour of the surface text, status colours, the accent and the focus ring are drawn on. Each
   * finished surface is held to every pair the contrast audit holds the bare surface to — the same foregrounds, the
   * same minimums — so an effect cannot make a status unreadable or a focus ring vanish where the bare palette passed.
   * The worst measurement per pair is reported once.
   *
   * The hairline is the one pair left out. An effect is how a theme draws a widget card's surface, and a card finished
   * by one is told apart from the page by the finish itself; the edge that must stay visible is the host's own card's,
   * which no effect reaches and which `edge-visible` measures on the bare card.
   */
  const worst = new Map<string, ThemeProtectedFailureView>();
  for (const { surface, color } of finishedSurfaces(colors, identity)) {
    for (const pair of requiredPairs({ ...colors, [surface]: color })) {
      if (pair.backgroundToken !== surface || pair.foregroundToken === "border") continue;
      const ratio = contrastRatio(pair.foreground, pair.background);
      if (ratio >= pair.minimum) continue;
      const key = `${pair.foregroundToken}/${surface}`;
      const known = worst.get(key);
      if (known === undefined || ratio < known.value) {
        worst.set(key, { scheme, check: "surface-readable", first: pair.foregroundToken, second: surface, value: round(ratio), minimum: pair.minimum });
      }
    }
  }
  failures.push(...worst.values());

  /*
   * The Orb is the product's signature and is never hidden. It is drawn as light added to its glass body, so a palette
   * whose every light channel is dark draws the page itself on a dark page. The brightest of its channels, lit as the
   * shader lights it, must stand apart from the page.
   */
  const orbLight = Math.max(...orbLitColors(colors.canvas, themeOrbPalette(orb)).map((lit) => colorDistance(lit, colors.canvas)));
  if (orbLight < PROTECTED_MINIMUMS["orb-visible"]) {
    failures.push({ scheme, check: "orb-visible", first: "orb", second: "canvas", value: round(orbLight), minimum: PROTECTED_MINIMUMS["orb-visible"] });
  }
  return failures;
}

/** Every scheme's palette, one identity and one Orb default, audited. */
export function auditProtectedSchemes(
  palettes: Readonly<Record<ResolvedColorScheme, ColorTokens>>,
  identity: AppearanceIdentity,
  orb?: ThemeOrb,
): ThemeProtectedFailureView[] {
  return RESOLVED_COLOR_SCHEMES.flatMap((scheme) => auditProtected(scheme, palettes[scheme], identity, orb));
}
