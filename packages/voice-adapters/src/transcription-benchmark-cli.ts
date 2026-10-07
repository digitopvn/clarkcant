import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { GeminiLiveAdapter } from "./gemini-live.ts";
import { GeminiTranscribeLiveAdapter } from "./gemini-transcribe.ts";
import {
  type BenchmarkCorpus,
  benchmarkRecognizer,
  corpusContext,
  formatBenchmarkReport,
  parseCorpus,
  recognizersIn,
} from "./transcription-benchmark.ts";

/**
 * Run the transcription benchmark.
 *
 *   node packages/voice-adapters/src/transcription-benchmark-cli.ts
 *     Scores every recognizer output already in the corpus, raw and normalised. No network, no credential.
 *
 *   node packages/voice-adapters/src/transcription-benchmark-cli.ts --audio <manifest.json> --recognizer <id>
 *     Recognizes real recordings with a real provider first, then scores them beside the corpus outputs. The manifest
 *     is `{ "entries": [{ "id": "u001", "wav": "u001.wav" }] }`, paths relative to the manifest, each a PCM16 16 kHz
 *     mono WAV of the corpus utterance with that id. Recognizers: `gemini-transcribe-live` (dedicated, with the
 *     corpus vocabulary) and `gemini-live` (the conversational baseline's input transcription). The key is read from
 *     GEMINI_API_KEY and never printed; without one the run stops and says which gate is missing.
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

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string" },
      audio: { type: "string" },
      recognizer: { type: "string" },
    },
  });
  const corpus = parseCorpus(JSON.parse(readFileSync(values.corpus ?? DEFAULT_CORPUS, "utf8")));

  if (values.audio !== undefined) {
    const id = values.recognizer ?? "gemini-transcribe-live";
    const recognize = AUDIO_RECOGNIZERS[id];
    if (recognize === undefined) {
      process.stderr.write(`unknown recognizer ${id}; known: ${Object.keys(AUDIO_RECOGNIZERS).join(", ")}\n`);
      return 1;
    }
    const apiKey = process.env["GEMINI_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      process.stderr.write("external gate: GEMINI_API_KEY is not configured, so no audio was recognized\n");
      return 2;
    }
    const manifestPath = resolve(values.audio);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entries?: Array<{ id?: unknown; wav?: unknown }> };
    const latencies: number[] = [];
    for (const entry of manifest.entries ?? []) {
      if (typeof entry.id !== "string" || typeof entry.wav !== "string") throw new Error("manifest entries need a string id and wav");
      const utterance = corpus.utterances.find((item) => item.id === entry.id);
      if (utterance === undefined) throw new Error(`manifest names ${entry.id}, which is not in the corpus`);
      const pcm = pcmFromWav(readFileSync(resolve(dirname(manifestPath), entry.wav)));
      const heard = await recognize(pcm, apiKey, corpus);
      utterance.recognizers[`${id}-audio`] = heard.text === "" ? "(nothing recognized)" : heard.text;
      latencies.push(heard.finalizeMs);
    }
    latencies.sort((left, right) => left - right);
    const quantile = (q: number): string => (latencies.length === 0 ? "-" : `${Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!)} ms`);
    process.stdout.write(`Finalization after end of audio: p50 ${quantile(0.5)}, p95 ${quantile(0.95)} over ${latencies.length} recordings.\n\n`);
  }

  const context = corpusContext(corpus);
  const results = recognizersIn(corpus).map((recognizer) => benchmarkRecognizer(corpus, recognizer, context));
  process.stdout.write(`${formatBenchmarkReport(corpus, results)}\n`);
  return 0;
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
