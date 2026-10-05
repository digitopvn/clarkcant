import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type DataClass, checkSendBoundary } from "@clarkcant/contracts";

import { RealPiAdapter, type RealPiAdapterOptions, type WorkerBrief } from "../src/index.ts";

/**
 * A message that starts with `/skill:<name>` is expanded by the SDK, in its own prompt and steer, into the skill's file
 * read from disk. The host checks the message it typed, not that file, so what holds the file to the session's model is
 * the session's context guard: the loader leaves out a skill whose file the model may not receive, and the adapter
 * checks the file again when such a message is sent.
 *
 * Driven through the real SDK: its loader discovers the skill, its session expands the command, and its agent loop
 * builds the provider request. Only the stream function is replaced, so the request is captured and nothing is sent.
 */

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
/** Assembled from parts, so a secret scanner reading this file sees no credential. */
const CREDENTIAL = ["sk", "_live_", "4f9aK2mX8qL3vB7nR1tY6wZ0"].join("");
const NARROW: readonly DataClass[] = ["public", "internal"];
const EVERY: readonly DataClass[] = ["public", "internal", "confidential", "secret"];

let root: string;
let cwd: string;
let agentDir: string;
let skillFile: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function writeSkill(body: string): void {
  writeFileSync(skillFile, `---\nname: deploy\ndescription: Deploy the service.\n---\n\n${body}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarkcant-skill-command-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "deploy"), { recursive: true });
  skillFile = join(agentDir, "skills", "deploy", "SKILL.md");
  // The loader also reads the person's own skill folders under their home: moved into the temporary directory, so the
  // session sees only the skill written here.
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

interface Captured {
  /** The user text of every provider request the session built, in order. */
  sent: string[];
}

/**
 * The real SDK, with the model catalogue read without a network refresh and each session's stream function replaced by
 * one that records the request and answers at once.
 */
async function realSdkCapturing(captured: Captured): Promise<NonNullable<RealPiAdapterOptions["sdk"]>> {
  const sdk = (await import(SDK_PACKAGE)) as unknown as Record<string, unknown> & {
    ModelRuntime: { create: (options: Record<string, unknown>) => Promise<unknown> };
    createAgentSession: (options: unknown) => Promise<{ session: { agent: { streamFunction: unknown } } }>;
  };
  const stream = (model: { api: string; provider: string; id: string }, context: { messages: unknown[] }) => {
    const users = context.messages.filter((message) => (message as { role?: string }).role === "user");
    captured.sent.push(JSON.stringify(users.at(-1) ?? null));
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

/** The guard a host holds a session to: what the session's model may receive. */
function guardFor(allowed: readonly DataClass[]): NonNullable<WorkerBrief["contextGuard"]> {
  return ({ text }) => checkSendBoundary({ allowed, texts: [text] }).ok;
}

async function promptSkill(allowed: readonly DataClass[], before?: () => void): Promise<string> {
  const captured: Captured = { sent: [] };
  const sdk = await realSdkCapturing(captured);
  const model = await catalogueModel(sdk);
  const adapter = new RealPiAdapter({ cwd, agentDir, model, apiKey: "test-only-key", sdk });
  const handle = await adapter.createWorkerSession({
    goal: "deploy",
    projectRoots: [],
    allowedCapabilityRefs: [],
    contextGuard: guardFor(allowed),
  });
  before?.();
  await adapter.prompt(handle.sessionId, "/skill:deploy to staging");
  await adapter.dispose(handle.sessionId);
  expect(captured.sent).toHaveLength(1);
  return captured.sent[0] ?? "";
}

describe("a /skill: message on the real SDK", () => {
  it("is not expanded into a body the session's model may not receive", async () => {
    writeSkill(`Sign in with the key ${CREDENTIAL} before you deploy.`);
    const sent = await promptSkill(NARROW);
    expect(sent).not.toContain(CREDENTIAL);
    expect(sent).not.toContain("<skill name=");
    // The message goes as the person typed it, which the host's own check already covered.
    expect(sent).toContain("/skill:deploy to staging");
  }, 60_000);

  it("is expanded for a model that may receive the body", async () => {
    writeSkill(`Sign in with the key ${CREDENTIAL} before you deploy.`);
    const sent = await promptSkill(EVERY);
    expect(sent).toContain('<skill name=\\"deploy\\"');
    expect(sent).toContain(CREDENTIAL);
    expect(sent).toContain("to staging");
  }, 60_000);

  it("is checked on the file as it is when the message is sent, not as it was when the session started", async () => {
    writeSkill("Run the deploy script.");
    const sent = await promptSkill(NARROW, () => writeSkill(`Sign in with the key ${CREDENTIAL} before you deploy.`));
    expect(sent).not.toContain(CREDENTIAL);
    expect(sent).not.toContain("<skill name=");
  }, 60_000);
});
