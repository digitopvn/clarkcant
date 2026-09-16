import type { Instant } from "@clarkcant/contracts";
import { nowInstant } from "@clarkcant/contracts";

import { NotImplementedError, type PiAdapter, type ResourceRefreshRequest, type ToolDefinition, type WorkerBrief, type WorkerEvent, type WorkerSessionHandle } from "./types.ts";

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

/** SDK exports the adapter requires. Verified before any session is created. */
export const REQUIRED_SDK_EXPORTS = [
  "createAgentSession",
  "SessionManager",
  "DefaultResourceLoader",
  "defineTool",
  "ModelRuntime",
  "getAgentDir",
] as const;

export interface RealPiAdapterOptions {
  /** Working directory for the worker; also the loader's discovery root. */
  cwd: string;
  /** Directory holding Pi's own configuration and credentials. */
  agentDir?: string;
  /**
   * Built-in tool allowlist. Defaults to a read-only set: a worker that can write
   * must be granted that explicitly, not by omission.
   */
  builtinTools?: readonly string[];
  /** Injected so tests can exercise the adapter without loading the real SDK. */
  sdk?: SdkModule;
}

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
      startedAtMs: number;
      turns: number;
    }
  >();

  #sdk: SdkModule | undefined;
  #loader:
    | (SdkModule["DefaultResourceLoader"] extends new (options: infer _O) => infer R ? R : never)
    | undefined;
  #counter = 0;
  readonly #aborted = new Set<string>();

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
      } as never);
    this.#loader = loader;
    await loader.reload();

    const { session } = await sdk.createAgentSession({
      cwd: this.#options.cwd,
      ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
      sessionManager: sdk.SessionManager.inMemory(this.#options.cwd),
      resourceLoader: loader,
      tools: [...(this.#options.builtinTools ?? READ_ONLY_TOOLS)],
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
      startedAtMs: Date.now(),
      turns: 0,
    });

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
    // SAFETY: `defineTool` returns an `AnyToolDefinition`, which the SDK accepts in
    // both `customTools` and `agent.state.tools` at runtime. The declaration's
    // generic parameter is not inferred from our JSON-Schema-typed `parameters`
    // (the SDK expects a TypeBox schema), so the structural match fails at compile
    // time even though the runtime shape is the documented one. The P0.1 probe
    // exercises registration and invocation to keep this cast honest.
    const defined = sdk.defineTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as never,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const result = await tool.execute(params);
        return { content: [{ type: "text" as const, text: result.text }], details: {} };
      },
    }) as unknown as SdkTool;
    entry.session.agent.state.tools = [...entry.session.agent.state.tools, defined];
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

  usage(sessionId: string): { turns: number; tokens?: number } {
    return { turns: this.#require(sessionId).turns };
  }

  /**
   * Send a prompt and resolve when the run settles.
   *
   * The brief's wall-clock budget is enforced here, at the only place a run is
   * started, so a runaway worker stops on its own rather than being noticed later.
   */
  async prompt(sessionId: string, text: string): Promise<void> {
    const entry = this.#require(sessionId);
    const elapsedMs = Date.now() - entry.startedAtMs;
    const budgetMs = entry.brief.maxWallClockMs;
    if (budgetMs !== undefined && elapsedMs > budgetMs) {
      await this.abort(
        sessionId,
        `wall-clock budget of ${budgetMs} ms exceeded after ${elapsedMs} ms`,
      );
      throw new Error(
        `worker ${sessionId} exceeded its ${budgetMs} ms wall-clock budget; it was stopped instead of continuing without a limit`,
      );
    }
    // TODO(P2): scope filesystem access to brief.projectRoots. The SDK's read and
    // search tools resolve paths themselves, so containment has to be applied by
    // wrapping them rather than by inspection here. Until that exists, callers must
    // only pass project roots the user already approved and must not treat this
    // adapter as path-confining.
    entry.turns += 1;
    await entry.session.prompt(text);
    await entry.session.agent.waitForIdle();
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
