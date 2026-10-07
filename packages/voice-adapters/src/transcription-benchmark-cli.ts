import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { GeminiLiveAdapter } from "./gemini-live.ts";
import { GeminiTranscribeLiveAdapter } from "./gemini-transcribe.ts";
import {
  type BenchmarkCorpus,
  type CorpusUtterance,
  benchmarkRecognizer,
  corpusContext,
  formatBenchmarkReport,
  formatTranscripts,
  parseCorpus,
  recognizersIn,
} from "./transcription-benchmark.ts";

/**
 * Run the transcription benchmark.
 *
 *   node packages/voice-adapters/src/transcription-benchmark-cli.ts
 *     Scores every recognizer output already in the corpus, raw and normalised. No network, no credential.
 *
 *   node packages/voice-adapters/src/transcription-benchmark-cli.ts --audio <manifest.json> --recognizer <id> [--recognizer <id> ...]
 *     Recognizes real recordings with each named recognizer first, then scores them, as `<id>-audio`, side by side
 *     with each other and the corpus outputs in one table. The manifest
 *     is `{ "entries": [{ "id": "u001", "wav": "u001.wav" }] }`, paths relative to the manifest, each a PCM16 16 kHz
 *     mono WAV of the corpus utterance with that id. Recognizers: `gemini-transcribe-live` (dedicated, with the
 *     corpus vocabulary, and the default) and `gemini-live` (the conversational baseline's input transcription). The
 *     key is read from GEMINI_API_KEY and never printed; without one the run stops and says which gate is missing.
 *     A recognizer that fails is named with its error and left out of the table, the ones that completed are still
 *     scored, and the run exits 1. The run exits 3 instead when a completed recognizer came back with a session term the
 *     person did not say (see `vocabulary-bias` in the corpus), and names the `vocabulary-bias` entries the manifest left
 *     unrecorded.
 *
 *   --transcripts prints every utterance's transcript per recognizer, as heard and normalised, beside the reference.
 *   --corpus <file> scores another corpus. A leading `--` (what `pnpm <script> -- --flag` forwards) is accepted.
 *
 * Every report gives two exact-utterance measures: strict, and audio-tolerant (case anywhere in the utterance and
 * trailing `. , ! ? ; : …` ignored), because a real recognizer capitalises and punctuates and the strict measure counts
 * that as a miss.
 *
 * Adding Soniox, Deepgram or a local recognizer is an adapter implementing `SpeechRecognitionAdapter` and one entry
 * in `AUDIO_RECOGNIZERS`; nothing in the scorer changes.
 */

const DEFAULT_CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../bench/vi-en-coding-corpus.json");
const PCM_BYTES_PER_SECOND = 32_000;

type AudioRecognizer = (pcm: Uint8Array, apiKey: string, corpus: BenchmarkCorpus) => Promise<{ text: string; finalizeMs: number; firstInterimMs?: number }>;

const AUDIO_RECOGNIZERS: Record<string, AudioRecognizer> = {
  "gemini-transcribe-live": async (pcm, apiKey, corpus) => {
    const recognizer = new GeminiTranscribeLiveAdapter();
    const finals: string[] = [];
    let firstInterimMs: number | undefined;
    const started = performance.now();
    let lastFinalAt = started;
    recognizer.onUtterance((utterance) => {
      if (!utterance.isFinal) {
        firstInterimMs ??= performance.now() - started;
        return;
      }
      finals.push(utterance.text.trim());
      lastFinalAt = performance.now();
    });
    await recognizer.start({ sessionId: "bench", tokenProvider: async () => apiKey, context: corpusContext(corpus) });
    const audioEnd = await streamRealtime(pcm, (frame) => recognizer.sendAudio(frame));
    recognizer.endAudio();
    await quietFor(() => Math.max(lastFinalAt, audioEnd), 1500, 15_000);
    await recognizer.stop();
    return { text: finals.join(" ").trim(), finalizeMs: Math.max(0, lastFinalAt - audioEnd), ...(firstInterimMs === undefined ? {} : { firstInterimMs }) };
  },
  "gemini-live": async (pcm, apiKey) => {
    const adapter = new GeminiLiveAdapter({ systemInstruction: "Stay silent. Do not answer." });
    let text = "";
    let firstInterimMs: number | undefined;
    const started = performance.now();
    let lastAt = started;
    adapter.onTranscript((fragment) => {
      if (fragment.role !== "user") return;
      if (fragment.text !== "") firstInterimMs ??= performance.now() - started;
      text += fragment.text;
      lastAt = performance.now();
    });
    await adapter.connect({ sessionId: "bench", tokenProvider: async () => apiKey });
    const audioEnd = await streamRealtime(pcm, (frame) => adapter.sendAudio(frame));
    // The live model ends a turn on silence, so silence is what it is sent.
    const silenceEnd = await streamRealtime(new Uint8Array(PCM_BYTES_PER_SECOND), (frame) => adapter.sendAudio(frame));
    await quietFor(() => Math.max(lastAt, silenceEnd), 1500, 15_000);
    await adapter.disconnect();
    return { text: text.trim(), finalizeMs: Math.max(0, lastAt - audioEnd), ...(firstInterimMs === undefined ? {} : { firstInterimMs }) };
  },
};

export interface BenchArguments {
  corpus?: string;
  audio?: string;
  /** Audio recognizers to run, in the order named; `gemini-transcribe-live` when none is named. */
  recognizers: string[];
  transcripts: boolean;
}

/**
 * Read the command line. `pnpm <script> -- --corpus x` forwards the `--` itself, and `parseArgs` would read every flag
 * after it as a stray positional, so one leading `--` is dropped first.
 */
export function parseBenchArgs(argv: readonly string[]): BenchArguments {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : [...argv],
    options: {
      corpus: { type: "string" },
      audio: { type: "string" },
      recognizer: { type: "string", multiple: true },
      transcripts: { type: "boolean" },
    },
  });
  if (values.recognizer !== undefined && values.audio === undefined) {
    throw new Error("--recognizer names an audio recognizer, so it needs --audio <manifest.json>");
  }
  return {
    ...(values.corpus === undefined ? {} : { corpus: values.corpus }),
    ...(values.audio === undefined ? {} : { audio: values.audio }),
    recognizers: [...new Set(values.recognizer ?? ["gemini-transcribe-live"])],
    transcripts: values.transcripts ?? false,
  };
}

async function main(): Promise<number> {
  const args = parseBenchArgs(process.argv.slice(2));
  const corpus = parseCorpus(JSON.parse(readFileSync(args.corpus ?? DEFAULT_CORPUS, "utf8")));
  let failed: RecognizerFailure[] = [];

  if (args.audio !== undefined) {
    const unknown = args.recognizers.filter((id) => AUDIO_RECOGNIZERS[id] === undefined);
    if (unknown.length > 0) {
      process.stderr.write(`unknown recognizer ${unknown.join(", ")}; known: ${Object.keys(AUDIO_RECOGNIZERS).join(", ")}\n`);
      return 1;
    }
    const apiKey = process.env["GEMINI_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      process.stderr.write("external gate: GEMINI_API_KEY is not configured, so no audio was recognized\n");
      return 2;
    }
    const manifestPath = resolve(args.audio);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries?: Array<{ id?: unknown; wav?: unknown }> };
    // Every recording is read and checked before any provider is called, so a bad manifest costs no quota.
    const recordings = (manifest.entries ?? []).map((entry) => {
      if (typeof entry.id !== "string" || typeof entry.wav !== "string") throw new Error("manifest entries need a string id and wav");
      const utterance = corpus.utterances.find((item) => item.id === entry.id);
      if (utterance === undefined) throw new Error(`manifest names ${entry.id}, which is not in the corpus`);
      return { utterance, pcm: pcmFromWav(readFileSync(resolve(dirname(manifestPath), entry.wav))) };
    });
    failed = await runAudioRecognizers(args.recognizers, recordings, (id, pcm) => AUDIO_RECOGNIZERS[id]!(pcm, apiKey, corpus), (line) => process.stdout.write(line));
    process.stdout.write("\n");
  }

  const context = corpusContext(corpus);
  const recognizers = recognizersIn(corpus);
  const results = recognizers.map((recognizer) => benchmarkRecognizer(corpus, recognizer, context));
  process.stdout.write(`${formatBenchmarkReport(corpus, results)}\n`);
  if (args.transcripts) process.stdout.write(`\n${formatTranscripts(corpus, recognizers, context)}\n`);
  for (const failure of failed) process.stderr.write(`${failure.id} failed and is not in the report: ${failure.error}\n`);
  if (args.audio === undefined) return failed.length === 0 ? 0 : 1;
  // The audio run is the regression check for vocabulary bias: a session term heard but not said fails it, whether the
  // bias or an ordinary mishearing put it there. It outranks a failed recognizer, whose run scored nothing to check.
  let biased = false;
  for (const id of args.recognizers.filter((name) => !failed.some((failure) => failure.id === name))) {
    const audioResult = results.find((result) => result.recognizer === `${id}-audio`);
    const uncovered = corpus.utterances.filter((utterance) => utterance.categories.includes("vocabulary-bias") && utterance.recognizers[`${id}-audio`] === undefined);
    if (uncovered.length > 0) process.stderr.write(`${id}: not checked for vocabulary bias, no recording: ${uncovered.map((utterance) => utterance.id).join(", ")}\n`);
    if (audioResult !== undefined && audioResult.substitutions.length > 0) {
      process.stderr.write(`${id}: vocabulary term heard but not said: ${audioResult.substitutions.join(", ")} (a session term the person did not say; the bias or an ordinary mishearing may have put it there)\n`);
      biased = true;
    }
  }
  if (biased) return 3;
  return failed.length === 0 ? 0 : 1;
}

export interface RecognizerFailure {
  id: string;
  error: string;
}

/**
 * Recognize every recording with each recognizer in turn, and record each one's transcripts as `<id>-audio` only once
 * all of its recordings are done. A recognizer that throws is reported as failed with its error and gets no row, so
 * no score is invented from part of a run, and the recognizers that completed are still scored.
 */
export async function runAudioRecognizers(
  ids: readonly string[],
  recordings: ReadonlyArray<{ utterance: CorpusUtterance; pcm: Uint8Array }>,
  recognize: (id: string, pcm: Uint8Array) => Promise<{ text: string; finalizeMs: number }>,
  write: (line: string) => void,
): Promise<RecognizerFailure[]> {
  const failed: RecognizerFailure[] = [];
  for (const id of ids) {
    const heardBy = new Map<CorpusUtterance, string>();
    const latencies: number[] = [];
    try {
      for (const { utterance, pcm } of recordings) {
        const heard = await recognize(id, pcm);
        heardBy.set(utterance, heard.text === "" ? "(nothing recognized)" : heard.text);
        latencies.push(heard.finalizeMs);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      failed.push({ id, error });
      write(`${id}: failed after ${heardBy.size} of ${recordings.length} recordings, not scored: ${error}\n`);
      continue;
    }
    for (const [utterance, text] of heardBy) utterance.recognizers[`${id}-audio`] = text;
    latencies.sort((left, right) => left - right);
    const quantile = (q: number): string => (latencies.length === 0 ? "-" : `${Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!)} ms`);
    write(`${id}: finalization after end of audio: p50 ${quantile(0.5)}, p95 ${quantile(0.95)} over ${latencies.length} recordings.\n`);
  }
  return failed;
}

/** Send audio at the speed it was spoken, in 100 ms frames, so a live recognizer sees what a microphone gives it. */
async function streamRealtime(pcm: Uint8Array, send: (frame: Uint8Array) => void): Promise<number> {
  const frame = PCM_BYTES_PER_SECOND / 10;
  for (let at = 0; at < pcm.byteLength; at += frame) {
    send(pcm.subarray(at, at + frame));
    await new Promise((resolveFrame) => setTimeout(resolveFrame, 100));
  }
  return performance.now();
}

async function quietFor(last: () => number, quietMs: number, limitMs: number): Promise<void> {
  const started = performance.now();
  while (performance.now() - last() < quietMs && performance.now() - started < limitMs) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/** PCM16 16 kHz mono from a WAV file, refused rather than resampled when it is anything else. */
export function pcmFromWav(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (offset: number): string => String.fromCharCode(...file.subarray(offset, offset + 4));
  if (file.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let format: { channels: number; rate: number; bits: number } | undefined;
  while (offset + 8 <= file.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") format = { channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === "data") {
      if (format === undefined || format.channels !== 1 || format.rate !== 16_000 || format.bits !== 16) {
        throw new Error("the recording must be PCM16, 16 kHz, mono");
      }
      return file.subarray(body, Math.min(file.byteLength, body + size));
    }
    offset = body + size + (size % 2);
  }
  throw new Error("the WAV file has no data chunk");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}
