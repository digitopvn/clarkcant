import { describe, expect, it } from "vitest";

import {
  DEFAULT_TTS_MODEL,
  GEMINI_INTERACTIONS_ENDPOINT,
  GEMINI_TTS_FLASH_LITE_MODEL,
  GEMINI_TTS_FLASH_MODEL,
  GeminiTtsClient,
  type FetchLike,
} from "../src/gemini-tts.ts";

const SAMPLE_AUDIO_BASE64 = Buffer.from("fake-clip-bytes").toString("base64");

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
    expect(Buffer.from(result.audio).toString()).toBe("fake-clip-bytes");
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
        { outputs: [{ type: "audio", data: Buffer.from("first").toString("base64"), mime_type: "audio/wav" }] },
        { outputs: [{ type: "audio", data: Buffer.from("second").toString("base64"), mime_type: "audio/wav" }] },
      ],
    });
    const client = new GeminiTtsClient({ fetch });

    const result = await client.synthesize("test-key", { text: "hello" });

    expect(Buffer.from(result.audio).toString()).toBe("second");
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
