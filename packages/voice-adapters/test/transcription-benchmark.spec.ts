import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { transcribeVocabulary } from "../src/gemini-transcribe.ts";
import { pcmFromWav } from "../src/transcription-benchmark-cli.ts";
import { normalizeTranscript } from "../src/transcript-normalizer.ts";
import { benchmarkRecognizer, corpusContext, formatBenchmarkReport, parseCorpus, recognizersIn, unstableReferences } from "../src/transcription-benchmark.ts";
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
  });
});

describe("vocabulary bias in an audio run", () => {
  const biased = corpus.utterances.filter((utterance) => utterance.categories.includes("vocabulary-bias"));

  it("carries a person's name, another model version and a near-neighbour symbol for the audio run to check", () => {
    expect(biased.map((utterance) => utterance.id)).toEqual(["u069", "u072", "u075"]);
  });

  it("keeps the listed twin of each one out of what the recognizer is biased with", () => {
    const sent = transcribeVocabulary(corpusContext(corpus));
    for (const twin of ["Jev", "claude-opus-4", "getUser"]) expect(sent).not.toContain(twin);
  });

  it("reports a session term written over what was said, as the recognizer heard it on audio", () => {
    // What the dedicated recognizer returned for these recordings when it was biased with the full vocabulary.
    const run = structuredClone(corpus);
    const heard: Record<string, string> = {
      u069: "Sửa hàm getUser cho đúng type.",
      u072: "Hi anh Jev, bên design xem màu này ổn không?",
      u075: "Đổi sang claude-opus-4 thử xem.",
    };
    for (const utterance of run.utterances) {
      const text = heard[utterance.id];
      if (text !== undefined) utterance.recognizers["gemini-transcribe-live-audio"] = text;
    }
    const result = benchmarkRecognizer(run, "gemini-transcribe-live-audio");
    expect(result.substitutions).toEqual(["u069", "u072", "u075"]);
    expect(formatBenchmarkReport(run, [result])).toContain("- gemini-transcribe-live-audio: 3 (u069, u072, u075)");

    for (const utterance of run.utterances) {
      if (heard[utterance.id] !== undefined) utterance.recognizers["gemini-transcribe-live-audio"] = `${utterance.reference}.`;
    }
    expect(benchmarkRecognizer(run, "gemini-transcribe-live-audio").substitutions).toEqual([]);
  });

  it("reports a session term heard in another casing than its canonical spelling", () => {
    const run = structuredClone(corpus);
    const target = run.utterances.find((utterance) => utterance.id === "u072")!;
    target.recognizers["gemini-transcribe-live-audio"] = "Hi anh jev, bên design xem màu này ổn không?";
    expect(benchmarkRecognizer(run, "gemini-transcribe-live-audio").substitutions).toEqual(["u072"]);
  });

  it("counts a destructive command heard as a harmless one, and not a casing slip", () => {
    // `git stash` heard as `git status`; `zod`, `electron` and `react` heard in lower case are not substitutions.
    expect(benchmarkRecognizer(corpus, "simulated-live-baseline").substitutions).toEqual(["u003", "u050"]);
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
