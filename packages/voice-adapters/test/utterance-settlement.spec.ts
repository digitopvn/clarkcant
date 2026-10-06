import type { RecognitionContext, RecognizedUtterance, SpeechRecognitionCapabilities, VoiceState } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { buildRecognitionContext } from "../src/coding-vocabulary.ts";
import type { SpeechRecognitionAdapter } from "../src/recognition.ts";
import {
  UtteranceAudioBuffer,
  type UtteranceRetry,
  focusContext,
  preferAlternative,
  recognizerRetry,
  settleUtterance,
  settleUtteranceNow,
} from "../src/utterance-settlement.ts";

/**
 * From a final recognition result to the canonical utterance: normalise, decide whether one utterance deserves a
 * second hearing, and keep the better reading by a fixed rule. Nothing here may ask a model to rewrite a sentence.
 */

const CONTEXT = buildRecognitionContext({ symbols: ["voiceSession", "voice_session"] });
const AUDIO = new Uint8Array([1, 2, 3, 4]);

function utterance(text: string, extra: Partial<RecognizedUtterance> = {}): RecognizedUtterance {
  return {
    voiceSessionId: "voice-1",
    utteranceId: "voice-1:s0",
    revision: 0,
    isFinal: true,
    text,
    provider: "fake",
    model: "fake-model",
    contextApplied: true,
    at: "2026-10-06T03:00:00.000Z" as never,
    sequence: 0,
    ...extra,
  };
}

const AMBIGUOUS = "đổi tên biến voice session cho rõ hơn";

describe("settling an utterance", () => {
  it("normalises a clear utterance without a retry, and records what changed", async () => {
    let called = 0;
    const settled = await settleUtterance({
      utterance: utterance("sửa lỗi stale closer trong use effect"),
      context: CONTEXT,
      audio: AUDIO,
      retry: async () => {
        called += 1;
        return undefined;
      },
    });
    expect(settled.text).toBe("sửa lỗi stale closure trong useEffect");
    expect(settled.heard).toBe("sửa lỗi stale closer trong use effect");
    expect(called).toBe(0);
    expect(settled.provenance.retry).toBeUndefined();
    expect(settled.provenance.normalization.map((change) => change.rule)).toEqual(["alias", "spacing"]);
    expect(settled.provenance).toMatchObject({ utteranceId: "voice-1:s0", provider: "fake", contextApplied: true, abstained: 0, termCount: CONTEXT.terms.length });
  });

  it("recognizes an ambiguous utterance again, focused on its candidates, and keeps the reading that resolves it", async () => {
    const seen: Array<{ reason: string; first: string | undefined; bytes: number }> = [];
    const retry: UtteranceRetry = async ({ audio, context, reason }) => {
      seen.push({ reason, first: context.terms[0]?.text, bytes: audio.byteLength });
      return "đổi tên biến voiceSession cho rõ hơn";
    };
    const settled = await settleUtterance({ utterance: utterance(AMBIGUOUS), context: CONTEXT, audio: AUDIO, retry });
    expect(settled.text).toBe("đổi tên biến voiceSession cho rõ hơn");
    expect(settled.provenance.retry).toEqual({ reason: "ambiguous-technical-span", outcome: "used-retry" });
    expect(settled.provenance.abstained).toBe(0);
    expect(seen).toEqual([{ reason: "ambiguous-technical-span", first: "voiceSession", bytes: 4 }]);
  });

  it("keeps the original when the retry heard a different sentence", async () => {
    const settled = await settleUtterance({
      utterance: utterance(AMBIGUOUS),
      context: CONTEXT,
      audio: AUDIO,
      retry: async () => "hôm nay mình đi ăn phở voiceSession nhé",
    });
    expect(settled.text).toBe(AMBIGUOUS);
    expect(settled.provenance.retry).toEqual({ reason: "ambiguous-technical-span", outcome: "kept-original" });
    expect(settled.provenance.abstained).toBe(1);
  });

  it("keeps the original when the retry fails or is too slow, and says so", async () => {
    const failed = await settleUtterance({
      utterance: utterance(AMBIGUOUS),
      context: CONTEXT,
      audio: AUDIO,
      retry: async () => {
        throw new Error("provider down");
      },
    });
    expect(failed.provenance.retry?.outcome).toBe("failed");

    const slow = await settleUtterance({
      utterance: utterance(AMBIGUOUS),
      context: CONTEXT,
      audio: AUDIO,
      retry: () => new Promise(() => undefined),
      retryTimeoutMs: 20,
    });
    expect(slow.text).toBe(AMBIGUOUS);
    expect(slow.provenance.retry?.outcome).toBe("failed");
  });

  it("reports a retry as unavailable when there is no audio or no retry, never as done", async () => {
    const noAudio = await settleUtterance({ utterance: utterance(AMBIGUOUS), context: CONTEXT, retry: async () => "x" });
    expect(noAudio.provenance.retry).toEqual({ reason: "ambiguous-technical-span", outcome: "unavailable" });
    const now = settleUtteranceNow({ utterance: utterance(AMBIGUOUS), context: CONTEXT });
    expect(now.provenance.retry).toEqual({ reason: "ambiguous-technical-span", outcome: "unavailable" });
    expect(now.text).toBe(AMBIGUOUS);
  });

  it("retries a technical span the provider was unsure of, and carries the provider's confidence through", async () => {
    const text = "sửa lỗi use effect trong ui state";
    const start = text.indexOf("use effect");
    const settled = await settleUtterance({
      utterance: utterance(text, { confidence: 0.8, spans: [{ start, end: start + "use effect".length, confidence: 0.3 }] }),
      context: CONTEXT,
      audio: AUDIO,
      retry: async () => "sửa lỗi use effect trong use state",
    });
    expect(settled.provenance.retry).toEqual({ reason: "low-confidence-technical-span", outcome: "used-retry" });
    expect(settled.text).toBe("sửa lỗi useEffect trong useState");
    expect(settled.provenance.confidence).toEqual({ utterance: 0.8, lowestSpan: 0.3, lowSpans: 1 });
  });

  it("does not retry an unsure span that is ordinary words", async () => {
    const text = "hôm nay trời đẹp";
    const settled = await settleUtterance({
      utterance: utterance(text, { spans: [{ start: 0, end: 3, confidence: 0.2 }] }),
      context: CONTEXT,
      audio: AUDIO,
      retry: async () => "x",
    });
    expect(settled.provenance.retry).toBeUndefined();
    expect(settled.provenance.confidence).toEqual({ lowestSpan: 0.2, lowSpans: 1 });
  });
});

describe("choosing between two readings", () => {
  it("keeps the original on a tie", () => {
    expect(preferAlternative(AMBIGUOUS, AMBIGUOUS, CONTEXT)).toBe(false);
    expect(preferAlternative(AMBIGUOUS, "", CONTEXT)).toBe(false);
  });

  it("puts the uncertain candidates first at full weight for the retry", () => {
    const focused = focusContext(CONTEXT, ["voice_session"]);
    expect(focused.terms[0]).toMatchObject({ text: "voice_session", weight: 1 });
    expect(focused.terms).toHaveLength(CONTEXT.terms.length);
    expect(focusContext(CONTEXT, [])).toBe(CONTEXT);
  });
});

describe("the utterance audio buffer", () => {
  it("keeps only the newest audio within its bound, and is empty after a take", () => {
    const buffer = new UtteranceAudioBuffer(6);
    buffer.push(new Uint8Array([1, 2, 3]));
    buffer.push(new Uint8Array([4, 5, 6]));
    buffer.push(new Uint8Array([7, 8]));
    expect(buffer.byteLength).toBeLessThanOrEqual(6);
    expect([...buffer.take()]).toEqual([4, 5, 6, 7, 8]);
    expect(buffer.byteLength).toBe(0);
    buffer.push(new Uint8Array(10));
    expect(buffer.byteLength).toBe(0);
  });

  it("copies what it keeps, so a reused frame buffer cannot change it", () => {
    const buffer = new UtteranceAudioBuffer();
    const frame = new Uint8Array([1, 2]);
    buffer.push(frame);
    frame[0] = 9;
    expect([...buffer.take()]).toEqual([1, 2]);
  });
});

class ScriptedRecognizer implements SpeechRecognitionAdapter {
  readonly provider = "scripted";
  readonly model = "scripted-model";
  readonly capabilities: SpeechRecognitionCapabilities = {
    provider: "scripted",
    model: "scripted-model",
    interimResults: true,
    languageDetection: false,
    confidence: "none",
    vocabulary: true,
    maxVocabularyTerms: 100,
    contextUpdate: "next-connection",
    utteranceRetry: true,
  };
  bytes = 0;
  stopped = false;
  context: RecognitionContext | undefined;
  readonly reply: string;
  #listener: ((utterance: RecognizedUtterance) => void) | undefined;
  constructor(reply: string) {
    this.reply = reply;
  }
  async start(input: { context?: RecognitionContext }): Promise<void> {
    this.context = input.context;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  sendAudio(frame: Uint8Array): void {
    this.bytes += frame.byteLength;
  }
  endAudio(): void {
    this.#listener?.(utterance("tạm", { isFinal: false }));
    this.#listener?.(utterance(this.reply));
  }
  setMuted(): void {}
  updateContext(): void {}
  onUtterance(listener: (utterance: RecognizedUtterance) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }
  onStateChange(listener: (state: VoiceState) => void): () => void {
    void listener;
    return () => undefined;
  }
}

describe("a recognizer as a retry", () => {
  it("feeds one utterance's audio to a fresh session, collects its final, and closes it", async () => {
    const recognizers: ScriptedRecognizer[] = [];
    const retry = recognizerRetry({
      createRecognizer: () => {
        const recognizer = new ScriptedRecognizer("đổi tên biến voiceSession");
        recognizers.push(recognizer);
        return recognizer;
      },
      tokenProvider: async () => "key",
      quietMs: 10,
    });
    const audio = new Uint8Array(3200 * 2 + 100);
    const heard = await retry({ audio, context: CONTEXT, reason: "ambiguous-technical-span" });

    expect(heard).toBe("đổi tên biến voiceSession");
    expect(recognizers).toHaveLength(1);
    expect(recognizers[0]?.bytes).toBe(audio.byteLength);
    expect(recognizers[0]?.context).toBe(CONTEXT);
    expect(recognizers[0]?.stopped).toBe(true);
  });

  it("answers nothing when the recognizer heard nothing", async () => {
    const retry = recognizerRetry({ createRecognizer: () => new ScriptedRecognizer("  "), tokenProvider: async () => "key", quietMs: 10 });
    expect(await retry({ audio: AUDIO, context: CONTEXT, reason: "ambiguous-technical-span" })).toBeUndefined();
  });
});
