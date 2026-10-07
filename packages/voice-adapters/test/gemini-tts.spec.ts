import { describe, expect, it } from "vitest";

import {
  DEFAULT_TTS_MODEL,
  GEMINI_INTERACTIONS_ENDPOINT,
  GEMINI_TTS_FLASH_LITE_MODEL,
  GEMINI_TTS_FLASH_MODEL,
  GeminiTtsClient,
  readSampleRate,
  type FetchLike,
} from "../src/gemini-tts.ts";

/** A PCM16 mono WAV clip at `rate`, with optional chunks placed before `fmt ` the way some encoders write them. */
function wav(rate: number, samples: Buffer, leadingChunks: Buffer[] = []): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(samples.length, 4);
  const body = Buffer.concat([...leadingChunks, fmt, data, samples]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

const SAMPLE_WAV = wav(24000, Buffer.from("fake-clip-bytes"));
const SAMPLE_AUDIO_BASE64 = SAMPLE_WAV.toString("base64");

function fetchReturning(payload: unknown, options: { ok?: boolean; status?: number; bodyText?: string } = {}): {
  fetch: FetchLike;
  calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }>;
} {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: async () => payload,
      text: async () => options.bodyText ?? JSON.stringify(payload),
    };
  };
  return { fetch, calls };
}

describe("GeminiTtsClient", () => {
  it("defaults to the flash-lite model and posts to the Interactions endpoint", async () => {
    const { fetch, calls } = fetchReturning({
      status: "completed",
      steps: [{ outputs: [{ type: "audio", data: SAMPLE_AUDIO_BASE64, mime_type: "audio/wav" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    const result = await client.synthesize("test-key", { text: "Have a wonderful day!" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GEMINI_INTERACTIONS_ENDPOINT);
    expect(calls[0]?.init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
    expect(body["model"]).toBe(DEFAULT_TTS_MODEL);
    expect(DEFAULT_TTS_MODEL).toBe(GEMINI_TTS_FLASH_LITE_MODEL);
    expect(result.mimeType).toBe("audio/wav");
    expect(result.sampleRateHz).toBe(24000);
    expect(Buffer.from(result.audio).equals(SAMPLE_WAV)).toBe(true);
  });

  it("selects the high-fidelity model, a voice and a style annotation when asked", async () => {
    const { fetch, calls } = fetchReturning({
      steps: [{ outputs: [{ type: "audio", data: SAMPLE_AUDIO_BASE64, mime_type: "audio/wav" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    await client.synthesize("test-key", {
      text: "Have a wonderful day!",
      model: GEMINI_TTS_FLASH_MODEL,
      voice: "Kore",
      style: "cheerful and friendly",
      sampleRateHz: 16000,
    });

    const body = JSON.parse(calls[0]!.init.body) as {
      model: string;
      input: Array<{ content: Array<{ annotations?: Array<{ style: string }> }> }>;
      response_format: { sample_rate: number };
      generation_config: { speech_config: Array<{ voice: string }> };
    };
    expect(body.model).toBe(GEMINI_TTS_FLASH_MODEL);
    expect(body.input[0]?.content[0]?.annotations?.[0]?.style).toBe("cheerful and friendly");
    expect(body.response_format.sample_rate).toBe(16000);
    expect(body.generation_config.speech_config[0]?.voice).toBe("Kore");
  });

  it("never embeds the API key in the request body", async () => {
    const { fetch, calls } = fetchReturning({
      steps: [{ outputs: [{ type: "audio", data: SAMPLE_AUDIO_BASE64, mime_type: "audio/wav" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    await client.synthesize("super-secret-key", { text: "hello" });

    expect(calls[0]!.init.body.includes("super-secret-key")).toBe(false);
  });

  it("takes the last audio block when the response nests more than one", async () => {
    const { fetch } = fetchReturning({
      steps: [
        { outputs: [{ type: "audio", data: Buffer.from("first").toString("base64"), mime_type: "audio/L16;rate=24000" }] },
        { outputs: [{ type: "audio", data: Buffer.from("second").toString("base64"), mime_type: "audio/L16;rate=24000" }] },
      ],
    });
    const client = new GeminiTtsClient({ fetch });

    const result = await client.synthesize("test-key", { text: "hello" });

    expect(Buffer.from(result.audio).toString()).toBe("second");
  });

  it("returns the rate the provider actually sent when it differs from the one requested", async () => {
    const { fetch, calls } = fetchReturning({
      steps: [{ outputs: [{ type: "audio", data: wav(24000, Buffer.alloc(480)).toString("base64"), mime_type: "audio/wav" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    const result = await client.synthesize("test-key", { text: "hello", sampleRateHz: 16000 });

    const body = JSON.parse(calls[0]!.init.body) as { response_format: { sample_rate: number } };
    expect(body.response_format.sample_rate).toBe(16000);
    expect(result.sampleRateHz).toBe(24000);
  });

  it("reads the rate from a raw PCM mime type's rate parameter", async () => {
    const { fetch } = fetchReturning({
      steps: [{ outputs: [{ type: "audio", data: Buffer.alloc(320).toString("base64"), mime_type: "audio/L16;codec=pcm;rate=24000" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    const result = await client.synthesize("test-key", { text: "hello", sampleRateHz: 16000 });

    expect(result.mimeType).toBe("audio/L16;codec=pcm;rate=24000");
    expect(result.sampleRateHz).toBe(24000);
  });

  it("reads a WAV rate when other chunks precede the format chunk", async () => {
    const list = Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc"), Buffer.alloc(1)]);
    const { fetch } = fetchReturning({
      steps: [{ outputs: [{ type: "audio", data: wav(16000, Buffer.alloc(320), [list]).toString("base64"), mime_type: "audio/wav" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    const result = await client.synthesize("test-key", { text: "hello" });

    expect(result.sampleRateHz).toBe(16000);
  });

  it("refuses audio whose sample rate it cannot read rather than letting a caller guess", async () => {
    const { fetch } = fetchReturning({
      steps: [{ outputs: [{ type: "audio", data: Buffer.from("not a wav").toString("base64"), mime_type: "audio/wav" }] }],
    });
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("test-key", { text: "hello" })).rejects.toThrow(/sample rate could not be read/);
  });

  it("rejects an empty API key without making a request", async () => {
    const { fetch, calls } = fetchReturning({});
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("", { text: "hello" })).rejects.toThrow(/API key/);
    expect(calls).toHaveLength(0);
  });

  it("rejects empty text without making a request", async () => {
    const { fetch, calls } = fetchReturning({});
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("test-key", { text: "   " })).rejects.toThrow(/empty text/);
    expect(calls).toHaveLength(0);
  });

  it("rejects text that cannot fit the input token limit without making a request", async () => {
    const { fetch, calls } = fetchReturning({});
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("test-key", { text: "a".repeat(8192 * 4 + 1) })).rejects.toThrow(/input limit/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unsupported sample rate without making a request", async () => {
    const { fetch, calls } = fetchReturning({});
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("test-key", { text: "hello", sampleRateHz: 44100 as never })).rejects.toThrow(
      /sample rate/,
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces a failed HTTP response with status and truncated body, never throwing raw", async () => {
    const { fetch } = fetchReturning({ error: "quota exceeded" }, { ok: false, status: 429, bodyText: "quota exceeded" });
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("test-key", { text: "hello" })).rejects.toThrow(/429/);
  });

  it("reports a response with no audio content block rather than returning empty bytes", async () => {
    const { fetch } = fetchReturning({ steps: [{ outputs: [{ type: "text", text: "no audio here" }] }] });
    const client = new GeminiTtsClient({ fetch });

    await expect(client.synthesize("test-key", { text: "hello" })).rejects.toThrow(/no audio/);
  });

  it("throws at construction when no fetch implementation is available", () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error -- deliberately removing the ambient fetch to exercise the guard
    delete globalThis.fetch;
    try {
      expect(() => new GeminiTtsClient({})).toThrow(/no fetch implementation/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("readSampleRate", () => {
  const pcm = new Uint8Array(320);

  it("refuses a zero, fractional or implausibly large rate", () => {
    expect(readSampleRate("audio/L16;rate=0", pcm)).toBeUndefined();
    expect(readSampleRate("audio/L16;rate=24000.5", pcm)).toBeUndefined();
    expect(readSampleRate("audio/L16;rate=99999999999999999999", pcm)).toBeUndefined();
    expect(readSampleRate("audio/L16;rate=384001", pcm)).toBeUndefined();
    expect(readSampleRate("audio/wav", wav(0, Buffer.alloc(320)))).toBeUndefined();
    expect(readSampleRate("audio/wav", wav(500000, Buffer.alloc(320)))).toBeUndefined();
  });

  it("trusts the WAV header over a conflicting mime rate", () => {
    expect(readSampleRate("audio/wav;rate=16000", wav(24000, Buffer.alloc(320)))).toBe(24000);
  });

  it("uses the mime rate for headerless PCM", () => {
    expect(readSampleRate("audio/L16;codec=pcm;rate=16000", pcm)).toBe(16000);
  });

  it("falls back to the mime rate when a WAV is truncated before its format chunk", () => {
    const truncated = wav(24000, Buffer.alloc(320)).subarray(0, 20);
    expect(readSampleRate("audio/wav;rate=16000", truncated)).toBe(16000);
  });
});
