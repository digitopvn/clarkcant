import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RealPiAdapter, type RealPiAdapterOptions } from "../src/index.ts";

/**
 * A steer that lands after Pi's agent loop last read its queue stays queued once the run settles, and the adapter sends
 * it again as a prompt. A Pi extension's message queued in that same window sits in the agent's queue next to it, with
 * no text copy in the session; sending the steers again must not throw it away, and must not send anything twice.
 *
 * Driven through the real SDK: its session queues the steer and keeps its copy, its agent holds the extension's message
 * and its loop builds the provider requests. Only the stream function is replaced, so each request is captured and
 * nothing is sent.
 */

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

let root: string;
let cwd: string;
let agentDir: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarkcant-late-steer-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // The loader also reads the person's own folders under their home: moved into the temporary directory.
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

interface QueuedMessage {
  role: string;
  [key: string]: unknown;
}

interface Session {
  /** The session's own follow-up, as the person's follow-up is queued: with a text copy kept by the session. */
  followUp: (text: string) => Promise<void>;
  /** The session's own steer, which takes pictures as well; the adapter's steer takes text only. */
  steer: (text: string, images?: { type: "image"; data: string; mimeType: string }[]) => Promise<void>;
  agent: {
    streamFunction: unknown;
    steeringMode: string;
    followUpMode: string;
    steer: (message: QueuedMessage) => void;
    followUp: (message: QueuedMessage) => void;
    hasQueuedMessages: () => boolean;
    peekQueuedMessages: () => QueuedMessage[];
  };
}

interface Harness {
  /** What each provider request added after the last answer, as JSON, in order. */
  sent: string[];
  /** Every whole provider request, system prompt included, as JSON, in order. */
  requests: string[];
  /** Every text the extension's input handler was given, in order. */
  inputs: string[];
  session?: Session;
}

/** What the extension's input handler adds to every text it is given, so the text it made can be told apart. */
const HANDLED = " [handled]";

/** What another extension's `before_agent_start` handler adds to the system prompt of every run. */
const THIRD_PARTY_FRAGMENT = "THIRD-PARTY-FRAGMENT";

/**
 * The real SDK, with the model catalogue read without a network refresh and each session's stream function replaced by
 * one that records the request and answers at once. The session is kept, so a test can queue on it as Pi does.
 *
 * Every session also loads an inline extension with an input handler, as a Pi extension registers one: it records the
 * text it is given and hands it on with a marker added. Another extension adds a fragment to each run's system prompt
 * from `before_agent_start`, as a third-party extension may.
 */
async function realSdk(harness: Harness): Promise<NonNullable<RealPiAdapterOptions["sdk"]>> {
  const sdk = (await import(SDK_PACKAGE)) as unknown as Record<string, unknown> & {
    ModelRuntime: { create: (options: Record<string, unknown>) => Promise<unknown> };
    createAgentSession: (options: unknown) => Promise<{ session: Session }>;
    DefaultResourceLoader: new (options: Record<string, unknown>) => object;
  };
  const inputCounter = {
    name: "late-steer-input-counter",
    factory: (api: { on: (event: string, handler: (event: { text: string }) => unknown) => void }) => {
      api.on("input", (event) => {
        harness.inputs.push(event.text);
        return { action: "transform", text: `${event.text}${HANDLED}` };
      });
    },
  };
  const systemPromptFragment = {
    name: "late-steer-system-prompt-fragment",
    factory: (api: { on: (event: string, handler: (event: { systemPrompt: string }) => unknown) => void }) => {
      api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${THIRD_PARTY_FRAGMENT}` }));
    },
  };
  class CountingLoader extends sdk.DefaultResourceLoader {
    constructor(options: Record<string, unknown>) {
      const factories = (options.extensionFactories as unknown[] | undefined) ?? [];
      super({ ...options, extensionFactories: [...factories, inputCounter, systemPromptFragment] });
    }
  }
  const stream = (model: { api: string; provider: string; id: string }, context: { messages: { role?: string }[] }) => {
    const lastAnswer = context.messages.findLastIndex((message) => message.role === "assistant");
    harness.sent.push(JSON.stringify(context.messages.slice(lastAnswer + 1)));
    harness.requests.push(JSON.stringify(context));
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    return {
      result: async () => message,
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
      },
    };
  };
  return {
    ...sdk,
    DefaultResourceLoader: CountingLoader,
    ModelRuntime: {
      create: (options: Record<string, unknown>) =>
        sdk.ModelRuntime.create({ ...options, modelsPath: null, refreshOnCreate: false }),
    },
    createAgentSession: async (options: unknown) => {
      const created = await sdk.createAgentSession(options);
      created.session.agent.streamFunction = stream;
      harness.session = created.session;
      return created;
    },
  } as unknown as NonNullable<RealPiAdapterOptions["sdk"]>;
}

/** A provider and model from the SDK's own catalogue, so the session resolves a real model without any account. */
async function catalogueModel(sdk: NonNullable<RealPiAdapterOptions["sdk"]>): Promise<{ provider: string; id: string }> {
  const runtime = (await (sdk.ModelRuntime as unknown as { create: (options: object) => Promise<unknown> }).create({})) as {
    getProviders: () => { id: string }[];
    getModels: (provider: string) => { id: string }[];
  };
  for (const provider of runtime.getProviders()) {
    const model = runtime.getModels(provider.id)[0];
    if (model !== undefined) return { provider: provider.id, id: model.id };
  }
  throw new Error("the SDK's catalogue offers no model");
}

/** A message as a Pi extension's `sendMessage` puts it in the agent's queue while a reply streams. */
function extensionMessage(text: string): QueuedMessage {
  return { role: "custom", customType: "reminder", content: text, display: true, timestamp: Date.now() };
}

/** How many times `text` reached the model across the requests after `from`. */
function timesSent(harness: Harness, from: number, text: string): number {
  return harness.sent.slice(from).reduce((count, request) => count + request.split(text).length - 1, 0);
}

/** The index of the first request after `from` that carried `text`. */
function requestOf(harness: Harness, from: number, text: string): number {
  return harness.sent.findIndex((request, index) => index >= from && request.includes(text));
}

/** Where `text` first reached the model, across the requests after `from` read one after another. */
function positionOf(harness: Harness, from: number, text: string): number {
  return harness.sent.slice(from).join("\n").indexOf(text);
}

async function answeredSession(
  options: Partial<RealPiAdapterOptions> = {},
): Promise<{ adapter: RealPiAdapter; sessionId: string; harness: Harness; session: Session }> {
  const harness: Harness = { sent: [], requests: [], inputs: [] };
  const sdk = await realSdk(harness);
  const model = await catalogueModel(sdk);
  const adapter = new RealPiAdapter({ cwd, agentDir, model, apiKey: "test-only-key", sdk, ...options });
  const handle = await adapter.createWorkerSession({ goal: "answer", projectRoots: [], allowedCapabilityRefs: [] });
  await adapter.prompt(handle.sessionId, "first question");
  const session = harness.session;
  if (session === undefined) throw new Error("the SDK created no session");
  return { adapter, sessionId: handle.sessionId, harness, session };
}

describe("late steers sent again after a turn", () => {
  it("also send what an extension queued while the reply streamed, each once and in the order Pi would have", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    // What the run left behind: the person's late steers and follow-up, with an extension's steers and follow-ups
    // queued among them.
    await adapter.steer(sessionId, "person steer one");
    await adapter.steer(sessionId, "person steer two");
    session.agent.steer(extensionMessage("extension steer one"));
    await adapter.steer(sessionId, "person steer three");
    session.agent.steer(extensionMessage("extension steer two"));
    await session.followUp("person follow-up");
    session.agent.followUp(extensionMessage("extension follow-up one"));
    session.agent.followUp(extensionMessage("extension follow-up two"));
    const order = [
      "person steer one",
      "person steer two",
      "extension steer one",
      "person steer three",
      "extension steer two",
      "person follow-up",
      "extension follow-up one",
      "extension follow-up two",
    ];

    await adapter.continueQueued(sessionId);

    for (const text of order) expect(timesSent(harness, before, text), text).toBe(1);
    const positions = order.map((text) => positionOf(harness, before, text));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The person's leading steers go as one prompt; the steers after them each wait for a reply, one at a time.
    expect(requestOf(harness, before, "person steer two")).toBe(requestOf(harness, before, "person steer one"));
    expect(requestOf(harness, before, "person steer three")).toBeGreaterThan(requestOf(harness, before, "extension steer one"));
    // A follow-up stays a follow-up: it waits for a reply after the last steer.
    expect(requestOf(harness, before, "person follow-up")).toBeGreaterThan(requestOf(harness, before, "extension steer two"));
    expect(requestOf(harness, before, "extension follow-up one")).toBeGreaterThan(requestOf(harness, before, "extension steer two"));
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);

  it("answer an extension's message queued before the person's steer before that steer", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    session.agent.steer(extensionMessage("file X changed on disk"));
    await adapter.steer(sessionId, "now fix it");

    await adapter.continueQueued(sessionId);

    expect(timesSent(harness, before, "file X changed on disk")).toBe(1);
    expect(timesSent(harness, before, "now fix it")).toBe(1);
    expect(positionOf(harness, before, "file X changed on disk")).toBeLessThan(positionOf(harness, before, "now fix it"));
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);

  it("start a run on an extension's message when no steer of the person's is left, and leave the queue modes as they were", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;
    session.agent.followUpMode = "all";

    session.agent.steer(extensionMessage("extension note alone"));
    session.agent.followUp(extensionMessage("extension follow-up alone"));

    await adapter.continueQueued(sessionId);

    expect(timesSent(harness, before, "extension note alone")).toBe(1);
    expect(timesSent(harness, before, "extension follow-up alone")).toBe(1);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(session.agent.steeringMode).toBe("one-at-a-time");
    expect(session.agent.followUpMode).toBe("all");
    await adapter.dispose(sessionId);
  }, 60_000);

  it("skip a queued message it cannot start a run with, say so, and start the run on the next one in the same call", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    try {
      session.agent.steer({ role: "user", content: [], timestamp: Date.now() });
      session.agent.steer(extensionMessage("extension note after it"));

      // One call, as the runtime's drain loop makes: it stops at the first failure, so the rest must go now.
      await adapter.continueQueued(sessionId);

      expect(timesSent(harness, before, "extension note after it")).toBe(1);
      expect(session.agent.hasQueuedMessages()).toBe(false);
      expect(warnings).toHaveBeenCalledWith(expect.stringMatching(/dropped 1 queued message\(s\) with nothing to send \(user\)/));
    } finally {
      warnings.mockRestore();
    }
    await adapter.dispose(sessionId);
  }, 60_000);

  it("fail, naming what it dropped, only when nothing sendable is left, with the queue empty", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    session.agent.steer({ role: "user", content: [], timestamp: Date.now() });
    session.agent.followUp({ role: "user", content: "", timestamp: Date.now() });

    await expect(adapter.continueQueued(sessionId)).rejects.toThrow(/dropped 2 queued message\(s\).*nothing sendable was left/);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(harness.sent.length).toBe(before);
    await adapter.dispose(sessionId);
  }, 60_000);
});

/** A one-pixel PNG: a picture the SDK's image normalisation accepts. */
const PIXEL = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

/** How many pictures reached the model across the requests after `from`. */
function picturesSent(harness: Harness, from: number): number {
  return harness.sent.slice(from).reduce((count, request) => count + request.split('"type":"image"').length - 1, 0);
}

describe("late steers with pictures sent again after a turn", () => {
  it("keep the picture a steer carried", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    await session.steer("look at this screenshot", [PIXEL]);

    await adapter.continueQueued(sessionId);

    expect(timesSent(harness, before, "look at this screenshot")).toBe(1);
    expect(picturesSent(harness, before)).toBe(1);
    const request = harness.sent[requestOf(harness, before, "look at this screenshot")] ?? "";
    expect(request).toContain('"type":"image"');
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);

  it("send a steer that is only a picture as that picture, not as an empty sentence", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    await session.steer("", [PIXEL]);

    await adapter.continueQueued(sessionId);

    expect(picturesSent(harness, before)).toBe(1);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);
});

describe("late steers sent again after a turn, with an extension's input handler", () => {
  it("run the handler once per steer, when it was steered, and send the text it made", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;
    const steers = ["late steer one", "late steer two", "late steer with a picture"];

    await adapter.steer(sessionId, "late steer one");
    await adapter.steer(sessionId, "late steer two");
    await session.steer("late steer with a picture", [PIXEL]);
    const handledWhenSteered = harness.inputs.slice(1);

    await adapter.continueQueued(sessionId);

    // The first question went through the handler when it was prompted; each steer once more, and only then.
    expect(handledWhenSteered).toEqual(steers);
    expect(harness.inputs.slice(1)).toEqual(steers);
    for (const text of steers) {
      expect(timesSent(harness, before, `${text}${HANDLED}`), text).toBe(1);
      expect(timesSent(harness, before, `${text}${HANDLED}${HANDLED}`), text).toBe(0);
    }
    expect(picturesSent(harness, before)).toBe(1);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);
});

describe("late steers sent again after a turn keep the run's system prompt", () => {
  const PERSONAL = "PERSONAL-MARKER";

  it("carry the person's instructions and another extension's system prompt fragment", async () => {
    const { adapter, sessionId, harness } = await answeredSession({ personalInstructions: () => PERSONAL });
    const before = harness.requests.length;

    await adapter.steer(sessionId, "late steer for the system prompt");
    await adapter.continueQueued(sessionId);

    const resent = harness.requests.slice(before);
    expect(resent.length).toBeGreaterThan(0);
    for (const request of resent) {
      expect(request).toContain(PERSONAL);
      expect(request).toContain(THIRD_PARTY_FRAGMENT);
    }
    expect(timesSent(harness, harness.sent.length - resent.length, `late steer for the system prompt${HANDLED}`)).toBe(1);
    await adapter.dispose(sessionId);
  }, 60_000);

  it("fall back to the public prompt when a member it mirrors has another shape, still sending the steer with its instructions", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession({ personalInstructions: () => PERSONAL });
    const before = harness.requests.length;
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    // As an SDK whose private members changed shape would look: the pending next-turn messages held in a set rather
    // than an array, which the SDK's own prompt still iterates but the mirrored sequence does not take.
    (session as unknown as { _pendingNextTurnMessages: unknown })._pendingNextTurnMessages = new Set();

    try {
      await adapter.steer(sessionId, "late steer on the fallback");
      await adapter.continueQueued(sessionId);
      await adapter.steer(sessionId, "second late steer on the fallback");
      await adapter.continueQueued(sessionId);

      const resent = harness.requests.slice(before);
      expect(resent.join("\n")).toContain("late steer on the fallback");
      expect(resent.join("\n")).toContain("second late steer on the fallback");
      for (const request of resent) expect(request).toContain(PERSONAL);
      expect(session.agent.hasQueuedMessages()).toBe(false);
      // Once per adapter, however many steers take the fallback.
      expect(warnings.mock.calls.filter(([message]) => String(message).includes("private members"))).toHaveLength(1);
    } finally {
      warnings.mockRestore();
    }
    await adapter.dispose(sessionId);
  }, 60_000);

  it("refuse to start while the session still streams, leaving the queue as it was", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;
    await adapter.steer(sessionId, "steer while streaming");
    Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

    try {
      await expect(adapter.continueQueued(sessionId)).rejects.toThrow(/still running; its queued messages stay queued/);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      expect(harness.sent.length).toBe(before);
    } finally {
      delete (session as unknown as { isStreaming?: unknown }).isStreaming;
    }
    await adapter.continueQueued(sessionId);
    expect(timesSent(harness, before, `steer while streaming${HANDLED}`)).toBe(1);
    await adapter.dispose(sessionId);
  }, 60_000);
});