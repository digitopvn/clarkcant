import {
  LAYOUT,
  MOTION,
  MOTION_REDUCED,
  RADIUS,
  SPACE,
  TYPE_SCALE,
  type ThemeName,
  THEMES,
} from "./tokens.ts";

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
  window: "--cc-window",
  card: "--cc-card",
  elevated: "--cc-elevated",
  code: "--cc-code",
  border: "--cc-border",
  text: "--cc-text",
  textMuted: "--cc-text-muted",
  textTertiary: "--cc-text-tertiary",
  accent: "--cc-accent",
  onAccent: "--cc-on-accent",
  success: "--cc-success",
  warning: "--cc-warning",
  danger: "--cc-danger",
  focus: "--cc-focus",
};

/**
 * Layout measurements.
 *
 * Emitted as variables rather than imported by each component because a component that
 * imports a number from TypeScript cannot be overridden by a package that wants a
 * different measure, and cannot be inspected in a browser's developer tools.
 */
const LAYOUT_VARIABLES: Record<keyof typeof LAYOUT, string> = {
  conversationMaxWidth: "--cc-conversation-max-width",
  composerMaxWidth: "--cc-composer-max-width",
  composerMinHeight: "--cc-composer-min-height",
  topBarHeight: "--cc-topbar-height",
  modalWidth: "--cc-modal-width",
};

export function tokensToCss(theme: ThemeName): string {
  const colors = THEMES[theme];
  const lines: string[] = [
    // Without this, every control the user agent draws itself — buttons, scrollbars, form
    // fields, the caret — keeps the light default regardless of the palette, which is how a
    // dark interface ends up with a bright grey pill in the middle of it.
    `  color-scheme: ${theme};`,
  ];

  for (const [key, variable] of Object.entries(COLOR_VARIABLES) as [keyof typeof colors, string][]) {
    lines.push(`  ${variable}: ${colors[key]};`);
  }
  // Size and leading are emitted as a pair, so a component cannot take the size and forget
  // the leading that was chosen to go with it.
  for (const [name, value] of Object.entries(TYPE_SCALE)) {
    lines.push(`  --cc-text-${kebab(name)}: ${value.size};`);
    lines.push(`  --cc-leading-${kebab(name)}: ${value.lineHeight};`);
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
  for (const [name, value] of Object.entries(LAYOUT_VARIABLES)) {
    lines.push(`  ${value}: ${LAYOUT[name as keyof typeof LAYOUT]};`);
  }

  /*
   * The bare attribute selector as well as the root one, so a theme can be scoped to a subtree. The Widget Lab
   * previews a widget in the other theme by setting the attribute on its preview frame; with only the root
   * selector that attribute changed nothing, and the Lab's theme control was a control that did nothing.
   */
  return `:root[data-cc-theme="${theme}"],\n[data-cc-theme="${theme}"] {\n${lines.join("\n")}\n}`;
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
  // The same reduced set, scoped to a subtree that asks for it, which is how the Widget Lab previews reduced motion
  // without changing the person's own preference.
  const scoped = `[data-cc-reduced-motion="true"] {\n${Object.entries(MOTION_REDUCED)
    .map(([name, value]) => `  --cc-motion-${name}: ${value};`)
    .join("\n")}\n}`;
  return `${tokensToCss("dark")}\n\n${tokensToCss("light")}\n\n${media}\n\n${scoped}`;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
