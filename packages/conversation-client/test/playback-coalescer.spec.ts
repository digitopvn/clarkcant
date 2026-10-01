import { describe, expect, it } from "vitest";

import { createPlaybackCoalescer } from "../src/playback-coalescer.ts";

describe("local playback state coalescing", () => {
  it("writes the initial state and coalesces frequent clock updates to the interval", () => {
    let time = 0;
    const writes: unknown[] = [];
    const report = createPlaybackCoalescer({ now: () => time, intervalMs: 3_000, write: (state) => writes.push(state) });
    report({ status: "playing", position: 0, duration: 60 }, "playing");
    time = 500;
    report({ status: "playing", position: 1, duration: 60 }, "timeupdate");
    time = 2_999;
    report({ status: "playing", position: 4, duration: 60 }, "timeupdate");
    time = 3_000;
    report({ status: "playing", position: 5, duration: 60 }, "timeupdate");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ status: "playing", position: 5, duration: 60 });
  });

  it("writes a minute of continuous play a bounded number of times, not once per tick", () => {
    let time = 0;
    let writes = 0;
    const report = createPlaybackCoalescer({ now: () => time, write: () => (writes += 1) });
    report({ status: "playing", position: 0, duration: 120 }, "playing");
    // A browser reports the clock about four times a second while a video plays.
    let ticks = 0;
    for (time = 250; time <= 60_000; time += 250) {
      report({ status: "playing", position: time / 1000, duration: 120 }, "timeupdate");
      ticks += 1;
    }
    expect(ticks).toBe(240);
    // The first write, then at most one every three seconds of the sixty.
    expect(writes).toBeLessThanOrEqual(21);
    expect(writes).toBeGreaterThan(1);
  });

  it("flushes pause, seek and end transitions immediately", () => {
    const writes: string[] = [];
    const report = createPlaybackCoalescer({ now: () => 1, write: (state) => writes.push(`${state.status}:${state.position}`) });
    report({ status: "playing", position: 0, duration: 30 }, "playing");
    report({ status: "paused", position: 1, duration: 30 }, "pause");
    report({ status: "paused", position: 8, duration: 30 }, "seek");
    report({ status: "ended", position: 30, duration: 30 }, "ended");
    expect(writes).toEqual(["playing:0", "paused:1", "paused:8", "ended:30"]);
  });

  it("does not repeat an unchanged state and never writes a non-finite clock", () => {
    const writes: unknown[] = [];
    const report = createPlaybackCoalescer({ now: () => 1, write: (state) => writes.push(state) });
    report({ status: "paused", position: 4, duration: 10 }, "pause");
    report({ status: "paused", position: 4, duration: 10 }, "pause");
    report({ status: "paused", position: Number.NaN, duration: Number.POSITIVE_INFINITY }, "seek");
    expect(writes).toEqual([
      { status: "paused", position: 4, duration: 10 },
      { status: "paused", position: 0, duration: 0 },
    ]);
  });
});
