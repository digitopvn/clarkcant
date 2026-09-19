import { describe, expect, it } from "vitest";

import { RealPiAdapter, type RealPiAdapterOptions } from "../src/index.ts";

/**
 * The personal-instructions callback, wired into the real adapter.
 *
 * Two claims, and neither can be checked from the composition module alone:
 *
 *   - the callback actually reaches the resource loader as an inline extension, rather than being a
 *     function this adapter accepts and drops;
 *   - the handler the extension registers appends a section to the prompt the SDK composed, so the
 *     product and security instructions survive.
 *
 * The second is the one that matters. A wiring mistake here would look like a feature that works —
 * the user's text would reach the model — while quietly having replaced the tool and security
 * instructions that came before it.
 *
 * The callback is deliberately read *per call* rather than once, because that is the promise of the
 * feature: a preference written while the app is open reaches the next turn, not the next session.
 */

/** A stand-in for the prompt the SDK assembles, with the instructions that must survive. */
const BASE_PROMPT = [
  "You are ClarkCant.",
  "",
  "## Product invariants",
  "",
  "Conversation is the primary surface.",
  "",
  "## Security",
  "",
  "Never print a credential.",
].join("\n");

/**
 * A stub SDK that behaves like the real one where it matters here.
 *
 * It records the loader options so a test can see what the adapter passed, and it calls the inline
 * factory with an api whose `on` registers a handler — the same shape the real SDK uses, verified
 * separately against the installed package by the compatibility spec.
 */
function stubSdk() {
  const registered = new Map<string, (event: { systemPrompt: string }) => { systemPrompt: string }>();
  const loaderOptions: Record<string, unknown>[] = [];

  class StubLoader {
    constructor(options: Record<string, unknown>) {
      loaderOptions.push(options);
    }

    async reload(): Promise<void> {
      for (const entry of (this as unknown as { factories?: { factory: (api: unknown) => void }[] }).factories ?? []) {
        entry.factory({
          on: (event: string, handler: (event: { systemPrompt: string }) => { systemPrompt: string }) => {
            registered.set(event, handler);
          },
        });
      }
    }
  }

  // The options object is captured on construction; the factories are read back out of it on reload so
  // the stub does not need to duplicate the adapter's field names.
  const module_ = {
    getAgentDir: () => process.cwd(),
    DefaultResourceLoader: class extends StubLoader {
      constructor(options: Record<string, unknown>) {
        super(options);
        // Hand the recorded factories to the base class so `reload` can call them.
        (this as unknown as { factories?: unknown }).factories = options.extensionFactories;
      }
    },
    SessionManager: { inMemory: () => ({}), create: () => ({}) },
    createAgentSession: async () => ({
      session: {
        sessionId: "pi-session-stub",
        sessionFile: undefined,
        subscribe: () => () => undefined,
        prompt: async () => undefined,
        abort: async () => undefined,
        dispose: () => undefined,
        agent: { state: { tools: [] }, waitForIdle: async () => undefined },
      },
    }),
    ModelRuntime: { create: async () => ({ getModels: () => [], getProviders: () => [] }) },
  };

  return { module: module_, registered, loaderOptions };
}

function adapterWith(sdk: ReturnType<typeof stubSdk>, personalInstructions?: () => string | undefined): RealPiAdapter {
  // SAFETY: the stub implements exactly the SDK surface this adapter touches. TypeScript cannot verify a
  // deliberate partial stand-in against the SDK's whole module type, and loading the real SDK here would
  // turn a wiring assertion into a provider call.
  return new RealPiAdapter({
    cwd: process.cwd(),
    ...(personalInstructions === undefined ? {} : { personalInstructions }),
    sdk: sdk.module as unknown as NonNullable<RealPiAdapterOptions["sdk"]>,
  });
}

describe("the callback reaches the loader as an inline extension", () => {
  it("registers exactly one named, hidden factory", async () => {
    const sdk = stubSdk();
    await adapterWith(sdk, () => "Prefer concise answers.").createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });

    const options = sdk.loaderOptions.at(0);
    const factories = options?.extensionFactories as { name?: string; hidden?: boolean }[] | undefined;
    expect(factories).toHaveLength(1);
    expect(factories?.[0]?.name).toBe("clark-personal-instructions");
    // Hidden, so a list of "extensions on this machine" does not invite somebody to disable the feature
    // they just configured.
    expect(factories?.[0]?.hidden).toBe(true);
  });

  it("registers no factory at all when nothing supplies instructions", async () => {
    const sdk = stubSdk();
    await adapterWith(sdk).createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    // An absent callback is the state of a node with no personal instructions configured, and the loader
    // should be exactly as it was rather than carrying a factory that contributes nothing.
    expect(sdk.loaderOptions.at(0)?.extensionFactories).toBeUndefined();
  });

  it("registers a before_agent_start handler, which is the hook the section is appended in", async () => {
    const sdk = stubSdk();
    await adapterWith(sdk, () => "Prefer concise answers.").createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });
    expect([...sdk.registered.keys()]).toEqual(["before_agent_start"]);
  });
});

describe("the handler appends to the prompt the SDK composed", () => {
  it("keeps the product and security instructions and adds the user's after them", async () => {
    const sdk = stubSdk();
    await adapterWith(sdk, () => "Use TypeScript for code examples.").createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });

    const handler = sdk.registered.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = handler?.({ systemPrompt: BASE_PROMPT });
    const composed = result?.systemPrompt ?? "";

    // The instructions that must survive, in their original order.
    expect(composed).toContain("## Product invariants");
    expect(composed).toContain("## Security");
    expect(composed).toContain("Never print a credential.");
    expect(composed.startsWith(BASE_PROMPT)).toBe(true);

    // And the user's text, after them.
    expect(composed.indexOf("## Personal instructions")).toBeGreaterThan(composed.indexOf("## Security"));
    expect(composed).toContain("Use TypeScript for code examples.");
  });

  it("returns the base prompt untouched when the preference is empty", async () => {
    const sdk = stubSdk();
    await adapterWith(sdk, () => undefined).createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });
    const handler = sdk.registered.get("before_agent_start");
    expect(handler?.({ systemPrompt: BASE_PROMPT }).systemPrompt).toBe(BASE_PROMPT);
  });

  it("reads the callback on every turn, so a change reaches the next one", async () => {
    // The whole promise of the feature: writing a preference while the app is open must reach the next
    // turn. A callback captured once at session creation would make it a restart instead.
    const sdk = stubSdk();
    let current = "First version.";
    await adapterWith(sdk, () => current).createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });

    const handler = sdk.registered.get("before_agent_start");
    expect(handler?.({ systemPrompt: BASE_PROMPT }).systemPrompt).toContain("First version.");

    current = "Second version.";
    const next = handler?.({ systemPrompt: BASE_PROMPT }).systemPrompt ?? "";
    expect(next).toContain("Second version.");
    // And exactly one section, because the handler composes from the base it is given rather than from
    // its own previous output.
    expect(next.split("## Personal instructions").length - 1).toBe(1);
  });

  it("does not put the user's text into the turn's prompt", async () => {
    /*
     * The user's instructions belong in the system prompt, not prefixed onto the message. Asserted because
     * prefixing the user prompt is the tempting shortcut, and it is the one the plan forbids: it would make
     * the text look like part of the user's own request, and it would not be replaced between turns.
     */
    const sdk = stubSdk();
    const prompts: string[] = [];
    const adapter = new RealPiAdapter({
      cwd: process.cwd(),
      personalInstructions: () => "SECRET-PREFERENCE-TEXT",
      sdk: {
        ...sdk.module,
        createAgentSession: async () => ({
          session: {
            sessionId: "s",
            sessionFile: undefined,
            subscribe: () => () => undefined,
            prompt: async (text: string) => {
              prompts.push(text);
            },
            abort: async () => undefined,
            dispose: () => undefined,
            agent: { state: { tools: [] }, waitForIdle: async () => undefined },
          },
        }),
      } as unknown as NonNullable<RealPiAdapterOptions["sdk"]>,
    });

    const handle = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    await adapter.prompt(handle.sessionId, "what is the weather");

    expect(prompts).toEqual(["what is the weather"]);
    expect(prompts.join("")).not.toContain("SECRET-PREFERENCE-TEXT");
  });
});
