import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { type AppIntentDecision, type Instant, nodeIdSchema, instantSchema, type VoiceState } from "@clarkcant/contracts";
import { createConversation, migrate, messagesSince, openDatabase } from "@clarkcant/storage";
import type { VoiceProviderAdapter } from "@clarkcant/voice-adapters";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeServices } from "../src/services.ts";
import {
  attachVoiceGateway,
  interpretDecision,
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
  /** Declared so the test double matches the interface the real adapters implement. */
  readonly capabilities = {
    provider: "fake-live",
    supportsVoiceSelection: false,
    voices: [],
    supportsPreview: false,
  };
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

/** A finished utterance, the way the adapter reports one: the words, then an empty closing fragment. */
function sayFor(adapter: FakeAdapter, text: string): void {
  adapter.emitTranscript(text, "user", false);
  adapter.emitTranscript("", "user", true);
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

    /*
     * What used to be asserted here - that this audio reached the socket - is now asserted the other way round, in the
     * test about what the agent asked to be said. The rule narrowed on purpose: a frame with no request behind it is the
     * model talking on its own, and that is what a person heard coming out of the speaker.
     */
    adapter.sendAudioBack(new Uint8Array([4, 5, 6]));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("does not play audio the agent never asked to be said", async () => {
    const adapter = new FakeAdapter();
    // An answer is what gives the session something of its own to read aloud; audio arriving with no such request is
    // the model talking on its own, which is the thing this refuses.
    context = await startGateway(() => "credential", adapter, {
      answer: async () => ({ reply: "troi nang", recordedMessages: 1 }),
    });
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    // First the volunteered audio, then something the agent actually asked to be said. The order is the evidence: if
    // the volunteered frame had been played, it would be the first binary frame the socket saw, and the assertion below
    // would find [9, 9, 9] instead of the reply's own audio.
    adapter.sendAudioBack(new Uint8Array([9, 9, 9]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.spoken).toEqual([]);

    adapter.emitTranscript("what is the weather", "user", false);
    adapter.emitTranscript("", "user", true);
    for (let attempt = 0; attempt < 20 && adapter.spoken.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(adapter.spoken.length).toBeGreaterThan(0);

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

  it("takes the sentence when the transcription goes quiet, without waiting for the model's turn", async () => {
    // Measured against a real session: the provider sends the user's sentence once, whole, with no closing
    // marker, and its marker arrives only when the model's own turn ends - six point eight seconds later in the
    // probe, with the agent's answer queued behind it.
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    context = await startGateway(() => "credential", adapter, {
      utteranceSettleMs: 20,
      answer: async ({ text }) => {
        asked.push(text);
        return { reply: REPLY, recordedMessages: 1 };
      },
    });
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");

    adapter.emitTranscript("chuyển ba tệp giúp tôi", "user", false);

    await client.waitFor(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["role"] === "assistant",
      "the agent's answer",
    );
    expect(asked).toEqual(["chuyển ba tệp giúp tôi"]);
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

  it("shows the answer while it is being written, not only once the turn is done", async () => {
    const adapter = new FakeAdapter();
    const client = await opened(
      {
        answer: async ({ onText }) => {
          onText?.("Đang");
          onText?.("Đang chuyển");
          return { reply: REPLY, recordedMessages: 1 };
        },
      },
      adapter,
    );

    say(adapter, "câu hỏi");
    await client.waitFor(
      (message) => !message.binary && message.control["type"] === "transcript" && message.control["text"] === "Đang chuyển",
      "a partial answer",
    );

    // The text so far, not a fragment: the surface replaces what it shows rather than pasting pieces.
    const partials = client.received
      .filter(
        (message) =>
          !message.binary &&
          message.control["type"] === "transcript" &&
          message.control["role"] === "assistant" &&
          message.control["final"] === false,
      )
      .map((message) => (!message.binary ? message.control["text"] : undefined));
    expect(partials).toEqual(["Đang", "Đang chuyển"]);

    // And the durable answer still arrives, once, marked final.
    const final = await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["role"] === "assistant" &&
        message.control["final"] === true,
      "the final answer",
    );
    expect(final.binary === false && final.control["text"]).toBe(REPLY);
  });

  it("does not store the session's own reading of the answer as a second message", async () => {
    const adapter = new FakeAdapter();
    const client = await opened({ answer: async () => ({ reply: REPLY, recordedMessages: 2 }) }, adapter);

    say(adapter, "câu hỏi");
    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["role"] === "assistant" &&
        message.control["final"] === true,
      "the answer",
    );

    // The session reads the answer back, and its own transcription of that reading arrives here. Keeping
    // it would store the same answer twice - the duplicate that appeared when the fallback was added.
    adapter.emitTranscript(REPLY);
    client.send({ type: "end" });

    const ended = await client.control("ended");
    expect(ended.binary === false && ended.control["recordedMessages"]).toBe(2);
    const gateway = context;
    if (gateway === undefined) throw new Error("the gateway was not started");
    expect(messagesSince(gateway.deps.db, CONVERSATION as never, 0).length).toBe(0);
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
  it("makes it the voice, not the mind: silent while the person speaks, and reading back what it is given", () => {
    const defaults = voiceAdapterDefaults({});

    expect(defaults?.systemInstruction).toBeTruthy();
    // The provider transcribes the input on its own, so the model is told to say nothing at all while somebody
    // speaks. Asking it to transcribe as well is what had it reading the person's own sentence back to them,
    // before it had any answer to give.
    expect(defaults?.systemInstruction).toMatch(/giữ im lặng/i);
    expect(defaults?.systemInstruction).toMatch(/không chép lại/i);
    expect(defaults?.systemInstruction).toMatch(/đọc nguyên văn/i);
  });

  it("still pins the model it was configured with", () => {
    expect(voiceAdapterDefaults({ model: "gemini-live-test-model" })).toMatchObject({
      model: "gemini-live-test-model",
    });
  });
});

/**
 * A command the user approves by speaking.
 *
 * A voice session is a person holding a microphone, not a mouse: a turn that proposes a command ends with a
 * card nobody is going to click. So the session asks out loud, takes the spoken answer as the decision, and
 * carries it out through the same path the button uses - the same digest, the same receipt.
 */
describe("approving a command by voice", () => {
  const PROPOSAL = {
    approvalId: "appr_9",
    digest: "sha256:abc123",
    description: "Chạy git clone trong D:/work",
  };

  async function withProposal(
    decideApproval: (input: { approvalId: string; decision: string; digest: string }) => Promise<{
      ok: boolean;
      message: string;
    }>,
  ) {
    const adapter = new FakeAdapter();
    const calls: Array<{ approvalId: string; decision: string; digest: string }> = [];
    context = await startGateway(() => "credential", adapter, {
      answer: async () => ({
        reply: "Tui cần chạy một lệnh.",
        recordedMessages: 2,
        pendingInteraction: { kind: "approval", ...PROPOSAL },
      }),
      decideApproval: async (input) => {
        // Only what the decision consists of: the conversation is implied by the session.
        calls.push({ approvalId: input.approvalId, decision: input.decision, digest: input.digest });
        return decideApproval(input);
      },
    });
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");
    return { adapter, client, calls };
  }

  // A question the session asked about the decision: the first one names the operation, and the second teaches the
  // two words that would decide it.
  const asked = (message: Received): boolean =>
    !message.binary &&
    message.control["type"] === "transcript" &&
    typeof message.control["text"] === "string" &&
    (message.control["text"].includes("cho phép chạy") || message.control["text"].includes("chưa rõ ý bạn"));

  const said = (text: string) => (message: Received): boolean =>
    !message.binary && message.control["type"] === "transcript" && message.control["text"] === text;

  it("asks about the operation, and takes a spoken yes as the decision", async () => {
    const { adapter, client, calls } = await withProposal(async () => ({ ok: true, message: "đã chạy" }));

    sayFor(adapter, "clone giúp tui một repo");
    // The question names the operation and reaches the person as words, not as a card they cannot press.
    await client.waitFor(asked, "the approval question");

    sayFor(adapter, "đồng ý");
    await client.waitFor(said("Đã duyệt. Tui chạy lệnh đó ngay."), "the decision");

    // Exactly the binding the button sends: the same approval and the same digest that was displayed.
    expect(calls).toEqual([{ approvalId: PROPOSAL.approvalId, decision: "granted", digest: PROPOSAL.digest }]);
  });

  it("carries out a spoken refusal, and runs nothing", async () => {
    const { adapter, client, calls } = await withProposal(async () => ({ ok: true, message: "" }));

    sayFor(adapter, "clone giúp tui một repo");
    await client.waitFor(asked, "the approval question");
    sayFor(adapter, "không cho phép đâu");

    await client.waitFor(said("Đã từ chối. Không có gì được chạy."), "the refusal");
    expect(calls.map((call) => call.decision)).toEqual(["denied"]);
  });

  it("asks again when the answer could have meant anything, and decides nothing", async () => {
    const { adapter, client, calls } = await withProposal(async () => ({ ok: true, message: "" }));

    sayFor(adapter, "clone giúp tui một repo");
    await client.waitFor(asked, "the approval question");
    sayFor(adapter, "để tui suy nghĩ thêm đã");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const questions = client.received.filter(asked);
    // Asked twice, and nothing was decided: an operation that is about to run on the machine is not decided by
    // a sentence that could have meant anything.
    expect(questions.length).toBe(2);
    expect(calls).toEqual([]);
  });

  it("reports what the node said when a decision is refused", async () => {
    const { adapter, client } = await withProposal(async () => ({ ok: false, message: "đã hết hạn" }));

    sayFor(adapter, "clone giúp tui một repo");
    await client.waitFor(asked, "the approval question");
    sayFor(adapter, "ok");

    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        typeof message.control["text"] === "string" &&
        message.control["text"].includes("đã hết hạn"),
      "the node's refusal",
    );
  });
});

/**
 * What a spoken answer means.
 *
 * This decides whether a command runs, so it is a keyword match rather than a model call: a decision a
 * provider could paraphrase is a decision nobody can predict.
 */
describe("reading a spoken decision", () => {
  it("reads a refusal before a permission, because one word can contain the other", () => {
    expect(interpretDecision("không được")).toBe("denied");
    expect(interpretDecision("ừ, đồng ý")).toBe("granted");
    expect(interpretDecision("cho phép chạy đi")).toBe("granted");
    expect(interpretDecision("để tui xem lại đã")).toBeUndefined();
  });

  it("accepts the spellings a transcriber may drop the marks from", () => {
    expect(interpretDecision("dong y")).toBe("granted");
    expect(interpretDecision("tu choi")).toBe("denied");
  });
});

/**
 * Answering a question by voice.
 *
 * The same path a click takes: the session matches the words against the question's own options and hands the
 * result to the one function the HTTP route also calls. What only this suite shows is that a spoken sentence
 * becomes exactly the answer a button would have sent — the option id, not the word that was heard.
 */
describe("answering a question by voice", () => {
  const QUESTION = {
    kind: "question" as const,
    questionId: "q_1",
    questionType: "single-choice" as const,
    prompt: "Chọn môi trường triển khai.",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    allowOther: false,
    voicePrompt: "Chọn môi trường triển khai. Staging hay Production?",
  };

  const spoken = (text: string) => (message: Received): boolean =>
    !message.binary && message.control["type"] === "transcript" && message.control["text"] === text;

  async function withQuestion(): Promise<{
    adapter: FakeAdapter;
    client: ReturnType<typeof connect>;
    calls: Array<{ questionId: string; optionIds?: string[]; confirmed?: boolean }>;
  }> {
    const adapter = new FakeAdapter();
    const calls: Array<{ questionId: string; optionIds?: string[]; confirmed?: boolean }> = [];
    context = await startGateway(() => "credential", adapter, {
      answer: async () => ({
        reply: "Tui cần biết bạn muốn môi trường nào.",
        recordedMessages: 1,
        pendingInteraction: QUESTION,
      }),
      answerQuestion: async (input) => {
        calls.push({
          questionId: input.questionId,
          ...(input.optionIds === undefined ? {} : { optionIds: input.optionIds }),
          ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
        });
        return { ok: true, message: "đã ghi" };
      },
    });
    const client = connect(context.url);
    await client.opened;
    client.auth(TOKEN, CONVERSATION);
    await client.control("ready");
    return { adapter, client, calls };
  }

  it("reads the question out with its own options, and takes a spoken option as the answer", async () => {
    const { adapter, client, calls } = await withQuestion();

    sayFor(adapter, "triển khai giúp tui");
    await client.waitFor(spoken(QUESTION.voicePrompt), "the question read out loud");

    sayFor(adapter, "production");
    await client.waitFor(spoken("Đã ghi câu trả lời của bạn."), "the answer being recorded");

    expect(calls).toEqual([{ questionId: "q_1", optionIds: ["production"] }]);
  });

  it("asks again when the words do not fit the question, and records nothing", async () => {
    const { adapter, client, calls } = await withQuestion();

    sayFor(adapter, "triển khai giúp tui");
    await client.waitFor(spoken(QUESTION.voicePrompt), "the question read out loud");
    sayFor(adapter, "cái gì cũng được");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const asked = client.received.filter(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        typeof message.control["text"] === "string" &&
        message.control["text"].includes("chưa khớp được câu trả lời"),
    );
    // Asked again rather than guessed at, because a misheard choice is not recoverable the way a second question is.
    expect(asked.length).toBe(1);
    expect(calls).toEqual([]);
  });
});

/*
 * A spoken command to the application.
 *
 * The property under test is that the voice path is the same path as a click: the node's registry decides, the
 * decision travels as its own frame, and only the one executable member is acted on. The second property is that
 * a spoken quit cannot happen on one sentence, because the executable decision only ever comes back after the
 * node has spent a token.
 */
describe("a spoken command to the application", () => {
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

  const say = (adapter: FakeAdapter, text: string): void => {
    adapter.emitTranscript(text, "user", false);
    adapter.emitTranscript("", "user", true);
  };

  const OPEN_SETTINGS: AppIntentDecision = {
    kind: "intent",
    intent: { kind: "settings.open" },
    requiresConfirmation: false,
    readBack: "Tôi mở Settings nhé.",
  };

  const QUIT_QUESTION: AppIntentDecision = {
    kind: "needs-confirmation",
    intent: { kind: "app.quit" },
    readBack: "Tôi hiểu là bạn muốn thoát ứng dụng. Bạn xác nhận chứ?",
    confirmationToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  };

  /** Frames whose decision a page would act on. Nothing should produce one unless a question was answered. */
  const executableFrames = (client: ReturnType<typeof connect>): unknown[] =>
    client.received.filter(
      (message) =>
        !message.binary &&
        message.control["type"] === "app-intent" &&
        (message.control["decision"] as { kind?: string } | undefined)?.kind === "intent",
    );

  it("answers with the intent frame and never asks the agent", async () => {
    const adapter = new FakeAdapter();
    let asked = 0;
    const client = await opened(
      {
        resolveAppIntent: () => OPEN_SETTINGS,
        answer: async () => {
          asked += 1;
          return { reply: "không nên tới đây", recordedMessages: 0 };
        },
      },
      adapter,
    );

    say(adapter, "mở settings");

    const frame = await client.waitFor(
      (message) => !message.binary && message.control["type"] === "app-intent",
      "the app-intent frame",
    );
    expect(frame.binary === false && frame.control["decision"]).toEqual(OPEN_SETTINGS);
    // A command is not a question: the agent is not asked, and the decision is what gets acted on.
    expect(asked).toBe(0);
    expect(adapter.spoken).toEqual([OPEN_SETTINGS.readBack]);
  });

  it("asks before quitting and sends nothing a page could act on", async () => {
    const adapter = new FakeAdapter();
    const confirmed: unknown[] = [];
    const client = await opened(
      {
        resolveAppIntent: () => QUIT_QUESTION,
        confirmAppIntent: (input) => {
          confirmed.push(input);
          return { kind: "refused", say: "không" };
        },
      },
      adapter,
    );

    say(adapter, "thoát ứng dụng");
    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "app-intent" &&
        (message.control["decision"] as { kind?: string }).kind === "needs-confirmation",
      "the confirmation question",
    );

    // The token is on the wire, but nothing executable is, and no confirmation has been taken.
    expect(executableFrames(client)).toHaveLength(0);
    expect(confirmed).toHaveLength(0);
  });

  it("turns a spoken yes into the executable decision, and a no into nothing", async () => {
    const adapter = new FakeAdapter();
    const client = await opened(
      {
        resolveAppIntent: () => QUIT_QUESTION,
        confirmAppIntent: ({ token, decision }) =>
          decision === "granted" && token === QUIT_QUESTION.confirmationToken
            ? {
                kind: "intent",
                intent: { kind: "app.quit" },
                requiresConfirmation: false,
                readBack: "Tôi thoát ứng dụng nhé.",
              }
            : { kind: "refused", say: "Tôi đã bỏ qua câu lệnh đó." },
      },
      adapter,
    );

    say(adapter, "thoát ứng dụng");
    await client.waitFor(
      (message) =>
        !message.binary &&
        (message.control["decision"] as { kind?: string } | undefined)?.kind === "needs-confirmation",
      "the confirmation question",
    );

    say(adapter, "đồng ý");
    const granted = await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "app-intent" &&
        (message.control["decision"] as { kind?: string }).kind === "intent",
      "the executable decision",
    );
    const decided =
      granted.binary === false ? (granted.control["decision"] as { intent: { kind: string } }) : undefined;
    expect(decided?.intent.kind).toBe("app.quit");
    expect(executableFrames(client)).toHaveLength(1);
  });

  it("says it does not understand a command it cannot match, and runs nothing", async () => {
    const adapter = new FakeAdapter();
    let asked = 0;
    const refused: AppIntentDecision = { kind: "refused", say: "Tôi chưa hiểu câu lệnh đó." };
    const client = await opened(
      {
        resolveAppIntent: () => refused,
        answer: async () => {
          asked += 1;
          return { reply: "không nên tới đây", recordedMessages: 0 };
        },
      },
      adapter,
    );

    say(adapter, "mở cửa sổ trời");
    await client.waitFor(
      (message) =>
        !message.binary && message.control["type"] === "transcript" && message.control["text"] === refused.say,
      "the refusal",
    );

    // Refused means refused: no action, and the agent does not get to improvise a guess either.
    expect(asked).toBe(0);
    expect(executableFrames(client)).toHaveLength(0);
  });

  it("leaves a question that merely mentions settings to the agent", async () => {
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    const client = await opened(
      {
        resolveAppIntent: () => ({ kind: "none" }),
        answer: async ({ text }) => {
          asked.push(text);
          return { reply: "Đây là phần cài đặt của node.", recordedMessages: 2 };
        },
      },
      adapter,
    );

    say(adapter, "xem cài đặt của máy chủ này giúp tôi");
    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["text"] === "Đây là phần cài đặt của node.",
      "the agent's answer",
    );

    expect(asked).toEqual(["xem cài đặt của máy chủ này giúp tôi"]);
    expect(executableFrames(client)).toHaveLength(0);
  });

  it("reads a spoken command as an unclear answer while an approval is waiting", async () => {
    const adapter = new FakeAdapter();
    const resolved: string[] = [];
    const decisions: string[] = [];
    let turns = 0;
    const client = await opened(
      {
        resolveAppIntent: ({ text }) => {
          resolved.push(text);
          // Only a sentence that really is a command maps to one. The first sentence is a work request, so the
          // registry passes it on: this test is about the ordering, not about matching.
          return text.includes("settings") ? OPEN_SETTINGS : { kind: "none" };
        },
        answer: async () => {
          turns += 1;
          return turns === 1
            ? {
                reply: "Tui cần bạn duyệt lệnh này.",
                recordedMessages: 2,
                pendingInteraction: { kind: "approval", approvalId: "appr_1", digest: "digest", description: "chạy lệnh" },
              }
            : { reply: "xong", recordedMessages: 1 };
        },
        decideApproval: async ({ decision }) => {
          decisions.push(decision);
          return { ok: true, message: "Đã duyệt." };
        },
      },
      adapter,
    );

    say(adapter, "chạy lệnh này giúp tui");
    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["text"] === "chạy lệnh. Bạn cho phép chạy hay là không?",
      "the approval question",
    );

    // Now a sentence that would otherwise open Settings. It has to be read as an answer to the question that is
    // already waiting, because an operation about to run on the machine is the more dangerous of the two, and a
    // sentence must not be able to decide both.
    say(adapter, "mở settings");
    await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        String(message.control["text"]).includes("Tui chưa rõ ý bạn"),
      "the ask-again sentence",
    );

    // The registry saw the first sentence, which was not a command. The second one never reached it: a
    // sentence said while a question is waiting is an answer to that question and nothing else.
    expect(resolved).toEqual(["chạy lệnh này giúp tui"]);
    expect(decisions).toEqual([]);
    expect(executableFrames(client)).toHaveLength(0);
  });
});

describe("a lease whose peer cannot be reached", () => {
  it("is released, because one vanished peer would otherwise hold the node's only slot forever", async () => {
    /*
     * Measured before this existed: with a proxy frozen in the middle — the peer gone, this side's socket still
     * open — the next session was refused `VOICE_SESSION_BUSY` naming the gone peer, and only a restart changed
     * that. The socket is real here and the peer is made unreachable by pausing it, which is what a frozen path
     * looks like from the node: connected, silent, never closing.
     */
    const adapter = new FakeAdapter();
    context = await startGateway(() => "key", adapter, { heartbeatMs: 40 });
    const gone = connect(context.url);
    await gone.opened;
    gone.auth(TOKEN);
    await gone.control("ready");
    expect(context.gateway.activeSessionCount()).toBe(1);

    // No close frame and no FIN: the peer stops reading, so it never answers a ping.
    gone.ws.pause();

    const released = Date.now() + 3000;
    while (context.gateway.activeSessionCount() > 0 && Date.now() < released) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // What matters is not the count but the slot: somebody else has to be let in.
    expect(context.gateway.activeSessionCount()).toBe(0);
    const next = connect(context.url);
    await next.opened;
    next.auth(TOKEN);
    const ready = await next.control("ready");
    expect(ready.binary === false && ready.control["type"]).toBe("ready");
  });

  it("is kept while the peer keeps answering, so a live session is never ended for being quiet", async () => {
    /*
     * The other half of the same rule, and the half that would do damage if it were wrong: a heartbeat that ends
     * live sessions is worse than the leak it fixes. Nothing is sent from the page across these intervals — the
     * pong is the transport's own, which is also why a browser answers it with its tab in the background.
     */
    const adapter = new FakeAdapter();
    context = await startGateway(() => "key", adapter, { heartbeatMs: 20 });
    const live = connect(context.url);
    await live.opened;
    live.auth(TOKEN);
    await live.control("ready");

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(context.gateway.activeSessionCount()).toBe(1);
    expect(adapter.disconnected).toBe(0);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("a spoken sentence with nowhere to be answered", () => {
  it("is answered by saying so, instead of being transcribed and dropped", async () => {
    /*
     * The failure this replaces was silent: the words were transcribed, `ask` returned early because the session had
     * no conversation, and nothing else happened. No reply, no error, and a surface that read "listening" — which is
     * what a person reports as "voice does not work" while every other layer checks out.
     *
     * Measured on the real path: the same audio with a conversation bound produced the agent's answer and 468 KB of
     * speech back; without one it produced neither.
     */
    const adapter = new FakeAdapter();
    const asked: string[] = [];
    context = await startGateway(() => "key", adapter, {
      answer: async ({ text }) => {
        asked.push(text);
        return undefined;
      },
    });

    const client = connect(context.url);
    await client.opened;
    // No conversation id: the session is not bound to one.
    client.auth(TOKEN);
    await client.control("ready");

    sayFor(adapter, "xin chào");

    const said = await client.waitFor(
      (message) =>
        !message.binary &&
        message.control["type"] === "transcript" &&
        message.control["final"] === true &&
        String(message.control["text"]).includes("chưa gắn với hội thoại"),
      "the explanation that there is nowhere to answer",
    );

    // Spoken as well as written: the person is in a voice session and is owed the reason out loud.
    expect(adapter.spoken.join(" ")).toContain("chưa gắn với hội thoại");
    expect(said.binary === false && typeof said.control["text"]).toBe("string");
    // The agent is never asked: there is no conversation for an answer to belong to.
    expect(asked).toEqual([]);
  });
});
