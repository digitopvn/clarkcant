/**
 * The Orb's colour channels, shared by the Orb preference and a theme's Orb suggestion.
 *
 * A module of its own because both `preferences.ts` and `themes.ts` need it, and `preferences.ts` already imports from
 * `themes.ts`: declaring it in either would make the other import a value across a cycle, which is evaluated before it
 * exists. `preferences.ts` re-exports everything here, so its public names are unchanged.
 */

import { z } from "zod";

/**
 * The named colour channels the shader has.
 *
 * Names rather than shader source: a stored preference selects a channel and cannot introduce
 * code. The list is asserted against the renderer's own palette in the orb tests, so it cannot
 * drift into names the shader never reads.
 */
export const ORB_PALETTE_CHANNELS = [
  "canvas",
  "glowColor",
  "highlight",
  "shellInner",
  "shellMid",
  "shellEdge",
  "sheenColor",
  "colorA",
  "colorB",
  "colorC",
  "colorD",
] as const;
export type OrbPaletteChannel = (typeof ORB_PALETTE_CHANNELS)[number];

/** Linear RGB in the shader's own space, so no conversion happens at the boundary. */
export const orbColorSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

const paletteShape = Object.fromEntries(
  ORB_PALETTE_CHANNELS.map((channel) => [channel, orbColorSchema.optional()]),
) as Record<OrbPaletteChannel, z.ZodOptional<typeof orbColorSchema>>;

export const orbPalettePreferenceSchema = z.strictObject(paletteShape);
export type OrbPalettePreference = z.infer<typeof orbPalettePreferenceSchema>;
