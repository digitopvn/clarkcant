import { type ThemeName, THEMES, MOTION, MOTION_REDUCED, RADIUS, SPACE, TYPE_SCALE } from "./tokens.ts";

/**
 * Emit the token set as CSS custom properties.
 *
 * Generated from the token objects rather than hand-written, so a palette change cannot
 * leave the stylesheet behind. That drift is the usual reason a "design system" ends up
 * with two conflicting sources of truth, and the contrast audit only means something if
 * the CSS is genuinely derived from the audited values.
 */

const COLOR_VARIABLES: Record<keyof (typeof THEMES)["dark"], string> = {
  canvas: "--cc-canvas",
  surface: "--cc-surface",
  surfaceMuted: "--cc-surface-muted",
  border: "--cc-border",
  text: "--cc-text",
  textMuted: "--cc-text-muted",
  accent: "--cc-accent",
  onAccent: "--cc-on-accent",
  success: "--cc-success",
  warning: "--cc-warning",
  danger: "--cc-danger",
  focus: "--cc-focus",
};

export function tokensToCss(theme: ThemeName): string {
  const colors = THEMES[theme];
  const lines: string[] = [];

  for (const [key, variable] of Object.entries(COLOR_VARIABLES) as [keyof typeof colors, string][]) {
    lines.push(`  ${variable}: ${colors[key]};`);
  }
  for (const [name, value] of Object.entries(TYPE_SCALE)) {
    lines.push(`  --cc-text-${kebab(name)}: ${value};`);
  }
  for (const [name, value] of Object.entries(SPACE)) {
    lines.push(`  --cc-space-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(RADIUS)) {
    lines.push(`  --cc-radius-${name}: ${value};`);
  }
  for (const [name, value] of Object.entries(MOTION)) {
    lines.push(`  --cc-motion-${name}: ${value};`);
  }

  return `:root[data-cc-theme="${theme}"] {\n${lines.join("\n")}\n}`;
}

/**
 * Both themes, plus the reduced-motion override.
 *
 * Reduced motion is a separate token set rather than a multiplier applied by each
 * component: a transition with a zero duration still fires transition events, so a
 * component that animates at 1ms is not the same as one that does not animate.
 */
export function themeStylesheet(): string {
  const media = `@media (prefers-reduced-motion: reduce) {\n  :root {\n${Object.entries(
    MOTION_REDUCED,
  )
    .map(([name, value]) => `    --cc-motion-${name}: ${value};`)
    .join("\n")}\n  }\n}`;
  return `${tokensToCss("dark")}\n\n${tokensToCss("light")}\n\n${media}`;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
