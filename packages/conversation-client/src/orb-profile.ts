/**
 * The orb's named profiles, and the bounded patch a user may apply to one.
 *
 * The orb is the product's signature, so personalization is a closed set of named channels with
 * declared ranges: a profile chooses colour, optics, animation rate and the shell's physics, and it
 * can never introduce code. Everything a profile can express is clamped against the bounds the
 * contracts package declares — the same numbers the settings surface offers — so the slider cannot
 * express a value this renderer would ignore, and a value written by an older build keeps rendering
 * instead of snapping or failing.
 *
 * Three properties the callers rely on:
 *
 *   - **Reduced motion wins.** It is applied last, to the resolved values rather than to the patch, so
 *     no profile and no stored patch can ask for motion a person has switched off. Colour is not
 *     motion and survives.
 *   - **The result is immutable and deterministic.** The same input always produces the same `key`,
 *     which is what lets the renderer treat a profile change as one rebuild rather than a rebuild per
 *     render.
 *   - **Parsing happens here.** The stored values arrive from a preference API as unvalidated data;
 *     this is the boundary where they become numbers, and anything that does not parse falls back to
 *     the shipped orb rather than reaching a shader.
 */

import {
  ORB_MOTION_BOUNDS,
  ORB_OPTICAL_BOUNDS,
  ORB_PHYSICS_BOUNDS,
  ORB_PALETTE_CHANNELS,
  orbProfileSchema,
  type OrbPaletteChannel,
  type OrbProfileName,
} from "@clarkcant/contracts";

import { ORB_PALETTE, ORB_SHAPE, type OrbStyle } from "./orb-shader.ts";

export interface OrbPhysics {
  stiffness: number;
  damping: number;
  wobbleGain: number;
  pointerResponse: number;
}

export interface OrbOptical {
  radius: number;
  exposure: number;
  chromatic: number;
  glow: number;
  sheen: number;
}

/** Colour overrides, by the shader's own channel names. Absent channels keep the shipped palette. */
export type OrbPaletteOverride = Partial<Record<OrbPaletteChannel, readonly number[]>>;

export interface ResolvedOrbProfile {
  /** The profile that was asked for. `custom` means the patch below was applied. */
  name: OrbProfileName;
  /**
   * Stable identity of the resolved values.
   *
   * Handed to the renderer's dependency list. Two renders that resolve to the same values share a key
   * and rebuild nothing; a key that changed is the only reason to rebuild the GPU program.
   */
  key: string;
  optical: OrbOptical;
  physics: OrbPhysics;
  /** Animation rate. Zero under reduced motion, whatever the profile or the patch asked for. */
  speed: number;
  palette: OrbPaletteOverride;
  /** What is drawn inside the glass. `band` is the signature orb. */
  style: OrbStyle;
  /** True when the resolve suppressed motion, so a caller never has to re-derive it and disagree. */
  reducedMotion: boolean;
}

interface Preset {
  optical: Partial<OrbOptical>;
  speed: number;
  physics: Partial<OrbPhysics>;
  /** Colour channels the preset replaces. Every value is a 0..1 triple, like a stored patch. */
  palette: OrbPaletteOverride;
  style: OrbStyle;
}

/**
 * The six shipped profiles.
 *
 * Each is a name for a mood rather than a theme: `clark` is the orb exactly as it shipped; `calm`
 * is cooler, settles sooner and answers the pointer gently; `jelly` is warm and rings for longer;
 * `glass` is icy, crisp and stiff; `pearl` draws mother-of-pearl contours in soft pastels; and
 * `plasma` draws filaments reaching from a lit core. They differ in values and in which interior the
 * shader draws, never in which channels exist, and none of them can change the orb's shape: the same
 * glass shell, rim and silhouette are what make every one of them recognisably Clark.
 *
 * Palettes leave `canvas` alone on purpose. That channel is the surface the orb sits on, which is the
 * theme's to decide, not the profile's.
 */
const PRESETS: Record<Exclude<OrbProfileName, "custom">, Preset> = {
  clark: { optical: {}, speed: ORB_MOTION_BOUNDS.speed.default, physics: {}, palette: {}, style: "band" },
  calm: {
    optical: { glow: 0.22, chromatic: 0.3, sheen: 0.22 },
    speed: 0.8,
    physics: { stiffness: 70, damping: 14, wobbleGain: 0.45, pointerResponse: 0.6 },
    palette: {
      glowColor: [0.36, 0.62, 0.86],
      shellMid: [0.55, 0.85, 0.9],
      shellEdge: [0.5, 0.64, 0.9],
      colorA: [0.62, 0.9, 0.86],
      colorB: [0.45, 0.78, 0.95],
      colorC: [0.6, 0.66, 0.98],
      colorD: [0.42, 0.55, 0.9],
    },
    style: "band",
  },
  jelly: {
    optical: { glow: 0.36, chromatic: 0.5 },
    speed: 1.4,
    physics: { stiffness: 135, damping: 5.5, wobbleGain: 1, pointerResponse: 1.35 },
    palette: {
      glowColor: [1, 0.45, 0.66],
      shellMid: [1, 0.72, 0.82],
      shellEdge: [1, 0.55, 0.75],
      colorA: [1, 0.78, 0.45],
      colorB: [1, 0.55, 0.62],
      colorC: [0.98, 0.45, 0.85],
      colorD: [0.78, 0.5, 1],
    },
    style: "band",
  },
  glass: {
    optical: { exposure: 2.8, chromatic: 0.6, sheen: 0.5, glow: 0.2 },
    speed: 1,
    physics: { stiffness: 150, damping: 9, wobbleGain: 0.3, pointerResponse: 0.85 },
    palette: {
      glowColor: [0.7, 0.85, 1],
      shellMid: [0.85, 0.95, 1],
      shellEdge: [0.75, 0.85, 1],
      colorA: [0.95, 0.98, 1],
      colorB: [0.72, 0.9, 1],
      colorC: [0.82, 0.8, 1],
      colorD: [0.62, 0.72, 1],
    },
    style: "band",
  },
  pearl: {
    optical: { exposure: 1.6, chromatic: 0.9, sheen: 0.6, glow: 0.24 },
    speed: 0.7,
    physics: { stiffness: 80, damping: 11, wobbleGain: 0.6, pointerResponse: 0.8 },
    palette: {
      glowColor: [0.95, 0.78, 0.9],
      shellMid: [0.9, 0.97, 0.95],
      shellEdge: [0.88, 0.8, 1],
      colorA: [1, 0.82, 0.86],
      colorB: [0.78, 0.96, 0.88],
      colorC: [0.84, 0.8, 1],
      colorD: [1, 0.95, 0.8],
    },
    style: "pearl",
  },
  plasma: {
    optical: { exposure: 2.4, chromatic: 0.5, glow: 0.5, sheen: 0.2 },
    speed: 1.6,
    physics: { stiffness: 110, damping: 8, wobbleGain: 0.8, pointerResponse: 1.2 },
    palette: {
      glowColor: [0.65, 0.35, 1],
      shellMid: [0.55, 0.7, 1],
      shellEdge: [0.7, 0.45, 1],
      colorA: [1, 0.35, 0.85],
      colorB: [0.35, 0.55, 1],
      colorC: [0.7, 0.4, 1],
      colorD: [0.35, 0.95, 1],
    },
    style: "plasma",
  },
};

/** The shipped orb, for a caller that has no profile: one value, so nothing has to guess. */
export const DEFAULT_ORB_PROFILE: ResolvedOrbProfile = resolveOrbProfile({});

function clamp(value: number, bound: { min: number; max: number }): number {
  /*
   * `NaN` first, because it has no direction to saturate towards and passes both comparisons below — one
   * reaching `uniform1f` is how a personalization bug becomes a blank canvas. An infinity is different: it
   * does have a direction, and the comparisons below saturate it to the bound it was heading for rather than
   * silently landing it on the opposite one.
   */
  if (Number.isNaN(value)) return bound.min;
  return Math.min(Math.max(value, bound.min), bound.max);
}

function resolveOptical(preset: Partial<OrbOptical>, patch: Partial<OrbOptical>): OrbOptical {
  const pick = (key: keyof OrbOptical): number => {
    const raw = patch[key] ?? preset[key] ?? ORB_SHAPE[key];
    return clamp(raw, ORB_OPTICAL_BOUNDS[key]);
  };
  return {
    radius: pick("radius"),
    exposure: pick("exposure"),
    chromatic: pick("chromatic"),
    glow: pick("glow"),
    sheen: pick("sheen"),
  };
}

function resolvePhysics(preset: Partial<OrbPhysics>, patch: Partial<OrbPhysics>): OrbPhysics {
  const pick = (key: keyof OrbPhysics): number => {
    const raw = patch[key] ?? preset[key] ?? ORB_PHYSICS_BOUNDS[key].default;
    return clamp(raw, ORB_PHYSICS_BOUNDS[key]);
  };
  return {
    stiffness: pick("stiffness"),
    damping: pick("damping"),
    wobbleGain: pick("wobbleGain"),
    pointerResponse: pick("pointerResponse"),
  };
}

/**
 * The numbers a stored patch actually holds, before any range is applied.
 *
 * Deliberately not the registry's own schema. That schema is the gate on a *write*, and it refuses an
 * out-of-range value so nothing invalid is ever stored. This is the other end of the same data: a value
 * that is already in the store, possibly written by an older build, possibly edited by hand. Parsing it
 * with the write-time schema would discard the whole patch over one bad field — the rest of a user's
 * personalization silently reverting — where clamping keeps everything that can be honoured.
 *
 * Only finite numbers are read. A `NaN` passes both comparisons in a naive clamp, and one reaching
 * `uniform1f` is how a personalization bug becomes a blank canvas.
 */
function readNumbers(value: unknown, keys: readonly string[]): Record<string, number> {
  const numbers: Record<string, number> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return numbers;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    // A non-finite number is kept here and clamped below, so it lands on a bound rather than being
    // treated as "absent" and silently inheriting the preset's value.
    if (typeof raw === "number") numbers[key] = raw;
  }
  return numbers;
}

const OPTICAL_KEYS = ["radius", "exposure", "chromatic", "glow", "sheen"] as const;
const PHYSICS_KEYS = ["stiffness", "damping", "wobbleGain", "pointerResponse"] as const;

/** Only the channels the shader has, only as 0..1 triples. Anything else is dropped, not coerced. */
function resolvePalette(patch: unknown): OrbPaletteOverride {
  const palette: OrbPaletteOverride = {};
  if (typeof patch !== "object" || patch === null) return palette;
  for (const channel of ORB_PALETTE_CHANNELS) {
    const value = (patch as Record<string, unknown>)[channel];
    if (!Array.isArray(value) || value.length !== 3) continue;
    if (!value.every((part) => typeof part === "number" && Number.isFinite(part))) continue;
    palette[channel] = [
      Math.min(Math.max(value[0] as number, 0), 1),
      Math.min(Math.max(value[1] as number, 0), 1),
      Math.min(Math.max(value[2] as number, 0), 1),
    ];
  }
  return palette;
}

/**
 * Resolve a stored preference pair into the values the renderer uses.
 *
 * Anything that does not parse resolves to the shipped orb. That is deliberate for a preference: a
 * corrupt or older-shaped value must not be the reason the product's own face fails to draw, and a
 * silently different orb is worse than the profile the user actually chose.
 */
export function resolveOrbProfile(input: {
  /** Stored `orb.profile`. Unvalidated on purpose: this is the boundary that validates it. */
  profile?: unknown;
  /** Stored `orb.custom`. */
  custom?: unknown;
  /** The platform's own answer, not a preference: this one cannot be switched off from settings. */
  reducedMotion?: boolean;
}): ResolvedOrbProfile {
  const parsedProfile = orbProfileSchema.safeParse(input.profile);
  const name: OrbProfileName = parsedProfile.success ? parsedProfile.data : "clark";

  // A patch belongs to the custom profile. Selecting a preset is a decision, and a stale patch must not
  // quietly change what the preset means.
  const applies = name === "custom";
  const preset: Preset = applies ? PRESETS.clark : PRESETS[name];

  const stored = typeof input.custom === "object" && input.custom !== null ? (input.custom as Record<string, unknown>) : {};
  const patchOptical = applies ? readNumbers(stored.optical, OPTICAL_KEYS) : {};
  const patchPhysics = applies ? readNumbers(stored.physics, PHYSICS_KEYS) : {};
  const patchMotion = applies ? readNumbers(stored.motion, ["speed"]) : {};

  const optical = resolveOptical(preset.optical, patchOptical);
  const fromPatch = resolvePhysics(preset.physics, patchPhysics);
  const requestedSpeed = clamp(patchMotion.speed ?? preset.speed, ORB_MOTION_BOUNDS.speed);
  // A preset's own palette passes through the same clamp as a stored patch, so the bound holds for
  // shipped values too rather than only for what a person typed.
  const palette = resolvePalette(applies ? stored.palette : preset.palette);
  const style = preset.style;

  /*
   * Reduced motion is applied to the resolved values rather than to the patch. A preference that could
   * outrank the platform setting would be a setting that makes the accessibility switch a lie.
   */
  const reducedMotion = input.reducedMotion === true;
  const physics: OrbPhysics = reducedMotion
    ? { ...fromPatch, wobbleGain: 0, pointerResponse: 0 }
    : fromPatch;
  const speed = reducedMotion ? 0 : requestedSpeed;

  return {
    name,
    key: profileKey({ name, optical, physics, speed, palette, style, reducedMotion }),
    optical,
    physics,
    speed,
    palette,
    style,
    reducedMotion,
  };
}

function profileKey(input: Omit<ResolvedOrbProfile, "key">): string {
  const channels = ORB_PALETTE_CHANNELS.map((channel) => {
    const value = input.palette[channel];
    // Quantised to a byte: two colours that differ below what a display can show are the same profile,
    // and rebuilding a WebGL program for them would be work nobody can see.
    return value === undefined ? "-" : value.map((part) => Math.round(part * 255)).join(".");
  }).join(",");
  return [
    input.name,
    input.style,
    input.reducedMotion ? "reduced" : "motion",
    input.speed.toFixed(3),
    Object.values(input.optical).map((value) => value.toFixed(3)).join("/"),
    Object.values(input.physics).map((value) => value.toFixed(3)).join("/"),
    channels,
  ].join("|");
}

/**
 * A background for the element the orb falls back to when WebGL is unavailable.
 *
 * The fallback is the canvas' own CSS background, and it exists so a machine without WebGL still shows
 * the product's face rather than an empty box. Returning nothing when no palette was chosen keeps the
 * shipped stylesheet in charge of the default look; a personalised orb keeps its colours either way,
 * which is the part a user would notice going missing.
 */
export function orbFallbackBackground(palette: OrbPaletteOverride): string | undefined {
  if (Object.keys(palette).length === 0) return undefined;
  return orbPaletteGradient(palette);
}

/**
 * A static picture of a palette: the orb's shell as a radial gradient, with the shipped colours for
 * any channel the palette leaves alone.
 *
 * Used where a still image of a profile is what is wanted, which is the fallback above and the swatch
 * on each preset in Settings. It is always the profile's own colours, so a swatch cannot promise an orb
 * the renderer would not draw.
 *
 * The last colour runs to the element's edge rather than fading out inside it. Every place this is used
 * clips the element to a circle, and a gradient centred off-axis that ended inside that circle left a
 * crescent of whatever was behind it showing at the lower right.
 */
export function orbPaletteGradient(palette: OrbPaletteOverride): string {
  const css = (channel: OrbPaletteChannel, fallback: readonly number[]): string => {
    const value = palette[channel] ?? fallback;
    return `rgb(${value.map((part) => Math.round(part * 255)).join(" ")})`;
  };

  const inner = css("highlight", ORB_PALETTE.highlight);
  const mid = css("shellMid", ORB_PALETTE.shellMid);
  const edge = css("shellEdge", ORB_PALETTE.shellEdge);
  return `radial-gradient(circle farthest-corner at 34% 30%, ${inner} 0%, ${mid} 38%, ${edge} 78%)`;
}
