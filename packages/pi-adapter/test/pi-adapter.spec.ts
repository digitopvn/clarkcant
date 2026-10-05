import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterAll, beforeAll } from "vitest";

import {
  FakePiAdapter,
  RealPiAdapter,
  READ_ONLY_TOOLS,
  SCOPED_FS_TOOL_NAMES,
  mapPiEvent,
  type RealPiAdapterOptions,
  type ToolDefinition,
  type WorkerBrief,
} from "../src/index.ts";
import { toSdkTool } from "../src/real.ts";

describe("a tool result that carries an image", () => {
  type CapturedConfig = {
    execute?: (id: string, params: Record<string, unknown>) => Promise<{ content: unknown[] }>;
  };

  /** Run a tool through the SDK conversion and keep the config the SDK would have received. */
  function capture(tool: Parameters<typeof toSdkTool>[1]): CapturedConfig {
    const captured: CapturedConfig = {};
    const sdk = {
      defineTool: (config: unknown): unknown => {
        Object.assign(captured, config as CapturedConfig);
        return config;
      },
    };
    toSdkTool(sdk as never, tool);
    return captured;
  }

  it("hands the image to the SDK as an image block, not as a sentence about one", async () => {
    const captured = capture({
      name: "read_attachment",
      label: "Đọc một tệp đính kèm",
      description: "reads a file the user attached",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({
        text: "Ảnh “anh.png” (image/png, 4 byte) ở dưới.",
        image: { mimeType: "image/png", dataBase64: "AAAA" },
      }),
    });

    const result = await captured.execute?.("call-1", {});
    // The SDK's content union carries an image member, so the picture reaches the model as a picture.
    // A single text block here is exactly the defect this test exists to catch.
    expect(result?.content).toEqual([
      { type: "text", text: "Ảnh “anh.png” (image/png, 4 byte) ở dưới." },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("leaves a tool that read text as a single text block", async () => {
    const captured = capture({
      name: "read_attachment",
      label: "Đọc một tệp đính kèm",
      description: "reads a file the user attached",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({ text: "Nội dung của “ghi-chu.txt”:\nchi la chu" }),
    });

    const result = await captured.execute?.("call-1", {});
    expect(result?.content).toEqual([{ type: "text", text: "Nội dung của “ghi-chu.txt”:\nchi la chu" }]);
  });
});

describe("fake adapter used by CI and E2E", () => {
  it("runs a scripted turn and emits the same event shapes as the real adapter", async () => {
    const adapter = new FakePiAdapter({ script: ["the fixture file contains three records"] });
    const session = await adapter.createWorkerSession({
      goal: "summarise the fixture",
      projectRoots: ["/tmp/fixture"],
      allowedCapabilityRefs: [],
    });

    const events: string[] = [];
    adapter.subscribe(session.sessionId, (event) => events.push(event.type));
    const text = await adapter.run(session.sessionId, "summarise the fixture");

    expect(text).toContain("three records");
    expect(events).toContain("text-delta");
    expect(events).toContain("turn-end");
    // `settled` is emitted, but it is not success: only the verifier decides that.
    expect(events).toContain("settled");
  });

  it("refuses to subscribe the same listener twice (T25)", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const listener = (): void => {};
    adapter.subscribe(session.sessionId, listener);
    expect(() => adapter.subscribe(session.sessionId, listener)).toThrow(/twice/);
  });

  it("releases listeners on dispose so a swap cannot double-deliver", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    adapter.subscribe(session.sessionId, () => {});
    expect(adapter.listenerCount(session.sessionId)).toBe(1);
    await adapter.dispose(session.sessionId);
    expect(() => adapter.listenerCount(session.sessionId)).toThrow();
  });

  it("refuses to register the same tool name twice", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const tool = {
      name: "read_fixture",
      label: "Read fixture",
      description: "reads the fixture file",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "contents" }),
    };
    await adapter.registerTool(session.sessionId, tool);
    await expect(adapter.registerTool(session.sessionId, tool)).rejects.toThrow(/already registered/);
  });

  it("only runs a tool that is both registered and active", async () => {
    const adapter = new FakePiAdapter();
    const tool = (name: string) => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: name }),
    });
    const session = await adapter.createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
      customTools: [tool("a")],
    });
    // Created tools start active, as the real adapter's do; narrowing one away makes it uncallable.
    expect(await adapter.callTool(session.sessionId, "a", {})).toBe("a");
    await adapter.setActiveTools(session.sessionId, []);
    await expect(adapter.callTool(session.sessionId, "a", {})).rejects.toThrow(/not active/);
    await expect(adapter.callTool(session.sessionId, "missing", {})).rejects.toThrow();
  });

  it("keeps a tool registered after creation active, as the real adapter does", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    await adapter.registerTool(session.sessionId, {
      name: "read_fixture",
      label: "Read fixture",
      description: "reads the fixture file",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "contents" }),
    });
    expect(await adapter.callTool(session.sessionId, "read_fixture", {})).toBe("contents");
    await adapter.setActiveTools(session.sessionId, []);
    expect(adapter.activeToolNames(session.sessionId)).toEqual(["read_fixture"]);
  });

  it("activates only registered tools, and can widen again after narrowing", async () => {
    const adapter = new FakePiAdapter();
    const tool = (name: string) => ({
      name,
      label: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: name }),
    });
    const session = await adapter.createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
      customTools: [tool("a"), tool("b")],
    });
    await adapter.setActiveTools(session.sessionId, ["a", "b", "never_registered"]);
    expect(adapter.activeToolNames(session.sessionId)).toEqual(["a", "b"]);
    await adapter.setActiveTools(session.sessionId, ["a"]);
    expect(adapter.activeToolNames(session.sessionId)).toEqual(["a"]);
    await adapter.setActiveTools(session.sessionId, ["a", "b"]);
    expect(adapter.activeToolNames(session.sessionId)).toEqual(["a", "b"]);
  });

  it("reports the refresh scope it actually applied", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const applied = await adapter.refreshResources(session.sessionId, { scope: "ui", reason: "theme changed" });
    // A UI-only change must not be reported as a worker restart.
    expect(applied.applied).toBe("ui");
    expect(applied.note).toContain("ui");
  });

  it("creates a successor session on handoff without dropping the original", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const { successor, note } = await adapter.handoff(session.sessionId, {
      goal: "g2",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });
    expect(successor.sessionId).not.toBe(session.sessionId);
    expect(note).toContain("preserved");
    // The previous session is still addressable until the caller disposes it.
    expect(adapter.usage(session.sessionId).turns).toBe(0);
  });
});

describe("real SDK adapter availability (P0.1)", () => {
  it(
    "loads the installed Pi SDK and reports the required exports as present",
    async () => {
      const adapter = new RealPiAdapter({ cwd: process.cwd(), builtinTools: READ_ONLY_TOOLS });
      const availability = await adapter.availability();
      expect(availability.available).toBe(true);
      expect(availability.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    },
    // Loading the SDK is genuinely heavy, and this test runs alongside suites that spawn a
    // Chromium and several child processes. At the 20 second default it measured the machine's
    // load rather than the adapter, and failed intermittently for that reason alone. The timeout
    // is stated so a real regression here is still reported as a failure rather than as slowness.
    60_000,
  );
});

describe("SDK event mapping", () => {
  it("drops events it does not recognise rather than forwarding an unvalidated shape", () => {
    expect(mapPiEvent("s1", { type: "some_future_event" } as never)).toBeUndefined();
  });

  it("maps a tool failure to an error tool-end", () => {
    const mapped = mapPiEvent("s1", {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "c1",
      isError: true,
    } as never);
    expect(mapped).toEqual({
      type: "tool-end",
      sessionId: "s1",
      toolName: "bash",
      toolCallId: "c1",
      isError: true,
    });
  });
});

/**
 * The SDK surface `createWorkerSession` and `prompt` actually use.
 *
 * A stub rather than the real SDK, because the behaviour under test is a clock: whether the budget is
 * measured from the run or from the session's creation. That cannot be asserted against a real provider
 * without spending minutes of wall clock, and the assertion would then be about the provider.
 */
function stubSdk(options: { idleDelayMs?: number } = {}) {
  const prompts: string[] = [];
  /**
   * The options each session was created with, which is where the tool allowlist travels.
   *
   * Recorded rather than inferred: the one option that decides whether a confined worker has the SDK's
   * own `read` and `grep` at all is the allowlist the adapter passes here, and a test that assumed it
   * would be proving the adapter's intentions rather than its behaviour.
   */
  const sessions: {
    tools?: string[];
    customTools?: {
      name: string;
      execute?: (id: string, params: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>;
    }[];
  }[] = [];
  let aborts = 0;
  let release: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const finishIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    release?.();
    release = undefined;
  };

  const session = {
    sessionId: "pi-session-stub",
    sessionFile: undefined,
    subscribe: () => () => undefined,
    prompt: async (text: string) => {
      prompts.push(text);
    },
    abort: async () => {
      aborts += 1;
      finishIdle();
    },
    dispose: finishIdle,
    agent: {
      state: { tools: [] as { name: string }[] },
      waitForIdle: () =>
        new Promise<void>((resolve) => {
          release = resolve;
          // No configured delay means the run settles at once; a stub that hangs by default would make
          // "the fast case" impossible to write.
          if (options.idleDelayMs === undefined) resolve();
          else idleTimer = setTimeout(finishIdle, options.idleDelayMs);
        }),
    },
  };

  const module_ = {
    getAgentDir: () => process.cwd(),
    DefaultResourceLoader: class {
      async reload(): Promise<void> {
        return undefined;
      }
    },
    SessionManager: { inMemory: () => ({}), create: () => ({}) },
    // The SDK's `defineTool` is an identity function at runtime, and the stub keeps that: a captured custom
    // tool is then the object the adapter handed over rather than a stand-in for it.
    defineTool: (config: unknown) => config,
    createAgentSession: async (options: { tools?: string[]; customTools?: { name: string }[] }) => {
      sessions.push(options);
      return { session };
    },
    ModelRuntime: { create: async () => ({ getModels: () => [], getProviders: () => [] }) },
  };

  return { module: module_, prompts, aborts: () => aborts, sessions, session };
}

function adapterWith(sdk: ReturnType<typeof stubSdk>): RealPiAdapter {
  // SAFETY: the stub implements exactly the SDK surface this adapter touches — a resource loader, a
  // session manager, `createAgentSession` and the session's own methods. TypeScript cannot verify a
  // deliberate partial stand-in against the SDK's whole module type, and loading the real SDK here
  // would turn a clock assertion into a provider call.
  return new RealPiAdapter({
    cwd: process.cwd(),
    sdk: sdk.module as unknown as NonNullable<RealPiAdapterOptions["sdk"]>,
  });
}

describe("the fake records what it was told", () => {
  it("the fake records the prompt it was given", async () => {
    // A test double that forgets its input cannot be used to assert what the node sent, which is the
    // only place some claims can be checked at all.
    const adapter = new FakePiAdapter({ script: ["ok"] });
    const handle = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    await adapter.prompt(handle.sessionId, "first prompt");
    await adapter.prompt(handle.sessionId, "second prompt");
    expect(adapter.promptsFor(handle.sessionId)).toEqual(["first prompt", "second prompt"]);
    // A copy, so a caller cannot reach in and change the record of what was sent.
    expect(adapter.promptsFor(handle.sessionId)).not.toBe(adapter.promptsFor(handle.sessionId));
  });

  it("answers an unknown session with nothing rather than throwing", () => {
    const adapter = new FakePiAdapter();
    expect(adapter.promptsFor("fake-session-does-not-exist")).toEqual([]);
    expect(adapter.allPrompts()).toEqual([]);
  });
});

describe("the wall-clock budget bounds a run, not a session's age", () => {
  const brief = (maxWallClockMs: number) => ({
    goal: "answer the user",
    projectRoots: [],
    allowedCapabilityRefs: [],
    maxWallClockMs,
  });

  it("keeps answering in a session older than its budget, as long as each run is fast", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);
    const handle = await adapter.createWorkerSession(brief(40));

    // The session is now twice its budget old while every run is instantaneous. The check this replaces
    // read that age and refused every prompt for the rest of the session's life, which is the reported
    // symptom: a conversation that fails every message after working for two minutes.
    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(adapter.prompt(handle.sessionId, "còn đó không?")).resolves.toBeUndefined();
    expect(sdk.prompts).toEqual(["còn đó không?"]);
    expect(sdk.aborts()).toBe(0);
    await adapter.dispose(handle.sessionId);
  });

  it("still stops a run that overruns the budget", async () => {
    // The guarantee the old check was trying to provide, kept: a run that never settles is aborted by
    // the clock rather than left running.
    const sdk = stubSdk({ idleDelayMs: 5_000 });
    const adapter = adapterWith(sdk);
    const handle = await adapter.createWorkerSession(brief(40));

    let failure: unknown;
    try {
      await adapter.prompt(handle.sessionId, "chạy mãi đi");
    } catch (cause) {
      failure = cause;
    }

    expect(String(failure)).toContain("exceeded its 40 ms wall-clock budget");
    expect(sdk.aborts()).toBe(1);
    await adapter.dispose(handle.sessionId);
  });
});

describe("the model catalogue", () => {
  it("lists every provider with its own models, and marks exactly one as current", async () => {
    const catalogue = await new FakePiAdapter().catalogue();

    // More than one provider, and more than one model across them: a chooser that only ever saw a single row would
    // never exercise the grouping, and a catalogue with one model could never show the current one among others.
    expect(catalogue.length).toBeGreaterThan(1);
    const models = catalogue.flatMap((provider) => provider.models);
    expect(models.length).toBeGreaterThan(catalogue.length);
    expect(models.filter((model) => model.current)).toHaveLength(1);

    // Each model names the provider it came from, so a chooser can group without re-deriving it from the grouping.
    for (const provider of catalogue) {
      for (const model of provider.models) expect(model.provider).toBe(provider.id);
    }
  });

  it("states tool calling only for a model pi ships unchanged, and leaves every other model unknown", async () => {
    const shipped = { api: "openai-responses", baseUrl: "https://api.example.test/v1" };
    // What pi's own catalogue lists: a runtime that ignores models.json and never refreshes.
    const builtin = {
      acme: [
        { id: "shipped", ...shipped },
        { id: "moved", ...shipped },
      ],
    };
    // What this installation runs: the shipped model, a built-in id a models.json moved to another endpoint, and a
    // model somebody added by hand.
    const configured = {
      acme: [
        { id: "shipped", ...shipped, contextWindow: 1000 },
        { id: "moved", api: shipped.api, baseUrl: "http://localhost:11434/v1" },
        { id: "hand-added", ...shipped },
      ],
    };
    const runtimeOver = (models: Record<string, readonly { id: string }[]>) => ({
      getProviders: () => Object.keys(models).map((id) => ({ id })),
      getModels: (provider: string) => models[provider] ?? [],
    });
    const created: unknown[] = [];
    const module_ = {
      ModelRuntime: {
        create: async (options: { modelsPath?: string | null; refreshOnCreate?: boolean }) => {
          created.push(options);
          return runtimeOver(options.modelsPath === null ? builtin : configured);
        },
      },
    };
    // SAFETY: the stand-in implements only `ModelRuntime.create`, the one SDK surface `catalogue()` touches.
    const adapter = new RealPiAdapter({ cwd: process.cwd(), sdk: module_ as unknown as NonNullable<RealPiAdapterOptions["sdk"]> });

    const models = (await adapter.catalogue()).flatMap((provider) => provider.models);
    const toolCalls = Object.fromEntries(models.map((model) => [model.id, model.toolCalls]));
    expect(toolCalls).toEqual({ shipped: true, moved: undefined, "hand-added": undefined });
    // Unknown is never written down as "no".
    expect(models.some((model) => model.toolCalls === false)).toBe(false);
    // The built-in list is read without the agent directory's models.json and without a refresh.
    expect(created).toContainEqual({ modelsPath: null, refreshOnCreate: false });
  });

  it("leaves every model unknown when pi's built-in catalogue cannot be read", async () => {
    const module_ = {
      ModelRuntime: {
        create: async (options: { modelsPath?: string | null }) => {
          if (options.modelsPath === null) throw new Error("no built-in catalogue");
          return {
            getProviders: () => [{ id: "acme" }],
            getModels: () => [{ id: "shipped", api: "openai-responses", baseUrl: "https://api.example.test/v1" }],
          };
        },
      },
    };
    // SAFETY: as above, only `ModelRuntime.create` is touched.
    const adapter = new RealPiAdapter({ cwd: process.cwd(), sdk: module_ as unknown as NonNullable<RealPiAdapterOptions["sdk"]> });
    const [model] = (await adapter.catalogue()).flatMap((provider) => provider.models);
    expect(model?.id).toBe("shipped");
    expect(model?.toolCalls).toBeUndefined();
  });
});

  it("resolves the model a brief carries, not only the one the adapter was built with", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);

    // The stub offers no models for any provider, which is what makes this testable without a provider account: the
    // refusal names the provider that was asked about, so the provider the adapter resolved is visible in the failure.
    // A brief carrying a model that was then ignored would name the adapter's own provider instead - and that is the
    // bug this covers, because a choice stored in the interface reaches a session only through this brief.
    await expect(
      adapter.createWorkerSession({
        goal: "answer the user",
        projectRoots: [],
        allowedCapabilityRefs: [],
        maxWallClockMs: 40,
        model: { provider: "from-the-brief", id: "any-model" },
      }),
    ).rejects.toThrow(/from-the-brief/);
  });

describe("the extension listing", () => {
  it("reports the names and kinds pi would load from its own agent directory, and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pi-agent-"));
    mkdirSync(join(dir, "extensions", "my-extension"), { recursive: true });
    // Written with contents that must not appear in the answer: the listing reports that a file is there, never what is
    // in it, because an extension on a real machine can hold a credential.
    writeFileSync(join(dir, "extensions", "notes.ts"), "const token = must-not-be-listed;");
    // Left beside them and never loaded, so never listed.
    writeFileSync(join(dir, "extensions", "notes.ts.bak.20260920"), "");
    writeFileSync(join(dir, "extensions", "settings.json"), "{}");

    const adapter = new RealPiAdapter({
      cwd: process.cwd(),
      agentDir: dir,
      sdk: stubSdk().module as unknown as NonNullable<RealPiAdapterOptions["sdk"]>,
    });

    const listed = await adapter.extensions();
    expect(listed).toEqual([
      { name: "my-extension", kind: "directory" },
      { name: "notes.ts", kind: "file" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("must-not-be-listed");

    // A machine where nobody has configured pi is a fact rather than a failure: an empty list, not an error.
    rmSync(join(dir, "extensions"), { recursive: true, force: true });
    expect(await adapter.extensions()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pi's own settings", () => {
  it("reports scalars and redacts anything whose name suggests a secret, reading no other file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pi-settings-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ defaultModel: "a-model", providerApiKey: "must-not-appear", thinkingBudgets: { low: 1 } }),
    );

    const adapter = new RealPiAdapter({
      cwd: process.cwd(),
      agentDir: dir,
      sdk: stubSdk().module as unknown as NonNullable<RealPiAdapterOptions["sdk"]>,
    });

    const settings = await adapter.piSettings();
    const byKey = new Map(settings.map((entry) => [entry.key, entry.value]));
    expect(byKey.get("defaultModel")).toBe("a-model");
    expect(byKey.get("thinkingBudgets")).toBe('{"low":1}');

    // The redaction is by name and is deliberately broad: a settings file on a real machine can carry a provider key,
    // and a section that echoed it would be the place it leaked from.
    expect(byKey.get("providerApiKey")).toBe("[redacted]");
    expect(JSON.stringify(settings)).not.toContain("must-not-appear");

    // No file is a fact rather than a failure: a machine where nobody has configured pi has nothing to report.
    rmSync(join(dir, "settings.json"));
    expect(await adapter.piSettings()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * A worker bound to its approved project roots (Phase 2).
 *
 * The spike settled that the SDK's `tools` option is a hard allowlist gating built-in and custom tools
 * alike. What these tests pin is what this adapter does with that fact: the adapter itself builds the scoped
 * tools from the brief's roots, so a brief that carries roots — with or without the confinement flag, with or
 * without tools of its own — never runs on the SDK's own `read`/`grep`/`find`/`ls`; a brief that claims
 * confinement without a root is refused by name; and no tool can be added to a strictly confined session
 * afterwards, which is the path the spike named as the one that would quietly undo the boundary.
 */
describe("a brief confined to its approved project roots", () => {
  let base: string;
  let root: string;
  let elsewhere: string;

  beforeAll(() => {
    // Real directories: the roots are approved by reading them, so a made-up path is not a root this adapter
    // can be asked about.
    base = mkdtempSync(join(tmpdir(), "cc-pi-confined-"));
    root = join(base, "project");
    elsewhere = join(base, "elsewhere");
    mkdirSync(root, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(root, "notes.md"), "inside the approved root\n", "utf8");
    writeFileSync(join(elsewhere, "secret.txt"), "not for the worker\n", "utf8");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const scoped = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: `${name} stays inside the approved roots`,
    promptSnippet: `${name}: inside the approved roots`,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => ({ text: "not called in these tests" }),
  });

  const confinedBrief = (): WorkerBrief => ({
    goal: "work in the project",
    projectRoots: [root],
    allowedCapabilityRefs: [],
    confineToProjectRoots: true,
    customTools: SCOPED_FS_TOOL_NAMES.map(scoped),
  });

  it("runs with the scoped tools and leaves the SDK's own file tools out of the allowlist", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);

    await adapter.createWorkerSession(confinedBrief());

    const created = sdk.sessions[0];
    expect(created?.tools).toEqual([...SCOPED_FS_TOOL_NAMES]);
    expect(created?.tools).not.toContain("read");
    expect(created?.customTools?.map((custom) => custom.name)).toEqual([...SCOPED_FS_TOOL_NAMES]);
  });

  it("binds the scoped tools to the brief's roots when the brief only carries the roots", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);

    // No confinement flag and no tools: the state `apps/worker` and the probe build, neither of which may be
    // left running the SDK's `read` and `ls` against the adapter's working directory.
    await adapter.createWorkerSession({
      goal: "work in the project",
      projectRoots: [root],
      allowedCapabilityRefs: [],
    });

    const created = sdk.sessions[0];
    expect(created?.tools).toEqual([...SCOPED_FS_TOOL_NAMES]);
    expect(created?.tools).not.toContain("grep");
    expect(created?.customTools?.map((custom) => custom.name)).toEqual([...SCOPED_FS_TOOL_NAMES]);
  });

  it("does not let a caller's own tool under a scoped name decide what the roots are", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);
    const decoy: ToolDefinition = {
      ...scoped("clarkcant_read"),
      description: "a read the caller bound to some other directory",
      execute: async () => ({ text: "the caller's tool answered" }),
    };

    // The same tool names, from a caller, so the session gets the adapter's binding of the brief's roots
    // rather than a set of tools that could be pointed anywhere.
    await adapter.createWorkerSession({
      goal: "work in the project",
      projectRoots: [root],
      allowedCapabilityRefs: [],
      customTools: [decoy],
    });

    const read = sdk.sessions[0]?.customTools?.find((custom) => custom.name === "clarkcant_read");
    const inside = await read?.execute?.("call-1", { path: join(root, "notes.md") });
    const outside = await read?.execute?.("call-2", { path: join(elsewhere, "secret.txt") });

    expect(inside?.content[0]?.text).toContain("inside the approved root");
    expect(inside?.content[0]?.text).not.toContain("the caller's tool answered");
    expect(outside?.content[0]?.text).toMatch(/^refused: /);
    expect(outside?.content[0]?.text).not.toContain("not for the worker");
  });

  it("refuses a brief that declares confinement with no approved root", async () => {
    const adapter = adapterWith(stubSdk());

    // Fail closed and say so: a session that is confined with no filesystem tool at all is a configuration
    // error, not a constraint somebody chose.
    await expect(
      adapter.createWorkerSession({
        goal: "work in the project",
        projectRoots: [],
        allowedCapabilityRefs: [],
        confineToProjectRoots: true,
      }),
    ).rejects.toThrow(/carries no approved project root/);
  });

  it("refuses to start when a declared root cannot be approved", async () => {
    const adapter = adapterWith(stubSdk());
    const missing = join(base, "not-there");

    // Dropping the root would confine the worker to something other than what was approved.
    await expect(
      adapter.createWorkerSession({
        goal: "work in the project",
        projectRoots: [missing],
        allowedCapabilityRefs: [],
        confineToProjectRoots: true,
      }),
    ).rejects.toThrow(new RegExp(missing.replace(/[/\\.]/g, "\\$&")));
  });

  it("refuses to register another tool on a confined session", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);
    const handle = await adapter.createWorkerSession(confinedBrief());

    await expect(adapter.registerTool(handle.sessionId, scoped("something_else"))).rejects.toThrow(
      /confined to its approved project roots/,
    );
  });
  it("gives a session without roots no filesystem tool unless the adapter was built to allow one", async () => {
    const sdk = stubSdk();
    const adapter = adapterWith(sdk);

    // The packed-worker probe's brief: no roots, no tools. Nothing it runs may reach the adapter's working
    // directory through the SDK's own `read`, `grep`, `find` or `ls`.
    await adapter.createWorkerSession({ goal: "prove the pack runs", projectRoots: [], allowedCapabilityRefs: [] });

    expect(sdk.sessions[0]?.tools).toEqual([]);
  });

  it("still runs the built-in read-only tools for an adapter that opts in by name", async () => {
    const sdk = stubSdk();
    const adapter = new RealPiAdapter({
      cwd: process.cwd(),
      builtinTools: READ_ONLY_TOOLS,
      sdk: sdk.module as unknown as NonNullable<RealPiAdapterOptions["sdk"]>,
    });

    await adapter.createWorkerSession({ goal: "probe the SDK", projectRoots: [], allowedCapabilityRefs: [] });

    expect(sdk.sessions[0]?.tools).toEqual([...READ_ONLY_TOOLS]);
  });
});


describe("the real adapter narrows and widens a session's tools from the set it was created with", () => {
  /**
   * A session whose tool list starts as the SDK's would — every allowed tool active — and, when `withByName`, whose
   * `setActiveToolsByName` activates from a registry of exactly those tools and records the prompt rebuild it implies.
   */
  function registrySdk(withByName: boolean) {
    const sdk = stubSdk();
    const rebuilt: string[][] = [];
    const created = sdk.module.createAgentSession;
    sdk.module.createAgentSession = async (options: { tools?: string[]; customTools?: { name: string }[] }) => {
      const result = await created(options);
      const registry = new Map((options.tools ?? []).map((name) => [name, { name }]));
      const session = result.session as unknown as {
        agent: { state: { tools: { name: string }[] } };
        setActiveToolsByName?: (names: string[]) => void;
      };
      session.agent.state.tools = [...registry.values()];
      if (withByName) {
        session.setActiveToolsByName = (names: string[]) => {
          session.agent.state.tools = names.flatMap((name) => {
            const tool = registry.get(name);
            return tool === undefined ? [] : [tool];
          });
          rebuilt.push(names);
        };
      } else {
        delete session.setActiveToolsByName;
      }
      return result;
    };
    return { sdk, rebuilt };
  }

  const custom = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ text: name }),
  });

  /** The names on the stub's one session, which is the object the adapter changes. */
  const toolNames = (sdk: ReturnType<typeof stubSdk>): string[] => sdk.session.agent.state.tools.map((tool) => tool.name);

  it("writes nothing itself when the SDK cannot change the active tools, and says so", async () => {
    const { sdk } = registrySdk(false);
    const adapter = adapterWith(sdk);
    const handle = await adapter.createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
      customTools: [custom("a"), custom("b")],
    });
    // Writing the list directly would leave the system prompt describing tools the model can no longer call.
    await expect(adapter.setActiveTools(handle.sessionId, ["a"])).rejects.toThrow(/cannot change/);
    expect(toolNames(sdk)).toEqual(["a", "b"]);
  });

  it("narrow, widen and narrow again end where they should, through the SDK's setActiveToolsByName", async () => {
    const { sdk, rebuilt } = registrySdk(true);
    const adapter = adapterWith(sdk);
    const handle = await adapter.createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
      customTools: [custom("a"), custom("b"), custom("c")],
    });
    const state = (): string[] => toolNames(sdk);
    expect(state()).toEqual(["a", "b", "c"]);

    await adapter.setActiveTools(handle.sessionId, ["a"]);
    expect(state()).toEqual(["a"]);
    // The defect: filtering the current list made this a no-op, and "b" could never come back.
    await adapter.setActiveTools(handle.sessionId, ["a", "b", "c"]);
    expect(state()).toEqual(["a", "b", "c"]);
    // A name the session was not created with is never activated.
    await adapter.setActiveTools(handle.sessionId, ["b", "read", "bash"]);
    expect(state()).toEqual(["b"]);
    expect(rebuilt).toEqual([["a"], ["a", "b", "c"], ["b"]]);
  });

  it("keeps a tool registered after creation whatever the active set is", async () => {
    const { sdk } = registrySdk(true);
    const adapter = adapterWith(sdk);
    const handle = await adapter.createWorkerSession({
      goal: "g",
      projectRoots: [],
      allowedCapabilityRefs: [],
      customTools: [custom("a"), custom("b")],
    });
    await adapter.registerTool(handle.sessionId, custom("late"));
    await adapter.setActiveTools(handle.sessionId, ["a"]);
    expect(toolNames(sdk)).toEqual(["a", "late"]);
  });
});

describe("a model id the provider retired", () => {
  it("runs the catalogue's replacement instead of refusing every turn", async () => {
    const sdk = stubSdk();
    // DeepSeek's catalogue after Pi 1.0: the V4 Flash alias is gone and `deepseek-flash` replaced it.
    sdk.module.ModelRuntime = {
      create: async () => ({
        getProviders: () => [{ id: "deepseek" }],
        getModels: (provider: string) => (provider === "deepseek" ? [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] : []),
      }),
    } as unknown as typeof sdk.module.ModelRuntime;
    const adapter = adapterWith(sdk);

    const handle = await adapter.createWorkerSession({
      goal: "answer the user",
      projectRoots: [],
      allowedCapabilityRefs: [],
      model: { provider: "deepseek", id: "deepseek-v4-flash" },
    });

    expect((sdk.sessions.at(-1) as { model?: { id: string } }).model?.id).toBe("deepseek-flash");
    await adapter.dispose(handle.sessionId);
  });
});
