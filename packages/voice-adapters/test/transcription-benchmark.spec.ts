import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseBenchArgs, pcmFromWav } from "../src/transcription-benchmark-cli.ts";
import { normalizeTranscript } from "../src/transcript-normalizer.ts";
import {
  benchmarkRecognizer,
  corpusContext,
  formatBenchmarkReport,
  formatTranscripts,
  parseCorpus,
  recognizersIn,
  unstableReferences,
} from "../src/transcription-benchmark.ts";
import { audioExact, characterErrorRate, editDistance, scoreTranscripts, termPreserved, wordErrorRate } from "../src/transcription-metrics.ts";

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

  it("forgives a recognizer's capital and closing punctuation on the audio-tolerant measure, and nothing more", () => {
    expect(audioExact("chạy pnpm test", "Chạy pnpm test.")).toBe(true);
    expect(audioExact("sửa useEffect nhé", "Sửa useEffect nhé?!")).toBe(true);
    expect(audioExact("mở voice-session.ts", "Mở voice-session.ts.")).toBe(true);
    expect(audioExact("chạy pnpm test", "chạy pnpm, test")).toBe(false);
    expect(audioExact("chạy pnpm test", "chạy npm test")).toBe(false);

    const score = scoreTranscripts([
      { reference: "chạy pnpm test", hypothesis: "Chạy pnpm test.", terms: [] },
      { reference: "sửa useEffect", hypothesis: "sửa useEffect", terms: [] },
      { reference: "git stash", hypothesis: "Git stash, nhé.", terms: [] },
    ]);
    expect(score.exactUtteranceRate).toBeCloseTo(1 / 3);
    expect(score.audioExactUtteranceRate).toBeCloseTo(2 / 3);
  });
});

describe("the benchmark command line", () => {
  it("accepts the -- that pnpm forwards before the flags", () => {
    expect(parseBenchArgs(["--", "--corpus", "x.json"])).toEqual({ corpus: "x.json", recognizers: ["gemini-transcribe-live"], transcripts: false });
    expect(parseBenchArgs(["--corpus", "x.json"])).toEqual(parseBenchArgs(["--", "--corpus", "x.json"]));
  });

  it("takes several recognizers for one audio run, in order and once each", () => {
    expect(parseBenchArgs(["--audio", "m.json", "--recognizer", "gemini-live", "--recognizer", "gemini-transcribe-live", "--recognizer", "gemini-live"]).recognizers).toEqual([
      "gemini-live",
      "gemini-transcribe-live",
    ]);
    expect(parseBenchArgs(["--audio", "m.json"]).recognizers).toEqual(["gemini-transcribe-live"]);
  });

  it("prints transcripts only when asked", () => {
    expect(parseBenchArgs([]).transcripts).toBe(false);
    expect(parseBenchArgs(["--transcripts"]).transcripts).toBe(true);
  });

  it("refuses an unknown flag, and a recognizer without audio to run it on", () => {
    expect(() => parseBenchArgs(["--recogniser", "gemini-live"])).toThrow();
    expect(() => parseBenchArgs(["--recognizer", "gemini-live"])).toThrow("--audio");
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

  it("leaves every canonical reference exactly as it is", () => {
    expect(unstableReferences(corpus)).toEqual([]);
  });

  it("carries negative entries - near neighbours, embedded names, a person's name, other versions - and leaves each one alone", () => {
    const negatives = corpus.utterances.filter((utterance) => utterance.categories.includes("negative"));
    expect(negatives.length).toBeGreaterThanOrEqual(7);
    expect(negatives.filter((utterance) => utterance.categories.includes("version")).length).toBeGreaterThanOrEqual(2);
    const context = corpusContext(corpus);
    for (const utterance of negatives) {
      expect(utterance.recognizers["simulated-live-baseline"]).toBe(utterance.reference);
      expect(normalizeTranscript(utterance.reference, context).changes).toEqual([]);
    }
  });

  it("does not assemble a command out of a respelled word", () => {
    const guarded = corpus.utterances.find((utterance) => utterance.categories.includes("command-guard"));
    expect(guarded).toBeDefined();
    const heard = guarded!.recognizers["simulated-live-baseline"]!;
    expect(normalizeTranscript(heard, corpusContext(corpus)).text).toBe(heard);
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
    expect(report).toContain("Canonical references the normaliser would change: 0.");
    expect(report).toContain("| Exact (strict) | Exact (audio-tolerant) |");
  });

  it("lists each utterance's transcripts per recognizer beside the reference, with which exact measure each meets", () => {
    const small = parseCorpus({
      version: 1,
      context: {},
      utterances: [
        { id: "a", reference: "chạy pnpm test", terms: [], recognizers: { live: "Chạy pnpm test.", other: "chạy pnpm test" } },
        { id: "b", reference: "x | y", terms: [], recognizers: { other: "x | z" } },
      ],
    });
    const table = formatTranscripts(small, ["live"]);
    expect(table).toContain("| a | reference | chạy pnpm test | - |");
    expect(table).toContain("| a | live (raw) | Chạy pnpm test. | audio-tolerant |");
    expect(table).toContain("| a | live (normalized) |");
    expect(table).not.toContain("| b |");

    const both = formatTranscripts(small, ["live", "other"]);
    expect(both).toContain("| a | other (raw) | chạy pnpm test | strict |");
    expect(both).toContain("| b | other (raw) | x \\| z | no |");
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
