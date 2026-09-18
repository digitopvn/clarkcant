import { describe, expect, it } from "vitest";

import { WAVEFORM_BARS, foldTranscriptUpdate, waveformBars } from "../src/VoiceOverlay.tsx";
import { rmsLevel, type VoiceTranscriptUpdate } from "../src/voice-session.ts";

/**
 * What the voice screen shows when somebody speaks.
 *
 * Both functions are pure, which is why the shape of the waveform and the loudness of a frame can be
 * asserted without an audio device — the parts that need a microphone are the parts a browser test
 * covers, and the arithmetic in between is here.
 */

function constant(value: number, length = 4): Float32Array {
  return new Float32Array(length).fill(value);
}

describe("how loud one frame is", () => {
  it("reads silence as nothing", () => {
    expect(rmsLevel(constant(0))).toBe(0);
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });

  it("clamps a full-scale signal instead of reporting more than full", () => {
    expect(rmsLevel(constant(1))).toBe(1);
    expect(rmsLevel(constant(-1))).toBe(1);
  });

  it("makes ordinary speech visible rather than leaving it near zero", () => {
    // A raw RMS of quiet speech is around 0.02..0.08. Unscaled, a bar chart of that is a flat row, which
    // is indistinguishable from a microphone that is not working.
    expect(rmsLevel(constant(0.05))).toBeGreaterThan(0.15);
    expect(rmsLevel(constant(0.02))).toBeLessThan(0.2);
  });

  it("agrees between the two sample formats it is given", () => {
    // Capture arrives as floats and playback as 16-bit integers; a level that meant something different
    // per direction would show the microphone as quieter than the model.
    const floats = new Float32Array([0.5, -0.5, 0.25, -0.25]);
    const ints = new Int16Array([16384, -16384, 8192, -8192]);
    expect(rmsLevel(ints)).toBeCloseTo(rmsLevel(floats), 5);
  });

  it("prefers average loudness to peaks", () => {
    // One loud sample in an otherwise quiet frame is a click, not a word: peak metering would show it as
    // loud, which is the reading that makes a level meter useless for speech.
    const click = new Float32Array(100).fill(0);
    click[0] = 1;
    expect(rmsLevel(click)).toBeLessThan(rmsLevel(constant(0.4, 100)));
  });
});

describe("the waveform", () => {
  it("returns the number of bars the design draws", () => {
    expect(waveformBars([0, 0, 0], WAVEFORM_BARS)).toHaveLength(WAVEFORM_BARS);
    expect(waveformBars([], 5)).toHaveLength(5);
  });

  it("keeps every bar inside the row and never at zero height", () => {
    for (const level of [0, 0.01, 0.5, 1]) {
      const bars = waveformBars([level, level], WAVEFORM_BARS);
      for (const height of bars) {
        expect(height).toBeGreaterThan(0);
        expect(height).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is tallest in the middle and tapers towards the ends", () => {
    // The shape is what makes it read as a waveform; a row of equal bars is a level meter.
    const bars = waveformBars([0.8, 0.8, 0.8], WAVEFORM_BARS);
    const middle = bars[Math.floor(WAVEFORM_BARS / 2)] ?? 0;
    expect(middle).toBeGreaterThan(bars[0] ?? 0);
    expect(middle).toBeGreaterThan(bars[WAVEFORM_BARS - 1] ?? 0);
  });

  it("grows when the voice gets louder", () => {
    const quiet = waveformBars([0.1, 0.1], WAVEFORM_BARS);
    const loud = waveformBars([0.9, 0.9], WAVEFORM_BARS);
    const middle = Math.floor(WAVEFORM_BARS / 2);
    expect(loud[middle] ?? 0).toBeGreaterThan(quiet[middle] ?? 0);
    // The floor is what keeps a silent microphone visible as an open one.
    expect(Math.min(...waveformBars([0, 0, 0], WAVEFORM_BARS))).toBeGreaterThan(0);
  });
});

/**
 * How a streamed answer lands on screen.
 *
 * The node sends the text so far, not a fragment to append, so an update in the middle of a sentence
 * replaces the line it belongs to. Appending would produce one line per delta - the answer as it stood a
 * moment ago, over and over.
 */
describe("folding a streamed answer into the transcript", () => {
  const partial = (text: string): VoiceTranscriptUpdate => ({ role: "assistant", text, final: false });
  const done = (text: string): VoiceTranscriptUpdate => ({ role: "assistant", text, final: true });

  it("replaces the line a non-final update belongs to", () => {
    expect(foldTranscriptUpdate([partial("Đang")], partial("Đang chuyển"))).toEqual([partial("Đang chuyển")]);
  });

  it("starts a new line once the previous one is final", () => {
    const first = [done("xong rồi")];
    expect(foldTranscriptUpdate(first, partial("câu tiếp"))).toEqual([done("xong rồi"), partial("câu tiếp")]);
  });

  it("starts a new line when the speaker changes", () => {
    const heard = [{ role: "user" as const, text: "tôi nói", final: false }];
    expect(foldTranscriptUpdate(heard, partial("và"))).toEqual([...heard, partial("và")]);
  });
});
