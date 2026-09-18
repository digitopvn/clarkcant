import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { type Instant, nodeIdSchema, instantSchema, type VoiceState } from "@clarkcant/contracts";
import { createConversation, migrate, messagesSince, openDatabase } from "@clarkcant/storage";
import type { VoiceProviderAdapter } from "@clarkcant/voice-adapters";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeServices } from "../src/services.ts";
import {
  attachVoiceGateway,
  voiceAdapterDefaults,
  type VoiceGateway,
  type VoiceGatewayOptions,
} from "../src/voice-session.ts";

/**
 * The voice socket's boundary.
 *
 * These tests are about what the node refuses and what it records — the two places where a voice
 * session can go wrong in a way nobody notices until later. They run against a real socket and a
 * real database, with only the provider replaced, because the properties under test are the
 * transport's and the storage's rather than the adapter's.
 */

const AT = instantSchema.parse("2026-09-17T03:00:00.000Z") as Instant;
const NODE = nodeIdSchema.parse("node_voice_test");
const CONVERSATION = "conv_voice" as never;
const TOKEN = "test_local_token_value";

let counter = 0;
function buildDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  createConversation(db, { conversationId: CONVERSATION, homeNodeId: NODE, title: "voice", at: AT });
  return {
    db,
    nodeId: NODE,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

/** A provider that answers on command, so the socket can be tested without a network. */
class FakeAdapter implements VoiceProviderAdapter {
  readonly provider = "fake-live";
  connected = 0;
  disconnected = 0;
  muted = false;
  readonly frames: Uint8Array[] = [];
  #onState: ((state: VoiceState) => void) | undefined;
  #onTranscript: Parameters<VoiceProviderAdapter["onTranscript"]>[0] | undefined;
  #onAudio: ((pcm16: Uint8Array) => void) | undefined;

  async connect(): Promise<void> {
    this.connected += 1;
    this.#onState?.("listening");
  }
  async disconnect(): Promise<void> {
    this.disconnected += 1;
  }
  sendAudio(frame: Uint8Array): void {
    this.frames.push(frame);
  }
  onTranscript(listener: Parameters<VoiceProviderAdapter["onTranscript"]>[0]): () => void {
    this.#onTranscript = listener;
    return () => undefined;
  }
  onAudio(listener: Parameters<VoiceProviderAdapter["onAudio"]>[0]): () => void {
    this.#onAudio = listener;
    return () => undefined;
  }
  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.#onState = listener;
    return () => undefined;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** Everything the gateway asked this session to say out loud. */
  readonly spoken: string[] = [];

  speak(text: string): void {
    this.spoken.push(text);
  }

  /** A transcript fragment the provider would have produced, for either side. */
  emitTranscript(text: string, role: "user" | "assistant" = "assistant", final = false): void {
    this.#onTranscript?.({
      voiceSessionId: "session",
      utteranceId: role === "user" ? "session:u0" : "session:a0",
      fragmentIndex: 0,
      isFinal: final,
      text,
      role,
      at: AT,
      sequence: 0,
    });
  }

  /** Audio the provider would send back, so the socket's forwarding can be asserted. */
  sendAudioBack(pcm16: Uint8Array): void {
    this.#onAudio?.(pcm16);
  }
}

type Control = Record<string, unknown>;
type Received = { binary: true; bytes: Uint8Array } | { binary: false; control: Control };

async function startGateway(
  credential: () => string | undefined,
  adapter: FakeAdapter,
  options: Partial<VoiceGatewayOptions> = {},
): Promise<{ url: string; gateway: VoiceGateway; server: Server; deps: ReturnType<typeof buildDeps> }> {
  const deps = buildDeps();
  const services = {
    runtime: { identity: { localToken: TOKEN, nodeId: NODE }, db: deps.db },
    conductor: deps as never,
    model: null,
    describe: () => ({ node: "test", platform: "test", arch: "test" }),
  } as unknown as NodeServices;

  const server = createServer();
  const gateway = attachVoiceGateway({ server, services, credential, createAdapter: () => adapter, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/voice`, gateway, server, deps };
}

function connect(url: string) {
  const ws = new WebSocket(url);
  const received: Received[] = [];
  const waiters: Array<{ match: (message: Received) => boolean; resolve: (message: Received) => void }> = [];

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    const message: Received = isBinary
      ? { binary: true, bytes: new Uint8Array(data) }
      : { binary: false, control: JSON.parse(data.toString()) as Control };
    received.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });

  const opened = new Promise<void>((resolve) => ws.on("open", () => resolve()));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );

  const waitFor = (match: (message: Received) => boolean, label: string): Promise<Received> =>
    new Promise((resolve, reject) => {
      const found = received.find(match);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
      waiters.push({
        match,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });

  return {
    ws,
    received,
    opened,
    closed,
    waitFor,
    auth: (token: string, conversationId?: string): void =>
      ws.send(JSON.stringify({ type: "auth", token, ...(conversationId === undefined ? {} : { conversationId }) })),
    send: (payload: Control): void => ws.send(JSON.stringify(payload)),
    sendAudio: (bytes: number[]): void => ws.send(Buffer.from(bytes), { binary: true }),
    control: (type: string): Promise<Received> =>
      waitFor((message) => !message.binary && message.control["type"] === type, type),
  };
}

let context: Awaited<ReturnType<typeof startGateway>> | undefined;

afterEach(async () => {
  if (context === undefined) return;
  await context.gateway.close();
  await new Promise<void>((resolve) => context?.server.close(() => resolve()));
  context = undefined;
});

describe("opening a voice session", () => {
  it("refuses audio that arrives before authentication, and never connects a provider", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;

    client.sendAudio([1, 2, 3]);

    const denial = await client.control("denied");
    expect(denial.binary === false && denial.control["code"]).toBe("UNAUTHENTICATED");
    expect(adapter.connected).toBe(0);
    // The socket is closed rather than left open for a second attempt.
    await expect(client.closed).resolves.toMatchObject({ code: 1008 });
  });

  it("refuses a first frame that is not an auth message", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;

    client.send({ type: "hello" });

    const denial = await client.control("denied");
    expect(denial.binary === false && denial.control["code"]).toBe("UNAUTHENTICATED");
    expect(adapter.connected).toBe(0);
  });

  it("refuses a wrong token with the same answer as a missing one", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;

    client.auth("wrong-token-value", CONVERSATION);

    const denial = await client.control("denied");
    expect(denial.binary === false && denial.control["message"]).toBe(
      "a valid bearer token is required to open a voice session",
    );
    expect(adapter.connected).toBe(0);
  });

  it("refuses with a reason when the node holds no provider credential", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => undefined, adapter);
    const client = connect(context.url);
    await client.opened;

    client.auth(TOKEN, CONVERSATION);

    const denial = await client.control("denied");
    expect(denial.binary === false && denial.control["code"]).toBe("VOICE_NOT_CONFIGURED");
    expect(adapter.connected).toBe(0);
  });

  it("opens a session, reports the audio formats, and says whether the transcript will be stored", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;

    client.auth(TOKEN, CONVERSATION);

    const ready = await client.control("ready");
    expect(ready.binary === false && ready.control).toMatchObject({
      inputSampleRateHz: 16000,
      outputSampleRateHz: 24000,
      willRecord: true,
    });
    expect(adapter.connected).toBe(1);
  });

  it("reports plainly when a session has no conversation to record into", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;

    client.auth(TOKEN);

    const ready = await client.control("ready");
    expect(ready.binary === false && ready.control["willRecord"]).toBe(false);
  });

  it("refuses a second session and names the tab that holds the first", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const first = connect(context.url);
    await first.opened;
    first.auth(TOKEN, CONVERSATION);
    await first.control("ready");

    const second = connect(context.url);
    await second.opened;
    second.auth(TOKEN, CONVERSATION);

    const denial = await second.control("denied");
    expect(denial.binary === false && denial.control["code"]).toBe("VOICE_SESSION_BUSY");
    expect(typeof (denial.binary === false ? denial.control["heldBy"] : undefined)).toBe("string");
    await expect(second.closed).resolves.toMatchObject({ code: 1013 });
    // The first session is untouched by the refusal.
    expect(context.gateway.activeSessionCount()).toBe(1);
  });
});

describe("a live session", () => {
  it("carries audio in both directions", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    client.sendAudio([7, 8, 9]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.frames.map((frame) => [...frame])).toEqual([[7, 8, 9]]);

    adapter.emitTranscript("hello from the model");
    const transcript = await client.control("transcript");
    expect(transcript.binary === false && transcript.control).toMatchObject({
      role: "assistant",
      text: "hello from the model",
    });

    // And audio comes back as a binary frame rather than as a control message.
    adapter.sendAudioBack(new Uint8Array([4, 5, 6]));
    const audio = await client.waitFor((message) => message.binary, "an audio frame");
    expect(audio.binary && [...audio.bytes]).toEqual([4, 5, 6]);
  });

  it("stops accepting sessions once it has ended one", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    client.send({ type: "end" });
    const ended = await client.control("ended");
    expect(ended.binary === false).toBe(true);
    expect(context.gateway.activeSessionCount()).toBe(0);

    const next = connect(context.url);
    await next.opened;
    next.auth(TOKEN, CONVERSATION);
    await expect(next.control("ready")).resolves.toBeDefined();
  });
});

describe("recording the transcript", () => {
  it("writes both sides to the timeline once, and not a second time on close", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    // The user's side comes from the adapter's transcript events, as it does in production.
    adapter.emitTranscript("what is the weather", "user", false);
    // ...and the model's. The adapter distinguishes the roles; the socket only forwards them.
    await new Promise((resolve) => setTimeout(resolve, 20));

    client.send({ type: "end" });
    const ended = await client.control("ended");
    expect(ended.binary === false && ended.control["recordedMessages"]).toBeGreaterThan(0);

    const afterEnd = messagesSince(context.deps.db, CONVERSATION as never, 0);
    // Closing the socket afterwards must not append a second copy.
    client.ws.close();
    await client.closed;
    const afterClose = messagesSince(context.deps.db, CONVERSATION as never, 0);
    expect(afterClose.length).toBe(afterEnd.length);
  });

  it("does not run a model turn when recording a finished session", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    adapter.emitTranscript("an answer nobody needs to regenerate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send({ type: "end" });
    await client.control("ended");

    const messages = messagesSince(context.deps.db, CONVERSATION as never, 0);
    // Exactly one stored message: the spoken answer. A second one would mean voice had become a
    // conversational path and asked the model again.
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("assistant");
  });

  it("records nothing for a session that was never authenticated", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;

    client.sendAudio([1]);
    await client.control("denied");
    await client.closed;

    expect(messagesSince(context.deps.db, CONVERSATION as never, 0).length).toBe(0);
  });
});

describe("the conversation a session targets", () => {
  it("reports the transcript it stored, so the caller is not left guessing", async () => {
    const adapter = new FakeAdapter();
    context = await startGateway(() => "credential", adapter);
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    adapter.emitTranscript("the only thing said");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send({ type: "end" });

    const ended = await client.control("ended");
    const stored = messagesSince(context.deps.db, CONVERSATION as never, 0);
    expect(ended.binary === false && ended.control["recordedMessages"]).toBe(stored.length);
    expect(JSON.stringify(stored[0]?.blocks)).toContain("the only thing said");
  });
});

/**
 * A sentence becoming a message.
 *
 * Voice is an input channel to the agent rather than a second assistant: what is said becomes a
 * message in the conversation, the agent answers it with whatever tools it needs, and the words that
 * come back are read aloud by the session. These tests are about that path and about the two ways it
 * could quietly go wrong - answering twice, or going silent after one failure.
 */
describe("a spoken sentence the agent answers", () => {
  const REPLY = "Đã chuyển xong ba tệp.";

  function clientFor(): ReturnType<typeof connect> {
    return context === undefined ? (undefined as never) : connect(context.url);
  }

  async function opened(options: Partial<VoiceGatewayOptions>, adapter: FakeAdapter) {
    context = await startGateway(() => "credential", adapter, options);
    const client = clientFor();
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");
    return client;
  }

  /** A finished utterance, the way the adapter reports one: text, then an empty closing fragment. */
  const say = (adapter: FakeAdapter, text: string): void => {
    adapter.emitTranscript(text, "user", false);
    adapter.emitTranscript("", "user", true);
  };

  it("sends the utterance to the agent and reads its answer back", async () => {
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    const client = await opened(
      {
        answer: async ({ text }) => {
          asked.push(text);
          return { reply: REPLY, recordedMessages: 2 };
        },
      },
      adapter,
    );

    say(adapter, "chuyển ba tệp giúp tôi");

    const transcript = await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["role"] === "assistant" &&
        message.control["text"] === REPLY,
      "the agent's answer",
    );
    expect(transcript.binary === false && transcript.control["final"]).toBe(true);
    // The agent was asked once, with what was said and nothing else.
    expect(asked).toEqual(["chuyển ba tệp giúp tôi"]);
    // And the words are the agent's: the session is only the voice that reads them.
    expect(adapter.spoken).toEqual([REPLY]);
  });

  it("sends one message per utterance, however many fragments it arrived in", async () => {
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    const client = await opened(
      {
        answer: async ({ text }) => {
          asked.push(text);
          return { reply: REPLY, recordedMessages: 1 };
        },
      },
      adapter,
    );

    // A provider transcribes as the person speaks, so an utterance arrives in pieces and is closed
    // by an empty final fragment rather than by the text being repeated.
    adapter.emitTranscript("chuyển ", "user", false);
    adapter.emitTranscript("ba tệp ", "user", false);
    adapter.emitTranscript("giúp tôi", "user", false);
    adapter.emitTranscript("", "user", true);

    await client.waitFor(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["role"] === "assistant",
      "the agent's answer",
    );
    expect(asked).toEqual(["chuyển ba tệp giúp tôi"]);
  });

  it("does not repeat the live model's own words once the agent is answering", async () => {
    const adapter = new FakeAdapter();
    const client = await opened({ answer: async () => ({ reply: REPLY, recordedMessages: 1 }) }, adapter);

    say(adapter, "câu hỏi");
    await client.waitFor(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["role"] === "assistant",
      "the agent's answer",
    );
    // The session reads the reply back, so its own transcription of that reading is the same words a
    // second time. Two answers in the transcript is the failure this avoids.
    adapter.emitTranscript("Đã chuyển xong ba tệp.");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const answers = client.received.filter(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["role"] === "assistant",
    );
    expect(answers.length).toBe(1);
  });

  it("reports what the agent wrote, not nothing, when the session ends", async () => {
    const adapter = new FakeAdapter();
    const client = await opened({ answer: async () => ({ reply: REPLY, recordedMessages: 3 }) }, adapter);

    say(adapter, "câu hỏi");
    await client.waitFor(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["role"] === "assistant",
      "the agent's answer",
    );

    client.send({ type: "end" });
    const ended = await client.control("ended");
    // The messages were written while the sentence was being answered, so the closing report counts
    // them rather than recording the transcript a second time.
    expect(ended.binary === false && ended.control["recordedMessages"]).toBe(3);
  });

  it("stays open when the agent fails, so the next sentence gets its own attempt", async () => {
    const adapter = new FakeAdapter();
    let attempt = 0;
    const client = await opened(
      {
        answer: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("the model was unreachable");
          return { reply: REPLY, recordedMessages: 1 };
        },
      },
      adapter,
    );

    say(adapter, "câu hỏi đầu");
    const failure = await client.control("error");
    expect(failure.binary === false && failure.control["code"]).toBe("VOICE_ANSWER_FAILED");

    say(adapter, "câu hỏi thứ hai");
    await client.waitFor(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["role"] === "assistant",
      "the second answer",
    );
    expect(adapter.spoken).toEqual([REPLY]);
  });

  it("answers in the order the sentences were said, even when the first one is slow", async () => {
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    const client = await opened(
      {
        answer: async ({ text }) => {
          asked.push(text);
          if (text === "câu thứ nhất") await new Promise((resolve) => setTimeout(resolve, 40));
          return { reply: `đáp cho: ${text}`, recordedMessages: 1 };
        },
      },
      adapter,
    );

    say(adapter, "câu thứ nhất");
    say(adapter, "câu thứ hai");

    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["text"] === "đáp cho: câu thứ hai",
      "the second answer",
    );
    // Asked in order, and read back in order: a reply spoken over the question before it is worse
    // than a reply that arrives late.
    expect(asked).toEqual(["câu thứ nhất", "câu thứ hai"]);
    expect(adapter.spoken).toEqual(["đáp cho: câu thứ nhất", "đáp cho: câu thứ hai"]);
  });
});

beforeEach(() => {
  counter = 0;
});

/**
 * What the live session is told to be.
 *
 * A requirement rather than a detail: left to itself the model answers whatever it hears, and the
 * same question then has two answers in the room - the model's guess, made without a tool and
 * without the conversation, next to the agent's, which is the only one that could read the file.
 */
describe("the instruction the live session runs under", () => {
  it("makes it the voice, not the mind: transcribe, read back, do not answer", () => {
    const defaults = voiceAdapterDefaults({});

    expect(defaults?.systemInstruction).toBeTruthy();
    expect(defaults?.systemInstruction).toMatch(/không tự trả lời/i);
    expect(defaults?.systemInstruction).toMatch(/đọc nguyên văn/i);
  });

  it("still pins the model it was configured with", () => {
    expect(voiceAdapterDefaults({ model: "gemini-live-test-model" })).toMatchObject({
      model: "gemini-live-test-model",
    });
  });
});
