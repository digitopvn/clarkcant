import {
  APPEARANCE_API_VERSION,
  BUILTIN_CLARK_THEME_REF,
  RESOLVED_COLOR_SCHEMES,
  TOKEN_CONTRACT_VERSION,
  appearanceSnapshotSchema,
  type AppearanceSnapshot,
  type AppearanceTokens,
  type ResolvedColorScheme,
  type ThemeContrastFailureView,
  type ThemeDocument,
  type ThemeMotionEasing,
  type ThemeProtectedFailureView,
} from "@clarkcant/contracts";

import { type ContrastAudit, auditColors } from "./contrast.ts";
import { resolveIdentity } from "./identity.ts";
import { auditProtectedSchemes } from "./protected.ts";
import { CLARK_SCHEMES, type ColorTokens, LAYOUT, MOTION, MOTION_REDUCED, RADIUS, SPACE, TYPE_SCALE } from "./tokens.ts";

/**
 * The appearance compiler: a theme document and a colour scheme in, a bounded snapshot out.
 *
 * A theme is a patch over Clark Default, so compiling starts from Clark's own tokens and applies only what the theme
 * says. The result is validated against the snapshot contract before it is returned — a theme that got past the
 * document schema still cannot produce a value of a shape the stylesheet writer was not built for.
 */

/**
 * Clark Default, as a theme document.
 *
 * Empty on purpose. Clark's tokens are the base every theme patches, so Clark itself patches nothing; stating its
 * palette a second time here would be a second copy that could drift from the one the contrast suite measures.
 */
export const CLARK_THEME: ThemeDocument = {
  appearanceApi: { min: APPEARANCE_API_VERSION, max: APPEARANCE_API_VERSION },
  id: "clark",
  displayName: "Clark Default",
};

/**
 * What to compile: Clark Default in a scheme, or a theme together with the reference it was selected by.
 *
 * The reference travels with the theme because the snapshot names the theme its tokens came from. Letting one default
 * without the other would stamp `builtin:clark` on another theme's tokens, and a consumer that trusts the name — a
 * cache, a fallback notice, a widget told which theme it is drawn in — would be told something untrue.
 */
export type CompileAppearanceInput =
  | {
      /** The scheme to draw in, already resolved from the person's choice. */
      scheme: ResolvedColorScheme;
      theme?: undefined;
      themeRef?: typeof BUILTIN_CLARK_THEME_REF | undefined;
    }
  | {
      scheme: ResolvedColorScheme;
      /** The theme, validated. */
      theme: ThemeDocument;
      /** The reference the theme was selected by. */
      themeRef: string;
    };

/** Compile one theme in one scheme. Throws if the input pairs a theme and a reference wrongly, or if the result would break the snapshot contract. */
export function compileAppearance(input: CompileAppearanceInput): AppearanceSnapshot {
  if (input.theme !== undefined && input.themeRef === undefined) {
    throw new Error("a theme is compiled with the reference it was selected by");
  }
  if (input.theme === undefined && input.themeRef !== undefined && input.themeRef !== BUILTIN_CLARK_THEME_REF) {
    throw new Error(`${input.themeRef} names a theme, but none was given to compile`);
  }
  const theme = input.theme ?? CLARK_THEME;
  const radius: Record<string, string> = { ...RADIUS };
  for (const [name, rem] of Object.entries(theme.radius ?? {})) {
    // `field` is identity, not one of the version-1 radius tokens; `resolveIdentity` carries it.
    if (rem !== undefined && name !== "field") radius[name] = remLength(rem);
  }
  const tokens = {
    color: themeColors(input.scheme, theme),
    type: TYPE_SCALE,
    space: SPACE,
    radius,
    motion: themeMotion(theme),
    // Host-owned: a theme can make motion faster, slower or stepped, and reduced motion is still none at all.
    motionReduced: MOTION_REDUCED,
    layout: LAYOUT,
    identity: resolveIdentity(theme),
  } as AppearanceTokens;
  const themeRef = input.themeRef ?? BUILTIN_CLARK_THEME_REF;
  return appearanceSnapshotSchema.parse({
    appearanceApi: APPEARANCE_API_VERSION,
    tokenContractVersion: TOKEN_CONTRACT_VERSION,
    themeRef,
    scheme: input.scheme,
    revision: fingerprint(JSON.stringify([APPEARANCE_API_VERSION, TOKEN_CONTRACT_VERSION, themeRef, input.scheme, tokens])),
    tokens,
  });
}

/** The contrast audit of a compiled snapshot: the same pairs and thresholds Clark Default is held to. */
export function auditAppearance(snapshot: AppearanceSnapshot): ContrastAudit {
  return auditColors(snapshot.scheme, snapshot.tokens.color);
}

/**
 * A theme document audited in every scheme it can be drawn in.
 *
 * The palette audited is the one `compileAppearance` draws, from the same merge, so the audit and the stylesheet cannot
 * disagree about which colours a theme ends up with. A colour that is not a six-digit hex throws here as it does there.
 */
export function auditThemeDocument(theme: ThemeDocument): ContrastAudit[] {
  return RESOLVED_COLOR_SCHEMES.map((scheme) => auditColors(scheme, themeColors(scheme, theme)));
}

/** Why a theme cannot be drawn readably: every failing pair as data, and the same failures as one English sentence. */
export interface ThemeContrastProblem {
  /** For a surface a person reads, which words each pair in their own language. */
  failures: ThemeContrastFailureView[];
  /** For logs and API messages. Never shown to a person as it is. */
  message: string;
}

/**
 * Why a theme cannot be drawn readably, or `undefined` when it can.
 *
 * The one place that decides which pairs a theme fails, so the node's listing, its refusal of a choice and the page's
 * own refusal agree. A theme that fails in either scheme is refused whole: the colour scheme is a separate choice, and a
 * person switching it must not land on unreadable text.
 */
export function themeContrastProblem(theme: ThemeDocument): ThemeContrastProblem | undefined {
  const failing = auditThemeDocument(theme).filter((audit) => audit.failures.length > 0);
  if (failing.length === 0) return undefined;
  const failures = failing.flatMap((audit) =>
    audit.failures.map((failure) => ({
      scheme: audit.scheme,
      foreground: failure.foregroundToken,
      background: failure.backgroundToken,
      ratio: failure.ratio,
      minimum: failure.minimum,
    })),
  );
  const parts = failing.map(
    (audit) =>
      `in the ${audit.scheme} scheme, ${audit.failures
        .map((failure) => `${failure.purpose} is ${failure.ratio.toFixed(2)}:1 and needs ${String(failure.minimum)}:1`)
        .join(", ")}`,
  );
  return { failures, message: `its colours are too close to read: ${parts.join("; ")}` };
}

/** A theme's palette in one scheme: Clark's, patched by what the theme says for that scheme. */
function themeColors(scheme: ResolvedColorScheme, theme: ThemeDocument): ColorTokens {
  return { ...CLARK_SCHEMES[scheme], ...theme.colors?.[scheme] } as ColorTokens;
}

/** The curves an easing choice draws with: the everyday curve, and the one with overshoot. */
const EASINGS: Readonly<Record<ThemeMotionEasing, { easing: string; bounce: string }>> = {
  standard: { easing: MOTION.easing, bounce: MOTION.bounce },
  snappy: { easing: "cubic-bezier(0.2, 0, 0, 1)", bounce: "cubic-bezier(0.3, 1.4, 0.5, 1)" },
  linear: { easing: "linear", bounce: "linear" },
  stepped: { easing: "steps(4)", bounce: "steps(4)" },
};

/**
 * A theme's full-motion tokens: Clark's durations scaled by the theme's speed, along the theme's curves.
 *
 * Clark's own object when the theme says nothing about motion, so a theme without motion compiles to exactly Clark's
 * values rather than to a recomputation of them.
 */
function themeMotion(theme: ThemeDocument): AppearanceTokens["motion"] {
  if (theme.motion === undefined) return MOTION;
  const speed = theme.motion.speed ?? 1;
  const curves = EASINGS[theme.motion.easing ?? "standard"];
  const scaled = (duration: string): string => `${String(Math.round(Number.parseInt(duration, 10) / speed))}ms`;
  return {
    micro: scaled(MOTION.micro),
    normal: scaled(MOTION.normal),
    panel: scaled(MOTION.panel),
    orb: scaled(MOTION.orb),
    enter: scaled(MOTION.enter),
    exit: scaled(MOTION.exit),
    glow: scaled(MOTION.glow),
    ...curves,
  };
}

/** Why a theme cannot be drawn, whichever audit refuses it first. */
export type ThemeDrawProblem =
  | { code: "THEME_LOW_CONTRAST"; message: string; contrast: ThemeContrastFailureView[] }
  | { code: "THEME_PROTECTED"; message: string; protected: ThemeProtectedFailureView[] };

/**
 * Why a theme would hide a protected state, or `undefined` when it would not. See `protected.ts`.
 *
 * Audited on the palettes and the identity `compileAppearance` draws, from the same merges.
 */
export function themeProtectedProblem(theme: ThemeDocument): { failures: ThemeProtectedFailureView[]; message: string } | undefined {
  const failures = auditProtectedSchemes(
    { dark: themeColors("dark", theme), light: themeColors("light", theme) },
    resolveIdentity(theme),
  );
  if (failures.length === 0) return undefined;
  const parts = failures.map(
    (failure) =>
      `in the ${failure.scheme} scheme, ${failure.check} (${failure.first} and ${failure.second}) measures ${failure.value.toFixed(2)} and needs ${String(failure.minimum)}`,
  );
  return { failures, message: `it would make protected states hard to tell apart: ${parts.join("; ")}` };
}

/**
 * Why a theme cannot be drawn, or `undefined` when it can: the one decision the node's listing, its refusal of a choice
 * and the page's own refusal all make, so they cannot disagree. Unreadable text is reported before hidden states.
 */
export function themeDrawProblem(theme: ThemeDocument): ThemeDrawProblem | undefined {
  const unreadable = themeContrastProblem(theme);
  if (unreadable !== undefined) return { code: "THEME_LOW_CONTRAST", message: unreadable.message, contrast: unreadable.failures };
  const hidden = themeProtectedProblem(theme);
  if (hidden !== undefined) return { code: "THEME_PROTECTED", message: hidden.message, protected: hidden.failures };
  return undefined;
}

/**
 * A rem length from a number, rounded to what the length contract accepts.
 *
 * `String(n)` alone would write `1e-7rem` for a tiny value, which is not a length.
 */
function remLength(value: number): string {
  return `${String(Number(value.toFixed(4)))}rem`;
}

/**
 * A 64-bit content fingerprint, as sixteen hex digits.
 *
 * Not a security hash, and not used as one: it tells a renderer that an appearance changed, and nothing trusts it to
 * say who produced it. It is computed here rather than with `node:crypto` because this package runs in the browser.
 */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
