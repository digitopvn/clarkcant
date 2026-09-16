/**
 * Design tokens.
 *
 * Versioned rather than inline, because a widget package declares the token version it
 * was built against and the host can then refuse to render it against a palette whose
 * contrast guarantees no longer hold.
 *
 * The palette follows the interface specification's "quiet chrome" position: surfaces are
 * near-neighbours and the accent is a pale lavender rather than a saturated brand colour.
 * A vivid accent on a dark canvas pulls attention to the chrome, which is the opposite of
 * what a conversation-first interface wants, because the conversation is the interface.
 *
 * Every colour here has a measured ratio in `test/contrast.spec.ts`.
 */

export const TOKEN_VERSION = "2.0.0" as const;

export interface ColorTokens {
  /** Page background, behind everything. */
  canvas: string;
  /** The application window: the surface the viewport sits on. */
  window: string;
  /** A card's own surface, one step above the canvas. */
  card: string;
  /** Elevated surface: menus, popovers, modals, anything that floats over a card. */
  elevated: string;
  /** A code or data block, which sits slightly below the surface it is read on. */
  code: string;
  /** Hairline borders and dividers. */
  border: string;
  /** Primary text. */
  text: string;
  /** Secondary text: timestamps, captions, helper copy. */
  textMuted: string;
  /** Tertiary text: the least prominent tier that is still text. */
  textTertiary: string;
  accent: string;
  /** Text on the accent colour. */
  onAccent: string;
  /** Status colours. Never the only signal: each pairs with an icon and a label. */
  success: string;
  warning: string;
  danger: string;
  /** Focus ring. Must be distinguishable from the surface behind it. */
  focus: string;
}

/**
 * The dark theme, from the interface specification.
 *
 * Two values are not the specification's literal strings, and both are deliberate:
 *
 *  - `border` is the specification's `rgba(255,255,255,.07)`. It is stored opaque because a
 *    contrast ratio needs a single colour to measure: an alpha value measures differently
 *    against every surface it is drawn on, so `auditTheme` could not state a number for it.
 *    This is that alpha composited over `card`, which is where borders mostly appear.
 *
 *  - `textTertiary` is lightened from the specification's `#70737D`. That value measures
 *    3.95:1 on this canvas, below the 4.5:1 that normal text requires, so using it as
 *    specified would have made the palette fail its own accessibility claim. The binding
 *    case is not the canvas but the lightest surface this tier can be drawn on, which in
 *    dark is `elevated`: `#70737D` measures 3.71:1 there. The value below is the smallest
 *    lightening that clears 4.5:1 on every surface, and it is still visibly a tier below
 *    `textMuted`.
 */
export const DARK: ColorTokens = {
  canvas: "#111317",
  window: "#14161A",
  card: "#17191D",
  elevated: "#1B1D22",
  code: "#101318",
  border: "#27292D",
  text: "#E7E7EA",
  textMuted: "#A0A2AB",
  textTertiary: "#858994",
  accent: "#B8AEDC",
  onAccent: "#111317",
  success: "#8EBCA3",
  warning: "#D1AC68",
  danger: "#C8757C",
  // Distinct from the accent, so a focus ring is still visible on an accent-coloured control.
  focus: "#D8D2F0",
};

/**
 * The light theme.
 *
 * The specification gives the light canvas. The rest is the same structure with the same
 * contrast obligations, tuned so every pair that is checked in dark is also checked here.
 */
export const LIGHT: ColorTokens = {
  canvas: "#F7F7F5",
  window: "#FFFFFF",
  card: "#FFFFFF",
  elevated: "#FFFFFF",
  code: "#F2F2EF",
  border: "#E5E5E1",
  text: "#1A1A1C",
  textMuted: "#5C5E66",
  // Darkened for the same reason as the dark theme's tertiary: the specification's value does
  // not clear 4.5:1 on the light surfaces it would be drawn on, and a code block is the
  // darkest-to-lightest case that binds it.
  textTertiary: "#696C74",
  accent: "#6B5FA8",
  onAccent: "#FFFFFF",
  success: "#3F6B52",
  warning: "#7A5B1E",
  danger: "#A33B45",
  focus: "#5B4FA0",
};

export const THEMES = { dark: DARK, light: LIGHT } as const;
export type ThemeName = keyof typeof THEMES;

/**
 * Type scale, in rem, with the line height each size is meant to be read at.
 *
 * The line height travels with the size rather than sitting as one global value, because a
 * 52px display line and an 11px meta line do not want the same leading, and a single
 * `line-height` is how a scale ends up looking wrong at both ends.
 */
export const TYPE_SCALE = {
  /** 52/60 — the largest display line, used for a hero. */
  displayXl: { size: "3.25rem", lineHeight: "3.75rem" },
  /** 34/42 — a screen's own heading. */
  displayLg: { size: "2.125rem", lineHeight: "2.625rem" },
  /** 24/32 — a section heading. */
  headingLg: { size: "1.5rem", lineHeight: "2rem" },
  /** 18/26 — a card heading, and the empty state's title. */
  headingMd: { size: "1.125rem", lineHeight: "1.625rem" },
  /** 16/24 — a lead paragraph. */
  bodyLg: { size: "1rem", lineHeight: "1.5rem" },
  /** 14/22 — body copy, and what a message is set in. */
  bodyMd: { size: "0.875rem", lineHeight: "1.375rem" },
  /** 13/20 — dense body copy inside a card. */
  bodySm: { size: "0.8125rem", lineHeight: "1.25rem" },
  /** 12/16 — button and field labels. */
  label: { size: "0.75rem", lineHeight: "1rem" },
  /** 12/20 — monospaced text: digests, paths, identifiers. The same size as `label` with the
   *  looser leading a run of hex digits needs to stay scannable. */
  monoSm: { size: "0.75rem", lineHeight: "1.25rem" },
  /** 11/16 — the smallest tier: timestamps, counts, provenance. */
  meta: { size: "0.6875rem", lineHeight: "1rem" },
} as const;

export type TypeToken = keyof typeof TYPE_SCALE;

/**
 * Spacing scale, in rem. A closed set, so a component cannot invent a gap.
 *
 * The original steps keep their original values, so adopting the specification's longer
 * scale adds sizes without silently resizing every screen that already used these names.
 * `xxs` is the one step outside the specification's scale; it predates it and is kept
 * because collapsing it would move existing hairlines.
 */
export const SPACE = {
  xxs: "0.125rem", // 2
  xs: "0.25rem", // 4
  sm: "0.5rem", // 8
  md: "0.75rem", // 12
  lg: "1rem", // 16
  xl: "1.5rem", // 24
  xxl: "2rem", // 32
  s20: "1.25rem", // 20
  s40: "2.5rem", // 40
  s48: "3rem", // 48
  s64: "4rem", // 64
  s80: "5rem", // 80
} as const;

/**
 * Radius scale, named for the component it is for.
 *
 * Named by role rather than by size because the specification pins specific radii to
 * specific components, and `lg` does not tell a reader whether a composer or a modal
 * should get it.
 */
export const RADIUS = {
  badge: "0.375rem", // 6 — chips and small labels
  button: "0.5rem", // 8
  card: "0.75rem", // 12 — compact cards
  response: "1rem", // 16 — response cards and the composer
  modal: "1.25rem", // 20
  pill: "999px",
} as const;

export const BORDER_WIDTH = { hairline: "1px" } as const;

/**
 * Motion tokens.
 *
 * `reduced` is a separate set rather than a multiplier that a component applies
 * itself, because "multiply by zero" still leaves a transition that fires events, and
 * a reduced-motion user should not get a spinner that animates at 1ms intervals.
 *
 * `orb` is the one long duration in the system. The orb is a background element and reads
 * as broken when it moves at interface speed, so it is allowed a range an order of
 * magnitude slower than a panel transition.
 */
export const MOTION = {
  micro: "120ms",
  normal: "180ms",
  panel: "280ms",
  orb: "600ms",
  easing: "cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

export const MOTION_REDUCED = {
  micro: "0ms",
  normal: "0ms",
  panel: "0ms",
  orb: "0ms",
  easing: "linear",
} as const;

export const MIN_TARGET_SIZE_PX = 24;

/**
 * Layout numbers from the specification.
 *
 * Held as tokens because they are the difference between "roughly matches the design" and
 * "matches it", and three separate screens each hard-coding 720px is how they drift.
 */
export const LAYOUT = {
  /** The reading measure of a conversation. */
  conversationMaxWidth: "800px",
  /** The composer is deliberately wider than the column it sits under. */
  composerMaxWidth: "840px",
  composerMinHeight: "70px",
  topBarHeight: "62px",
  modalWidth: "700px",
} as const;

export function motionFor(prefersReducedMotion: boolean) {
  return prefersReducedMotion ? MOTION_REDUCED : MOTION;
}
