import { describe, expect, it } from "vitest";

import { offscreenPlayback } from "../src/offscreen-playback.ts";

/**
 * Whether a pinned frame keeps running out of view: only when its granted profile authorizes playback and the person
 * chose to keep it playing. Everything else is suspended once it scrolls away.
 */
describe("a frame scrolled out of view", () => {
  it("keeps running when its profile authorizes playback and the person chose to keep it playing", () => {
    expect(offscreenPlayback({ inView: false, keepPlaying: true, isolatedFrame: true, offscreen: "authorized-playback" })).toEqual({
      playbackAllowed: true,
      active: true,
      playingOffscreen: true,
    });
  });

  it("is suspended when the person did not choose to keep it playing, even with a profile that allows it", () => {
    expect(offscreenPlayback({ inView: false, keepPlaying: false, isolatedFrame: true, offscreen: "authorized-playback" })).toEqual({
      playbackAllowed: true,
      active: false,
      playingOffscreen: false,
    });
  });

  it("is suspended under a light profile, whatever was pressed, and offers no toggle", () => {
    for (const keepPlaying of [false, true]) {
      expect(offscreenPlayback({ inView: false, keepPlaying, isolatedFrame: true, offscreen: "suspend" })).toEqual({
        playbackAllowed: false,
        active: false,
        playingOffscreen: false,
      });
    }
  });

  it("is suspended when the node did not say what its profile allows, or it is not an isolated frame", () => {
    expect(offscreenPlayback({ inView: false, keepPlaying: true, isolatedFrame: true, offscreen: undefined }).active).toBe(false);
    expect(offscreenPlayback({ inView: false, keepPlaying: true, isolatedFrame: false, offscreen: "authorized-playback" })).toEqual({
      playbackAllowed: false,
      active: false,
      playingOffscreen: false,
    });
  });
});

describe("a frame in view", () => {
  it("runs, and is not said to be playing out of view", () => {
    for (const offscreen of ["suspend", "authorized-playback", undefined] as const) {
      for (const keepPlaying of [false, true]) {
        const decided = offscreenPlayback({ inView: true, keepPlaying, isolatedFrame: true, offscreen });
        expect(decided.active).toBe(true);
        expect(decided.playingOffscreen).toBe(false);
      }
    }
  });
});
