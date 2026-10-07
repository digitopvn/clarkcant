import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  type AppIntentDecision,
  type Instant,
  type RecognitionContext,
  type RecognitionProvenance,
  type RecognizedUtterance,
  type SpeechRecognitionCapabilities,
  type VoiceState,
  instantSchema,
  nodeIdSchema,
} from "@clarkcant/contracts";
import { createConversation, messagesSince, migrate, openDatabase } from "@clarkcant/storage";
import {
  GeminiTranscribeLiveAdapter,
  type LiveSocket,
  type SpeechRecognitionAdapter,
  type UtteranceRetry,
  type VoiceProviderAdapter,
  buildRecognitionContext,
} from "@clarkcant/voice-adapters";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { describeRecognition, recognitionWiring } from "../src/bootstrap/voice-bootstrap.ts";
import type { NodeServices } from "../src/services.ts";
import { type VoiceGateway, type VoiceGatewayOptions, attachVoiceGateway } from "../src/voice-session.ts";

/**
 * Where the person's words come from, and what is done to them before they mean anything.
 *
 * A real socket and a real database, with both providers replaced: what is under test is that one settled, canonical
 * utterance is dispatched per thing said - through the same routing a live transcript takes - and that a recognizer
 * that fails leaves the session hearing rather than deaf.
 */

const AT = instantSchema.parse("2026-10-06T03:00:00.000Z") as Instant;
const NODE = nodeIdSchema.parse("node_voice_recognition");
const CONVERSATION = "conv_voice_recognition" as never;
const TOKEN = "test_local_token_value";
const CONTEXT: RecognitionContext = buildRecognitionContext({ symbols: ["voiceSession", "voice_session"] });

class FakeLive implements VoiceProviderAdapter {
  readonly provider = "fake-live";
  readonly capabilities = { provider: "fake-live", supportsVoiceSelection: false, voices: [], supportsPreview: false };
  readonly frames: Uint8Array[] = [];
  readonly spoken: string[] = [];
  muted = false;
  disconnected = 0;
  #onTranscript: Parameters<VoiceProviderAdapter["onTranscript"]>[0] | undefined;
  #onState: ((state: VoiceState) => void) | undefined;
  #fragments = 0;

  async connect(): Promise<void> {
    this.#onState?.("listening");
  }
  async disconnect(): Promise<void> {
    this.disconnected += 1;
  }
  sendAudio(frame: Uint8Array): void {
    this.frames.push(frame);
  }
  speak(text: string): void {
    this.spoken.push(text);
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
  }
  onTranscript(listener: Parameters<VoiceProviderAdapter["onTranscript"]>[0]): () => void {
    this.#onTranscript = listener;
    return () => undefined;
  }
  onAudio(): () => void {
    return () => undefined;
  }
  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.#onState = listener;
    return () => undefined;
  }

  /** What the live session's input transcription would report for one sentence: the words, then the close. */
  hear(text: string): void {
    for (const [fragment, isFinal] of [[text, false], ["", true]] as const) {
      this.#onTranscript?.({
        voiceSessionId: "session",
        utteranceId: "session:u0",
        fragmentIndex: this.#fragments++,
        isFinal,
        text: fragment,
        role: "user",
        at: AT,
        sequence: this.#fragments,
      });
    }
  }

  /** Words only, no close: the session has to wait for the quiet. */
  hearPartial(text: string): void {
    this.#onTranscript?.({
      voiceSessionId: "session",
      utteranceId: "session:u0",
      fragmentIndex: this.#fragments++,
      isFinal: false,
      text,
      role: "user",
      at: AT,
      sequence: this.#fragments,
    });
  }
}

class FakeRecognizer implements SpeechRecognitionAdapter {
  readonly provider = "fake-recognizer";
  readonly model = "fake-model";
  readonly capabilities: SpeechRecognitionCapabilities = {
    provider: "fake-recognizer",
    model: "fake-model",
    interimResults: true,
    languageDetection: false,
    confidence: "span",
    vocabulary: true,
    maxVocabularyTerms: 100,
    contextUpdate: "next-connection",
    utteranceRetry: true,
  };
  readonly frames: Uint8Array[] = [];
  started: RecognitionContext | undefined;
  startCount = 0;
  stopped = 0;
  audioEnded = 0;
  muted = false;
  failStart = false;
  /** A provider that accepts the connection and never completes setup: start waits until stopped. */
  hangStart = false;
  #utterance: ((utterance: RecognizedUtterance) => void) | undefined;
  #state: ((state: VoiceState) => void) | undefined;
  #sequence = 0;
  #release: ((cause: Error) => void) | undefined;

  async start(input: { context?: RecognitionContext }): Promise<void> {
    this.startCount += 1;
    if (this.failStart) throw new Error("socket refused");
    if (this.hangStart) {
      await new Promise<void>((_, reject) => {
        this.#release = reject;
      });
    }
    this.started = input.context;
    this.#state?.("listening");
  }
  async stop(): Promise<void> {
    this.stopped += 1;
    this.#release?.(new Error("stopped"));
  }
  sendAudio(frame: Uint8Array): void {
    this.frames.push(frame);
  }
  endAudio(): void {
    this.audioEnded += 1;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
  }
  updateContext(): void {}
  onUtterance(listener: (utterance: RecognizedUtterance) => void): () => void {
    this.#utterance = listener;
    return () => undefined;
  }
  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.#state = listener;
    return () => undefined;
  }

  emit(id: string, text: string, isFinal: boolean, extra: Partial<RecognizedUtterance> = {}): void {
    this.#utterance?.({
      voiceSessionId: "voice-1",
      utteranceId: id,
      revision: this.#sequence,
      isFinal,
      text,
      provider: this.provider,
      model: this.model,
      contextApplied: true,
      at: AT,
      sequence: this.#sequence++,
      ...extra,
    });
  }

  fail(): void {
    this.#state?.("failed");
  }
}

/** The provider's socket, for the real recognizer: what it is sent, and what the provider says back. */
class TranscribeSocket implements LiveSocket {
  readonly sent: string[] = [];
  #onOpen: (() => void) | undefined;
  #onMessage: ((payload: string) => void) | undefined;
  #onClose: ((info: { code: number; reason: string }) => void) | undefined;

  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {}
  onOpen(listener: () => void): void {
    this.#onOpen = listener;
  }
  onMessage(listener: (payload: string) => void): void {
    this.#onMessage = listener;
  }
  onClose(listener: (info: { code: number; reason: string }) => void): void {
    this.#onClose = listener;
  }
  onError(): void {}

  open(): void {
    this.#onOpen?.();
  }
  deliver(frame: unknown): void {
    this.#onMessage?.(JSON.stringify(frame));
  }
  drop(code: number, reason: string): void {
    this.#onClose?.({ code, reason });
  }
}

/** Wait for a condition the session reaches asynchronously, bounded so a regression fails rather than hangs. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Control = Record<string, unknown>;

let running: { gateway: VoiceGateway; server: Server } | undefined;

afterEach(async () => {
  if (running === undefined) return;
  await running.gateway.close();
  await new Promise<void>((resolve) => running?.server.close(() => resolve()));
  running = undefined;
});

async function open(options: Partial<VoiceGatewayOptions>, live: FakeLive, conversation = true) {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  createConversation(db, { conversationId: CONVERSATION, homeNodeId: NODE, title: "voice", at: AT });
  let counter = 0;
  const conductor = { db, nodeId: NODE, now: () => AT, newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}` };
  const services = {
    runtime: { identity: { localToken: TOKEN, nodeId: NODE }, db },
    conductor,
    model: null,
    describe: () => ({ node: "test", platform: "test", arch: "test" }),
  } as unknown as NodeServices;
  const server = createServer();
  const gateway = attachVoiceGateway({ server, services, credential: () => "credential", createAdapter: () => live, ...options });
  running = { gateway, server };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`);
  const received: Control[] = [];
  const waiters: Array<{ match: (control: Control) => boolean; resolve: (control: Control) => void }> = [];
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    const control = JSON.parse(data.toString()) as Control;
    received.push(control);
    for (const waiter of [...waiters]) {
      if (!waiter.match(control)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(control);
    }
  });
  const waitFor = (match: (control: Control) => boolean, label: string): Promise<Control> =>
    new Promise((resolve, reject) => {
      const found = received.find(match);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
      waiters.push({
        match,
        resolve: (control) => {
          clearTimeout(timer);
          resolve(control);
        },
      });
    });
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));
  ws.send(JSON.stringify({ type: "auth", token: TOKEN, ...(conversation ? { conversationId: CONVERSATION } : {}) }));
  await waitFor((control) => control["type"] === "ready", "ready");
  return {
    ws,
    db,
    received,
    waitFor,
    userLines: (): Array<{ text: unknown; final: unknown }> =>
      received.filter((control) => control["type"] === "transcript" && control["role"] === "user").map((control) => ({ text: control["text"], final: control["final"] })),
    sendAudio: (bytes: number[]): void => ws.send(Buffer.from(bytes), { binary: true }),
    send: (payload: Control): void => ws.send(JSON.stringify(payload)),
  };
}

/** An agent that records what it was asked and answers each sentence once. */
function recordingAgent(): { asked: string[]; answer: NonNullable<VoiceGatewayOptions["answer"]> } {
  const asked: string[] = [];
  return {
    asked,
    answer: async ({ text }) => {
      asked.push(text);
      return { reply: `ok ${asked.length}`, recordedMessages: 0 };
    },
  };
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("a session with a dedicated recognizer", () => {
  it("shows interim hypotheses, and dispatches only the settled final, once, in its canonical spelling", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const client = await open(
      { createRecognizer: () => recognizer, recognitionContext: async () => CONTEXT, answer: agent.answer },
      live,
    );
    expect(recognizer.started).toBe(CONTEXT);

    recognizer.emit("voice-1:s0", "sửa lỗi stale", false);
    recognizer.emit("voice-1:s0", "sửa lỗi stale closer trong use effect", false);
    recognizer.emit("voice-1:s0", "sửa lỗi stale closer trong use effect", true);
    // The same utterance finalized again - a provider repeat, or a late revision - is not a second sentence.
    recognizer.emit("voice-1:s0", "sửa lỗi stale closer trong use effect", true);

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    await settle();
    expect(agent.asked).toEqual(["sửa lỗi stale closure trong useEffect"]);
    expect(client.userLines()).toEqual([
      { text: "sửa lỗi stale", final: false },
      { text: "sửa lỗi stale closer trong use effect", final: false },
      { text: "sửa lỗi stale closure trong useEffect", final: true },
    ]);
  });

  it("ignores the live session's reading of the same audio, so one sentence is never two messages", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const client = await open({ createRecognizer: () => recognizer, recognitionContext: async () => CONTEXT, answer: agent.answer }, live);

    live.hear("sửa lỗi stay closer trong use effect");
    recognizer.emit("voice-1:s0", "sửa lỗi stale closure trong useEffect", true);

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    await settle(450);
    expect(agent.asked).toEqual(["sửa lỗi stale closure trong useEffect"]);
    expect(client.userLines().filter((line) => line.text === "sửa lỗi stay closer trong use effect")).toEqual([]);
  });

  it("dispatches successive utterances in the order they were said", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const client = await open({ createRecognizer: () => recognizer, answer: agent.answer }, live);

    recognizer.emit("voice-1:s0", "câu thứ nhất", true);
    recognizer.emit("voice-1:s1", "câu thứ hai", true);

    await client.waitFor((control) => control["type"] === "transcript" && control["text"] === "ok 2", "the second answer");
    expect(agent.asked).toEqual(["câu thứ nhất", "câu thứ hai"]);
  });

  it("routes the canonical text through the app-intent path exactly as a live transcript", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const seen: string[] = [];
    const decision: AppIntentDecision = { kind: "intent", intent: { kind: "settings.open" }, requiresConfirmation: false, readBack: "Mở Settings." };
    const client = await open(
      {
        createRecognizer: () => recognizer,
        recognitionContext: async () => CONTEXT,
        resolveAppIntent: ({ text }) => {
          seen.push(text);
          return decision;
        },
      },
      live,
    );

    recognizer.emit("voice-1:s0", "mở settings", true);

    const frame = await client.waitFor((control) => control["type"] === "app-intent", "the app-intent frame");
    expect(frame["decision"]).toEqual(decision);
    expect(seen).toEqual(["mở settings"]);
    expect(live.spoken).toEqual(["Mở Settings."]);
  });

  it("sends the audio to both, and the mute to both", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const client = await open({ createRecognizer: () => recognizer }, live);

    client.sendAudio([1, 2, 3, 4]);
    client.send({ type: "mute", muted: true });
    await settle();

    expect(live.frames.map((frame) => [...frame])).toEqual([[1, 2, 3, 4]]);
    expect(recognizer.frames.map((frame) => [...frame])).toEqual([[1, 2, 3, 4]]);
    expect(live.muted).toBe(true);
    expect(recognizer.muted).toBe(true);
    // The sentence before the mute is finalized now, not left open to be joined to whatever is said after it.
    expect(recognizer.audioEnded).toBe(1);
  });

  it("opens on the live transcription when the recognizer never finishes opening", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    recognizer.hangStart = true;
    const agent = recordingAgent();
    const client = await open(
      { createRecognizer: () => recognizer, recognitionContext: async () => CONTEXT, answer: agent.answer, recognizerStartTimeoutMs: 50 },
      live,
    );
    expect(recognizer.stopped).toBe(1);

    live.hear("sửa lỗi stale closer trong use effect");
    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    expect(agent.asked).toEqual(["sửa lỗi stale closure trong useEffect"]);
  });

  it("falls back without doubling a sentence the live reading finished late", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const client = await open({ createRecognizer: () => recognizer, answer: agent.answer, utteranceSettleMs: 20 }, live);

    recognizer.emit("voice-1:s0", "sửa lỗi stale closure nhé", true);
    await client.waitFor((control) => control["text"] === "ok 1", "the first answer");
    // The live reading of that same sentence arrives after the recognizer delivered it.
    live.hearPartial("sửa lỗi stale closure nhé");
    await settle(60);
    live.hearPartial(" mở file");
    recognizer.emit("voice-1:s1", "mở", false);
    recognizer.fail();

    await client.waitFor((control) => control["text"] === "ok 2", "the second answer");
    expect(agent.asked).toEqual(["sửa lỗi stale closure nhé", "mở file"]);
  });

  it("falls back without losing a sentence the live reading started early", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const client = await open({ createRecognizer: () => recognizer, answer: agent.answer, utteranceSettleMs: 20 }, live);

    live.hearPartial("sửa lỗi stale closure nhé");
    await settle(60);
    // The next sentence's live reading arrives before the recognizer delivers the first.
    live.hearPartial(" mở file voice session");
    recognizer.emit("voice-1:s0", "sửa lỗi stale closure nhé", true);
    await client.waitFor((control) => control["text"] === "ok 1", "the first answer");
    recognizer.emit("voice-1:s1", "mở", false);
    recognizer.fail();

    await client.waitFor((control) => control["text"] === "ok 2", "the second answer");
    expect(agent.asked).toEqual(["sửa lỗi stale closure nhé", "mở file voice session"]);
  });

  it("keeps a sentence whole across the provider's session limit, with the real recognizer", async () => {
    const live = new FakeLive();
    const agent = recordingAgent();
    const sockets: TranscribeSocket[] = [];
    const createRecognizer = (): SpeechRecognitionAdapter =>
      new GeminiTranscribeLiveAdapter({
        createSocket: () => {
          const socket = new TranscribeSocket();
          sockets.push(socket);
          // Accepts and completes setup as soon as the adapter has wired its listeners.
          queueMicrotask(() => {
            socket.open();
            socket.deliver({ setupComplete: {} });
          });
          return socket;
        },
      });
    const client = await open({ createRecognizer, answer: agent.answer }, live);
    expect(sockets).toHaveLength(1);

    sockets[0]!.deliver({ serverContent: { interimInputTranscription: { text: "mở file index" } } });
    // The provider ends every session at ten minutes, in the middle of whatever is being said.
    sockets[0]!.drop(1000, "session limit");
    await until(() => sockets.length === 2 && sockets[1]!.sent.length > 0);
    await settle();
    expect(agent.asked).toEqual([]);

    sockets[1]!.deliver({ serverContent: { inputTranscription: { text: "chấm ts giúp tui" } } });
    await client.waitFor((control) => control["text"] === "ok 1", "the answer");
    expect(agent.asked).toEqual(["mở file index chấm ts giúp tui"]);
    expect(client.userLines().filter((line) => line.final === true)).toEqual([{ text: "mở file index chấm ts giúp tui", final: true }]);
  });

  it("stops the recognizer when the session ends, and keeps an unfinished hypothesis as the person's words", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const client = await open({ createRecognizer: () => recognizer, recognitionContext: async () => CONTEXT, answer: recordingAgent().answer }, live);

    recognizer.emit("voice-1:s0", "kiểm tra use effect", false);
    client.send({ type: "end" });
    const ended = await client.waitFor((control) => control["type"] === "ended", "ended");

    expect(recognizer.stopped).toBe(1);
    expect(live.disconnected).toBe(1);
    expect(ended["recordedMessages"]).toBe(1);
    const stored = messagesSince(client.db, CONVERSATION, 0);
    expect(JSON.stringify(stored)).toContain("kiểm tra useEffect");
  });

  it("opens on the live transcription when the recognizer cannot open", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    recognizer.failStart = true;
    const agent = recordingAgent();
    const client = await open({ createRecognizer: () => recognizer, recognitionContext: async () => CONTEXT, answer: agent.answer }, live);

    live.hear("sửa lỗi stale closer trong use effect");

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    expect(agent.asked).toEqual(["sửa lỗi stale closure trong useEffect"]);
    expect(recognizer.stopped).toBe(1);
  });

  it("falls back to the live transcription mid-sentence when the recognizer fails, and still answers that sentence", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const client = await open(
      { createRecognizer: () => recognizer, recognitionContext: async () => CONTEXT, answer: agent.answer, utteranceSettleMs: 20 },
      live,
    );

    recognizer.emit("voice-1:s0", "câu đầu", true);
    await client.waitFor((control) => control["text"] === "ok 1", "the first answer");

    live.hearPartial("mở file voice session");
    recognizer.emit("voice-1:s1", "mở file", false);
    recognizer.fail();

    await client.waitFor((control) => control["text"] === "ok 2", "the second answer");
    expect(agent.asked).toEqual(["câu đầu", "mở file voice session"]);
    // After the fallback, a late result from the recognizer that failed is not dispatched.
    recognizer.emit("voice-1:s1", "mở file voiceSession", true);
    await settle(60);
    expect(agent.asked).toHaveLength(2);
  });

  it("recognizes an ambiguous utterance again with its own audio, and keeps the reading that resolves it", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const retried: Array<{ audio: number[]; reason: string; first: string | undefined }> = [];
    const retry: UtteranceRetry = async ({ audio, reason, context }) => {
      retried.push({ audio: [...audio], reason, first: context.terms[0]?.text });
      return "đổi tên biến voiceSession cho rõ hơn";
    };
    const provenance: RecognitionProvenance[] = [];
    const client = await open(
      {
        createRecognizer: () => recognizer,
        recognitionContext: async () => CONTEXT,
        utteranceRetry: retry,
        onRecognition: (entry) => provenance.push(entry),
        answer: agent.answer,
      },
      live,
    );

    client.sendAudio([9, 8, 7, 6]);
    await settle();
    recognizer.emit("voice-1:s0", "đổi tên biến voice session cho rõ hơn", true);

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    expect(agent.asked).toEqual(["đổi tên biến voiceSession cho rõ hơn"]);
    expect(retried).toEqual([{ audio: [9, 8, 7, 6], reason: "ambiguous-technical-span", first: "voiceSession" }]);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.retry).toEqual({ reason: "ambiguous-technical-span", outcome: "used-retry" });
    // The operator line names what happened, never what was said.
    const line = describeRecognition(provenance[0]!);
    expect(line).toContain("retry=ambiguous-technical-span:used-retry");
    expect(line).not.toContain("đổi tên");
    expect(line).not.toContain("voiceSession");
  });

  it("keeps the original when the retry fails, and says so", async () => {
    const live = new FakeLive();
    const recognizer = new FakeRecognizer();
    const agent = recordingAgent();
    const provenance: RecognitionProvenance[] = [];
    const client = await open(
      {
        createRecognizer: () => recognizer,
        recognitionContext: async () => CONTEXT,
        utteranceRetry: async () => {
          throw new Error("provider down");
        },
        onRecognition: (entry) => provenance.push(entry),
        answer: agent.answer,
      },
      live,
    );

    client.sendAudio([1, 1]);
    await settle();
    recognizer.emit("voice-1:s0", "đổi tên biến voice session cho rõ hơn", true);

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    expect(agent.asked).toEqual(["đổi tên biến voice session cho rõ hơn"]);
    expect(provenance[0]?.retry).toEqual({ reason: "ambiguous-technical-span", outcome: "failed" });
    expect(provenance[0]?.abstained).toBe(1);
  });
});

describe("a session on the live transcription", () => {
  it("dispatches the live reading as heard when there is no vocabulary, as before", async () => {
    const live = new FakeLive();
    const agent = recordingAgent();
    const client = await open({ answer: agent.answer }, live);

    live.hear("sửa lỗi stale closer trong use effect");

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    expect(agent.asked).toEqual(["sửa lỗi stale closer trong use effect"]);
  });

  it("normalises the live reading against the session vocabulary and shows the canonical sentence", async () => {
    const live = new FakeLive();
    const agent = recordingAgent();
    const provenance: RecognitionProvenance[] = [];
    const client = await open({ answer: agent.answer, recognitionContext: async () => CONTEXT, onRecognition: (entry) => provenance.push(entry) }, live);

    live.hear("sửa lỗi stale closer trong use effect");

    await client.waitFor((control) => control["type"] === "transcript" && control["role"] === "assistant", "the answer");
    expect(agent.asked).toEqual(["sửa lỗi stale closure trong useEffect"]);
    // One line in progress, then the one final line that settles it: never the raw reading and a corrected copy.
    expect(client.userLines()).toEqual([
      { text: "sửa lỗi stale closer trong use effect", final: false },
      { text: "sửa lỗi stale closure trong useEffect", final: true },
    ]);
    expect(provenance[0]).toMatchObject({ provider: "fake-live", contextApplied: false, abstained: 0 });
    expect(provenance[0]?.normalization.map((change) => change.rule).sort()).toEqual(["alias", "spacing"]);
  });

  it("leaves a spoken decision alone, so normalisation can never turn a refusal into something else", async () => {
    const live = new FakeLive();
    const decided: string[] = [];
    const client = await open(
      {
        recognitionContext: async () => CONTEXT,
        answer: async () => ({
          reply: "Tui sẽ chạy lệnh.",
          recordedMessages: 0,
          pendingInteraction: { kind: "approval", approvalId: "approval_1", digest: "d", description: "Chạy pnpm test" },
        }),
        decideApproval: async ({ decision }) => {
          decided.push(decision);
          return { ok: true, message: "" };
        },
      },
      live,
    );

    live.hear("chạy test đi");
    await client.waitFor((control) => typeof control["text"] === "string" && (control["text"] as string).includes("cho phép"), "the question");
    live.hear("không");
    await settle(100);
    expect(decided).toEqual(["denied"]);
  });
});

describe("choosing the recognizer", () => {
  const services = { runtime: { db: undefined, identity: { ownerPrincipalId: "owner", nodeId: NODE } } } as unknown as NodeServices;

  it("keeps the live transcription by default and always builds the vocabulary", () => {
    const wiring = recognitionWiring({ services, env: {}, credential: () => "key", fixture: false });
    expect(wiring.createRecognizer).toBeUndefined();
    expect(wiring.utteranceRetry).toBeUndefined();
    expect(wiring.recognitionContext).toBeTypeOf("function");
  });

  it("uses the dedicated recognizer only when the operator names it, and never for the fixture provider", () => {
    const chosen = recognitionWiring({ services, env: { CC_VOICE_RECOGNIZER: "gemini-transcribe" }, credential: () => "key", fixture: false });
    expect(chosen.createRecognizer?.().provider).toBe("gemini-transcribe");
    expect(chosen.utteranceRetry).toBeTypeOf("function");
    const fixture = recognitionWiring({ services, env: { CC_VOICE_RECOGNIZER: "gemini-transcribe" }, credential: () => "key", fixture: true });
    expect(fixture.createRecognizer).toBeUndefined();
    const unknown = recognitionWiring({ services, env: { CC_VOICE_RECOGNIZER: "whisper" }, credential: () => "key", fixture: false });
    expect(unknown.createRecognizer).toBeUndefined();
  });
});
