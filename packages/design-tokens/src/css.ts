import {
  COLOR_TOKEN_NAMES,
  LAYOUT_TOKEN_NAMES,
  MOTION_TOKEN_NAMES,
  RADIUS_TOKEN_NAMES,
  SPACE_TOKEN_NAMES,
  TYPE_TOKEN_NAMES,
  type AppearanceSnapshot,
  type ColorTokenName,
  type LayoutTokenName,
  type ResolvedColorScheme,
  type ThemeDocument,
} from "@clarkcant/contracts";

import { type CompileAppearanceInput, compileAppearance } from "./appearance.ts";
import { identityDeclarations, identityStylesheet } from "./identity.ts";

/**
 * Emit an appearance as CSS custom properties.
 *
 * Generated from the compiled snapshot rather than hand-written, so a palette change cannot leave the stylesheet
 * behind. That drift is the usual reason a "design system" ends up with two conflicting sources of truth, and the
 * contrast audit only means something if the CSS is genuinely derived from the audited values.
 *
 * Only the contract's own token names are iterated, and every value has already passed the snapshot schema, so what
 * a theme says can change a value but never a property name, a selector, or anything outside the declaration block.
 * Identity (see `identity.ts`) is written from the host's own templates in the same way; the one rule it adds, for the
 * backdrop, has a selector the host wrote and a pattern built from a closed list.
 */

const COLOR_VARIABLES: Record<ColorTokenName, string> = {
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
const LAYOUT_VARIABLES: Record<LayoutTokenName, string> = {
  conversationMaxWidth: "--cc-conversation-max-width",
  composerMaxWidth: "--cc-composer-max-width",
  composerMinHeight: "--cc-composer-min-height",
  topBarHeight: "--cc-topbar-height",
  modalWidth: "--cc-modal-width",
};

/** The canonical bounded token-to-property mapping, shared with the optional widget DOM adapter. */
function baseAppearanceDeclarations(snapshot: AppearanceSnapshot): Record<string, string> {
  const { scheme, tokens } = snapshot;
  const values: Record<string, string> = {
    // Without this, every control the user agent draws itself — buttons, scrollbars, form
    // fields, the caret — keeps the light default regardless of the palette, which is how a
    // dark interface ends up with a bright grey pill in the middle of it.
    "color-scheme": scheme,
  };

  for (const name of COLOR_TOKEN_NAMES) {
    values[COLOR_VARIABLES[name]] = tokens.color[name];
  }
  // Size and leading are emitted as a pair, so a component cannot take the size and forget
  // the leading that was chosen to go with it.
  for (const name of TYPE_TOKEN_NAMES) {
    values[`--cc-text-${kebab(name)}`] = tokens.type[name].size;
    values[`--cc-leading-${kebab(name)}`] = tokens.type[name].lineHeight;
  }
  for (const name of SPACE_TOKEN_NAMES) {
    values[`--cc-space-${name}`] = tokens.space[name];
  }
  for (const name of RADIUS_TOKEN_NAMES) {
    values[`--cc-radius-${name}`] = tokens.radius[name];
  }
  for (const name of MOTION_TOKEN_NAMES) {
    values[`--cc-motion-${name}`] = tokens.motion[name];
  }
  for (const name of LAYOUT_TOKEN_NAMES) {
    values[LAYOUT_VARIABLES[name]] = tokens.layout[name];
  }
  return values;
}

export function appearanceDeclarations(snapshot: AppearanceSnapshot): Record<string, string | undefined> {
  return { ...baseAppearanceDeclarations(snapshot), ...identityDeclarations(snapshot.tokens.identity) };
}

/** One snapshot as the declaration block for its scheme. */
export function appearanceToCss(snapshot: AppearanceSnapshot): string {
  const scheme = snapshot.scheme;
  const lines = Object.entries(baseAppearanceDeclarations(snapshot)).map(([name, value]) => `  ${name}: ${value};`);

  /*
   * The bare attribute selector as well as the root one, so a scheme can be scoped to a subtree. The Widget Lab
   * previews a widget in the other scheme by setting the attribute on its preview frame; with only the root
   * selector that attribute changed nothing, and the Lab's scheme control was a control that did nothing.
   */
  return `:root[data-cc-theme="${scheme}"],\n[data-cc-theme="${scheme}"] {\n${lines.join("\n")}\n}`;
}

/**
 * A theme's full stylesheet: both schemes, plus the reduced-motion override.
 *
 * Reduced motion is a separate token set rather than a multiplier applied by each
 * component: a transition with a zero duration still fires transition events, so a
 * component that animates at 1ms is not the same as one that does not animate.
 */
export function appearanceStylesheet(snapshots: Readonly<Record<ResolvedColorScheme, AppearanceSnapshot>>): string {
  const reduced = snapshots.dark.tokens.motionReduced;
  /*
   * The selectors repeat the scheme block's, so the override matches its specificity and, coming later, wins. With
   * `:root` alone (0,1,0) the scheme block (0,2,0) kept the full durations, and a person who asked the OS for reduced
   * motion still got every transition.
   */
  const media = `@media (prefers-reduced-motion: reduce) {\n  :root,\n  :root[data-cc-theme],\n  [data-cc-theme] {\n${MOTION_TOKEN_NAMES.map(
    (name) => `    --cc-motion-${name}: ${reduced[name]};`,
  ).join("\n")}\n  }\n}`;
  // The same reduced set, scoped to a subtree that asks for it, which is how the Widget Lab previews reduced motion
  // without changing the person's own preference.
  const scoped = `[data-cc-reduced-motion="true"] {\n${MOTION_TOKEN_NAMES.map(
    (name) => `  --cc-motion-${name}: ${reduced[name]};`,
  ).join("\n")}\n}`;
  /*
   * Identity is the same in both schemes, and empty for Clark Default and for any theme that leaves identity alone, so
   * their sheets are exactly what they were before identity existed. It sits before the reduced-motion blocks, which
   * stay last so nothing after them can restore a duration they zeroed.
   */
  const identity = identityStylesheet(snapshots.dark.tokens.identity);
  const schemes = `${appearanceToCss(snapshots.dark)}\n\n${appearanceToCss(snapshots.light)}`;
  return `${schemes}${identity === "" ? "" : `\n\n${identity}`}\n\n${media}\n\n${scoped}`;
}

/** The stylesheet for a theme and the reference it was selected by, or Clark Default's when none is given. */
export function themeStylesheet(): string;
export function themeStylesheet(theme: ThemeDocument, themeRef: string): string;
export function themeStylesheet(theme?: ThemeDocument, themeRef?: string): string {
  const compile = (scheme: ResolvedColorScheme) =>
    compileAppearance((theme === undefined ? { scheme } : { scheme, theme, themeRef }) as CompileAppearanceInput);
  return appearanceStylesheet({ dark: compile("dark"), light: compile("light") });
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
