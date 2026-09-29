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
    if (rem !== undefined) radius[name] = remLength(rem);
  }
  const tokens = {
    color: themeColors(input.scheme, theme),
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

/**
 * A theme document audited in every scheme it can be drawn in.
 *
 * The palette audited is the one `compileAppearance` draws, from the same merge, so the audit and the stylesheet cannot
 * disagree about which colours a theme ends up with. A colour that is not a six-digit hex throws here as it does there.
 */
export function auditThemeDocument(theme: ThemeDocument): ContrastAudit[] {
  return RESOLVED_COLOR_SCHEMES.map((scheme) => auditColors(scheme, themeColors(scheme, theme)));
}

/**
 * Why a theme cannot be drawn readably, or `undefined` when it can.
 *
 * One sentence naming every pair that fails, in each scheme, with the ratio it has and the one it needs, so the node's
 * notice and the page's own refusal say the same thing. A theme that fails in either scheme is refused whole: the
 * colour scheme is a separate choice, and a person switching it must not land on unreadable text.
 */
export function themeContrastProblem(theme: ThemeDocument): string | undefined {
  const failing = auditThemeDocument(theme).filter((audit) => audit.failures.length > 0);
  if (failing.length === 0) return undefined;
  const parts = failing.map(
    (audit) =>
      `in the ${audit.scheme} scheme, ${audit.failures
        .map((failure) => `${failure.purpose} is ${failure.ratio.toFixed(2)}:1 and needs ${String(failure.minimum)}:1`)
        .join(", ")}`,
  );
  return `its colours are too close to read: ${parts.join("; ")}`;
}

/** A theme's palette in one scheme: Clark's, patched by what the theme says for that scheme. */
function themeColors(scheme: ResolvedColorScheme, theme: ThemeDocument): ColorTokens {
  return { ...CLARK_SCHEMES[scheme], ...theme.colors?.[scheme] } as ColorTokens;
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
