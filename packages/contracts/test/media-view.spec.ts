import { describe, expect, it } from "vitest";

import {
  MEDIA_PLAYBACK_WRITE_INTERVAL_MS,
  MEDIA_PLAYING_FRESH_MS,
  MEDIA_STATE_VERSION,
  MEDIA_SELECTION_MIGRATION,
  MEDIA_VIDEO_MIGRATION,
  playingIsFresh,
  readMediaPlayback, readMediaSelection, stateAsCurrentVersion, stateMigrationGaps } from "../src/index.ts";

describe("media view state", () => {
  it("believes a stored playing only while a live player could still have written it", () => {
    const written = "2026-10-01T10:00:00.000Z";
    const after = (ms: number): string => new Date(Date.parse(written) + ms).toISOString();
    // Two missed interval writes plus slack for a slow round trip.
    expect(MEDIA_PLAYING_FRESH_MS).toBeGreaterThan(2 * MEDIA_PLAYBACK_WRITE_INTERVAL_MS);
    expect(playingIsFresh(written, after(0))).toBe(true);
    expect(playingIsFresh(written, after(MEDIA_PLAYING_FRESH_MS))).toBe(true);
    expect(playingIsFresh(written, after(MEDIA_PLAYING_FRESH_MS + 1))).toBe(false);
    expect(playingIsFresh(undefined, after(0))).toBe(false);
    expect(playingIsFresh("not a time", after(0))).toBe(false);
  });

  it("clamps restored selection to the items still present", () => {
    expect(readMediaSelection({ selectedIndex: 8 }, 3)).toEqual({ selectedIndex: 2 });
    expect(readMediaSelection({ selectedIndex: -2 }, 3)).toEqual({ selectedIndex: 0 });
    expect(readMediaSelection({ selectedIndex: 1 }, 0)).toEqual({ selectedIndex: 0 });
  });

  it("migrates old selection and playback rows without overwriting present state", () => {
    const selectionDefinition = { stateVersion: MEDIA_STATE_VERSION, stateMigrations: [MEDIA_SELECTION_MIGRATION] };
    const videoDefinition = { stateVersion: MEDIA_STATE_VERSION, stateMigrations: [MEDIA_VIDEO_MIGRATION] };
    expect(stateMigrationGaps(selectionDefinition)).toEqual([]);
    expect(stateAsCurrentVersion(selectionDefinition, { stateVersion: 1, body: {} })).toEqual({ stateVersion: 2, body: { selectedIndex: 0 } });
    expect(stateAsCurrentVersion(videoDefinition, { stateVersion: 1, body: { position: 12 } })).toEqual({
      stateVersion: 2,
      body: { status: "paused", position: 12, duration: 0 },
    });
  });

  it("never restores a playing state and bounds playback values", () => {
    expect(readMediaPlayback({ status: "playing", position: 200, duration: 120 })).toEqual({ status: "paused", position: 120, duration: 120 });
    expect(readMediaPlayback({ status: "ended", position: Number.POSITIVE_INFINITY, duration: -1 })).toEqual({ status: "ended", position: 0, duration: 0 });
  });
});
