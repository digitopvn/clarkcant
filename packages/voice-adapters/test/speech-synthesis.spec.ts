import { describe, expect, it } from "vitest";

import { DEFAULT_TTS_MODEL, type FetchLike, GEMINI_TTS_FLASH_MODEL, GeminiTtsSynthesisAdapter } from "../src/gemini-tts.ts";
import type { SpeechSynthesisAdapter } from "../src/recognition.ts";

/**
 * The synthesis seam: one request, one clip, with the credential asked for at call time.
 */

function recordingFetch(): { fetch: FetchLike; bodies: Array<Record<string, unknown>>; keys: string[] } {
  const bodies: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    keys.push(init.headers["x-goog-api-key"] ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ steps: [{ outputs: [{ type: "audio", data: Buffer.from("clip").toString("base64"), mime_type: "audio/wav" }] }] }),
      text: async () => "",
    };
  };
  return { fetch, bodies, keys };
}

describe("speech synthesis through the Gemini TTS seam", () => {
  it("asks for the credential per call, uses the configured model, and returns the clip", async () => {
    const { fetch, bodies, keys } = recordingFetch();
    let asked = 0;
    const synthesis: SpeechSynthesisAdapter = new GeminiTtsSynthesisAdapter({ fetch, model: GEMINI_TTS_FLASH_MODEL });

    const clip = await synthesis.synthesize({
      text: "Xin chào",
      voice: "Kore",
      tokenProvider: async () => {
        asked += 1;
        return "per-call-key";
      },
    });

    expect(synthesis.provider).toBe("gemini-tts");
    expect(asked).toBe(1);
    expect(keys).toEqual(["per-call-key"]);
    expect(bodies[0]?.["model"]).toBe(GEMINI_TTS_FLASH_MODEL);
    expect(JSON.stringify(bodies[0])).not.toContain("per-call-key");
    expect(clip.mimeType).toBe("audio/wav");
    expect(Buffer.from(clip.audio).toString()).toBe("clip");
  });

  it("defaults to the pinned model", async () => {
    const { fetch, bodies } = recordingFetch();
    await new GeminiTtsSynthesisAdapter({ fetch }).synthesize({ text: "hi", tokenProvider: async () => "k" });
    expect(bodies[0]?.["model"]).toBe(DEFAULT_TTS_MODEL);
  });
});
