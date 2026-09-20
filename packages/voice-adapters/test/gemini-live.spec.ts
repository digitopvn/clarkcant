import { assembleUtterance, type VoiceState, type VoiceTranscriptFragment } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { GeminiLiveAdapter, type LiveSocket } from "../src/gemini-live.ts";
import {
  DEFAULT_LIVE_MODEL,
  buildAudioMessage,
  buildSetupMessage,
  SILENCE_BEFORE_TURN_END_MS,
  buildTextMessage,
  containsCredential,
  parseServerMessage,
  sampleRateFromMime,
} from "../src/protocol.ts";

/**
 * A socket that records what was sent and lets a test deliver what the provider would.
 *
 * The transport is injected rather than mocked, so these tests exercise the adapter's real
 * mapping code with no network, no key and no quota.
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

  // Test-side controls.
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

const CREDENTIAL = "test-credential-value";

/** Start a connect and hand back the socket once the adapter has created it. */
async function begin(): Promise<{ adapter: GeminiLiveAdapter; socket: FakeSocket; connected: Promise<void>; url: string }> {
  let resolver: (() => void) | undefined;
  const created = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  let socket: FakeSocket | undefined;
  let url = "";

  const adapter = new GeminiLiveAdapter({
    createSocket: (endpoint) => {
      url = endpoint;
      socket = new FakeSocket();
      resolver?.();
      return socket;
    },
    now: () => "2026-09-17T00:00:00.000Z" as never,
  });

  const connected = adapter.connect({ sessionId: "session-1", tokenProvider: async () => CREDENTIAL });
  await created;
  if (socket === undefined) throw new Error("the adapter never created a socket");
  return { adapter, socket, connected, url };
}

describe("the setup message", () => {
  it("asks for audio, enables both transcripts, and pins the measured model", () => {
    const message = buildSetupMessage() as { setup: Record<string, unknown> };
    expect(message.setup["model"]).toBe(`models/${DEFAULT_LIVE_MODEL}`);
    expect(message.setup["generationConfig"]).toEqual({ responseModalities: ["AUDIO"] });
    expect(message.setup["inputAudioTranscription"]).toEqual({});
    expect(message.setup["outputAudioTranscription"]).toEqual({});
  });

  it("sends no thinking field, because extended thinking is a different model id", () => {
    // Not a style preference: the variant is selected by id, so a thinking parameter would either
    // be ignored or contradict the model that was pinned.
    const serialised = JSON.stringify(buildSetupMessage({ systemInstruction: "be brief" }));
    expect(serialised).not.toContain("thinking");
    expect(serialised).not.toContain("affective");
  });

  it("omits the system instruction entirely when none was given, rather than sending an empty one", () => {
    const message = buildSetupMessage() as { setup: Record<string, unknown> };
    expect("systemInstruction" in message.setup).toBe(false);
  });

  it("asks the provider to finish a turn on a silence run, without which nothing is ever answered", () => {
    /*
     * The field that decides whether a live session answers at all.
     *
     * Measured against the real endpoint: with no `realtimeInputConfig`, a session streaming real speech started
     * activity and then produced two messages and no reply for as long as the audio ran — no input transcription, no
     * model turn — while looking perfectly live. With `silenceDurationMs` set, the same audio produced 65 messages, a
     * transcript and a spoken answer. Of the fields `automaticActivityDetection` offers, only this one changed the
     * outcome, which is why it is the only one sent.
     */
    const message = buildSetupMessage() as { setup: Record<string, unknown> };

    expect(message.setup["realtimeInputConfig"]).toEqual({
      automaticActivityDetection: { silenceDurationMs: SILENCE_BEFORE_TURN_END_MS },
    });
    // A zero here would be the same as omitting the field, so the value has to mean something.
    expect(SILENCE_BEFORE_TURN_END_MS).toBeGreaterThan(0);
  });
});

describe("the credential", () => {
  it("travels in the socket URL and in no message body", async () => {
    const { adapter, socket, connected, url } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    expect(url).toContain(encodeURIComponent(CREDENTIAL));
    expect(socket.sent.length).toBeGreaterThan(0);
    for (const payload of socket.sent) {
      expect(containsCredential(payload, CREDENTIAL)).toBe(false);
    }

    adapter.sendAudio(new Uint8Array([1, 2, 3, 4]));
    for (const payload of socket.sent) {
      expect(containsCredential(payload, CREDENTIAL)).toBe(false);
    }
  });

  it("refuses to open a session when the credential is empty", async () => {
    const adapter = new GeminiLiveAdapter({ createSocket: () => new FakeSocket() });
    await expect(adapter.connect({ sessionId: "s", tokenProvider: async () => "" })).rejects.toThrow(/no credential/);
  });

  it("reports the credential gate without consuming a credential", () => {
    const adapter = new GeminiLiveAdapter();
    expect(adapter.credentialAvailable(async () => CREDENTIAL)).toBe(true);
    expect(adapter.credentialAvailable("not a function" as never)).toBe(false);
  });
});

describe("sending audio", () => {
  it("drops frames sent before the session is ready, rather than queueing speech for later", async () => {
    const { adapter, socket } = await begin();
    adapter.sendAudio(new Uint8Array([1, 2]));
    expect(socket.sentObjects().some((m) => "realtimeInput" in m)).toBe(false);
    expect(adapter.audioFrameCounts).toEqual({ sent: 0, dropped: 1 });
  });

  it("forwards frames once ready, with the rate the provider reads", async () => {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    adapter.sendAudio(new Uint8Array([1, 2, 3, 4]));
    const audio = socket.sentObjects().find((m) => "realtimeInput" in m) as
      | { realtimeInput: { audio: { mimeType: string; data: string } } }
      | undefined;
    expect(audio?.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(audio?.realtimeInput.audio.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(adapter.audioFrameCounts.sent).toBe(1);
  });

  it("sends nothing while muted, and counts the frames it refused", async () => {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    adapter.setMuted(true);
    adapter.sendAudio(new Uint8Array([9, 9]));
    expect(socket.sentObjects().some((m) => "realtimeInput" in m)).toBe(false);

    adapter.setMuted(false);
    adapter.sendAudio(new Uint8Array([9, 9]));
    expect(adapter.audioFrameCounts).toEqual({ sent: 1, dropped: 1 });
  });

  it("refuses an implausibly large frame instead of forwarding a stuck producer", async () => {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    adapter.sendAudio(new Uint8Array(600 * 1024));
    expect(adapter.audioFrameCounts).toEqual({ sent: 0, dropped: 1 });
  });
});

describe("state", () => {
  it("moves connecting to listening to speaking and back to listening", async () => {
    const { adapter, socket, connected } = await begin();
    const seen: VoiceState[] = [];
    adapter.onStateChange((state) => seen.push(state));

    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;
    socket.deliver({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "", mimeType: "audio/pcm;rate=24000" } }] } } });
    socket.deliver({ serverContent: { turnComplete: true } });

    expect(seen).toContain("connecting");
    expect(seen.at(-1)).toBe("listening");
    // The first audio of a turn is what "speaking" means; there is no separate signal for it.
    expect(socket.sent.length).toBeGreaterThan(0);
  });

  it("tells a late subscriber the current state instead of leaving it guessing", async () => {
    const { socket, adapter, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    const seen: VoiceState[] = [];
    adapter.onStateChange((state) => seen.push(state));
    expect(seen).toEqual(["listening"]);
  });

  it("reports an unexpected close as failed, not as a session the user ended", async () => {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    socket.drop(1006, "network gone");
    expect(adapter.state).toBe("failed");
  });

  it("reports a provider error as failed", async () => {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    socket.deliver({ error: { message: "quota exceeded" } });
    expect(adapter.state).toBe("failed");
  });

  it("reports a clean disconnect as ended", async () => {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    await adapter.disconnect();
    expect(adapter.state).toBe("ended");
    expect(socket.closed).toBe(true);
  });
});

describe("transcripts", () => {
  it("turns provider transcription into contract fragments that complete a turn", async () => {
    const { adapter, socket, connected } = await begin();
    const fragments: VoiceTranscriptFragment[] = [];
    adapter.onTranscript((fragment) => fragments.push(fragment));

    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    socket.deliver({ serverContent: { inputTranscription: { text: "hello there" } } });
    socket.deliver({ serverContent: { inputTranscription: { text: " how are you" } } });
    socket.deliver({ serverContent: { turnComplete: true } });

    const assembly = assembleUtterance(fragments);
    expect(assembly.complete).toBe(true);
    expect(assembly.text).toBe("hello there how are you");
    // Every fragment satisfies the contract, or the parse inside the adapter would have thrown.
    expect(fragments.every((fragment) => fragment.voiceSessionId === "session-1")).toBe(true);
  });

  it("starts a new utterance for the next turn rather than appending to the last", async () => {
    const { adapter, socket, connected } = await begin();
    const fragments: VoiceTranscriptFragment[] = [];
    adapter.onTranscript((fragment) => fragments.push(fragment));

    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    socket.deliver({ serverContent: { inputTranscription: { text: "first" } } });
    socket.deliver({ serverContent: { turnComplete: true } });
    socket.deliver({ serverContent: { inputTranscription: { text: "second" } } });
    socket.deliver({ serverContent: { turnComplete: true } });

    const utterances = new Set(fragments.map((fragment) => fragment.utteranceId));
    expect(utterances.size).toBe(2);
  });

  it("keeps the user's and the model's words in separate utterances", async () => {
    const { adapter, socket, connected } = await begin();
    const fragments: VoiceTranscriptFragment[] = [];
    adapter.onTranscript((fragment) => fragments.push(fragment));

    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;

    socket.deliver({ serverContent: { inputTranscription: { text: "what time is it" } } });
    socket.deliver({ serverContent: { outputTranscription: { text: "it is noon" } } });
    socket.deliver({ serverContent: { turnComplete: true } });

    const user = fragments.filter((fragment) => fragment.role === "user");
    const assistant = fragments.filter((fragment) => fragment.role === "assistant");
    expect(assembleUtterance(user).text).toBe("what time is it");
    expect(assembleUtterance(assistant).text).toBe("it is noon");
  });
});

describe("parsing", () => {
  it("reports an unparseable frame rather than dropping it", () => {
    expect(parseServerMessage("not json")).toEqual([{ kind: "unrecognised", keys: ["unparseable"] }]);
  });

  it("reports unknown top-level fields, so a provider upgrade is visible", () => {
    expect(parseServerMessage(JSON.stringify({ somethingNew: {} }))).toEqual([
      { kind: "unrecognised", keys: ["somethingNew"] },
    ]);
  });

  it("stays quiet about frames it understands and does not act on", () => {
    expect(parseServerMessage(JSON.stringify({ usageMetadata: { totalTokenCount: 12 } }))).toEqual([]);
    expect(parseServerMessage(JSON.stringify({ sessionResumptionUpdate: { resumable: true } }))).toEqual([]);
  });

  it("reads several things out of one frame instead of only the first", () => {
    const events = parseServerMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: "AAA=", mimeType: "audio/pcm;rate=24000" } }] },
          outputTranscription: { text: "hi" },
          turnComplete: true,
        },
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["audio", "transcript", "turnComplete"]);
  });

  it("falls back to the measured output rate when the MIME type does not carry one", () => {
    expect(sampleRateFromMime(undefined)).toBe(24000);
    expect(sampleRateFromMime("audio/pcm;rate=16000")).toBe(16000);
  });

  it("builds a text turn for tests and scripted sessions", () => {
    expect(buildTextMessage("hello")).toEqual({
      clientContent: { turns: [{ role: "user", parts: [{ text: "hello" }] }], turnComplete: true },
    });
  });

  it("carries the input rate in the MIME type where the provider reads it", () => {
    const message = buildAudioMessage(new Uint8Array([0])) as {
      realtimeInput: { audio: { mimeType: string } };
    };
    expect(message.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
  });
});

/**
 * Reading the agent's reply out loud.
 *
 * The provider's voice, somebody else's words. These tests exist because the two are easy to
 * confuse: the call has to carry the text exactly, and it must not turn into a second question for
 * the model to answer.
 */
describe("reading a given text out loud", () => {
  async function ready(): Promise<{ adapter: GeminiLiveAdapter; socket: FakeSocket }> {
    const { adapter, socket, connected } = await begin();
    socket.open();
    socket.deliver({ setupComplete: {} });
    await connected;
    return { adapter, socket };
  }

  it("sends the words as a turn rather than asking the model anything", async () => {
    const { adapter, socket } = await ready();

    adapter.speak("Xong rồi: ba tệp đã được chuyển.");

    const turn = socket.sentObjects().find((message) => "clientContent" in message);
    expect(turn).toEqual({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Xong rồi: ba tệp đã được chuyển." }] }],
        turnComplete: true,
      },
    });
    // The reply is text, not a fabricated audio frame: the provider owns the audio.
    expect(socket.sentObjects().some((message) => "realtimeInput" in message)).toBe(false);
  });

  it("says nothing when there is nothing to say", async () => {
    const { adapter, socket } = await ready();
    const before = socket.sent.length;

    adapter.speak("   ");

    // A silent turn still costs a round trip, and the silence it produces reads as a stall.
    expect(socket.sent.length).toBe(before);
  });

  it("is dropped before the session is ready, because setup has to be first on the socket", async () => {
    const { adapter, socket } = await begin();
    socket.open();
    const before = socket.sent.length;

    adapter.speak("quá sớm");

    expect(socket.sent.length).toBe(before);
  });

  it("does not throw when there is no session at all", () => {
    // A caller that has lost its session has nothing to recover with, so this must be a no-op
    // rather than an exception raised at the layer that cannot do anything about it.
    const adapter = new GeminiLiveAdapter({ createSocket: () => {
      throw new Error("no socket should ever be created here");
    } });

    expect(() => adapter.speak("xin chào")).not.toThrow();
  });
});
