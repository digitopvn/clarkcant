import { describe, expect, it } from "vitest";

import { ORB_BASE_PALETTE, ORB_LIGHT_CHANNELS, themeOrbPalette } from "@clarkcant/design-tokens";

import { orbProfileName, resolveOrbProfile } from "../src/orb-profile.ts";
import { markReducedMotion } from "../src/use-orb-profile.ts";

/**
 * A theme's Orb suggestion, and the order it loses in.
 *
 * The person's own choice beats the theme; the theme beats Clark's own Orb; reduced motion beats all three. A theme can
 * only name one of the shipped presets and lay colours over it in the Orb's own closed channels - it never reaches the
 * person's custom tuning.
 */

const PLASMA_SUGGESTION = { profile: "plasma", palette: { glowColor: [1, 0.2, 0.2] } };

describe("the theme's Orb default", () => {
  it("applies while the person has not chosen an Orb, with its colours over the preset's", () => {
    const drawn = resolveOrbProfile({ profile: undefined, theme: PLASMA_SUGGESTION });
    const plasma = resolveOrbProfile({ profile: "plasma" });
    expect(drawn.name).toBe("plasma");
    expect(drawn.style).toBe(plasma.style);
    expect(drawn.speed).toBe(plasma.speed);
    expect(drawn.palette.glowColor).toEqual([1, 0.2, 0.2]);
    // Channels the theme left alone keep the preset's colour.
    expect(drawn.palette.colorA).toEqual(plasma.palette.colorA);
    expect(drawn.key).not.toBe(plasma.key);
  });

  it("loses to the person's own choice, colours and all", () => {
    for (const chosen of ["clark", "calm", "pearl"] as const) {
      const drawn = resolveOrbProfile({ profile: chosen, theme: PLASMA_SUGGESTION });
      expect(drawn).toEqual(resolveOrbProfile({ profile: chosen }));
    }
    // The person's custom tuning is theirs; a theme's palette does not ride on it.
    const custom = { palette: { glowColor: [0, 1, 0] }, motion: { speed: 0.5 } };
    const tuned = resolveOrbProfile({ profile: "custom", custom, theme: PLASMA_SUGGESTION });
    expect(tuned.name).toBe("custom");
    expect(tuned.palette.glowColor).toEqual([0, 1, 0]);
    expect(tuned.speed).toBe(0.5);
  });

  it("treats a stored choice that does not parse as a choice of Clark's Orb, not as leave to the theme", () => {
    expect(orbProfileName("not-a-profile", "plasma")).toBe("clark");
    expect(resolveOrbProfile({ profile: 42, theme: PLASMA_SUGGESTION }).name).toBe("clark");
  });

  it("ignores a suggestion that is not one of the shipped presets", () => {
    for (const theme of [{ profile: "custom" }, { profile: "neon" }, { profile: 1 }, "plasma", null, []]) {
      const drawn = resolveOrbProfile({ profile: undefined, theme });
      expect(drawn, JSON.stringify(theme)).toEqual(resolveOrbProfile({}));
    }
    expect(orbProfileName(undefined, "custom")).toBe("clark");
    expect(orbProfileName(undefined, undefined)).toBe("clark");
  });

  it("keeps a theme's colours inside the Orb's closed channels and bounds", () => {
    const drawn = resolveOrbProfile({
      theme: { profile: "calm", palette: { glowColor: [2, -1, 0.5], shader: [1, 1, 1], colorA: [1, 1], colorB: ["1", 0, 0] } },
    });
    expect(drawn.palette.glowColor).toEqual([1, 0, 0.5]);
    expect("shader" in drawn.palette).toBe(false);
    // A malformed channel keeps the preset's value rather than breaking the palette.
    expect(drawn.palette.colorA).toEqual(resolveOrbProfile({ profile: "calm" }).palette.colorA);
    expect(drawn.palette.colorB).toEqual(resolveOrbProfile({ profile: "calm" }).palette.colorB);
  });

  it("never takes the page colour from a theme, so a theme cannot paint the Orb in the page's own colour", () => {
    const drawn = resolveOrbProfile({ theme: { profile: "clark", palette: { canvas: [1, 1, 1], glowColor: [0, 0.5, 1] } } });
    expect(drawn.palette.canvas).toEqual(resolveOrbProfile({}).palette.canvas);
    expect(drawn.palette.glowColor).toEqual([0, 0.5, 1]);
  });

  it("draws each preset with the colours the protected audit measures", () => {
    for (const profile of ["clark", "calm", "jelly", "glass", "pearl", "plasma"] as const) {
      const drawn = resolveOrbProfile({ profile });
      const measured = themeOrbPalette({ profile });
      // A resolved palette names only the channels it changes; the rest are the shipped palette's.
      for (const channel of ORB_LIGHT_CHANNELS) {
        expect(drawn.palette[channel] ?? ORB_BASE_PALETTE[channel], `${profile} ${channel}`).toEqual(measured[channel]);
      }
    }
  });
});

describe("reduced motion", () => {
  it("wins over the theme's Orb and over the person's own, keeping the colours", () => {
    for (const input of [
      { theme: PLASMA_SUGGESTION },
      { profile: "jelly" },
      { profile: "custom", custom: { motion: { speed: 2 }, physics: { wobbleGain: 1 } } },
    ]) {
      const drawn = resolveOrbProfile({ ...input, reducedMotion: true });
      expect(drawn.reducedMotion, JSON.stringify(input)).toBe(true);
      expect(drawn.speed).toBe(0);
      expect(drawn.physics.wobbleGain).toBe(0);
      expect(drawn.physics.pointerResponse).toBe(0);
      expect(drawn.palette).toEqual(resolveOrbProfile(input).palette);
    }
  });

  it("marks the page when the person chose Reduced, and clears the mark when they did not", () => {
    // The mark is what the token sheet's and the page's reduced-motion rules match; see styles.spec for those rules.
    const body = { dataset: {} as DOMStringMap } as HTMLElement;
    markReducedMotion(body, true);
    expect(body.dataset.ccReducedMotion).toBe("true");
    markReducedMotion(body, false);
    expect("ccReducedMotion" in body.dataset).toBe(false);
  });
});
