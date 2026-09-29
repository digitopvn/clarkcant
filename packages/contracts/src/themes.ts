/**
 * Themes and the appearance a host renders from one.
 *
 * Two choices that the product used to hold as one are separate here, and keeping them separate is the point of this
 * module:
 *
 *   - the **theme** is a visual system — Clark Default, or a theme a package provides — named by a `ThemeRef`;
 *   - the **colour scheme** is System, Light or Dark, and it is resolved against the operating system to one of the
 *     two schemes every theme is drawn in.
 *
 * A theme is data, never code. A `ThemeDocument` is what a package ships and what the host validates; an
 * `AppearanceSnapshot` is what the host compiles from it and what a renderer is allowed to read. Every value in a
 * snapshot is a closed token name mapped to a value of a checked shape — a six-digit hex colour, a length, a duration,
 * an easing — so nothing a theme says can become a selector, a `url(…)`, a variable reference or a script when the
 * snapshot is written out as CSS.
 *
 * The versions below are this contract's own. They are deliberately not the `@clarkcant/design-tokens` package
 * version: a theme published to a marketplace is bound to the shape it was written against, and a refactor inside the
 * token package must not be able to invalidate every published theme.
 */

import { z } from "zod";

import type { RiskLane } from "./directory.ts";
import { facetIdSchema } from "./install.ts";

/** The version of the theme document and snapshot shapes. A theme declares the range it was written against. */
export const APPEARANCE_API_VERSION = 1;

/** The version of the token name set a snapshot carries. Adding a token is a new version; renaming one is too. */
export const TOKEN_CONTRACT_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Colour scheme
 * ------------------------------------------------------------------ */

/**
 * What the person chose. `system` is a choice, not a scheme: it means "follow the operating system", and storing the
 * scheme it resolved to instead would stop the interface following the system it was asked to follow.
 */
export const colorSchemeSchema = z.enum(["system", "light", "dark"]);
export type ColorScheme = z.infer<typeof colorSchemeSchema>;
export const COLOR_SCHEMES: readonly ColorScheme[] = colorSchemeSchema.options;
export const DEFAULT_COLOR_SCHEME: ColorScheme = "system";

/** The scheme actually drawn. Every theme is drawn in exactly these two. */
export const resolvedColorSchemeSchema = z.enum(["dark", "light"]);
export type ResolvedColorScheme = z.infer<typeof resolvedColorSchemeSchema>;
export const RESOLVED_COLOR_SCHEMES: readonly ResolvedColorScheme[] = resolvedColorSchemeSchema.options;

/** Turn a choice into the scheme that is drawn. */
export function resolveColorScheme(choice: ColorScheme, systemPrefersLight: boolean): ResolvedColorScheme {
  if (choice === "system") return systemPrefersLight ? "light" : "dark";
  return choice;
}

/* ------------------------------------------------------------------ *
 * Theme references
 * ------------------------------------------------------------------ */

/**
 * Which theme, as a string a preference can hold.
 *
 *   - `builtin:<name>` — a theme this build ships, such as `builtin:clark`;
 *   - `package:<packageId>#<facetId>` — the `themes` facet `facetId` of the installed package `packageId`.
 *
 * `#` separates the two because a facet id cannot contain one, while a package id may contain `/` and `@`
 * (`@community/pixel-arcade`). A reference names a theme; it grants nothing and loads nothing by itself, and a
 * reference to a theme that is not installed resolves to Clark Default rather than failing.
 */
export type ThemeRefParts =
  | { readonly kind: "builtin"; readonly name: string }
  | { readonly kind: "package"; readonly packageId: string; readonly facetId: string };

export const BUILTIN_THEME_PREFIX = "builtin:";
export const PACKAGE_THEME_PREFIX = "package:";
export const BUILTIN_CLARK_THEME_REF = "builtin:clark";

const BUILTIN_THEME_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** Printable, no whitespace and no `#`: a package id is looked up verbatim, never interpreted. */
const THEME_PACKAGE_ID = /^[\x21-\x22\x24-\x7e]{1,160}$/;

/** The parts of a reference, or nothing when the string is not one. */
export function parseThemeRef(value: string): ThemeRefParts | undefined {
  if (value.length > 400) return undefined;
  if (value.startsWith(BUILTIN_THEME_PREFIX)) {
    const name = value.slice(BUILTIN_THEME_PREFIX.length);
    return BUILTIN_THEME_NAME.test(name) ? { kind: "builtin", name } : undefined;
  }
  if (value.startsWith(PACKAGE_THEME_PREFIX)) {
    const rest = value.slice(PACKAGE_THEME_PREFIX.length);
    const separator = rest.lastIndexOf("#");
    if (separator <= 0) return undefined;
    const packageId = rest.slice(0, separator);
    const facetId = rest.slice(separator + 1);
    // The manifest's own facet-id schema, so a reference can name every facet a manifest can declare and no other.
    if (!THEME_PACKAGE_ID.test(packageId) || !facetIdSchema.safeParse(facetId).success) return undefined;
    return { kind: "package", packageId, facetId };
  }
  return undefined;
}

/** The reference for a set of parts. The inverse of `parseThemeRef` for every value it accepts. */
export function formatThemeRef(parts: ThemeRefParts): string {
  return parts.kind === "builtin"
    ? `${BUILTIN_THEME_PREFIX}${parts.name}`
    : `${PACKAGE_THEME_PREFIX}${parts.packageId}#${parts.facetId}`;
}

export const themeRefSchema = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => parseThemeRef(value) !== undefined, {
    error: "must be builtin:<name> or package:<packageId>#<facetId>",
  });
export type ThemeRef = z.infer<typeof themeRefSchema>;

/* ------------------------------------------------------------------ *
 * Token names
 * ------------------------------------------------------------------ */

/**
 * The public token names, per group.
 *
 * Closed lists, and the public contract: a widget or a theme can rely on these names existing, and nothing outside
 * them is emitted. `@clarkcant/design-tokens` declares its values against these lists, so a token added there
 * without being added here is a compile error rather than a variable no contract describes.
 */
export const COLOR_TOKEN_NAMES = [
  "canvas",
  "window",
  "card",
  "elevated",
  "code",
  "border",
  "text",
  "textMuted",
  "textTertiary",
  "accent",
  "onAccent",
  "success",
  "warning",
  "danger",
  "focus",
] as const;
export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];

export const TYPE_TOKEN_NAMES = [
  "displayXl",
  "displayLg",
  "headingLg",
  "headingMd",
  "bodyLg",
  "bodyMd",
  "bodySm",
  "label",
  "monoSm",
  "meta",
] as const;
export type TypeTokenName = (typeof TYPE_TOKEN_NAMES)[number];

export const SPACE_TOKEN_NAMES = ["xxs", "xs", "sm", "md", "lg", "xl", "xxl", "s20", "s40", "s48", "s64", "s80"] as const;
export type SpaceTokenName = (typeof SPACE_TOKEN_NAMES)[number];

/** Radii by the component they are for. `pill` is part of the set and is host-owned: a theme cannot restyle it. */
export const RADIUS_TOKEN_NAMES = ["badge", "button", "card", "response", "modal", "pill"] as const;
export type RadiusTokenName = (typeof RADIUS_TOKEN_NAMES)[number];

/** The radii a theme may set. */
export const THEMEABLE_RADIUS_NAMES = ["badge", "button", "card", "response", "modal"] as const;
export type ThemeableRadiusName = (typeof THEMEABLE_RADIUS_NAMES)[number];

/** Motion is two kinds of value: how long, and along which curve. */
export const MOTION_DURATION_NAMES = ["micro", "normal", "panel", "orb", "enter", "exit", "glow"] as const;
export const MOTION_EASING_NAMES = ["easing", "bounce"] as const;
export const MOTION_TOKEN_NAMES = [...MOTION_DURATION_NAMES, ...MOTION_EASING_NAMES] as const;
export type MotionTokenName = (typeof MOTION_TOKEN_NAMES)[number];

export const LAYOUT_TOKEN_NAMES = [
  "conversationMaxWidth",
  "composerMaxWidth",
  "composerMinHeight",
  "topBarHeight",
  "modalWidth",
] as const;
export type LayoutTokenName = (typeof LAYOUT_TOKEN_NAMES)[number];

/* ------------------------------------------------------------------ *
 * Value shapes
 * ------------------------------------------------------------------ */

/**
 * A colour, as exactly six hex digits.
 *
 * Deliberately narrower than CSS: no keywords, no functions, no alpha. A contrast ratio needs one opaque colour to
 * measure, and a value that could be `var(…)`, `url(…)` or `transparent` could not be audited and could carry more
 * than a colour into a stylesheet.
 */
export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, { error: "must be a six-digit hex colour, #rrggbb" });

/** A length the host wrote: a plain number of `rem` or `px`. */
export const cssLengthSchema = z.string().regex(/^(?:0|[0-9]{1,4}(?:\.[0-9]{1,4})?)(?:rem|px)$/, {
  error: "must be a number of rem or px",
});

/** A duration the host wrote. */
export const cssDurationSchema = z.string().regex(/^[0-9]{1,5}ms$/, { error: "must be a whole number of milliseconds" });

const EASING_NUMBER = "-?[0-9](?:\\.[0-9]{1,3})?";
/** An easing the host wrote: `linear`, or a `cubic-bezier` of four plain numbers. */
export const cssEasingSchema = z
  .string()
  .regex(new RegExp(`^(?:linear|cubic-bezier\\(${EASING_NUMBER}, ${EASING_NUMBER}, ${EASING_NUMBER}, ${EASING_NUMBER}\\))$`), {
    error: "must be linear or a cubic-bezier of four numbers",
  });

function closedRecord<const Name extends string, Value extends z.ZodType>(names: readonly Name[], value: Value) {
  return z.strictObject(Object.fromEntries(names.map((name) => [name, value])) as Record<Name, Value>);
}

function partialRecord<const Name extends string, Value extends z.ZodType>(names: readonly Name[], value: Value) {
  return z.strictObject(Object.fromEntries(names.map((name) => [name, value.optional()])) as Record<Name, z.ZodOptional<Value>>);
}

export const colorTokensSchema = closedRecord(COLOR_TOKEN_NAMES, hexColorSchema);
export type ColorTokenSet = z.infer<typeof colorTokensSchema>;

/* ------------------------------------------------------------------ *
 * Theme document
 * ------------------------------------------------------------------ */

/**
 * How far a theme may move a radius, in rem.
 *
 * Zero is allowed, because a square control is a legitimate visual system (Neo Brutalism is built on it). The ceiling
 * keeps a card from becoming a circle whose content no longer fits inside its corners.
 */
export const THEME_RADIUS_BOUNDS = { min: 0, max: 2 } as const;

const themeRadiusSchema = z.number().min(THEME_RADIUS_BOUNDS.min).max(THEME_RADIUS_BOUNDS.max);

/** A theme's colours for one scheme: a patch over Clark's own palette for that scheme. */
export const themeColorOverridesSchema = partialRecord(COLOR_TOKEN_NAMES, hexColorSchema);
export type ThemeColorOverrides = z.infer<typeof themeColorOverridesSchema>;

/** The range of appearance API versions a theme was written against. */
export const appearanceApiRangeSchema = z
  .strictObject({ min: z.int().min(1), max: z.int().min(1) })
  .refine((range) => range.min <= range.max, { error: "appearanceApi.min must not exceed appearanceApi.max" });

/**
 * A theme, as a package ships it (`theme.json`) and as this build declares its own.
 *
 * A patch over Clark Default, not a complete description: a theme that says nothing about a token keeps Clark's value
 * for it. That keeps a small theme small, and it means a token added to a later contract version reaches every
 * existing theme with a sensible value instead of a hole. Strict throughout, so a field this version does not know is
 * refused rather than silently ignored — a theme that relies on a field the host drops would render as something its
 * author never saw.
 */
export const themeDocumentSchema = z.strictObject({
  appearanceApi: appearanceApiRangeSchema,
  /** The theme's id. For a package theme it must equal the `themes` facet id that points at this file. */
  id: facetIdSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(400).optional(),
  colors: z
    .strictObject({
      light: themeColorOverridesSchema.optional(),
      dark: themeColorOverridesSchema.optional(),
    })
    .optional(),
  /** Radii in rem, per component. */
  radius: partialRecord(THEMEABLE_RADIUS_NAMES, themeRadiusSchema).optional(),
});
export type ThemeDocument = z.infer<typeof themeDocumentSchema>;

/** Why this build cannot draw a theme written for another appearance API, or nothing when it can. */
export function themeCompatibilityProblem(document: Pick<ThemeDocument, "appearanceApi">): string | undefined {
  const { min, max } = document.appearanceApi;
  if (APPEARANCE_API_VERSION < min || APPEARANCE_API_VERSION > max) {
    return `the theme needs appearance API ${String(min)}–${String(max)}, and this build provides ${String(APPEARANCE_API_VERSION)}`;
  }
  return undefined;
}

export type ThemeDocumentCheck =
  | { readonly ok: true; readonly document: ThemeDocument }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validate a theme document at the boundary: its shape, then whether this build can draw it.
 *
 * Every problem is returned, each naming the field it is about, because a theme author fixing one error at a time
 * against a validator that stops at the first is a slow loop. The document that comes back is the parsed one, so a
 * caller never renders the raw input it was handed.
 */
export function checkThemeDocument(raw: unknown): ThemeDocumentCheck {
  const parsed = themeDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "document"}: ${issue.message}`),
    };
  }
  const incompatible = themeCompatibilityProblem(parsed.data);
  if (incompatible !== undefined) return { ok: false, problems: [incompatible] };
  return { ok: true, document: parsed.data };
}

/* ------------------------------------------------------------------ *
 * Appearance snapshot
 * ------------------------------------------------------------------ */

const motionTokensSchema = z.strictObject({
  ...closedRecord(MOTION_DURATION_NAMES, cssDurationSchema).shape,
  ...closedRecord(MOTION_EASING_NAMES, cssEasingSchema).shape,
});

export const appearanceTokensSchema = z.strictObject({
  color: colorTokensSchema,
  type: closedRecord(TYPE_TOKEN_NAMES, z.strictObject({ size: cssLengthSchema, lineHeight: cssLengthSchema })),
  space: closedRecord(SPACE_TOKEN_NAMES, cssLengthSchema),
  radius: closedRecord(RADIUS_TOKEN_NAMES, cssLengthSchema),
  motion: motionTokensSchema,
  /** The reduced-motion counterparts. A renderer uses these whenever reduced motion is asked for, whatever the theme. */
  motionReduced: motionTokensSchema,
  layout: closedRecord(LAYOUT_TOKEN_NAMES, cssLengthSchema),
});
export type AppearanceTokens = z.infer<typeof appearanceTokensSchema>;

/**
 * The resolved appearance for one theme in one scheme: what a renderer reads, never the theme document itself.
 *
 * Every token here is written out as a `--cc-*` custom property, and nothing else is: a value a snapshot carries but no
 * stylesheet emits would be a contract nobody can observe.
 *
 * `revision` is a fingerprint of everything else in the snapshot, so two compilations of the same theme in the same
 * scheme carry the same revision, and a consumer can tell "nothing changed" from "the appearance changed" without
 * comparing every token.
 */
export const appearanceSnapshotSchema = z.strictObject({
  appearanceApi: z.literal(APPEARANCE_API_VERSION),
  tokenContractVersion: z.literal(TOKEN_CONTRACT_VERSION),
  themeRef: themeRefSchema,
  scheme: resolvedColorSchemeSchema,
  revision: z.string().regex(/^[0-9a-f]{8,64}$/),
  tokens: appearanceTokensSchema,
});
export type AppearanceSnapshot = z.infer<typeof appearanceSnapshotSchema>;

/* ------------------------------------------------------------------ *
 * The node's answers: the theme registry and the resolved appearance
 * ------------------------------------------------------------------ */

/** Who provides a theme, with the provenance a person needs to judge it. */
export type ThemeProviderView =
  | { kind: "builtin" }
  | {
      kind: "package";
      packageId: string;
      version: string;
      digest: string;
      /** The package's strongest lane, not the theme's own: a theme shipped beside a service is a service package. */
      lane: RiskLane;
      sourceTier: string;
    };

/** One theme that can be selected. */
export interface ThemeListingView {
  themeRef: string;
  displayName: string;
  description?: string;
  provider: ThemeProviderView;
}

/** A theme an installed package declares that could not be loaded, and why. */
export interface ThemeProblemView {
  packageId: string;
  version: string;
  /** Absent when the package id cannot form a reference at all. */
  themeRef: string | undefined;
  message: string;
}

/** An installed package this node could not inspect for themes, which is a different fact from "has none". */
export interface UncheckedThemePackageView {
  packageId: string;
  version: string;
  code: "NO_DIRECTORY" | "NOT_IN_DIRECTORY" | "NOT_LOCAL" | "UNREADABLE";
  message: string;
}

/** `GET /themes`. Clark Default is always first. */
export interface ThemesResponse {
  themes: ThemeListingView[];
  problems: ThemeProblemView[];
  unchecked: UncheckedThemePackageView[];
}

/** Why the chosen theme is not the one being drawn. */
export type AppearanceFallbackCode =
  /** No active package provides it: never installed here, uninstalled, or its facet is gone in this version. */
  | "THEME_NOT_INSTALLED"
  /** The package is installed, and this theme in it did not pass validation. */
  | "THEME_INVALID"
  /** The theme is valid, and its colours fail the contrast audit Clark Default is held to, so text in it is unreadable. */
  | "THEME_LOW_CONTRAST"
  /** The package is installed, and this node could not read it. */
  | "THEME_UNAVAILABLE"
  /** A built-in name this build does not have. */
  | "THEME_UNKNOWN";

/** `GET /appearance`: the theme to draw now, and why it is not the chosen one when it is not. */
export interface AppearanceResponse {
  /** What the person chose. Kept as it is when it cannot be drawn, so restoring the package brings it back. */
  selectedRef: string;
  /** What is drawn. */
  appliedRef: string;
  /** The validated document to compile, or `null` for Clark Default. */
  theme: ThemeDocument | null;
  provider: ThemeProviderView;
  fallback: { code: AppearanceFallbackCode; message: string } | null;
}