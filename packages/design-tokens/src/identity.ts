import {
  CLARK_RECIPES,
  type AppearanceIdentity,
  type ThemeDocument,
  type ThemeFontProfile,
  type ThemeMonoProfile,
} from "@clarkcant/contracts";

/**
 * Identity: how a theme looks beyond its colours — type, lines, depth, component recipes and effects — as CSS the host
 * wrote.
 *
 * A theme document only ever names a profile, a recipe or an effect and gives it a bounded number. This module is the
 * one place those choices become declarations, and every declaration is built here from host-written templates, so a
 * value a theme supplies can change a number inside a template and never add a selector, a property, a `url(…)` or a
 * function the host did not write.
 *
 * Clark Default's identity is the look the product already had. Its values are the fallbacks the component stylesheet
 * reads each variable with (`var(--cc-line, 1px solid)`), and a theme's identity is emitted only where it differs from
 * Clark's. That is what keeps Clark Default's token sheet byte-identical to the one it always was, and a test holds
 * every fallback in the stylesheet to the value here.
 */

/** Clark Default's identity: every choice the product made before identity was themeable. */
export const CLARK_IDENTITY: AppearanceIdentity = {
  typography: { body: "clark", display: "clark", mono: "clark", headingWeight: 600 },
  border: { width: 1, style: "solid" },
  shadow: { style: "soft", offset: 4, color: "text" },
  fieldRadius: "10px",
  iconStroke: 1.8,
  recipes: { ...CLARK_RECIPES },
  effects: {
    backdrop: { kind: "dot-grid", intensity: 0.5, scale: 22 },
    surface: { kind: "none", intensity: 0.5 },
  },
};

const FONT_STACKS: Readonly<Record<ThemeFontProfile, string>> = {
  clark: `"Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif`,
  system: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  serif: `ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`,
  rounded: `ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif`,
  mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
};

const MONO_STACKS: Readonly<Record<ThemeMonoProfile, string>> = {
  clark: "ui-monospace, SFMono-Regular, Menlo, monospace",
  typewriter: `"Courier New", Courier, ui-monospace, monospace`,
};

/** A font profile's stack, for a surface that sets a font outside CSS (the terminal's canvas). */
export function monoFontStack(profile: ThemeMonoProfile): string {
  return MONO_STACKS[profile];
}

/**
 * Every identity variable, in the order a stylesheet writes them.
 *
 * A closed list: `identityDeclarations` cannot produce a name outside it, and the component stylesheet may only read
 * identity through these names.
 */
export const IDENTITY_VARIABLES = [
  "--cc-font-body",
  "--cc-font-display",
  "--cc-font-mono",
  "--cc-weight-heading",
  "--cc-line",
  "--cc-radius-field",
  "--cc-icon-stroke",
  "--cc-shadow-popover",
  "--cc-shadow-soft",
  "--cc-shadow-raised",
  "--cc-shadow-modal",
  "--cc-shadow-drawer",
  "--cc-backdrop-size",
  "--cc-backdrop-alpha",
  "--cc-surface-fill",
  "--cc-surface-image",
  "--cc-surface-size",
  "--cc-surface-filter",
  "--cc-button-bg",
  "--cc-button-edge",
  "--cc-button-shadow",
  "--cc-button-press",
  "--cc-button-press-shadow",
  "--cc-card-edge",
  "--cc-card-shadow",
  "--cc-input-bg",
  "--cc-input-edge",
  "--cc-input-radius",
  "--cc-modal-line",
  "--cc-modal-edge",
  "--cc-modal-shadow",
  "--cc-badge-radius",
  "--cc-composer-line",
  "--cc-composer-edge",
  "--cc-composer-radius",
  "--cc-composer-shadow",
] as const;
export type IdentityVariable = (typeof IDENTITY_VARIABLES)[number];

/**
 * An identity's declarations. `undefined` means "the stylesheet's own value": a variable Clark Default never sets, read
 * with a fallback that is itself another token (`var(--cc-badge-radius, var(--cc-radius-pill))`).
 */
export type IdentityDeclarations = Readonly<Record<IdentityVariable, string | undefined>>;

/** A percentage with at most one decimal, from a fraction. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 1000) / 10)}%`;
}

function px(value: number): string {
  return `${String(Math.round(value * 10) / 10)}px`;
}

/**
 * The pattern a backdrop effect draws, in the colour `--cc-grid-dot` the backdrop layers set.
 *
 * The image cannot travel as a variable like the rest of identity: it is drawn in `--cc-grid-dot`, which the backdrop
 * element and its lit layer each set for themselves, and a custom property declared on the root would resolve that
 * reference at the root, where it does not exist. So the stylesheet writer emits the image as a rule of its own; see
 * `identityStylesheet`.
 */
export function backdropPattern(identity: AppearanceIdentity): { image: string; size: string | undefined } {
  const { kind, scale } = identity.effects.backdrop;
  const dot = "var(--cc-grid-dot)";
  switch (kind) {
    case "none":
      return { image: "none", size: undefined };
    case "dot-grid":
      return { image: `radial-gradient(circle, ${dot} 1px, transparent 1.6px)`, size: `${px(scale)} ${px(scale)}` };
    case "hard-grid":
      return {
        image: `linear-gradient(${dot} 1px, transparent 1px), linear-gradient(90deg, ${dot} 1px, transparent 1px)`,
        size: `${px(scale)} ${px(scale)}`,
      };
    case "scanlines":
      return { image: `linear-gradient(${dot} 1px, transparent 1px)`, size: `100% ${px(Math.max(2, Math.round(scale / 6)))}` };
    case "grain": {
      const a = Math.max(3, Math.round(scale / 3));
      const b = Math.max(5, Math.round(scale / 2));
      const c = Math.max(7, Math.round((scale * 2) / 3));
      return {
        image:
          `radial-gradient(circle at 30% 40%, ${dot} 0.6px, transparent 1px), ` +
          `radial-gradient(circle at 70% 80%, ${dot} 0.5px, transparent 1px), ` +
          `radial-gradient(circle at 15% 85%, ${dot} 0.7px, transparent 1px)`,
        size: `${px(a)} ${px(a)}, ${px(b)} ${px(b)}, ${px(c)} ${px(c)}`,
      };
    }
    case "paper":
      return {
        image: `repeating-linear-gradient(135deg, ${dot} 0 1px, transparent 1px ${px(Math.max(4, Math.round(scale / 4)))})`,
        size: "auto",
      };
  }
}

/**
 * How strongly a surface effect overlays the surface it finishes, at full intensity, and in which colour.
 *
 * Shared by the declarations and by the protected audit, so the colour the audit measures text against is the colour
 * the stylesheet draws.
 */
export const SURFACE_EFFECT_OVERLAY = {
  glass: { token: "canvas", alpha: 0.35 },
  "soft-glow": { token: "accent", alpha: 0.12 },
  paper: { token: "text", alpha: 0.04 },
  grain: { token: "text", alpha: 0.1 },
} as const;

function surfaceDeclarations(identity: AppearanceIdentity): Partial<Record<IdentityVariable, string>> {
  const { kind, intensity } = identity.effects.surface;
  switch (kind) {
    case "none":
      return {};
    case "glass":
      return {
        "--cc-surface-fill": `color-mix(in oklab, var(--cc-card) ${percent(1 - SURFACE_EFFECT_OVERLAY.glass.alpha * intensity)}, transparent)`,
        "--cc-surface-filter": `blur(${px(4 + 12 * intensity)}) saturate(1.2)`,
      };
    case "soft-glow":
      return {
        "--cc-surface-image": `radial-gradient(120% 90% at 50% 0%, color-mix(in oklab, var(--cc-accent) ${percent(SURFACE_EFFECT_OVERLAY["soft-glow"].alpha * intensity)}, transparent), transparent 70%)`,
      };
    case "paper":
      return {
        "--cc-surface-image": `repeating-linear-gradient(135deg, color-mix(in oklab, var(--cc-text) ${percent(SURFACE_EFFECT_OVERLAY.paper.alpha * intensity)}, transparent) 0 1px, transparent 1px 5px)`,
      };
    case "grain": {
      const grain = `color-mix(in oklab, var(--cc-text) ${percent(SURFACE_EFFECT_OVERLAY.grain.alpha * intensity)}, transparent)`;
      return {
        "--cc-surface-image":
          `radial-gradient(circle at 30% 40%, ${grain} 0.6px, transparent 1px), ` +
          `radial-gradient(circle at 70% 80%, ${grain} 0.5px, transparent 1px)`,
        "--cc-surface-size": "5px 5px, 7px 7px",
      };
    }
  }
}

/** The shadow vocabulary: Clark's soft elevation, an offset block, or nothing. */
function shadowDeclarations(identity: AppearanceIdentity): Record<
  "--cc-shadow-popover" | "--cc-shadow-soft" | "--cc-shadow-raised" | "--cc-shadow-modal" | "--cc-shadow-drawer",
  string
> {
  const { style, offset, color } = identity.shadow;
  if (style === "none") {
    return {
      "--cc-shadow-popover": "none",
      "--cc-shadow-soft": "none",
      "--cc-shadow-raised": "none",
      "--cc-shadow-modal": "none",
      "--cc-shadow-drawer": "none",
    };
  }
  if (style === "hard") {
    const ink = `var(--cc-${color})`;
    return {
      "--cc-shadow-popover": `${px(offset)} ${px(offset)} 0 ${ink}`,
      "--cc-shadow-soft": `${px(offset)} ${px(offset)} 0 ${ink}`,
      "--cc-shadow-raised": `${px(offset)} ${px(offset)} 0 ${ink}`,
      "--cc-shadow-modal": `${px(offset + 2)} ${px(offset + 2)} 0 ${ink}`,
      "--cc-shadow-drawer": `${px(-offset)} 0 0 ${ink}`,
    };
  }
  return {
    "--cc-shadow-popover": "0 8px 24px rgb(0 0 0 / 35%)",
    "--cc-shadow-soft": "0 12px 32px rgb(0 0 0 / 35%)",
    "--cc-shadow-raised": "0 12px 32px color-mix(in oklab, var(--cc-code) 42%, transparent)",
    "--cc-shadow-modal": "0 24px 64px color-mix(in oklab, var(--cc-code) 70%, transparent)",
    "--cc-shadow-drawer": "-8px 0 32px color-mix(in oklab, var(--cc-code) 60%, transparent)",
  };
}

/** A small shadow for a control or a card, in the theme's shadow style. */
function smallShadow(identity: AppearanceIdentity, blocky: number): { shadow: string; press: string } {
  const { style, offset, color } = identity.shadow;
  if (style === "hard") {
    const size = Math.min(offset, blocky);
    return { shadow: `${px(size)} ${px(size)} 0 var(--cc-${color})`, press: `translate(${px(size)}, ${px(size)})` };
  }
  if (style === "soft") return { shadow: "0 2px 6px rgb(0 0 0 / 28%)", press: "translateY(1px)" };
  return { shadow: "none", press: "scale(0.97)" };
}

function recipeDeclarations(identity: AppearanceIdentity): Partial<Record<IdentityVariable, string>> {
  const { recipes, border } = identity;
  const heavier = `${px(border.width + 1)} ${border.style}`;
  const out: Partial<Record<IdentityVariable, string>> = {};

  switch (recipes.button) {
    case "quiet":
      out["--cc-button-bg"] = "transparent";
      out["--cc-button-edge"] = "transparent";
      break;
    case "outlined":
      break;
    case "solid":
      out["--cc-button-bg"] = "var(--cc-card)";
      out["--cc-button-edge"] = "var(--cc-card)";
      break;
    case "raised": {
      const { shadow, press } = smallShadow(identity, 4);
      out["--cc-button-shadow"] = shadow;
      out["--cc-button-press"] = press;
      break;
    }
    case "beveled":
      out["--cc-button-shadow"] =
        "inset 0 1px 0 color-mix(in oklab, var(--cc-text) 16%, transparent), inset 0 -2px 0 color-mix(in oklab, var(--cc-code) 60%, transparent)";
      out["--cc-button-press"] = "none";
      out["--cc-button-press-shadow"] = "inset 0 2px 0 color-mix(in oklab, var(--cc-code) 60%, transparent)";
      break;
  }

  switch (recipes.card) {
    case "flat":
      out["--cc-card-edge"] = "transparent";
      break;
    case "outlined":
      break;
    case "raised":
      out["--cc-card-shadow"] =
        identity.shadow.style === "soft" ? "0 6px 18px color-mix(in oklab, var(--cc-code) 38%, transparent)" : smallShadow(identity, 8).shadow;
      break;
  }

  switch (recipes.input) {
    case "quiet":
      out["--cc-input-bg"] = "transparent";
      break;
    case "filled":
      out["--cc-input-bg"] = "var(--cc-code)";
      out["--cc-input-edge"] = "transparent";
      break;
    case "outlined":
      break;
    case "underlined":
      out["--cc-input-bg"] = "transparent";
      out["--cc-input-edge"] = "transparent transparent var(--cc-text-muted)";
      out["--cc-input-radius"] = "0";
      break;
  }

  if (recipes.modal === "framed") {
    out["--cc-modal-line"] = heavier;
    out["--cc-modal-edge"] = "var(--cc-text-muted)";
    out["--cc-modal-shadow"] =
      identity.shadow.style === "soft" ? "0 12px 32px color-mix(in oklab, var(--cc-code) 50%, transparent)" : "var(--cc-shadow-modal)";
  }

  if (recipes.badge === "rounded") out["--cc-badge-radius"] = "var(--cc-radius-badge)";
  if (recipes.badge === "square") out["--cc-badge-radius"] = "0";

  if (recipes.composer === "integrated") {
    out["--cc-composer-radius"] = "var(--cc-radius-response)";
    out["--cc-composer-shadow"] = "none";
  }
  if (recipes.composer === "framed") {
    out["--cc-composer-radius"] = "var(--cc-radius-card)";
    out["--cc-composer-line"] = heavier;
    out["--cc-composer-edge"] = "var(--cc-text-muted)";
  }
  return out;
}

/** Every identity variable's value for an identity, from the host's own templates. */
export function identityDeclarations(identity: AppearanceIdentity): IdentityDeclarations {
  const pattern = backdropPattern(identity);
  const declared: Partial<Record<IdentityVariable, string>> = {
    "--cc-font-body": FONT_STACKS[identity.typography.body],
    "--cc-font-display": FONT_STACKS[identity.typography.display],
    "--cc-font-mono": MONO_STACKS[identity.typography.mono],
    "--cc-weight-heading": String(identity.typography.headingWeight),
    "--cc-line": `${px(identity.border.width)} ${identity.border.style}`,
    "--cc-radius-field": identity.fieldRadius,
    "--cc-icon-stroke": String(identity.iconStroke),
    ...shadowDeclarations(identity),
    "--cc-backdrop-alpha": percent(identity.effects.backdrop.intensity * 0.28),
    "--cc-button-bg": "var(--cc-elevated)",
    "--cc-button-edge": "var(--cc-border)",
    "--cc-button-shadow": "none",
    "--cc-button-press": "scale(0.97)",
    "--cc-button-press-shadow": "none",
    "--cc-card-edge": "var(--cc-border)",
    "--cc-card-shadow": "none",
    "--cc-input-bg": "var(--cc-elevated)",
    "--cc-input-edge": "var(--cc-border)",
    "--cc-modal-edge": "var(--cc-border)",
    "--cc-composer-edge": "var(--cc-border)",
    ...surfaceDeclarations(identity),
    ...recipeDeclarations(identity),
  };
  if (pattern.size !== undefined) declared["--cc-backdrop-size"] = pattern.size;
  return Object.fromEntries(IDENTITY_VARIABLES.map((name) => [name, declared[name]])) as Record<IdentityVariable, string | undefined>;
}

/** Clark Default's declarations: the value every identity fallback in the component stylesheet must equal. */
export const CLARK_IDENTITY_DECLARATIONS: IdentityDeclarations = identityDeclarations(CLARK_IDENTITY);

/**
 * The declarations where an identity differs from Clark Default's, in `IDENTITY_VARIABLES` order.
 *
 * Empty for Clark Default and for every theme that says nothing about identity, which is why their token sheets are
 * unchanged.
 */
export function identityOverrides(identity: AppearanceIdentity): [IdentityVariable, string][] {
  const declared = identityDeclarations(identity);
  const overrides: [IdentityVariable, string][] = [];
  for (const name of IDENTITY_VARIABLES) {
    const value = declared[name];
    if (value !== undefined && value !== CLARK_IDENTITY_DECLARATIONS[name]) overrides.push([name, value]);
  }
  return overrides;
}

/** Clark Default's backdrop image, which the component stylesheet draws unless a theme's identity replaces it. */
export const CLARK_BACKDROP_IMAGE = backdropPattern(CLARK_IDENTITY).image;

/**
 * The part of a stylesheet an identity adds: its declarations where they differ from Clark Default's, and its backdrop
 * where that differs. The empty string for Clark Default.
 *
 * The declarations are scoped like the scheme blocks — the root, and any subtree that sets a scheme — so a value that
 * refers to a colour token is resolved again inside a subtree drawn in the other scheme. The backdrop is one host-written
 * rule whose only variable part is a pattern built from this module's templates.
 */
export function identityStylesheet(identity: AppearanceIdentity): string {
  const overrides = identityOverrides(identity);
  const blocks: string[] = [];
  if (overrides.length > 0) {
    blocks.push(`:root,\n[data-cc-theme] {\n${overrides.map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`);
  }
  const { image } = backdropPattern(identity);
  if (image !== CLARK_BACKDROP_IMAGE) blocks.push(`.cc-dot-grid,\n.cc-dot-grid::after {\n  background-image: ${image};\n}`);
  return blocks.join("\n\n");
}

/** A theme's identity with every choice made: what the theme said, and Clark's choice for everything else. */
export function resolveIdentity(theme: ThemeDocument): AppearanceIdentity {
  const base = CLARK_IDENTITY;
  const field = theme.radius?.field;
  const recipes = theme.recipes;
  return {
    typography: {
      body: theme.typography?.body ?? base.typography.body,
      display: theme.typography?.display ?? base.typography.display,
      mono: theme.typography?.mono ?? base.typography.mono,
      headingWeight: theme.typography?.headingWeight ?? base.typography.headingWeight,
    },
    border: { width: theme.border?.width ?? base.border.width, style: theme.border?.style ?? base.border.style },
    shadow: {
      style: theme.shadow?.style ?? base.shadow.style,
      offset: theme.shadow?.offset ?? base.shadow.offset,
      color: theme.shadow?.color ?? base.shadow.color,
    },
    fieldRadius: field === undefined ? base.fieldRadius : `${String(Number(field.toFixed(4)))}rem`,
    iconStroke: theme.icons?.stroke ?? base.iconStroke,
    recipes: {
      button: recipes?.button ?? base.recipes.button,
      card: recipes?.card ?? base.recipes.card,
      input: recipes?.input ?? base.recipes.input,
      modal: recipes?.modal ?? base.recipes.modal,
      badge: recipes?.badge ?? base.recipes.badge,
      composer: recipes?.composer ?? base.recipes.composer,
    },
    effects: {
      backdrop:
        theme.effects?.backdrop === undefined
          ? base.effects.backdrop
          : {
              kind: theme.effects.backdrop.kind,
              intensity: theme.effects.backdrop.intensity ?? base.effects.backdrop.intensity,
              scale: theme.effects.backdrop.scale ?? base.effects.backdrop.scale,
            },
      surface:
        theme.effects?.surface === undefined
          ? base.effects.surface
          : { kind: theme.effects.surface.kind, intensity: theme.effects.surface.intensity ?? base.effects.surface.intensity },
    },
  };
}
