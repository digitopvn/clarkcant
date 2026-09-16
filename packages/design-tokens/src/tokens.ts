/**
 * Design tokens.
 *
 * Versioned rather than inline, because a widget package declares the token version it
 * was built against and the host can then refuse to render it against a palette whose
 * contrast guarantees no longer hold.
 *
 * The palette is deliberately small. A large colour list invites a component to pick a
 * colour that was never checked for contrast; every colour here has a measured ratio in
 * `test/contrast.spec.ts`.
 */

export const TOKEN_VERSION = "1.0.0" as const;

export interface ColorTokens {
  /** Page background. */
  canvas: string;
  /** Raised surface: cards, composer, modal body. */
  surface: string;
  /** Surface used while something is streaming. */
  surfaceMuted: string;
  /** Hairline borders and dividers. */
  border: string;
  /** Primary text. */
  text: string;
  /** Secondary text: timestamps, captions, helper copy. */
  textMuted: string;
  /** Text on the accent colour. */
  onAccent: string;
  accent: string;
  /** Status colours. Never the only signal: each pairs with an icon and a label. */
  success: string;
  warning: string;
  danger: string;
  /** Focus ring. Must be distinguishable from the surface behind it. */
  focus: string;
}

export const DARK: ColorTokens = {
  canvas: "#0b0b0d",
  surface: "#141417",
  surfaceMuted: "#1b1b20",
  border: "#2a2a31",
  text: "#f4f4f6",
  textMuted: "#a6a6b0",
  accent: "#7c7cf5",
  onAccent: "#0b0b0d",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  focus: "#a5a5ff",
};

export const LIGHT: ColorTokens = {
  canvas: "#fbfbfd",
  surface: "#ffffff",
  surfaceMuted: "#f2f2f5",
  border: "#dcdce3",
  text: "#14141a",
  textMuted: "#585866",
  accent: "#4f46e5",
  onAccent: "#ffffff",
  success: "#15803d",
  warning: "#a16207",
  danger: "#b91c1c",
  focus: "#4338ca",
};

export const THEMES = { dark: DARK, light: LIGHT } as const;
export type ThemeName = keyof typeof THEMES;

/** Type scale, in rem. */
export const TYPE_SCALE = {
  caption: "0.75rem",
  body: "0.875rem",
  bodyLarge: "1rem",
  title: "1.25rem",
  display: "2rem",
} as const;

/** Spacing scale, in rem. A closed set, so a component cannot invent a gap. */
export const SPACE = {
  xxs: "0.125rem",
  xs: "0.25rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  xxl: "2rem",
} as const;

export const RADIUS = { sm: "0.375rem", md: "0.625rem", lg: "1rem", full: "9999px" } as const;

/**
 * Motion tokens.
 *
 * `reduced` is a separate set rather than a multiplier that a component applies
 * itself, because "multiply by zero" still leaves a transition that fires events, and
 * a reduced-motion user should not get a spinner that animates at 1ms intervals.
 */
export const MOTION = {
  fast: "120ms",
  normal: "200ms",
  slow: "320ms",
  easing: "cubic-bezier(0.2, 0, 0.2, 1)",
} as const;

export const MOTION_REDUCED = {
  fast: "0ms",
  normal: "0ms",
  slow: "0ms",
  easing: "linear",
} as const;

export const MIN_TARGET_SIZE_PX = 24;

export function motionFor(prefersReducedMotion: boolean) {
  return prefersReducedMotion ? MOTION_REDUCED : MOTION;
}
