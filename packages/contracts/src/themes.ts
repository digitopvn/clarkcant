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
import { orbPalettePreferenceSchema } from "./orb-palette.ts";
import type { OrbProfileName } from "./preferences.ts";

/**
 * The version of the theme document and snapshot shapes. A theme declares the range it was written against.
 *
 * Version 2 added identity: typography, border, shadow, motion, component recipes, effects and an Orb default. Every
 * version-1 field kept its meaning, so a version-1 theme is still drawn; see `APPEARANCE_API_OLDEST`.
 */
export const APPEARANCE_API_VERSION = 2;

/**
 * The oldest appearance API this build still draws.
 *
 * A build supports a range rather than one number, so publishing version 2 did not orphan every theme written for 1: a
 * theme is drawable when its declared range and this one overlap.
 */
export const APPEARANCE_API_OLDEST = 1;

/**
 * The version of the token set a snapshot carries. Adding a token is a new version; renaming one is too.
 *
 * Version 2 added the `identity` group.
 */
export const TOKEN_CONTRACT_VERSION = 2;

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
/** An easing the host wrote: `linear`, a `cubic-bezier` of four plain numbers, or `steps(n)` for a stepped look. */
export const cssEasingSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:linear|steps\\([1-9]\\)|cubic-bezier\\(${EASING_NUMBER}, ${EASING_NUMBER}, ${EASING_NUMBER}, ${EASING_NUMBER}\\))$`,
    ),
    { error: "must be linear, steps(1-9) or a cubic-bezier of four numbers" },
  );

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

/* ------------------------------------------------------------------ *
 * Identity (appearance API 2)
 *
 * Everything below is a choice from a list the host wrote, or a number inside bounds the host set. A theme picks a
 * font profile, never a font-family string; a recipe, never a selector or a declaration; an effect and its strength,
 * never a gradient, a filter, a `url(…)` or a shader. The host turns each choice into CSS it wrote itself, so what a
 * theme says can change how a surface looks and never which elements are styled, what they say, or what they do.
 * ------------------------------------------------------------------ */

/**
 * The typefaces a theme can ask for, as profiles of system fonts.
 *
 * Profiles rather than family names, because a family name is a string that reaches a stylesheet, and because a font
 * this build does not ship would silently fall back on one machine and not another. `clark` is Plus Jakarta Sans.
 * `inter`, `geist`, `jetbrains` and `geist-mono` are faces the host ships itself, so they draw the same on every
 * platform; the others are system stacks. New profiles are only ever appended.
 */
export const THEME_FONT_PROFILES = ["clark", "system", "serif", "rounded", "mono", "inter", "geist"] as const;
export type ThemeFontProfile = (typeof THEME_FONT_PROFILES)[number];
export const THEME_MONO_PROFILES = ["clark", "typewriter", "jetbrains", "geist-mono"] as const;
export type ThemeMonoProfile = (typeof THEME_MONO_PROFILES)[number];

export const THEME_BORDER_STYLES = ["solid", "dashed"] as const;
/** How far a theme may thicken a structural line, in whole pixels. Never zero: an edge is how a region is found. */
export const THEME_BORDER_WIDTH_BOUNDS = { min: 1, max: 3 } as const;

/** `soft` is Clark's blurred elevation, `hard` an offset block with no blur, `none` a flat surface. */
export const THEME_SHADOW_STYLES = ["soft", "hard", "none"] as const;
export type ThemeShadowStyle = (typeof THEME_SHADOW_STYLES)[number];
/** The colour a hard shadow is drawn in, as a token rather than a value, so it follows the scheme. */
export const THEME_SHADOW_COLORS = ["text", "border", "accent"] as const;
export const THEME_SHADOW_OFFSET_BOUNDS = { min: 1, max: 8 } as const;

/** The curves a theme can move along. `standard` is Clark's. */
export const THEME_MOTION_EASINGS = ["standard", "snappy", "linear", "stepped"] as const;
export type ThemeMotionEasing = (typeof THEME_MOTION_EASINGS)[number];
/** A multiplier on every duration. Reduced motion is not multiplied: it stays zero whatever a theme says. */
export const THEME_MOTION_SPEED_BOUNDS = { min: 0.5, max: 2 } as const;

/** The font weight a heading is set in. */
export const THEME_HEADING_WEIGHT_BOUNDS = { min: 400, max: 800 } as const;

/** The stroke a line icon is drawn with, in the icon's own 24-unit grid. */
export const THEME_ICON_STROKE_BOUNDS = { min: 1, max: 2.5 } as const;

/**
 * Component recipes: host-written treatments a theme selects by name, one list per component.
 *
 * The first entry of each list is not special; Clark's own choice is in `CLARK_RECIPES`. A recipe restyles the
 * component's surface — fill, edge, elevation, corner — and nothing that carries meaning: focus rings, disabled state,
 * status colours and the host's own cards are drawn by rules no recipe reaches.
 */
export const THEME_RECIPES = {
  button: ["quiet", "outlined", "solid", "raised", "beveled"],
  card: ["flat", "outlined", "raised"],
  input: ["quiet", "filled", "outlined", "underlined"],
  modal: ["floating", "framed"],
  badge: ["pill", "rounded", "square"],
  composer: ["floating", "integrated", "framed"],
} as const;
export type ThemeRecipeComponent = keyof typeof THEME_RECIPES;
export const THEME_RECIPE_COMPONENTS = Object.keys(THEME_RECIPES) as ThemeRecipeComponent[];
export type ThemeRecipes = { [Component in ThemeRecipeComponent]: (typeof THEME_RECIPES)[Component][number] };

/** Clark Default's recipes: exactly the look the product had before recipes existed. */
export const CLARK_RECIPES: Readonly<ThemeRecipes> = {
  button: "outlined",
  card: "outlined",
  input: "outlined",
  modal: "floating",
  badge: "pill",
  composer: "floating",
};

/** What is drawn behind the conversation. Every one is a gradient the host wrote; none loads anything. */
export const THEME_BACKDROP_EFFECTS = ["none", "dot-grid", "hard-grid", "scanlines", "grain", "paper"] as const;
export type ThemeBackdropEffect = (typeof THEME_BACKDROP_EFFECTS)[number];
/** What a card, a modal and the composer are finished with. */
export const THEME_SURFACE_EFFECTS = ["none", "glass", "soft-glow", "paper", "grain"] as const;
export type ThemeSurfaceEffect = (typeof THEME_SURFACE_EFFECTS)[number];
export const THEME_EFFECT_INTENSITY_BOUNDS = { min: 0, max: 1 } as const;
/** The repeat of a backdrop pattern, in whole pixels. */
export const THEME_EFFECT_SCALE_BOUNDS = { min: 8, max: 48 } as const;

/**
 * The Orb profiles a theme may name as its default: every preset, never `custom`.
 *
 * `custom` is the person's own tuning; a theme naming it would point at values the person set, or at none. The list
 * is written here rather than imported because the preference registry imports this module.
 */
export const THEME_ORB_PROFILE_NAMES = ["clark", "calm", "jelly", "glass", "pearl", "plasma"] as const satisfies readonly Exclude<
  OrbProfileName,
  "custom"
>[];
export type ThemeOrbProfileName = (typeof THEME_ORB_PROFILE_NAMES)[number];

const intensitySchema = z.number().min(THEME_EFFECT_INTENSITY_BOUNDS.min).max(THEME_EFFECT_INTENSITY_BOUNDS.max);

export const themeTypographySchema = z.strictObject({
  body: z.enum(THEME_FONT_PROFILES).optional(),
  /** Headings and titles. */
  display: z.enum(THEME_FONT_PROFILES).optional(),
  /** Code, paths, digests and the terminal. */
  mono: z.enum(THEME_MONO_PROFILES).optional(),
  headingWeight: z.int().min(THEME_HEADING_WEIGHT_BOUNDS.min).max(THEME_HEADING_WEIGHT_BOUNDS.max).multipleOf(100).optional(),
});

export const themeBorderSchema = z.strictObject({
  width: z.int().min(THEME_BORDER_WIDTH_BOUNDS.min).max(THEME_BORDER_WIDTH_BOUNDS.max).optional(),
  style: z.enum(THEME_BORDER_STYLES).optional(),
});

export const themeShadowSchema = z.strictObject({
  style: z.enum(THEME_SHADOW_STYLES).optional(),
  /** How far a hard shadow is offset, in whole pixels. */
  offset: z.int().min(THEME_SHADOW_OFFSET_BOUNDS.min).max(THEME_SHADOW_OFFSET_BOUNDS.max).optional(),
  color: z.enum(THEME_SHADOW_COLORS).optional(),
});

export const themeMotionSchema = z.strictObject({
  speed: z.number().min(THEME_MOTION_SPEED_BOUNDS.min).max(THEME_MOTION_SPEED_BOUNDS.max).optional(),
  easing: z.enum(THEME_MOTION_EASINGS).optional(),
});

export const themeRecipesSchema = z.strictObject({
  button: z.enum(THEME_RECIPES.button).optional(),
  card: z.enum(THEME_RECIPES.card).optional(),
  input: z.enum(THEME_RECIPES.input).optional(),
  modal: z.enum(THEME_RECIPES.modal).optional(),
  badge: z.enum(THEME_RECIPES.badge).optional(),
  composer: z.enum(THEME_RECIPES.composer).optional(),
});

export const themeEffectsSchema = z.strictObject({
  backdrop: z
    .strictObject({
      kind: z.enum(THEME_BACKDROP_EFFECTS),
      intensity: intensitySchema.optional(),
      scale: z.int().min(THEME_EFFECT_SCALE_BOUNDS.min).max(THEME_EFFECT_SCALE_BOUNDS.max).optional(),
    })
    .optional(),
  surface: z.strictObject({ kind: z.enum(THEME_SURFACE_EFFECTS), intensity: intensitySchema.optional() }).optional(),
});

export const themeIconsSchema = z.strictObject({
  stroke: z.number().min(THEME_ICON_STROKE_BOUNDS.min).max(THEME_ICON_STROKE_BOUNDS.max).optional(),
});

export const themeOrbSchema = z.strictObject({
  /** The Orb this theme is drawn with when the person has not chosen one. The person's own choice always wins. */
  profile: z.enum(THEME_ORB_PROFILE_NAMES),
  /**
   * Colours laid over that profile's own, in the same closed channels and 0–1 bounds the Orb preference accepts: a
   * colour per named channel, never shader code. Dropped with the rest of the suggestion once the person chooses an Orb.
   *
   * Every channel but `canvas`, which is the page the Orb sits on: the page supplies it, and a theme that could set it
   * could paint the Orb in the page's own colour. The protected audit also measures the light the palette adds, so a
   * palette dark enough to vanish into the page is refused (`orb-visible`).
   */
  palette: orbPalettePreferenceSchema.omit({ canvas: true }).optional(),
});
export type ThemeOrb = z.infer<typeof themeOrbSchema>;

/** The fields that need appearance API 2, in the order a problem names them. */
const IDENTITY_FIELDS = ["typography", "border", "shadow", "motion", "icons", "recipes", "effects", "orb"] as const;

/**
 * A theme, as a package ships it (`theme.json`) and as this build declares its own.
 *
 * A patch over Clark Default, not a complete description: a theme that says nothing about a token keeps Clark's value
 * for it. That keeps a small theme small, and it means a token added to a later contract version reaches every
 * existing theme with a sensible value instead of a hole. Strict throughout, so a field this version does not know is
 * refused rather than silently ignored — a theme that relies on a field the host drops would render as something its
 * author never saw.
 */
export const themeDocumentSchema = z
  .strictObject({
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
    /** Radii in rem, per component. `field` — text fields and selects — needs appearance API 2. */
    radius: partialRecord([...THEMEABLE_RADIUS_NAMES, "field"], themeRadiusSchema).optional(),
    typography: themeTypographySchema.optional(),
    border: themeBorderSchema.optional(),
    shadow: themeShadowSchema.optional(),
    motion: themeMotionSchema.optional(),
    icons: themeIconsSchema.optional(),
    recipes: themeRecipesSchema.optional(),
    effects: themeEffectsSchema.optional(),
    orb: themeOrbSchema.optional(),
  })
  .superRefine((document, context) => {
    /*
     * A theme that uses identity cannot be drawn by a build that only knows version 1 — that build refuses the unknown
     * field — so declaring a range that starts at 1 would promise a build something it cannot do.
     */
    if (document.appearanceApi.min >= 2) return;
    const used = [
      ...IDENTITY_FIELDS.filter((field) => document[field] !== undefined),
      ...(document.radius?.field === undefined ? [] : ["radius.field"]),
    ];
    if (used.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["appearanceApi", "min"],
        message: `${used.join(", ")} need appearance API 2; set appearanceApi.min to 2`,
      });
    }
  });
export type ThemeDocument = z.infer<typeof themeDocumentSchema>;

/** Why this build cannot draw a theme written for another appearance API, or nothing when it can. */
export function themeCompatibilityProblem(document: Pick<ThemeDocument, "appearanceApi">): string | undefined {
  const { min, max } = document.appearanceApi;
  if (min > APPEARANCE_API_VERSION || max < APPEARANCE_API_OLDEST) {
    return `the theme needs appearance API ${String(min)}–${String(max)}, and this build provides ${String(APPEARANCE_API_OLDEST)}–${String(APPEARANCE_API_VERSION)}`;
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
  identity: z.strictObject({
    typography: z.strictObject({
      body: z.enum(THEME_FONT_PROFILES),
      display: z.enum(THEME_FONT_PROFILES),
      mono: z.enum(THEME_MONO_PROFILES),
      headingWeight: z.int().min(THEME_HEADING_WEIGHT_BOUNDS.min).max(THEME_HEADING_WEIGHT_BOUNDS.max).multipleOf(100),
    }),
    border: z.strictObject({
      width: z.int().min(THEME_BORDER_WIDTH_BOUNDS.min).max(THEME_BORDER_WIDTH_BOUNDS.max),
      style: z.enum(THEME_BORDER_STYLES),
    }),
    shadow: z.strictObject({
      style: z.enum(THEME_SHADOW_STYLES),
      offset: z.int().min(THEME_SHADOW_OFFSET_BOUNDS.min).max(THEME_SHADOW_OFFSET_BOUNDS.max),
      color: z.enum(THEME_SHADOW_COLORS),
    }),
    /** Text fields and selects. */
    fieldRadius: cssLengthSchema,
    iconStroke: z.number().min(THEME_ICON_STROKE_BOUNDS.min).max(THEME_ICON_STROKE_BOUNDS.max),
    recipes: z.strictObject({
      button: z.enum(THEME_RECIPES.button),
      card: z.enum(THEME_RECIPES.card),
      input: z.enum(THEME_RECIPES.input),
      modal: z.enum(THEME_RECIPES.modal),
      badge: z.enum(THEME_RECIPES.badge),
      composer: z.enum(THEME_RECIPES.composer),
    }),
    effects: z.strictObject({
      backdrop: z.strictObject({
        kind: z.enum(THEME_BACKDROP_EFFECTS),
        intensity: intensitySchema,
        scale: z.int().min(THEME_EFFECT_SCALE_BOUNDS.min).max(THEME_EFFECT_SCALE_BOUNDS.max),
      }),
      surface: z.strictObject({ kind: z.enum(THEME_SURFACE_EFFECTS), intensity: intensitySchema }),
    }),
  }),
});
export type AppearanceTokens = z.infer<typeof appearanceTokensSchema>;
/** A theme's identity with every choice made: what the theme said, and Clark's choice for everything it did not. */
export type AppearanceIdentity = AppearanceTokens["identity"];

/**
 * The resolved appearance for one theme in one scheme: what a renderer reads, never the theme document itself.
 *
 * Every token here is written out as a `--cc-*` custom property, and nothing else is: a value a snapshot carries but no
 * stylesheet emits would be a contract nobody can observe. The `identity` group is written as the properties where a
 * theme differs from Clark Default; Clark's own values are the fallbacks the component stylesheet reads them with, so
 * Clark Default's token sheet is the one it always was.
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

/**
 * One colour pair a theme fails the contrast audit on, as data rather than a sentence.
 *
 * `message` fields are English, for logs and for clients that show nothing better. A surface a person reads words each
 * failure itself, in their language, from these fields. `foreground` and `background` are names from the public token
 * contract.
 */
export interface ThemeContrastFailureView {
  scheme: ResolvedColorScheme;
  foreground: ColorTokenName;
  background: ColorTokenName;
  /** The ratio the pair has, rounded to two decimals. */
  ratio: number;
  /** The ratio it needs. */
  minimum: number;
}

/**
 * The protected-semantics checks: what must stay distinguishable in every theme, whatever else it changes.
 *
 *   - `status-distinct`: danger, warning, success and the accent (information, selection, the primary action) are
 *     told apart from each other;
 *   - `status-vs-text`: a status colour is told apart from body text, so a warning does not read as a sentence;
 *   - `focus-vs-border`: a focused control is told apart from an unfocused one;
 *   - `disabled-distinct`: the disabled tier is told apart from enabled text;
 *   - `edge-visible`: the edge the host's own cards — approval, credential, connection — are drawn with is seen
 *     against the card and the page;
 *   - `surface-readable`: text, the accent, the status colours and the focus ring stay readable on a surface an effect
 *     finished (the page under a backdrop and its pointer light; a card, the composer or the modal under glass, soft
 *     glow, paper or grain), held to the contrast audit's own minimums;
 *   - `orb-visible`: the Orb the theme draws by default adds light the eye can see against the page.
 *
 * Colour is never the only signal for any of these — every state also has a glyph, a word, an underline or a shape the
 * host draws — and these checks keep the colour a real second signal rather than a claim.
 */
export const PROTECTED_CHECKS = [
  "status-distinct",
  "status-vs-text",
  "focus-vs-border",
  "disabled-distinct",
  "edge-visible",
  "surface-readable",
  "orb-visible",
] as const;
export type ProtectedCheck = (typeof PROTECTED_CHECKS)[number];

/** One pair a theme fails a protected check on, as data a surface words in the reader's language. */
export interface ThemeProtectedFailureView {
  scheme: ResolvedColorScheme;
  check: ProtectedCheck;
  /** A colour token, or `orb` for `orb-visible`, which measures the Orb's light rather than a token. */
  first: ColorTokenName | "orb";
  second: ColorTokenName;
  /**
   * What the pair measures, rounded to two decimals: a perceptual distance (OKLab ΔE × 100) for every check but
   * `surface-readable`, which is a contrast ratio.
   */
  value: number;
  minimum: number;
}

/** A theme an installed package declares that could not be loaded, and why. */
export interface ThemeProblemView {
  packageId: string;
  version: string;
  /** Absent when the package id cannot form a reference at all. */
  themeRef: string | undefined;
  message: string;
  /** Present when the theme is valid and fails the contrast audit: every failing pair. */
  contrast?: ThemeContrastFailureView[];
  /** Present when the theme is valid, readable, and would hide a protected state: every failing check. */
  protected?: ThemeProtectedFailureView[];
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
  /**
   * The theme is valid and readable, and it would make a protected state — Stop, approve or deny, a status, focus,
   * disabled, the host's own cards — hard to tell apart.
   */
  | "THEME_PROTECTED"
  /** The package is installed, and this node could not read it. */
  | "THEME_UNAVAILABLE"
  /** A built-in name this build does not have. */
  | "THEME_UNKNOWN";

/** Why Clark Default is drawn instead of the chosen theme. */
export interface AppearanceFallbackView {
  code: AppearanceFallbackCode;
  /** English, for logs. A person is shown a sentence of the client's own, chosen by `code`. */
  message: string;
  /** With `THEME_LOW_CONTRAST`: every pair the theme fails. */
  contrast?: ThemeContrastFailureView[];
  /** With `THEME_PROTECTED`: every protected check the theme fails. */
  protected?: ThemeProtectedFailureView[];
}

/** `GET /appearance`: the theme to draw now, and why it is not the chosen one when it is not. */
export interface AppearanceResponse {
  /** What the person chose. Kept as it is when it cannot be drawn, so restoring the package brings it back. */
  selectedRef: string;
  /** What is drawn. */
  appliedRef: string;
  /** The validated document to compile, or `null` for Clark Default. */
  theme: ThemeDocument | null;
  provider: ThemeProviderView;
  fallback: AppearanceFallbackView | null;
  /** Personal spacing and accent, applied by the same snapshot compiler. Absent means defaults. */
  customization?: AppearanceCustomization;
  /** An installed update made the saved accent unreadable; the theme's own accent is retained. */
  customizationFallback?: AppearanceFallbackView;
}

export const accentPreferenceSchema = z.strictObject({
  dark: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  light: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).nullable();
/** A personal typeface: a profile, or `null` to keep the one the theme chose. */
export const fontPreferenceSchema = z.enum(THEME_FONT_PROFILES).nullable();
export const codeFontPreferenceSchema = z.enum(THEME_MONO_PROFILES).nullable();
export const appearanceCustomizationSchema = z.strictObject({
  accent: accentPreferenceSchema.default(null),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  /** The interface's typeface, for body text and headings alike. */
  font: fontPreferenceSchema.default(null),
  /** The typeface of code blocks, inline code, paths and figures set in monospace. */
  codeFont: codeFontPreferenceSchema.default(null),
});
export type AppearanceCustomization = z.infer<typeof appearanceCustomizationSchema>;

/** Whether any personal choice departs from the defaults, so a response or cache needs to carry the customization. */
export function isPersonalAppearance(customization: AppearanceCustomization): boolean {
  return customization.accent !== null || customization.density !== "comfortable"
    || customization.font !== null || customization.codeFont !== null;
}
