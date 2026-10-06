import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pcmFromWav } from "../src/transcription-benchmark-cli.ts";
import { benchmarkRecognizer, formatBenchmarkReport, parseCorpus, recognizersIn } from "../src/transcription-benchmark.ts";
import { characterErrorRate, editDistance, scoreTranscripts, termPreserved, wordErrorRate } from "../src/transcription-metrics.ts";

/**
 * The benchmark: its metrics, its corpus, and the result the normaliser has to keep earning.
 *
 * The corpus is text - what was said, and what a recognizer produced for it - so this runs anywhere. Audio runs use the
 * same scorer through the CLI and need a provider key; that is an external gate, not something asserted here.
 */

const CORPUS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../bench/vi-en-coding-corpus.json");
const corpus = parseCorpus(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));

describe("the metrics", () => {
  it("measures word and character error rates by edit distance", () => {
    expect(editDistance(["a", "b", "c"], ["a", "x", "c", "d"])).toBe(2);
    expect(wordErrorRate("chạy pnpm test", "chạy pnpm test")).toBe(0);
    expect(wordErrorRate("chạy pnpm test", "chạy p n p m test")).toBeCloseTo(4 / 3);
    expect(characterErrorRate("useEffect", "use effect")).toBeGreaterThan(0);
    expect(wordErrorRate("", "")).toBe(0);
  });

  it("counts a term as preserved only in its exact spelling, as a whole word", () => {
    expect(termPreserved("useEffect", "sửa useEffect nhé")).toBe(true);
    expect(termPreserved("useEffect", "sửa use effect nhé")).toBe(false);
    expect(termPreserved("useEffect", "sửa useeffect nhé")).toBe(false);
    expect(termPreserved("pnpm", "pnpmx")).toBe(false);
    expect(termPreserved("voice-session.ts", "mở voice-session.ts.")).toBe(true);
  });

  it("scores a technical term error rate and preservation per kind", () => {
    const score = scoreTranscripts([
      { reference: "chạy pnpm test", hypothesis: "chạy p n p m test", terms: [{ text: "pnpm", kind: "command" }] },
      { reference: "sửa useEffect", hypothesis: "sửa useEffect", terms: [{ text: "useEffect", kind: "symbol" }] },
    ]);
    expect(score.technicalTermErrorRate).toBe(0.5);
    expect(score.preservation["command"]).toMatchObject({ preserved: 0, total: 1 });
    expect(score.preservation["symbol"]).toMatchObject({ preserved: 1, total: 1 });
    expect(score.exactUtteranceRate).toBe(0.5);
  });
});

describe("the corpus", () => {
  it("holds at least sixty Vietnamese-English coding utterances, each with its terms and a recognizer output", () => {
    expect(corpus.utterances.length).toBeGreaterThanOrEqual(60);
    for (const utterance of corpus.utterances) {
      expect(Object.keys(utterance.recognizers).length).toBeGreaterThan(0);
      for (const term of utterance.terms) expect(utterance.reference).toContain(term.text);
    }
    const codeSwitched = corpus.utterances.filter((utterance) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu.test(utterance.reference));
    expect(codeSwitched.length).toBeGreaterThanOrEqual(45);
  });

  it("refuses a malformed corpus by naming what is wrong", () => {
    expect(() => parseCorpus({ version: 2 })).toThrow("version");
    expect(() => parseCorpus({ version: 1, context: {}, utterances: [{ id: "a", reference: "x", terms: [{ text: "x", kind: "nonsense" }], recognizers: {} }] })).toThrow(
      "unknown term kind",
    );
    expect(() => parseCorpus({ version: 1, context: { symbols: "useEffect" }, utterances: [] })).toThrow("context.symbols");
    expect(() => parseCorpus({ version: 1, context: { secrets: [] }, utterances: [] })).toThrow("context.secrets");
    expect(() =>
      parseCorpus({
        version: 1,
        context: {},
        utterances: [
          { id: "a", reference: "x", terms: [], recognizers: {} },
          { id: "a", reference: "y", terms: [], recognizers: {} },
        ],
      }),
    ).toThrow("duplicate");
  });
});

describe("the normaliser on the corpus", () => {
  const result = benchmarkRecognizer(corpus, "simulated-live-baseline");

  it("lowers the technical term error rate and the word error rate, without a single regression", () => {
    expect(result.regressions).toEqual([]);
    expect(result.normalized.technicalTermErrorRate).toBeLessThan(result.raw.technicalTermErrorRate / 2);
    expect(result.normalized.wer).toBeLessThan(result.raw.wer);
    expect(result.normalized.cer).toBeLessThan(result.raw.cer);
  });

  it("keeps every command and version it was given, and abstains rather than guessing", () => {
    for (const kind of ["command", "version"] as const) {
      expect(result.normalized.preservation[kind]?.preserved).toBeGreaterThanOrEqual(result.raw.preservation[kind]?.preserved ?? 0);
    }
    expect(result.abstained).toBeGreaterThanOrEqual(1);
  });

  it("formats a report with one row per recognizer and stage", () => {
    const report = formatBenchmarkReport(corpus, recognizersIn(corpus).map((recognizer) => benchmarkRecognizer(corpus, recognizer)));
    expect(report).toContain("| simulated-live-baseline | raw |");
    expect(report).toContain("| simulated-live-baseline | normalized |");
    expect(report).toContain(`Corpus: ${corpus.utterances.length} utterances`);
  });
});

describe("reading a recording for an audio run", () => {
  function wav(options: { channels?: number; rate?: number; bits?: number; data?: number[] } = {}): Uint8Array {
    const data = Uint8Array.from(options.data ?? [1, 0, 2, 0]);
    const out = new Uint8Array(44 + data.byteLength);
    const view = new DataView(out.buffer);
    const tag = (offset: number, text: string): void => {
      for (let index = 0; index < 4; index += 1) out[offset + index] = text.charCodeAt(index);
    };
    tag(0, "RIFF");
    view.setUint32(4, 36 + data.byteLength, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, options.channels ?? 1, true);
    view.setUint32(24, options.rate ?? 16_000, true);
    view.setUint32(28, (options.rate ?? 16_000) * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, options.bits ?? 16, true);
    tag(36, "data");
    view.setUint32(40, data.byteLength, true);
    out.set(data, 44);
    return out;
  }

  it("takes PCM16 16 kHz mono, and refuses anything it would have to resample", () => {
    expect([...pcmFromWav(wav())]).toEqual([1, 0, 2, 0]);
    expect(() => pcmFromWav(wav({ rate: 44_100 }))).toThrow("16 kHz");
    expect(() => pcmFromWav(wav({ channels: 2 }))).toThrow("mono");
    expect(() => pcmFromWav(new Uint8Array(10))).toThrow("RIFF");
  });
});
