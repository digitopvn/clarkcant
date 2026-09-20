import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Instant } from "@clarkcant/contracts";
import { nowInstant } from "@clarkcant/contracts";

import { NotImplementedError, type ModelCatalogue,
  type PiExtension,
  type PiSetting, type PiAdapter, type ResourceRefreshRequest, type ToolDefinition, type WorkerBrief, type WorkerEvent, type WorkerSessionHandle, type WorkerUsage } from "./types.ts";

/**
 * Real Pi SDK adapter.
 *
 * The only file in the repository that imports `@earendil-works/pi-coding-agent`.
 * It is typed against the SDK's own declarations rather than a hand-written mirror,
 * so a breaking SDK change becomes a compile error here instead of a runtime
 * surprise somewhere else.
 *
 * Behaviour the application depends on, and how each is obtained:
 *
 * - Which tools are active is a state assignment on the session, not a reload.
 *   Treating a tool-set change as a resource reload is what causes an unnecessary
 *   worker restart, which acceptance test T24 forbids.
 * - Subscriptions attach to a specific session and do not follow a replacement.
 *   `subscribe` therefore returns a real unsubscribe function and this adapter
 *   refuses to attach the same listener twice, because a duplicated listener is
 *   the mechanism by which T25 (stale handlers after reload) fails.
 * - Resource refresh is an explicit loader operation at a command or idle boundary.
 *   The adapter never terminates the worker to pick up skills or prompts.
 *
 * Anything this adapter does not yet do honestly throws `NotImplementedError`
 * naming the milestone that owns it.
 */

type SdkModule = typeof import("@earendil-works/pi-coding-agent");
type SdkSession = Awaited<ReturnType<SdkModule["createAgentSession"]>>["session"];
type SdkEvent = Parameters<Parameters<SdkSession["subscribe"]>[0]>[0];
type SdkTool = SdkSession["agent"]["state"]["tools"][number];

/**
 * Convert one of our tool definitions into the SDK's shape.
 *
 * SAFETY: `defineTool` is an identity function at runtime, and the SDK accepts the result in both
 * `customTools` and `agent.state.tools`. The declaration's generic parameter is not inferred from
 * our JSON-Schema-typed `parameters` — the SDK's type expects a TypeBox schema — so the structural
 * match fails at compile time even though the runtime shape is the documented one. `pi-ai` detects
 * the missing TypeBox marker and validates against plain JSON Schema instead.
 *
 * `promptSnippet` is carried through deliberately. Without it the SDK leaves the tool out of the
 * system prompt's "Available tools" list, and a model that cannot see its tools answers with
 * invented tool syntax rather than calling one.
 */
export function toSdkTool(sdk: SdkModule, tool: ToolDefinition): SdkTool {
  // SAFETY: the SDK's declaration types `parameters` as a TypeBox schema, which our runtime-validated
  // JSON Schema is not, so the generic cannot be inferred and the structural check fails at compile
  // time while the runtime shape is the documented one. `pi-ai` detects the absent TypeBox marker and
  // validates against plain JSON Schema instead, and `defineTool` is an identity function, so nothing
  // is transformed. Verified by the live model turn that calls this tool and gets a view back.
  return sdk.defineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as never,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await tool.execute(params);
      // A tool that read a picture returns the picture. The SDK's content union has an image member, and
      // flattening it to the sentence beside it would tell the model that a picture exists while hiding what
      // is in it. The sentence stays, so a transcript still says which file the picture came from.
      return {
        content: [
          { type: "text" as const, text: result.text },
          ...(result.image === undefined
            ? []
            : [{ type: "image" as const, data: result.image.dataBase64, mimeType: result.image.mimeType }]),
        ],
        details: {},
      };
    },
  }) as unknown as SdkTool;
}

/** SDK exports the adapter requires. Verified before any session is created. */
export const REQUIRED_SDK_EXPORTS = [
  "createAgentSession",
  "SessionManager",
  "DefaultResourceLoader",
  "defineTool",
  "ModelRuntime",
  "getAgentDir",
] as const;

import { composePersonalInstructions } from "./personal-instructions.ts";

export interface RealPiAdapterOptions {
  /** Working directory for the worker; also the loader's discovery root. */
  cwd: string;
  /** Directory holding Pi's own configuration and credentials. */
  agentDir?: string;
  /**
   * Directory the worker's own session transcript is written into.
   *
   * Unset means an in-memory session, which is what a probe wants. A node sets it: a transcript
   * that only exists in the process is a transcript that cannot be searched after a restart, and the
   * whole point of persisting one is that it outlives the run that produced it.
   */
  sessionDir?: string;
  /**
   * Called once the transcript exists on disk, with its path.
   *
   * The runtime uses it to index the file. It is a callback rather than something this adapter
   * writes itself because the adapter has no database and should not grow one.
   */
  onSessionFile?: (input: { sessionId: string; sessionFile: string; taskId?: string }) => void;
  /**
   * Which model the worker runs on.
   *
   * Left unset, the SDK resolves its own default, which reads from the user's global Pi
   * configuration. A node must not depend on that: the credential it runs on is the node's
   * business, and an operator who has never run Pi interactively has no default to resolve.
   * Naming the provider and model here makes the choice explicit and, when it cannot be
   * resolved, makes that a named failure at session creation rather than an obscure one at
   * the first turn.
   */
  model?: { provider: string; id: string; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
  /**
   * Built-in tool allowlist. Defaults to a read-only set: a worker that can write
   * must be granted that explicitly, not by omission.
   */
  builtinTools?: readonly string[];
  /**
   * The user's own instructions, read fresh on every turn.
   *
   * A callback rather than a string because that is the whole promise of the feature: a preference
   * written while the app is open reaches the next turn rather than the next session. Called once per
   * turn, so it must be cheap and must not throw.
   *
   * The text is appended as a section inside the system prompt the SDK composed, never substituted for
   * it — see `personal-instructions.ts`.
   */
  personalInstructions?: () => string | undefined;
  /** Injected so tests can exercise the adapter without loading the real SDK. */
  sdk?: SdkModule;
}

/** The reasoning levels the SDK accepts. Mirrored as a union so the option is typed. */
type SdkModelRuntime = Awaited<ReturnType<SdkModule["ModelRuntime"]["create"]>>;
type SdkModel = ReturnType<SdkModelRuntime["getModels"]>[number];

/**
 * Recorded evidence of which SDK lifecycle behaviour was actually verified.
 *
 * Written by `probe-cli.ts` into `docs/research/compatibility-lock.md`. Listing
 * blocked lifecycle steps next to verified ones is the point: it is the difference
 * between "we tested this" and "we never ran it".
 */
export interface CompatibilityLock {
  sdkPackage: string;
  sdkVersion: string;
  exportsPresent: string[];
  exportsMissing: string[];
  verifiedLifecycle: string[];
  blockedLifecycle: { step: string; reason: string }[];
}

/**
 * Whether a setting's name suggests it holds a secret.
 *
 * Deliberately broad and deliberately only about the name: the alternative is inspecting values, and a listing that
 * guessed at a value's shape would eventually get it wrong in the one direction that matters.
 */
function looksSecret(key: string): boolean {
  return /key|token|secret|password|credential/i.test(key);
}

/** A value as a line of text, bounded so one long list cannot fill a panel. */
function describeSetting(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value).slice(0, 200);
}

export class RealPiAdapter implements PiAdapter {
  readonly #sessions = new Map<
    string,
    {
      session: SdkSession;
      unsubscribe: () => void;
      listeners: Set<(event: WorkerEvent) => void>;
      loader: SdkModule["DefaultResourceLoader"] extends new (options: infer _O) => infer R ? R : never;
      registeredTools: Set<string>;
      brief: WorkerBrief;
      /**
       * Turns this session has run.
       *
       * There is deliberately no `startedAtMs` here any more. The wall-clock budget used to be measured
       * against the session's age, which meant a session older than its budget refused every message for
       * the rest of its life; keeping the timestamp invites the same mistake back.
       */
      turns: number;
    }
  >();

  #sdk: SdkModule | undefined;
  #modelRuntime: SdkModelRuntime | undefined;
  #loader:
    | (SdkModule["DefaultResourceLoader"] extends new (options: infer _O) => infer R ? R : never)
    | undefined;
  #counter = 0;
  readonly #aborted = new Set<string>();

  /**
   * Resolve the configured model against the SDK's catalogue.
   *
   * A provider or model that is not there is refused by name. Passing the identifier straight
   * through would defer the failure to the model runtime, whose complaint names neither the
   * provider nor what it does have, and that is the error an operator would have to debug.
   */
  async #resolveModel(
    sdk: SdkModule,
    wanted: RealPiAdapterOptions["model"] = this.#options.model,
  ): Promise<{ runtime?: SdkModelRuntime; model?: SdkModel }> {
    if (wanted === undefined) return {};

    // No options: the credentials this resolves against are the process environment's, which is
    // the path an operator can control without editing a file in their home directory. The
    // runtime has no `agentDir` option, so the credential directory an operator sets on the
    // adapter is deliberately not threaded here — env is the contract.
    this.#modelRuntime ??= await sdk.ModelRuntime.create({});
    const runtime = this.#modelRuntime;

    const available = runtime.getModels(wanted.provider);
    if (available.length === 0) {
      const providers = runtime.getProviders().map((provider) => provider.id);
      throw new Error(
        `no models are available for provider "${wanted.provider}"; available providers: ${providers.join(", ")}`,
      );
    }
    const model = available.find((candidate) => candidate.id === wanted.id);
    if (model === undefined) {
      const ids = available.map((candidate) => candidate.id).join(", ");
      throw new Error(
        `provider "${wanted.provider}" has no model "${wanted.id}"; it offers: ${ids}`,
      );
    }
    return { runtime, model };
  }

  readonly #options: RealPiAdapterOptions;

  constructor(options: RealPiAdapterOptions) {
    // Assigned rather than declared as a constructor parameter property: Node's
    // type-stripping loader cannot execute that syntax.
    this.#options = options;
  }

  async availability(): Promise<{ available: boolean; reason?: string; sdkVersion?: string }> {
    let sdk: SdkModule;
    try {
      sdk = await this.#load();
    } catch (cause) {
      return {
        available: false,
        reason: `the Pi SDK could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    const missing = REQUIRED_SDK_EXPORTS.filter((name) => !(name in sdk));
    if (missing.length > 0) {
      return {
        available: false,
        reason: `the installed Pi SDK is missing required exports: ${missing.join(", ")}`,
      };
    }
    return { available: true, sdkVersion: await sdkVersion() };  }

  /**
   * The providers and models this installation offers, read from the SDK's catalogue.
   *
   * Deliberately not filtered by whether a credential is configured: a person who cannot see the provider cannot
   * choose it, and cannot learn what to log into. Which of them are ready is a separate question, answered where the
   * choice is offered rather than by removing the choice.
   */
  async catalogue(): Promise<ModelCatalogue> {
    const sdk = await this.#load();
    this.#modelRuntime ??= await sdk.ModelRuntime.create({});
    const runtime = this.#modelRuntime;
    const current = this.#options.model;

    return runtime.getProviders().map((provider) => ({
      id: provider.id,
      models: runtime.getModels(provider.id).map((model) => ({
        provider: provider.id,
        id: model.id,
        current: current?.provider === provider.id && current.id === model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      })),
    }));
  }

  /**
   * What pi loads from its own agent directory.
   *
   * The directory is the same one the loader resolves, so this reports the extensions this node actually runs with
   * rather than the ones in some default place. A directory that is not there is an empty list instead of an error: a
   * machine where nobody has configured pi has no extensions, which is a fact rather than a failure.
   */
  async extensions(): Promise<readonly PiExtension[]> {
    const sdk = await this.#load();
    try {
      const entries = await readdir(join(this.#options.agentDir ?? sdk.getAgentDir(), "extensions"), {
        withFileTypes: true,
      });
      return entries
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  }

  /**
   * pi's own configuration, as far as it is safe to report it.
   *
   * `auth.json` is deliberately never read: it is where credentials live, and a panel that showed configuration has no
   * business near it. `settings.json` is configuration rather than secrets, but a key can be written into it all the
   * same, so anything whose name sounds like a secret is reported as redacted.
   */
  async piSettings(): Promise<readonly PiSetting[]> {
    const sdk = await this.#load();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.#options.agentDir ?? sdk.getAgentDir(), "settings.json"), "utf8"));
    } catch {
      // No file, or one that does not parse: either way there is nothing to report, which is a fact and not a failure.
      return [];
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .map(([key, value]) => ({ key, value: looksSecret(key) ? "[redacted]" : describeSetting(value) }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    const sdk = await this.#load();

    // A loader configured for this cwd and agent dir with no implicit extension
    // discovery: the application decides which skills and extensions exist, so a
    // project-local file cannot change worker behaviour behind the user's back.
    //
    // Both `cwd` and `agentDir` are required by the SDK's option type, and omitting
    // `agentDir` makes `reload()` throw deep inside the loader — which the P0.1 probe
    // caught rather than a user.
    const loader =
      this.#loader ??
      new sdk.DefaultResourceLoader({
        cwd: this.#options.cwd,
        agentDir: this.#options.agentDir ?? sdk.getAgentDir(),
        /*
         * The personal-instructions section, registered as a trusted inline extension.
         *
         * `before_agent_start` is the only seam in this SDK version that can reach the system prompt, and
         * it exposes the prompt the SDK itself composed. The handler appends one section to it and returns
         * the result, so the product's invariants and the tool and security instructions are still the
         * ones pi assembled — this cannot replace them, only follow them.
         *
         * The handler reads the callback on every call rather than capturing its value, which is what makes
         * a preference change take effect on the next turn instead of at the next session.
         *
         * `hidden` so the extension is not presented as one of the user's own: it is part of the product,
         * and a list of "extensions on this machine" that included it would invite somebody to disable the
         * feature they just configured.
         */
        ...(this.#options.personalInstructions === undefined
          ? {}
          : {
              extensionFactories: [
                {
                  name: "clark-personal-instructions",
                  hidden: true,
                  factory: (api: {
                    on: (event: string, handler: (event: { systemPrompt: string }) => { systemPrompt: string }) => void;
                  }) => {
                    api.on("before_agent_start", (event) => ({
                      systemPrompt: composePersonalInstructions({
                        base: event.systemPrompt,
                        text: this.#options.personalInstructions?.(),
                      }),
                    }));
                  },
                },
              ],
            }),
      } as never);
    this.#loader = loader;
    await loader.reload();

    const selection = await this.#resolveModel(sdk, brief.model ?? this.#options.model);

    const customTools = brief.customTools ?? [];
    const builtinTools = [...(this.#options.builtinTools ?? READ_ONLY_TOOLS)];

    const { session } = await sdk.createAgentSession({
      cwd: this.#options.cwd,
      ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
      ...(selection.runtime === undefined ? {} : { modelRuntime: selection.runtime }),
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(this.#options.model?.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: this.#options.model.thinkingLevel }),
      // Persistent when a directory is configured, in memory otherwise. The distinction is
      // deliberate: an in-memory session leaves nothing to resume and nothing to search, which is
      // fine for a probe and wrong for a node.
      sessionManager:
        this.#options.sessionDir === undefined
          ? sdk.SessionManager.inMemory(this.#options.cwd)
          : sdk.SessionManager.create(this.#options.cwd, this.#options.sessionDir),
      resourceLoader: loader,
      // A custom tool has to be named in `tools` as well as supplied in `customTools`. The
      // allowlist is consulted by name, and it refuses anything it does not list — so a tool that
      // is registered but not listed is invisible, and an empty allowlist refuses every tool there
      // is. That combination is what made a model answer with invented tool syntax: it was told it
      // had no tools and asked to use one.
      tools: [...builtinTools, ...customTools.map((tool) => tool.name)],
      customTools: customTools.map((tool) => toSdkTool(sdk, tool)),
    });

    this.#counter += 1;
    const sessionId = session.sessionId ?? `pi-session-${this.#counter}`;
    const listeners = new Set<(event: WorkerEvent) => void>();

    const unsubscribe = session.subscribe((raw) => {
      const mapped = mapPiEvent(sessionId, raw);
      if (!mapped) return;
      for (const listener of listeners) listener(mapped);
    });

    this.#sessions.set(sessionId, {
      session,
      unsubscribe,
      listeners,
      loader,
      registeredTools: new Set(),
      brief,
      turns: 0,
    });

    if (session.sessionFile !== undefined) {
      this.#options.onSessionFile?.({ sessionId, sessionFile: session.sessionFile });
    }

    return {
      sessionId,
      sessionFile: session.sessionFile,
      createdAt: nowInstant() satisfies Instant,
    };
  }

  async setActiveTools(sessionId: string, toolNames: readonly string[]): Promise<void> {
    const entry = this.#require(sessionId);
    const allowed = new Set(toolNames);
    const all = entry.session.agent.state.tools;
    // Assignment, not a reload. The SDK copies the top-level array.
    entry.session.agent.state.tools = all.filter(
      (tool) => allowed.has(tool.name) || entry.registeredTools.has(tool.name),
    );
  }

  async registerTool(sessionId: string, tool: ToolDefinition): Promise<void> {
    const entry = this.#require(sessionId);
    if (entry.registeredTools.has(tool.name)) {
      throw new Error(
        `tool ${tool.name} is already registered on ${sessionId}; re-registering would install a duplicate handler`,
      );
    }
    const sdk = await this.#load();
    entry.session.agent.state.tools = [...entry.session.agent.state.tools, toSdkTool(sdk, tool)];
    entry.registeredTools.add(tool.name);
  }

  async refreshResources(
    sessionId: string,
    request: ResourceRefreshRequest,
  ): Promise<{ applied: ResourceRefreshRequest["scope"]; note: string }> {
    const entry = this.#require(sessionId);

    if (request.scope === "ui") {
      return {
        applied: "ui",
        note: "UI generation refreshed; the worker session was deliberately left untouched",
      };
    }

    if (request.scope === "pi-worker") {
      // A native extension change needs a new worker, not a reload. Saying so is
      // more useful than doing something surprising.
      return {
        applied: "pi-worker",
        note: "a new worker generation is required for this change; call handoff() instead of reloading in place",
      };
    }

    await entry.loader.reload();
    return {
      applied: request.scope,
      note: `resource loader reloaded for ${request.scope} (${request.reason}); existing subscriptions were retained and no tool was re-registered`,
    };
  }

  async handoff(
    sessionId: string,
    brief: WorkerBrief,
  ): Promise<{ successor: WorkerSessionHandle; note: string }> {
    const entry = this.#require(sessionId);
    const previousTurns = entry.turns;
    const successor = await this.createWorkerSession(brief);
    return {
      successor,
      note: `successor worker created after ${previousTurns} turn(s); the previous session stays subscribed until the caller disposes it so no event is dropped during the swap`,
    };
  }

  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    const entry = this.#require(sessionId);
    if (entry.listeners.has(listener)) {
      throw new Error(
        "the same listener was subscribed twice; every event would be delivered twice",
      );
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  async steer(sessionId: string, text: string): Promise<void> {
    await this.#require(sessionId).session.steer(text);
  }

  async abort(sessionId: string, reason: string): Promise<void> {
    const entry = this.#require(sessionId);
    this.#aborted.add(sessionId);
    await entry.session.abort();
    for (const listener of entry.listeners) {
      listener({ type: "error", sessionId, message: `aborted: ${reason}` });
    }
  }

  async dispose(sessionId: string): Promise<void> {
    const entry = this.#require(sessionId);
    // Release the SDK subscription first: a handler firing into a disposed session
    // is the leak this ordering prevents.
    entry.unsubscribe();
    entry.listeners.clear();
    entry.session.dispose();
    this.#aborted.delete(sessionId);
    this.#sessions.delete(sessionId);
  }

  usage(sessionId: string): WorkerUsage {
    const entry = this.#require(sessionId);
    const stats = entry.session.getSessionStats();
    const context = stats.contextUsage;
    return {
      turns: entry.turns,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      costUsd: stats.cost,
      ...(context === undefined || context.tokens === null ? {} : { contextTokens: context.tokens }),
      ...(context === undefined ? {} : { contextWindow: context.contextWindow }),
    };
  }

  /**
   * Send a prompt and resolve when the run settles.
   *
   * The brief's wall-clock budget bounds **this run**, and the timer below is what enforces it, so a
   * runaway run stops on its own rather than being noticed later.
   *
   * It used to be measured from the session's creation and checked before the prompt, which read the
   * wrong clock: a session older than its budget refused every message for the rest of its life. A
   * conversation works for two minutes and then fails every message afterwards, on the same session id,
   * with the same "exceeded its wall-clock budget" — however fast each individual turn was. That is a
   * long conversation, not a runaway run, and it was reported exactly that way: an error in the middle
   * of a chat that then repeated for every message after it.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    const entry = this.#require(sessionId);
    const budgetMs = entry.brief.maxWallClockMs;

    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    if (budgetMs !== undefined) {
      timer = setTimeout(() => {
        expired = true;
        void this.abort(sessionId, `wall-clock budget of ${budgetMs} ms exceeded`);
      }, budgetMs);
    }

    entry.turns += 1;
    try {
      await entry.session.prompt(text);
      await entry.session.agent.waitForIdle();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (expired && budgetMs !== undefined) {
      throw new Error(
        `worker ${sessionId} exceeded its ${budgetMs} ms wall-clock budget; it was stopped instead of continuing without a limit`,
      );
    }

    // TODO(P2): scope filesystem access to brief.projectRoots. The SDK's read and search tools resolve
    // paths themselves, so containment has to be applied by wrapping them rather than by inspection here.
    // Until that exists, callers must only pass project roots the user already approved and must not treat
    // this adapter as path-confining. (The conversation path's own `run_command` applies containment at the
    // point it runs something; that does not cover the worker's built-in tools, which is what this note is
    // about.)
  }

  /** Number of live listeners, so a leak is observable rather than argued about. */
  listenerCount(sessionId: string): number {
    // Strict rather than `?? 0`: silently reporting zero for a disposed session would
    // hide exactly the stale-handler bug this method exists to detect.
    return this.#require(sessionId).listeners.size;
  }

  /**
   * Load the SDK once per adapter instance.
   *
   * A static specifier is used so the module that may be loaded is fixed at build
   * time and cannot be redirected at runtime.
   */
  async #load(): Promise<SdkModule> {
    if (this.#sdk) return this.#sdk;
    if (this.#options.sdk) {
      this.#sdk = this.#options.sdk;
      return this.#sdk;
    }
    this.#sdk = await import("@earendil-works/pi-coding-agent");
    return this.#sdk;
  }

  #require(sessionId: string) {
    const entry = this.#sessions.get(sessionId);
    if (!entry) throw new Error(`unknown or disposed Pi session ${sessionId}`);
    return entry;
  }
}

/** Default tool set: read-only. Write access is granted explicitly, never by default. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * Map an SDK event onto the adapter vocabulary.
 *
 * Unrecognised SDK events are dropped rather than forwarded as opaque payloads: a
 * new event type arriving untyped is exactly the unvalidated shape the contracts
 * package exists to prevent.
 */
export function mapPiEvent(sessionId: string, raw: SdkEvent): WorkerEvent | undefined {
  switch (raw.type) {
    case "message_update": {
      const inner = raw.assistantMessageEvent;
      if (inner.type === "text_delta") {
        return { type: "text-delta", sessionId, delta: inner.delta };
      }
      if (inner.type === "thinking_delta") {
        return { type: "thinking-delta", sessionId, delta: inner.delta };
      }
      return undefined;
    }
    case "tool_execution_start":
      return {
        type: "tool-start",
        sessionId,
        toolName: raw.toolName,
        toolCallId: raw.toolCallId,
      };
    case "tool_execution_end":
      return {
        type: "tool-end",
        sessionId,
        toolName: raw.toolName,
        toolCallId: raw.toolCallId,
        isError: raw.isError,
      };
    case "turn_end":
      return { type: "turn-end", sessionId, hadToolCalls: raw.toolResults.length > 0 };
    case "agent_settled":
      return { type: "settled", sessionId };
    default:
      return undefined;
  }
}

/**
 * Refuse a capability that has no local implementation.
 *
 * The app must not imply a missing capability is available because a name for it
 * could be constructed.
 */
export function unsupportedCapability(ref: string): never {
  throw new NotImplementedError(
    `capability ${ref} has no local implementation`,
    "P5 (chat-driven install and lifecycle)",
  );
}

/** Read the installed SDK version, or `unknown` when it cannot be determined. */
export async function sdkVersion(): Promise<string> {
  try {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    // `import.meta.resolve` rather than `createRequire().resolve`: the SDK is ESM-only
    // and its `exports` map defines no `require` condition, so CommonJS resolution
    // fails outright. The package's own entry always resolves, and a deep import of
    // `package.json` is not permitted by the exports map, so the nearest manifest is
    // found by walking up from the resolved entry.
    const entryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    let dir = dirname(entryPath);
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "@earendil-works/pi-coding-agent" && parsed.version) return parsed.version;
      } catch {
        // No readable manifest at this level; keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
