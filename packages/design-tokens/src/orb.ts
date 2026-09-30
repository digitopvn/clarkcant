import type { OrbPaletteChannel, ThemeOrb, ThemeOrbProfileName } from "@clarkcant/contracts";

/**
 * The Orb's colours as data: the shipped palette, each preset's own, and how much light a palette adds to the page.
 *
 * The shader and the presets live in the conversation client, and the protected audit lives here; both read these
 * values from this one place, so the colours the audit measures are the colours the Orb is drawn with.
 */

/** One Orb colour: a 0–1 value per channel, sent to the shader as it is. */
export type OrbColor = readonly [number, number, number];

/** The palette the Orb shipped with, which every preset and every theme palette is laid over. */
export const ORB_BASE_PALETTE = {
  canvas: [0.012, 0.016, 0.035],
  glowColor: [0.584, 0.424, 1.0],
  highlight: [1.0, 1.0, 1.0],
  shellInner: [1.0, 1.0, 1.0],
  shellMid: [0.608, 0.957, 1.0],
  shellEdge: [0.773, 0.663, 1.0],
  sheenColor: [0.918, 0.957, 1.0],
  colorA: [1.0, 0.847, 0.42],
  colorB: [0.51, 0.957, 1.0],
  colorC: [1.0, 0.482, 1.0],
  colorD: [0.557, 0.424, 1.0],
} as const satisfies Readonly<Record<OrbPaletteChannel, OrbColor>>;

/**
 * The channels each shipped preset replaces.
 *
 * None of them sets `canvas`: that channel is the surface the Orb sits on, which the page supplies.
 */
export const ORB_PRESET_PALETTES: Readonly<Record<ThemeOrbProfileName, Readonly<Partial<Record<OrbPaletteChannel, OrbColor>>>>> = {
  clark: {},
  calm: {
    glowColor: [0.36, 0.62, 0.86],
    shellMid: [0.55, 0.85, 0.9],
    shellEdge: [0.5, 0.64, 0.9],
    colorA: [0.62, 0.9, 0.86],
    colorB: [0.45, 0.78, 0.95],
    colorC: [0.6, 0.66, 0.98],
    colorD: [0.42, 0.55, 0.9],
  },
  jelly: {
    glowColor: [1, 0.45, 0.66],
    shellMid: [1, 0.72, 0.82],
    shellEdge: [1, 0.55, 0.75],
    colorA: [1, 0.78, 0.45],
    colorB: [1, 0.55, 0.62],
    colorC: [0.98, 0.45, 0.85],
    colorD: [0.78, 0.5, 1],
  },
  glass: {
    glowColor: [0.7, 0.85, 1],
    shellMid: [0.85, 0.95, 1],
    shellEdge: [0.75, 0.85, 1],
    colorA: [0.95, 0.98, 1],
    colorB: [0.72, 0.9, 1],
    colorC: [0.82, 0.8, 1],
    colorD: [0.62, 0.72, 1],
  },
  pearl: {
    glowColor: [0.95, 0.78, 0.9],
    shellMid: [0.9, 0.97, 0.95],
    shellEdge: [0.88, 0.8, 1],
    colorA: [1, 0.82, 0.86],
    colorB: [0.78, 0.96, 0.88],
    colorC: [0.84, 0.8, 1],
    colorD: [1, 0.95, 0.8],
  },
  plasma: {
    glowColor: [0.65, 0.35, 1],
    shellMid: [0.55, 0.7, 1],
    shellEdge: [0.7, 0.45, 1],
    colorA: [1, 0.35, 0.85],
    colorB: [0.35, 0.55, 1],
    colorC: [0.7, 0.4, 1],
    colorD: [0.35, 0.95, 1],
  },
};

/** The channels whose light is the Orb itself: its glow, its shell, and the colours drawn inside it. */
export const ORB_LIGHT_CHANNELS = ["glowColor", "shellEdge", "colorA", "colorB", "colorC", "colorD"] as const satisfies readonly OrbPaletteChannel[];

/**
 * The palette a theme's Orb default is drawn with: the shipped palette, the preset's channels over it, and the theme's
 * own colours over those. Clark's own Orb when the theme names none.
 *
 * `canvas` is never taken from a theme: the page supplies it, so a theme cannot paint the Orb in the page's colour.
 */
export function themeOrbPalette(orb: ThemeOrb | undefined): Readonly<Record<OrbPaletteChannel, OrbColor>> {
  const preset = orb === undefined ? {} : ORB_PRESET_PALETTES[orb.profile];
  const theme: Partial<Record<OrbPaletteChannel, OrbColor>> = {};
  for (const [channel, color] of Object.entries(orb?.palette ?? {}) as [OrbPaletteChannel, OrbColor | undefined][]) {
    if (color !== undefined) theme[channel] = color;
  }
  return { ...ORB_BASE_PALETTE, ...preset, ...theme, canvas: ORB_BASE_PALETTE.canvas };
}

/**
 * The deep glass the shader draws the Orb's body with on a light page, and the page luminance where it takes over.
 *
 * Mirrors the shader's composition (`orb-shader.ts`): on a dark page the body is the page plus the Orb's light, and on a
 * light page it is this dark glass plus the Orb's light. The page's colour reaches the shader as its hex value / 255 and
 * the result is written without conversion, so a channel's value × 255 is the pixel it adds.
 */
const DEEP_GLASS: OrbColor = [0.018, 0.02, 0.045];
const SURFACE_LIGHT_EDGES = { from: 0.35, to: 0.75 } as const;

/**
 * How much of a channel's colour the audit counts as light on the Orb's body. Lower than the shader's own gain at the
 * brightest point of the interior, so the measurement is of light the Orb certainly adds rather than of its peak.
 */
export const ORB_LIGHT_GAIN = 0.35;

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(Math.max((value - from) / (to - from), 0), 1);
  return t * t * (3 - 2 * t);
}

function toHex(color: readonly number[]): string {
  return `#${color.map((part) => Math.round(Math.min(Math.max(part, 0), 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(hex: string): OrbColor {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`${hex} is not a six-digit hex colour`);
  return [Number.parseInt(match[1] ?? "0", 16) / 255, Number.parseInt(match[2] ?? "0", 16) / 255, Number.parseInt(match[3] ?? "0", 16) / 255];
}

/**
 * The colours the Orb draws on a page, one per light channel: its body lit by that channel, as the shader composes it.
 *
 * A channel of pure black adds nothing, so on a dark page it draws exactly the page — which is how a palette of black
 * makes the Orb vanish while every value in it is in bounds.
 */
export function orbLitColors(canvasHex: string, palette: Readonly<Record<OrbPaletteChannel, OrbColor>>): string[] {
  const canvas = fromHex(canvasHex);
  const surfaceLight = smoothstep(SURFACE_LIGHT_EDGES.from, SURFACE_LIGHT_EDGES.to, 0.2126 * canvas[0] + 0.7152 * canvas[1] + 0.0722 * canvas[2]);
  const body = canvas.map((part, index) => part + ((DEEP_GLASS[index] ?? 0) - part) * surfaceLight);
  return ORB_LIGHT_CHANNELS.map((channel) => {
    const light = palette[channel];
    return toHex(body.map((part, index) => part + (light[index] ?? 0) * ORB_LIGHT_GAIN));
  });
}
