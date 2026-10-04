import { createOrbRenderer, type OrbOptions } from "./orb.ts";
import type { ResolvedOrbProfile } from "./orb-profile.ts";

/**
 * The profile's values as renderer options.
 *
 * Shared by the live orb and its still picture, so the avatar beside a reply is drawn from exactly the options the
 * header's orb is: a snapshot that read the profile its own way would be a second orb that only looks like the first.
 */
export function orbOptionsFromProfile(profile: ResolvedOrbProfile | undefined): OrbOptions {
  if (profile === undefined) return {};
  return {
    radius: profile.optical.radius,
    exposure: profile.optical.exposure,
    chromatic: profile.optical.chromatic,
    glow: profile.optical.glow,
    sheen: profile.optical.sheen,
    speed: profile.speed,
    physics: profile.physics,
    style: profile.style,
    ...(Object.keys(profile.palette).length === 0 ? {} : { palette: profile.palette }),
  };
}

/** Pictures already taken, by profile, page colour and size; a handful covers every switch a session makes. */
const snapshots = new Map<string, string | null>();
const SNAPSHOT_LIMIT = 8;
/** One canvas for every picture: a canvas holds its WebGL context, and a context per snapshot would run them out. */
let canvas: HTMLCanvasElement | undefined;

/**
 * One frame of the orb, at rest, as a PNG data URL — or `undefined` where WebGL cannot draw it.
 *
 * Drawn into a square buffer of exactly `pixels` and read back in the same task, before the browser composites, so the
 * buffer still holds the frame without asking the context to preserve it. The renderer is disposed at once; only the
 * picture stays. A failure is remembered as one, so a machine without WebGL does not retry on every render.
 */
export function orbSnapshot(options: OrbOptions, key: string, pixels: number): string | undefined {
  const cacheKey = `${key}|${String(pixels)}`;
  const cached = snapshots.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;

  let picture: string | null = null;
  try {
    if (typeof document !== "undefined") {
      canvas ??= document.createElement("canvas");
      canvas.width = pixels;
      canvas.height = pixels;
      const created = createOrbRenderer(canvas, options);
      if (created.ok) {
        created.renderer.frame(0);
        picture = canvas.toDataURL("image/png");
        created.renderer.dispose();
      }
    }
  } catch {
    picture = null;
  }

  if (snapshots.size >= SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  snapshots.set(cacheKey, picture);
  return picture ?? undefined;
}
