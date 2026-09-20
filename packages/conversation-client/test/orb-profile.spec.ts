import { describe, expect, it } from "vitest";

import {
  ORB_MOTION_BOUNDS,
  ORB_OPTICAL_BOUNDS,
  ORB_PALETTE_CHANNELS,
  ORB_PHYSICS_BOUNDS,
} from "@clarkcant/contracts";

import { orbFallbackBackground, resolveOrbProfile } from "../src/orb-profile.ts";
import { ORB_PALETTE, ORB_SHAPE } from "../src/orb-shader.ts";

/**
 * Orb personalization (V19).
 *
 * Four claims, each of which is a way personalization could go wrong rather than a way it could look
 * wrong:
 *
 *   - the shipped orb is unchanged when nothing is chosen, so this is additive;
 *   - every value is clamped to the declared bounds, so a stored profile cannot ask for a runaway
 *     simulation;
 *   - reduced motion wins over a custom profile, because a preference that outranked the platform
 *     setting would make the accessibility switch a lie;
 *   - the resolved profile has a stable key, which is what keeps the renderer from rebuilding on every
 *     render.
 */

describe("the shipped orb is what an empty preference draws", () => {
  it("resolves to the reference shape and the default physics", () => {
    const profile = resolveOrbProfile({});
    expect(profile.name).toBe("clark");
    expect(profile.optical).toEqual({
      radius: ORB_SHAPE.radius,
      exposure: ORB_SHAPE.exposure,
      chromatic: ORB_SHAPE.chromatic,
      glow: ORB_SHAPE.glow,
      sheen: ORB_SHAPE.sheen,
    });
    expect(profile.physics).toEqual({
      stiffness: ORB_PHYSICS_BOUNDS.stiffness.default,
      damping: ORB_PHYSICS_BOUNDS.damping.default,
      wobbleGain: ORB_PHYSICS_BOUNDS.wobbleGain.default,
      pointerResponse: ORB_PHYSICS_BOUNDS.pointerResponse.default,
    });
    expect(profile.speed).toBe(ORB_MOTION_BOUNDS.speed.default);
    // No palette override, so the stylesheet stays in charge of the default look.
    expect(profile.palette).toEqual({});
    expect(orbFallbackBackground(profile.palette)).toBeUndefined();
  });

  it("falls back to the shipped orb for a profile it cannot parse", () => {
    // A corrupt or older-shaped value must not be why the product's own face fails to draw.
    for (const bad of ["vaporwave", 42, null, { name: "jelly" }, ["jelly"]]) {
      expect(resolveOrbProfile({ profile: bad }).name, JSON.stringify(bad)).toBe("clark");
    }
    expect(resolveOrbProfile({ profile: "jelly", custom: "not an object" }).name).toBe("jelly");
  });
});

describe("every profile is deterministic and distinct", () => {
  it("resolves the same input to the same key and the same values", () => {
    const first = resolveOrbProfile({ profile: "jelly" });
    const second = resolveOrbProfile({ profile: "jelly" });
    expect(first.key).toBe(second.key);
    expect(first).toEqual(second);
  });

  it("gives each preset its own key", () => {
    const keys = ["clark", "calm", "jelly", "glass"].map(
      (name) => resolveOrbProfile({ profile: name }).key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps every preset inside the declared bounds", () => {
    for (const name of ["clark", "calm", "jelly", "glass"] as const) {
      const profile = resolveOrbProfile({ profile: name });
      for (const [key, value] of Object.entries(profile.optical)) {
        const bound = ORB_OPTICAL_BOUNDS[key as keyof typeof ORB_OPTICAL_BOUNDS];
        expect(value, `${name}.${key}`).toBeGreaterThanOrEqual(bound.min);
        expect(value, `${name}.${key}`).toBeLessThanOrEqual(bound.max);
      }
      for (const [key, value] of Object.entries(profile.physics)) {
        const bound = ORB_PHYSICS_BOUNDS[key as keyof typeof ORB_PHYSICS_BOUNDS];
        expect(value, `${name}.${key}`).toBeGreaterThanOrEqual(bound.min);
        expect(value, `${name}.${key}`).toBeLessThanOrEqual(bound.max);
      }
    }
  });

  it("actually differs between the presets, so a name means something", () => {
    const clark = resolveOrbProfile({ profile: "clark" });
    const jelly = resolveOrbProfile({ profile: "jelly" });
    const calm = resolveOrbProfile({ profile: "calm" });
    expect(jelly.physics.stiffness).toBeGreaterThan(clark.physics.stiffness);
    expect(calm.physics.damping).toBeGreaterThan(clark.physics.damping);
    expect(jelly.speed).toBeGreaterThan(calm.speed);
  });
});

describe("a custom patch is clamped, not trusted", () => {
  it("clamps every physics field to the declared range", () => {
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { physics: { stiffness: 4000, damping: -20, wobbleGain: 12, pointerResponse: 99 } },
    });
    expect(profile.physics.stiffness).toBe(ORB_PHYSICS_BOUNDS.stiffness.max);
    expect(profile.physics.damping).toBe(ORB_PHYSICS_BOUNDS.damping.min);
    expect(profile.physics.wobbleGain).toBe(ORB_PHYSICS_BOUNDS.wobbleGain.max);
    expect(profile.physics.pointerResponse).toBe(ORB_PHYSICS_BOUNDS.pointerResponse.max);
  });

  it("clamps optics and the animation rate too", () => {
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { optical: { exposure: 100 }, motion: { speed: 40 } },
    });
    expect(profile.optical.exposure).toBe(ORB_OPTICAL_BOUNDS.exposure.max);
    expect(profile.speed).toBe(ORB_MOTION_BOUNDS.speed.max);
  });

  it("survives a non-finite number rather than passing it to a shader", () => {
    // A `NaN` passes both comparisons in a naive clamp and reaches `uniform1f`, which is how a
    // personalization bug becomes a blank canvas.
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { physics: { stiffness: Number.NaN, damping: Number.POSITIVE_INFINITY } },
    });
    expect(Number.isFinite(profile.physics.stiffness)).toBe(true);
    expect(Number.isFinite(profile.physics.damping)).toBe(true);
    expect(profile.physics.stiffness).toBe(ORB_PHYSICS_BOUNDS.stiffness.min);
    expect(profile.physics.damping).toBe(ORB_PHYSICS_BOUNDS.damping.max);
  });

  it("applies a patch only to the custom profile", () => {
    // Selecting a preset is a decision, and a stale patch must not quietly change what it means.
    const custom = { palette: { colorA: [1, 0, 0] as const } };
    const preset = resolveOrbProfile({ profile: "calm", custom });
    expect(preset.palette).toEqual({});
    expect(resolveOrbProfile({ profile: "custom", custom }).palette.colorA).toEqual([1, 0, 0]);
  });

  it("keeps a custom patch layered over the shipped values, not over another preset", () => {
    const profile = resolveOrbProfile({ profile: "custom", custom: { physics: { damping: 20 } } });
    expect(profile.physics.damping).toBe(20);
    // Untouched fields are the shipped orb's, which is what makes the patch additive.
    expect(profile.physics.stiffness).toBe(ORB_PHYSICS_BOUNDS.stiffness.default);
    expect(profile.speed).toBe(ORB_MOTION_BOUNDS.speed.default);
  });
});

describe("a palette is named channels, never code", () => {
  it("accepts only the channels the shader has", () => {
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { palette: { colorA: [1, 0.5, 0], shellSparkle: [1, 1, 1] } },
    });
    expect(profile.palette.colorA).toEqual([1, 0.5, 0]);
    expect(Object.keys(profile.palette)).toEqual(["colorA"]);
  });

  it("drops a channel whose value is not a colour, and clamps one that is out of range", () => {
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { palette: { colorA: [2, 0, 0], colorB: "red", colorC: [1, 0], colorD: [0.1, 0.2, 0.3] } },
    });
    /*
     * Clamped rather than dropped, which is what every other numeric field does: an out-of-range component
     * still names the colour the user meant, so landing it on the bound keeps the personalization instead of
     * silently discarding it. What matters either way is that the shader is never handed a value outside the
     * range it assumes.
     */
    expect(profile.palette.colorA).toEqual([1, 0, 0]);
    // A value that is not a triple at all cannot be read as a colour, so the channel is left to the preset.
    expect(profile.palette.colorB).toBeUndefined();
    expect(profile.palette.colorC).toBeUndefined();
    expect(profile.palette.colorD).toEqual([0.1, 0.2, 0.3]);
  });

  it("cannot be used to smuggle shader source", () => {
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { palette: { fragmentShader: "void main() {}", colorA: [1, 1, 1] } },
    });
    expect(Object.keys(profile.palette)).toEqual(["colorA"]);
    expect(JSON.stringify(profile)).not.toContain("void main");
  });

  it("carries the chosen colours into the no-WebGL fallback", () => {
    // The fallback is the element's own background, so an orb that reverted to the shipped gradient on a
    // machine without WebGL would be a preference that silently did nothing there.
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: { palette: { shellMid: [0, 1, 0] } },
    });
    const background = orbFallbackBackground(profile.palette);
    expect(background).toContain("radial-gradient");
    expect(background).toContain("rgb(0 255 0)");
    // The channels that were not chosen keep the shipped colours rather than going transparent.
    expect(background).toContain("rgb(255 255 255)");
  });
});

describe("reduced motion wins over a custom profile", () => {
  it("stops the animation and the ring, and keeps the colours", () => {
    const profile = resolveOrbProfile({
      profile: "custom",
      custom: {
        motion: { speed: 3 },
        physics: { wobbleGain: 1, pointerResponse: 1.5 },
        palette: { colorA: [1, 0, 0] },
      },
      reducedMotion: true,
    });
    expect(profile.speed).toBe(0);
    expect(profile.physics.wobbleGain).toBe(0);
    expect(profile.physics.pointerResponse).toBe(0);
    expect(profile.reducedMotion).toBe(true);
    // Colour is not motion, so a personalized orb keeps its palette.
    expect(profile.palette.colorA).toEqual([1, 0, 0]);
  });

  it("cannot be undone by a profile asking for motion", () => {
    for (const name of ["clark", "calm", "jelly", "glass", "custom"] as const) {
      const profile = resolveOrbProfile({ profile: name, reducedMotion: true });
      expect(profile.speed, name).toBe(0);
      expect(profile.physics.wobbleGain, name).toBe(0);
      expect(profile.physics.pointerResponse, name).toBe(0);
    }
  });

  it("reports whether it suppressed motion, so a caller never has to re-derive it", () => {
    expect(resolveOrbProfile({ reducedMotion: false }).reducedMotion).toBe(false);
    expect(resolveOrbProfile({}).reducedMotion).toBe(false);
  });
});

describe("the profile key is stable, so the renderer rebuilds once per change", () => {
  it("does not change when an equal patch is re-supplied", () => {
    // The renderer's dependency is this value. If it changed per render, the GPU program would be
    // rebuilt on every keystroke in the composer.
    const a = resolveOrbProfile({ profile: "custom", custom: { physics: { stiffness: 120 } } });
    const b = resolveOrbProfile({ profile: "custom", custom: { physics: { stiffness: 120 } } });
    expect(a.key).toBe(b.key);
  });

  it("changes when a resolved value changes", () => {
    const before = resolveOrbProfile({ profile: "custom", custom: { physics: { stiffness: 120 } } });
    const after = resolveOrbProfile({ profile: "custom", custom: { physics: { stiffness: 121 } } });
    expect(after.key).not.toBe(before.key);
  });

  it("changes when reduced motion is switched on", () => {
    const moving = resolveOrbProfile({ profile: "jelly" });
    const still = resolveOrbProfile({ profile: "jelly", reducedMotion: true });
    expect(still.key).not.toBe(moving.key);
  });

  it("treats a colour difference below what a display can show as the same profile", () => {
    // Rebuilding a WebGL program for a difference nobody can see is work for nothing.
    const a = resolveOrbProfile({ profile: "custom", custom: { palette: { colorA: [1, 0.5, 0] } } });
    const b = resolveOrbProfile({ profile: "custom", custom: { palette: { colorA: [1, 0.5, 0.0000001] } } });
    expect(a.key).toBe(b.key);
  });
});

describe("the channels the registry names are the channels the shader has", () => {
  it("agrees with the renderer's own palette", () => {
    // The contract declares the channel names a stored preference may use. If the two ever disagree, a
    // user's chosen colour would be silently dropped by a renderer that never reads that uniform.
    expect([...ORB_PALETTE_CHANNELS].sort()).toEqual(Object.keys(ORB_PALETTE).sort());
  });
});
