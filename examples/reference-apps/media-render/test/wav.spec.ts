import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WAV_HEADER_BYTES,
  applyGain,
  checkRenderParameters,
  fixtureClip,
  parseWavHeader,
  renderPlan,
  wavHeader,
} from "../service/wav.mjs";
import {
  GAIN_INPUT,
  NO_FILE_KEPT,
  createPeaks,
  jobView,
  outputHeader,
  readParameters,
  readPersistedState,
  renderedName,
  statusText,
} from "../widgets/main/render-core.js";

/**
 * The render's own transform, on the fixture clip the journeys pick: gain, trim, the header it writes and the bytes it
 * makes, pinned by digest so a change to the arithmetic is a visible change to this file.
 */

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function samples(bytes: Uint8Array, from: number, count: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) => view.getInt16(from + index * 2, true));
}

/** What the service does, in one piece: the header it writes, then every chunk's samples with the gain applied. */
function renderWhole(input: Uint8Array, parameters: { gainDb: number; trimStartMs?: number; trimEndMs?: number }): Uint8Array {
  const header = parseWavHeader(input.subarray(0, WAV_HEADER_BYTES), input.byteLength);
  if (!header.ok) throw new Error(header.reason);
  const plan = renderPlan(header, parameters);
  if (!plan.ok) throw new Error(plan.reason);
  const output = new Uint8Array(44 + plan.end - plan.start);
  output.set(wavHeader(header.format, plan.end - plan.start), 0);
  for (let offset = plan.start; offset < plan.end; offset += 262_144) {
    const end = Math.min(plan.end, offset + 262_144);
    output.set(applyGain(input.subarray(offset, end), plan.gain), 44 + offset - plan.start);
  }
  return output;
}

describe("the fixture clip", () => {
  it("is larger than one bridge chunk and is the WAV it says it is", () => {
    const clip = fixtureClip({ seconds: 24 });
    expect(clip.byteLength).toBeGreaterThan(262_144);
    const header = parseWavHeader(clip.subarray(0, WAV_HEADER_BYTES), clip.byteLength);
    expect(header).toMatchObject({ ok: true, format: { channels: 1, sampleRate: 22_050, blockAlign: 2 }, dataOffset: 44, frames: 24 * 22_050 });
    expect(header.ok && header.durationSeconds).toBe(24);
  });

  it("is the same bytes every time", () => {
    expect(sha256(fixtureClip({ seconds: 2 }))).toBe(sha256(fixtureClip({ seconds: 2 })));
  });
});

describe("parseWavHeader", () => {
  it("refuses what it cannot render, with the reason a person reads", () => {
    const clip = fixtureClip({ seconds: 1 });
    expect(parseWavHeader(new TextEncoder().encode("not a wav file at all"), 21)).toEqual({ ok: false, reason: "the file is not a WAV file" });
    const eightBit = clip.slice(0, 64);
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(parseWavHeader(eightBit, clip.byteLength)).toMatchObject({ ok: false, reason: "only uncompressed 16-bit PCM WAV can be rendered" });
    const surround = fixtureClip({ seconds: 1 }).slice(0, 64);
    new DataView(surround.buffer).setUint16(22, 6, true);
    new DataView(surround.buffer).setUint16(32, 12, true);
    expect(parseWavHeader(surround, clip.byteLength)).toMatchObject({ ok: false, reason: "only mono or stereo WAV can be rendered" });
  });

  it("skips chunks before the samples and reads a truncated file as the samples it has", () => {
    const clip = fixtureClip({ seconds: 1 });
    const extra = new Uint8Array(clip.byteLength + 12);
    extra.set(clip.subarray(0, 36), 0);
    extra.set(new TextEncoder().encode("LIST"), 36);
    new DataView(extra.buffer).setUint32(40, 4, true);
    extra.set(new TextEncoder().encode("INFO"), 44);
    extra.set(clip.subarray(36), 48);
    const header = parseWavHeader(extra.subarray(0, WAV_HEADER_BYTES), extra.byteLength);
    expect(header).toMatchObject({ ok: true, dataOffset: 56, frames: 22_050 });
    const cut = parseWavHeader(clip.subarray(0, WAV_HEADER_BYTES), 44 + 1001);
    expect(cut).toMatchObject({ ok: true, dataBytes: 1000, frames: 500 });
  });

  it("refuses a format chunk shorter than PCM's 16 bytes before reading a field of it", () => {
    // RIFF, WAVE, an 8-byte "fmt " chunk, then the samples: a 16-byte read would take its fields from the data header.
    const clip = fixtureClip({ seconds: 1 });
    const short = new Uint8Array(12 + 8 + 8 + clip.byteLength - 36);
    short.set(clip.subarray(0, 12), 0);
    short.set(new TextEncoder().encode("fmt "), 12);
    new DataView(short.buffer).setUint32(16, 8, true);
    short.set(clip.subarray(20, 28), 20);
    short.set(clip.subarray(36), 28);
    expect(parseWavHeader(short.subarray(0, WAV_HEADER_BYTES), short.byteLength)).toEqual({
      ok: false,
      reason: "the WAV file's format chunk is shorter than the 16 bytes PCM needs",
    });
    // A full-size chunk the first bytes stop in the middle of is cut off, not read past.
    expect(parseWavHeader(clip.subarray(0, 30), clip.byteLength)).toEqual({ ok: false, reason: "the WAV file's format chunk is cut off" });
  });
});

describe("the render", () => {
  const clip = fixtureClip({ seconds: 2 });

  it("at 0 dB and no trim is the input, byte for byte", () => {
    expect(sha256(renderWhole(clip, { gainDb: 0 }))).toBe(sha256(clip));
  });

  it("applies the gain to every sample, rounding and clipping to 16 bits", () => {
    const half = renderWhole(clip, { gainDb: -6.020599913279624 });
    const before = samples(clip, 44 + 200, 8);
    expect(samples(half, 44 + 200, 8)).toEqual(before.map((value) => Math.round(value * 0.5)));
    const loud = applyGain(new Uint8Array(new Int16Array([20_000, -20_000, 100]).buffer), 4);
    expect(Array.from(new Int16Array(loud.buffer))).toEqual([32_767, -32_768, 400]);
  });

  it("trims whole frames from each end and writes a header for exactly what is left", () => {
    const output = renderWhole(clip, { gainDb: 0, trimStartMs: 100, trimEndMs: 500 });
    const header = outputHeader(output);
    expect(header).toMatchObject({ channels: 1, sampleRate: 22_050, frames: 2 * 22_050 - 2205 - 11_025 });
    expect(samples(output, 44, 4)).toEqual(samples(clip, 44 + 2205 * 2, 4));
    expect(output.byteLength).toBe(44 + (2 * 22_050 - 2205 - 11_025) * 2);
  });

  it("is pinned by digest, so a change to the arithmetic is a change to this test", () => {
    expect(sha256(renderWhole(clip, { gainDb: -6, trimStartMs: 250, trimEndMs: 250 }))).toBe(PINNED_RENDER_DIGEST);
  });

  it("refuses parameters it does not take, and a trim that leaves nothing", () => {
    expect(checkRenderParameters({ gainDb: 13 })).toBe("gain must be between -24 and 12 dB");
    expect(checkRenderParameters({ gainDb: 0, trimStartMs: -1 })).toBe("trimStartMs must be a whole number of milliseconds, at least 0");
    expect(checkRenderParameters({ gainDb: 0, trimEndMs: 1.5 })).toBe("trimEndMs must be a whole number of milliseconds, at least 0");
    const header = parseWavHeader(clip.subarray(0, WAV_HEADER_BYTES), clip.byteLength);
    if (!header.ok) throw new Error(header.reason);
    expect(renderPlan(header, { gainDb: 0, trimStartMs: 1000, trimEndMs: 1000 })).toEqual({ ok: false, reason: "the trim leaves no sound to render" });
  });
});

describe("the widget's rules", () => {
  it("offers a file only from a completed job, never from one that was stopped or failed", () => {
    const ref = { v: 1, artifactId: "art_out", kind: "finalized", mimeType: "audio/wav", sizeBytes: 100, name: "untitled.wav" };
    const base = { jobId: "job_x", resultRefs: [ref], createdAt: "2026-10-02T00:00:00.000Z" };
    expect(jobView({ ...base, status: "completed" }).output).toEqual(ref);
    expect(jobView({ ...base, status: "cancelled" }).output).toBeUndefined();
    expect(jobView({ ...base, status: "failed" }).output).toBeUndefined();
    const running = jobView({ ...base, resultRefs: [], status: "running", progress: { current: 3, total: 4, message: "Rendered 3 KiB of 4 KiB" } });
    expect(running).toMatchObject({ open: true, fraction: 0.75, message: "Rendered 3 KiB of 4 KiB" });
  });

  it("reads parameters the way the service checks them, and keeps only what its state promised", () => {
    expect(readParameters({ gainDb: "-6", trimStartMs: "", trimEndMs: "250" })).toEqual({ ok: true, value: { gainDb: -6, trimStartMs: 0, trimEndMs: 250 } });
    expect(readParameters({ gainDb: "20", trimStartMs: "0", trimEndMs: "0" }).ok).toBe(false);
    expect(readParameters({ gainDb: "0", trimStartMs: "1.5", trimEndMs: "0" }).ok).toBe(false);
    // A cut in gain, however a touch keyboard writes the minus or the decimal point; never a number in another notation.
    for (const [typed, gainDb] of [["−6", -6], [" -6,5 ", -6.5], ["-24", -24], ["3.5", 3.5]] as const) {
      expect(readParameters({ gainDb: typed, trimStartMs: "", trimEndMs: "" })).toEqual({ ok: true, value: { gainDb, trimStartMs: 0, trimEndMs: 0 } });
    }
    for (const typed of ["0x10", "1e1", "-", "6-", "--6"]) {
      expect(readParameters({ gainDb: typed, trimStartMs: "", trimEndMs: "" }).ok).toBe(false);
    }
    expect(readPersistedState({ job: "not-a-job", source: "art_x", gainDb: "loud", extra: true })).toEqual({
      source: null,
      job: null,
      output: null,
      gainDb: 0,
      trimStartMs: 0,
      trimEndMs: 0,
    });
    expect(renderedName("Bài hát.WAV")).toBe("Bài hát-render.wav");
  });

  it("asks for a keyboard with a minus key for the gain, since most of its range is negative", () => {
    // iOS's decimal pad has no minus key, and a number field shows no stepper on touch.
    expect(GAIN_INPUT).toMatchObject({ type: "text", inputmode: "text" });
    expect(new RegExp(`^(?:${GAIN_INPUT.pattern})$`, "v").test("−6,5")).toBe(true);
  });

  it("says what failed when a completed render left no file, rather than that it was rendered", () => {
    const ref = { v: 1, artifactId: "art_out", kind: "finalized", mimeType: "audio/wav", sizeBytes: 100, name: "untitled.wav" };
    const base = { jobId: "job_x", createdAt: "2026-10-02T00:00:00.000Z" };
    expect(statusText(jobView({ ...base, status: "completed", resultRefs: [ref] }))).toBe("Đã dựng xong.");
    const unkept = statusText(jobView({ ...base, status: "completed", resultRefs: [] }));
    expect(unkept).toBe(NO_FILE_KEPT);
    expect(unkept).toContain("Tệp gốc vẫn còn");
    expect(statusText(jobView({ ...base, status: "cancelled", resultRefs: [] }))).toBe("Đã dừng; không có tệp kết quả nào.");
  });

  it("folds a rendered file into a waveform one chunk at a time, the same however it is split", () => {
    const output = renderWhole(oneSecondClip(), { gainDb: 0 });
    const header = outputHeader(output);
    if (header === undefined) throw new Error("no header");
    const whole = createPeaks(header, 64);
    whole.add(output.subarray(44));
    const split = createPeaks(header, 64);
    for (let offset = 44; offset < output.byteLength; offset += 1001) split.add(output.subarray(offset, Math.min(output.byteLength, offset + 1001)));
    expect(Array.from(split.max)).toEqual(Array.from(whole.max));
    expect(Array.from(split.min)).toEqual(Array.from(whole.min));
    expect(Math.max(...whole.max)).toBeGreaterThan(0.3);
    expect(Math.min(...whole.min)).toBeLessThan(-0.3);
  });
});

function oneSecondClip(): Uint8Array {
  return fixtureClip({ seconds: 1 });
}

const PINNED_RENDER_DIGEST = "sha256:ab48b6a572cb2314cc133629b3eb353dc4e3bb070ca1cbad1d47c9b29f3f9262";
