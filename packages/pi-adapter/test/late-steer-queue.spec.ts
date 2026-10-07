import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  session?: Session;
}

/**
 * The real SDK, with the model catalogue read without a network refresh and each session's stream function replaced by
 * one that records the request and answers at once. The session is kept, so a test can queue on it as Pi does.
 */
async function realSdk(harness: Harness): Promise<NonNullable<RealPiAdapterOptions["sdk"]>> {
  const sdk = (await import(SDK_PACKAGE)) as unknown as Record<string, unknown> & {
    ModelRuntime: { create: (options: Record<string, unknown>) => Promise<unknown> };
    createAgentSession: (options: unknown) => Promise<{ session: Session }>;
  };
  const stream = (model: { api: string; provider: string; id: string }, context: { messages: { role?: string }[] }) => {
    const lastAnswer = context.messages.findLastIndex((message) => message.role === "assistant");
    harness.sent.push(JSON.stringify(context.messages.slice(lastAnswer + 1)));
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

async function answeredSession(): Promise<{ adapter: RealPiAdapter; sessionId: string; harness: Harness; session: Session }> {
  const harness: Harness = { sent: [] };
  const sdk = await realSdk(harness);
  const model = await catalogueModel(sdk);
  const adapter = new RealPiAdapter({ cwd, agentDir, model, apiKey: "test-only-key", sdk });
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

  it("drop a queued message it cannot start a run with, and say so, so a drain loop still finishes", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    session.agent.steer({ role: "user", content: [], timestamp: Date.now() });
    session.agent.steer(extensionMessage("extension note after it"));

    await expect(adapter.continueQueued(sessionId)).rejects.toThrow(/queued user message with nothing to send.*dropped/);
    // Only the message that could not start a run is gone; the next call sends the rest.
    expect(session.agent.peekQueuedMessages()).toEqual([expect.objectContaining({ customType: "reminder" })]);
    expect(harness.sent.length).toBe(before);

    await adapter.continueQueued(sessionId);
    expect(timesSent(harness, before, "extension note after it")).toBe(1);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);
});
