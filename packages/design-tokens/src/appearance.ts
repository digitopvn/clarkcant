import {
  APPEARANCE_API_VERSION,
  BUILTIN_CLARK_THEME_REF,
  RESOLVED_COLOR_SCHEMES,
  TOKEN_CONTRACT_VERSION,
  appearanceSnapshotSchema,
  type AppearanceSnapshot,
  type AppearanceTokens,
  type ResolvedColorScheme,
  type ThemeDocument,
} from "@clarkcant/contracts";

import { type ContrastAudit, auditColors } from "./contrast.ts";
import { CLARK_SCHEMES, LAYOUT, MOTION, MOTION_REDUCED, RADIUS, SPACE, TYPE_SCALE } from "./tokens.ts";

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

export interface CompileAppearanceInput {
  /** The scheme to draw in, already resolved from the person's choice. */
  scheme: ResolvedColorScheme;
  /** The theme, validated. Clark Default when absent. */
  theme?: ThemeDocument | undefined;
  /** The reference the theme was selected by. `builtin:clark` when absent. */
  themeRef?: string | undefined;
}

/** Compile one theme in one scheme. Throws only if the result would break the snapshot contract. */
export function compileAppearance(input: CompileAppearanceInput): AppearanceSnapshot {
  const theme = input.theme ?? CLARK_THEME;
  const radius: Record<string, string> = { ...RADIUS };
  for (const [name, rem] of Object.entries(theme.radius ?? {})) {
    if (rem !== undefined) radius[name] = remLength(rem);
  }
  const tokens = {
    color: { ...CLARK_SCHEMES[input.scheme], ...theme.colors?.[input.scheme] },
    type: TYPE_SCALE,
    space: SPACE,
    radius,
    motion: MOTION,
    motionReduced: MOTION_REDUCED,
    layout: LAYOUT,
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

/** A theme document audited in every scheme it can be drawn in. */
export function auditThemeDocument(theme: ThemeDocument): ContrastAudit[] {
  return RESOLVED_COLOR_SCHEMES.map((scheme) => auditAppearance(compileAppearance({ scheme, theme })));
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
