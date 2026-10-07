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
  agent: {
    streamFunction: unknown;
    steer: (message: QueuedMessage) => void;
    followUp: (message: QueuedMessage) => void;
    hasQueuedMessages: () => boolean;
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
  it("also send what an extension queued while the reply streamed, each exactly once", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    // What the run left behind: the person's late steer, and an extension's steer and follow-up queued beside it.
    await adapter.steer(sessionId, "late steer from the person");
    session.agent.steer(extensionMessage("extension steer note"));
    session.agent.followUp(extensionMessage("extension follow-up note"));

    await adapter.continueQueued(sessionId);

    expect(timesSent(harness, before, "late steer from the person")).toBe(1);
    expect(timesSent(harness, before, "extension steer note")).toBe(1);
    expect(timesSent(harness, before, "extension follow-up note")).toBe(1);
    // The extension's follow-up waits for the steers, as a follow-up does.
    const joined = harness.sent.slice(before).join("\n");
    expect(joined.indexOf("extension steer note")).toBeLessThan(joined.indexOf("extension follow-up note"));
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);

  it("start a run on an extension's message when no steer of the person's is left", async () => {
    const { adapter, sessionId, harness, session } = await answeredSession();
    const before = harness.sent.length;

    session.agent.steer(extensionMessage("extension note alone"));

    await adapter.continueQueued(sessionId);

    expect(timesSent(harness, before, "extension note alone")).toBe(1);
    expect(session.agent.hasQueuedMessages()).toBe(false);
    await adapter.dispose(sessionId);
  }, 60_000);
});
