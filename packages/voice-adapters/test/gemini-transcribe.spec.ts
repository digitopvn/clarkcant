import type { RecognizedUtterance, VoiceState } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { buildRecognitionContext } from "../src/coding-vocabulary.ts";
import type { LiveSocket } from "../src/gemini-live.ts";
import {
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  GEMINI_TRANSCRIBE_MAX_VOCABULARY,
  GeminiTranscribeLiveAdapter,
  buildTranscribeSetupMessage,
  parseTranscribeMessage,
  transcribeVocabulary,
} from "../src/gemini-transcribe.ts";
import { containsCredential } from "../src/protocol.ts";

/**
 * The dedicated recognizer against protocol fixtures shaped like the documented Live transcription messages.
 *
 * No network and no key: the transport is injected, so the real mapping code runs. Whether the provider answers like
 * this in practice is the live validation gate, which these tests do not claim to pass.
 */

class FakeSocket implements LiveSocket {
  readonly sent: string[] = [];
  closed = false;
  #onOpen: (() => void) | undefined;
  #onMessage: ((payload: string) => void) | undefined;
  #onClose: ((info: { code: number; reason: string }) => void) | undefined;
  #onError: ((message: string) => void) | undefined;

  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(listener: () => void): void {
    this.#onOpen = listener;
  }
  onMessage(listener: (payload: string) => void): void {
    this.#onMessage = listener;
  }
  onClose(listener: (info: { code: number; reason: string }) => void): void {
    this.#onClose = listener;
  }
  onError(listener: (message: string) => void): void {
    this.#onError = listener;
  }

  open(): void {
    this.#onOpen?.();
  }
  deliver(frame: unknown): void {
    this.#onMessage?.(JSON.stringify(frame));
  }
  fail(message: string): void {
    this.#onError?.(message);
  }
  drop(code = 1006, reason = ""): void {
    this.#onClose?.({ code, reason });
  }
  sentObjects(): Array<Record<string, unknown>> {
    return this.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
  }
}

const CREDENTIAL = "test-transcribe-credential";
const CONTEXT = buildRecognitionContext({ symbols: ["useVoiceSession"], packages: ["@clarkcant/voice-adapters"] });

function harness(options: { maxReopens?: number; setupTimeoutMs?: number; carryTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  let created: (() => void) | undefined;
  const adapter = new GeminiTranscribeLiveAdapter({
    createSocket: (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      urls.push(url);
      created?.();
      return socket;
    },
    ...options,
  });
  const utterances: RecognizedUtterance[] = [];
  const states: VoiceState[] = [];
  adapter.onUtterance((utterance) => utterances.push(utterance));
  adapter.onStateChange((state) => states.push(state));
  const nextSocket = (): Promise<FakeSocket> =>
    new Promise((resolve) => {
      const count = sockets.length;
      created = () => resolve(sockets[count]!);
    });
  return { adapter, sockets, urls, utterances, states, nextSocket };
}

async function started(options: { maxReopens?: number; carryTimeoutMs?: number } = {}) {
  const h = harness(options);
  const socketCreated = h.nextSocket();
  const starting = h.adapter.start({ sessionId: "voice-1", tokenProvider: async () => CREDENTIAL, context: CONTEXT });
  const socket = await socketCreated;
  socket.open();
  socket.deliver({ setupComplete: {} });
  await starting;
  return { ...h, socket };
}

describe("the transcription setup", () => {
  it("asks for verbatim transcription with automatic language detection and the session vocabulary", () => {
    const setup = buildTranscribeSetupMessage({ vocabulary: ["useVoiceSession"] });
    expect(setup).toEqual({
      setup: {
        model: `models/${GEMINI_TRANSCRIBE_LIVE_MODEL}`,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: { languageCodes: [], customVocabulary: ["useVoiceSession"], mode: "VERBATIM" },
        realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      },
    });
  });

  it("sends canonical spellings only, most relevant first, never an alias, and never more than the bound", () => {
    const words = transcribeVocabulary(CONTEXT);
    expect(words.length).toBeLessThanOrEqual(GEMINI_TRANSCRIBE_MAX_VOCABULARY);
    expect(words).toContain("useVoiceSession");
    expect(words).toContain("pnpm");
    // "pnp m" is a known mis-hearing of pnpm: biasing towards it would be the opposite of the point.
    expect(words).not.toContain("pnp m");
    expect(words.indexOf("useVoiceSession")).toBeLessThan(words.indexOf("Electron"));
    expect(transcribeVocabulary(undefined)).toEqual([]);
    expect(transcribeVocabulary(CONTEXT, 3)).toHaveLength(3);
  });
});

describe("reading the provider's messages", () => {
  it("reads an interim hypothesis, a final utterance, readiness and an error", () => {
    expect(parseTranscribeMessage(JSON.stringify({ setupComplete: {} }))).toEqual([{ kind: "ready" }]);
    expect(parseTranscribeMessage(JSON.stringify({ serverContent: { interimInputTranscription: { text: "sửa lỗi" } } }))).toEqual([
      { kind: "interim", text: "sửa lỗi" },
    ]);
    expect(parseTranscribeMessage(JSON.stringify({ serverContent: { inputTranscription: { text: "sửa lỗi useEffect" } } }))).toEqual([
      { kind: "final", text: "sửa lỗi useEffect" },
    ]);
    expect(parseTranscribeMessage(JSON.stringify({ error: { message: "quota" } }))).toEqual([{ kind: "providerError", message: "quota" }]);
  });

  it("reports an unknown frame by its keys rather than dropping it, and stays quiet about known bookkeeping", () => {
    expect(parseTranscribeMessage(JSON.stringify({ somethingNew: {} }))).toEqual([{ kind: "unrecognised", keys: ["somethingNew"] }]);
    expect(parseTranscribeMessage("not json")).toEqual([{ kind: "unrecognised", keys: ["unparseable"] }]);
    expect(parseTranscribeMessage(JSON.stringify({ usageMetadata: {} }))).toEqual([]);
    expect(parseTranscribeMessage(JSON.stringify({ serverContent: { turnComplete: true } }))).toEqual([]);
  });
});

describe("a transcription session", () => {
  it("keeps the credential in the connection URL and out of every message body", async () => {
    const { socket, urls, adapter } = await started();
    adapter.sendAudio(new Uint8Array([1, 2, 3, 4]));

    expect(urls[0]).toContain(`key=${CREDENTIAL}`);
    for (const payload of socket.sent) expect(containsCredential(payload, CREDENTIAL)).toBe(false);
    const setup = socket.sentObjects()[0]?.["setup"] as Record<string, unknown>;
    expect((setup["inputAudioTranscription"] as Record<string, unknown>)["customVocabulary"]).toContain("useVoiceSession");
  });

  it("reports interim revisions and then one final per utterance, with fresh ids for the next", async () => {
    const { socket, utterances } = await started();
    socket.deliver({ serverContent: { interimInputTranscription: { text: "sửa" } } });
    socket.deliver({ serverContent: { interimInputTranscription: { text: "sửa lỗi use effect" } } });
    socket.deliver({ serverContent: { inputTranscription: { text: "sửa lỗi useEffect" } } });
    socket.deliver({ serverContent: { inputTranscription: { text: "chạy pnpm test" } } });

    expect(utterances.map((utterance) => [utterance.utteranceId, utterance.revision, utterance.isFinal, utterance.text])).toEqual([
      ["voice-1:s0", 0, false, "sửa"],
      ["voice-1:s0", 1, false, "sửa lỗi use effect"],
      ["voice-1:s0", 2, true, "sửa lỗi useEffect"],
      ["voice-1:s1", 0, true, "chạy pnpm test"],
    ]);
    expect(utterances[2]).toMatchObject({ settledBy: "provider", contextApplied: true, provider: "gemini-transcribe" });
    // Nothing the provider does not report is invented.
    expect(utterances[2]?.confidence).toBeUndefined();
    expect(utterances[2]?.languages).toBeUndefined();
  });

  it("finalizes on the pause signal and refuses audio while muted", async () => {
    const { socket, adapter } = await started();
    adapter.setMuted(true);
    adapter.sendAudio(new Uint8Array([1, 2]));
    adapter.setMuted(false);
    adapter.sendAudio(new Uint8Array([3, 4]));
    adapter.endAudio();

    const sent = socket.sentObjects();
    expect(sent.filter((message) => message["realtimeInput"] !== undefined && "audio" in (message["realtimeInput"] as object))).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(adapter.audioFrameCounts).toEqual({ sent: 1, dropped: 1 });
  });

  it("carries a sentence across a reopen as one utterance, with the audio said meanwhile", async () => {
    const { socket, adapter, utterances, nextSocket, states } = await started();
    socket.deliver({ serverContent: { interimInputTranscription: { text: "mở file index" } } });
    const reopened = nextSocket();
    // A close after a working session is the provider's ten-minute limit: the recognizer reopens with its context.
    socket.drop(1000, "session limit");

    // Half a sentence is not dispatched as if it were finished.
    expect(utterances.filter((utterance) => utterance.isFinal)).toEqual([]);
    expect(states.at(-1)).toBe("reconnecting");
    adapter.sendAudio(new Uint8Array([5, 6]));
    adapter.sendAudio(new Uint8Array([7, 8]));

    const second = await reopened;
    second.open();
    second.deliver({ setupComplete: {} });
    expect(second.sentObjects()[0]?.["setup"]).toBeDefined();
    // The words said while it reopened reach the new session rather than being dropped.
    expect(second.sentObjects().filter((message) => message["realtimeInput"] !== undefined)).toHaveLength(2);
    expect(adapter.audioFrameCounts.dropped).toBe(0);

    second.deliver({ serverContent: { interimInputTranscription: { text: "chấm ts" } } });
    second.deliver({ serverContent: { inputTranscription: { text: "chấm ts giúp tui" } } });
    expect(utterances.map((utterance) => [utterance.utteranceId, utterance.isFinal, utterance.text])).toEqual([
      ["voice-1:s0", false, "mở file index"],
      ["voice-1:s0", false, "mở file index chấm ts"],
      ["voice-1:s0", true, "mở file index chấm ts giúp tui"],
    ]);
  });

  it("finalizes a carried sentence on its own when the session ended exactly as the sentence did", async () => {
    const { socket, utterances, nextSocket } = await started({ carryTimeoutMs: 20 });
    socket.deliver({ serverContent: { interimInputTranscription: { text: "chạy pnpm test" } } });
    const reopened = nextSocket();
    socket.drop(1000, "session limit");
    const second = await reopened;
    second.open();
    second.deliver({ setupComplete: {} });

    // Nothing more is said: the carried words are the whole sentence, not the start of the next one.
    await new Promise((resolve) => setTimeout(resolve, 60));
    second.deliver({ serverContent: { inputTranscription: { text: "mở file index" } } });
    expect(utterances.filter((utterance) => utterance.isFinal).map((utterance) => [utterance.utteranceId, utterance.text, utterance.settledBy])).toEqual([
      ["voice-1:s0", "chạy pnpm test", "session-end"],
      ["voice-1:s1", "mở file index", "provider"],
    ]);
  });

  it("does not finalize a carried sentence the reopened session goes on with", async () => {
    const { socket, utterances, nextSocket } = await started({ carryTimeoutMs: 20 });
    socket.deliver({ serverContent: { interimInputTranscription: { text: "mở file" } } });
    const reopened = nextSocket();
    socket.drop(1000, "session limit");
    const second = await reopened;
    second.open();
    second.deliver({ setupComplete: {} });
    second.deliver({ serverContent: { interimInputTranscription: { text: "index" } } });

    await new Promise((resolve) => setTimeout(resolve, 60));
    second.deliver({ serverContent: { inputTranscription: { text: "index chấm ts" } } });
    expect(utterances.filter((utterance) => utterance.isFinal).map((utterance) => utterance.text)).toEqual(["mở file index chấm ts"]);
  });

  it("leaves an unfinished hypothesis as the last interim, not a final, when recognition cannot continue", async () => {
    const { socket, utterances, states } = await started({ maxReopens: 0 });
    socket.deliver({ serverContent: { interimInputTranscription: { text: "mở file" } } });
    socket.drop(1011, "internal");
    expect(states.at(-1)).toBe("failed");
    expect(utterances.map((utterance) => utterance.isFinal)).toEqual([false]);
  });

  it("gives up on a setup that never completes, within its bound", async () => {
    const h = harness({ setupTimeoutMs: 20 });
    const created = h.nextSocket();
    const starting = h.adapter.start({ sessionId: "voice-5", tokenProvider: async () => CREDENTIAL });
    const socket = await created;
    socket.open();
    await expect(starting).rejects.toThrow("did not complete within 20 ms");
    expect(socket.closed).toBe(true);
    expect(h.adapter.state).toBe("failed");
  });

  it("releases a start still waiting for setup when it is stopped", async () => {
    const h = harness();
    const created = h.nextSocket();
    const starting = h.adapter.start({ sessionId: "voice-6", tokenProvider: async () => CREDENTIAL });
    const socket = await created;
    await h.adapter.stop();
    await expect(starting).rejects.toThrow("stopped before it was listening");
    expect(socket.closed).toBe(true);
  });

  it("fails rather than reopening forever when the provider keeps closing", async () => {
    const { socket, states } = await started({ maxReopens: 0 });
    socket.drop(1011, "internal");
    expect(states.at(-1)).toBe("failed");
  });

  it("rejects the start when the provider refuses the setup, and when the socket closes before it", async () => {
    const refused = harness();
    const created = refused.nextSocket();
    const starting = refused.adapter.start({ sessionId: "voice-2", tokenProvider: async () => CREDENTIAL });
    const socket = await created;
    socket.open();
    socket.deliver({ error: { message: "model not found" } });
    await expect(starting).rejects.toThrow("model not found");
    expect(refused.adapter.state).toBe("failed");

    const dropped = harness();
    const createdAgain = dropped.nextSocket();
    const startingAgain = dropped.adapter.start({ sessionId: "voice-3", tokenProvider: async () => CREDENTIAL });
    (await createdAgain).drop(1008, "policy");
    await expect(startingAgain).rejects.toThrow("closed before setup");
  });

  it("refuses an empty credential without opening anything", async () => {
    const h = harness();
    await expect(h.adapter.start({ sessionId: "voice-4", tokenProvider: async () => "" })).rejects.toThrow("no credential");
    expect(h.sockets).toHaveLength(0);
  });

  it("stops cleanly and does not reopen after a stop", async () => {
    const { socket, adapter, sockets } = await started();
    await adapter.stop();
    socket.drop(1000, "");
    expect(socket.closed).toBe(true);
    expect(adapter.state).toBe("ended");
    expect(sockets).toHaveLength(1);
  });

  it("describes what it can do without claiming confidence or language it does not report", () => {
    const { adapter } = harness();
    expect(adapter.capabilities).toMatchObject({ interimResults: true, confidence: "none", languageDetection: false, vocabulary: true });
  });
});
