import type { Instant } from "@clarkcant/contracts";

import type {
  ModelCatalogue,
  PiExtension,
  PiSetting,
  PiAdapter,
  ResourceRefreshRequest,
  ToolDefinition,
  WorkerBrief,
  WorkerEvent,
  WorkerSessionHandle,
} from "./types.ts";

/**
 * Deterministic in-process adapter.
 *
 * Exists so the whole application can be exercised end to end without a provider
 * account: CI, conformance tests and local development all run against this.
 *
 * It is deliberately honest about what it is. It emits the same event shapes the
 * real adapter does, and it never claims to have inferred anything. Anything that
 * would require a model returns a scripted answer that says so.
 */
export class FakePiAdapter implements PiAdapter {
  readonly #sessions = new Map<
    string,
    {
      handle: WorkerSessionHandle;
      brief: WorkerBrief;
      tools: Map<string, ToolDefinition>;
      activeTools: string[];
      listeners: Set<(event: WorkerEvent) => void>;
      script: string[];
      disposed: boolean;
      turns: number;
      tokens: number;
      /**
       * Every prompt this session was given, in order.
       *
       * A seam of the test double, not behaviour of the adapter. It exists because some properties can
       * only be observed at this boundary: what the model was actually told, and — more importantly —
       * what it was not. "The prompt names the attachment and no disk path" has no other place to be
       * checked, since the composer's fixture output runs before the turn and never sees the prompt.
       */
      prompts: string[];
    }
  >();

  #counter = 0;
  #aborted = new Set<string>();
  readonly #options: { script?: string[]; now?: () => Instant };

  constructor(options: { script?: string[]; now?: () => Instant } = {}) {
    // Assigned rather than declared as a constructor parameter property, because Node's
    // type-stripping loader cannot execute that syntax (enforced by `pnpm invariants`).
    this.#options = options;
  }

  async availability(): Promise<{ available: boolean; reason?: string; sdkVersion?: string }> {
    return { available: true, sdkVersion: "fake-1.0.0" };
  }

  /**
   * A scripted catalogue, deliberately wider than one provider with one model.
   *
   * The real one is read from the SDK's own list; this exists so the routes and the chooser can be exercised without a
   * provider account. A chooser that only ever saw a single row would never exercise the grouping, and a catalogue
   * with only one model could never show the current one being marked among others.
   */
  async catalogue(): Promise<ModelCatalogue> {
    return [
      {
        id: "fake",
        models: [
          { provider: "fake", id: "fake-model", current: true },
          { provider: "fake", id: "fake-model-large", contextWindow: 500_000, current: false },
        ],
      },
      {
        id: "fake-other",
        models: [{ provider: "fake-other", id: "fake-other-model", current: false }],
      },
    ];
  }

  /** A scripted list, including both kinds, so a section rendering them has both to render. */
  async extensions(): Promise<readonly PiExtension[]> {
    return [
      { name: "fake-extension", kind: "directory" },
      { name: "fake-hook.ts", kind: "file" },
    ];
  }

  /** A scripted configuration, including a redacted entry so a panel rendering one has one to render. */
  async piSettings(): Promise<readonly PiSetting[]> {
    return [
      { key: "defaultModel", value: "fake-model" },
      { key: "providerApiKey", value: "[redacted]" },
    ];
  }

  async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    this.#counter += 1;
    const sessionId = `fake-session-${this.#counter}`;
    const handle: WorkerSessionHandle = {
      sessionId,
      sessionFile: undefined,
      createdAt: (this.#options.now ?? (() => new Date().toISOString() as Instant))(),
    };
    this.#sessions.set(sessionId, {
      handle,
      brief,
      tools: new Map(),
      activeTools: [],
      listeners: new Set(),
      script: this.#options.script ?? [],
      disposed: false,
      turns: 0,
      tokens: 0,
      prompts: [],
    });
    return handle;
  }

  async setActiveTools(sessionId: string, toolNames: readonly string[]): Promise<void> {
    const session = this.#require(sessionId);
    session.activeTools = [...toolNames];
  }

  async registerTool(sessionId: string, tool: ToolDefinition): Promise<void> {
    const session = this.#require(sessionId);
    if (session.tools.has(tool.name)) {
      // Registering the same name twice is a duplicate listener bug in disguise,
      // so it is refused rather than silently overwritten.
      throw new Error(`tool ${tool.name} is already registered on ${sessionId}`);
    }
    session.tools.set(tool.name, tool);
  }

  async refreshResources(
    sessionId: string,
    request: ResourceRefreshRequest,
  ): Promise<{ applied: ResourceRefreshRequest["scope"]; note: string }> {
    this.#require(sessionId);
    return {
      applied: request.scope,
      note: `fake adapter applied ${request.scope} refresh in place for: ${request.reason}`,
    };
  }

  async handoff(sessionId: string, brief: WorkerBrief): Promise<{ successor: WorkerSessionHandle; note: string }> {
    const previous = this.#require(sessionId);
    const successor = await this.createWorkerSession(brief);
    return {
      successor,
      note: `successor session created after ${previous.brief.goal.length} characters of prior brief; task identity is preserved by the caller`,
    };
  }

  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    const session = this.#require(sessionId);
    if (session.listeners.has(listener)) {
      throw new Error("the same listener was subscribed twice; this would duplicate every event");
    }
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  async steer(sessionId: string, text: string): Promise<void> {
    this.#require(sessionId);
    this.#emit(sessionId, { type: "text-delta", sessionId, delta: `[steered: ${text}] ` });
  }

  async abort(sessionId: string, reason: string): Promise<void> {
    this.#require(sessionId);
    this.#aborted.add(sessionId);
    this.#emit(sessionId, { type: "text-delta", sessionId, delta: `[aborted: ${reason}]` });
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.#require(sessionId);
    session.disposed = true;
    // Listeners must be released on dispose; keeping them would leak into the next
    // session and produce exactly the duplicate-handler failure T25 describes.
    session.listeners.clear();
    this.#sessions.delete(sessionId);
  }

  usage(sessionId: string): { turns: number; tokens?: number } {
    const session = this.#require(sessionId);
    return { turns: session.turns, tokens: session.tokens };
  }

  /** Satisfies the seam. Kept as a thin call so there is one implementation, not two. */
  async prompt(sessionId: string, text: string): Promise<void> {
    await this.run(sessionId, text);
  }

  /** Test-only driver: the prompts a session has been given, oldest first. */
  promptsFor(sessionId: string): readonly string[] {
    // An unknown session answers with nothing rather than throwing: a test asking "what was it told?"
    // about a session that was disposed is asking a question with an empty answer, not reporting a bug.
    return [...(this.#sessions.get(sessionId)?.prompts ?? [])];
  }

  /** Test-only driver: every prompt across every session, oldest session first. */
  allPrompts(): readonly string[] {
    return [...this.#sessions.values()].flatMap((session) => session.prompts);
  }

  /** Test-only driver: run the scripted reply for a session. */
  async run(sessionId: string, prompt: string): Promise<string> {
    const session = this.#require(sessionId);
    session.prompts.push(prompt);
    const scripted = session.script.shift() ?? `scripted reply to: ${prompt}`;
    session.turns += 1;
    session.tokens += Math.ceil(scripted.length / 4);

    if (this.#aborted.has(sessionId)) {
      this.#emit(sessionId, { type: "settled", sessionId });
      return "";
    }

    for (const chunk of chunkText(scripted)) {
      this.#emit(sessionId, { type: "text-delta", sessionId, delta: chunk });
    }
    this.#emit(sessionId, { type: "turn-end", sessionId, hadToolCalls: false });
    this.#emit(sessionId, { type: "settled", sessionId });
    return scripted;
  }

  /** Test-only: run a registered tool the way the agent loop would, and answer with its text. */
  async callTool(sessionId: string, toolName: string, params: Record<string, unknown>): Promise<string> {
    return (await this.callToolResult(sessionId, toolName, params)).text;
  }

  /**
   * Test-only: the whole result of a tool call.
   *
   * `callTool` answers with the text, which is what most tests want. This one exists because a tool that
   * read a picture also returns the picture, and a test that only ever sees the text cannot tell that apart
   * from a tool that described the picture instead of handing it over.
   */
  async callToolResult(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ text: string; image?: { mimeType: string; dataBase64: string } }> {
    const session = this.#require(sessionId);
    if (!session.activeTools.includes(toolName)) {
      throw new Error(`tool ${toolName} is not active on ${sessionId}`);
    }
    const tool = session.tools.get(toolName);
    if (!tool) throw new Error(`tool ${toolName} is not registered on ${sessionId}`);
    this.#emit(sessionId, { type: "tool-start", sessionId, toolName, toolCallId: `call-${toolName}` });
    const result = await tool.execute(params);
    this.#emit(sessionId, {
      type: "tool-end",
      sessionId,
      toolName,
      toolCallId: `call-${toolName}`,
      isError: false,
    });
    return result;
  }

  listenerCount(sessionId: string): number {
    // Strict rather than `?? 0`: silently reporting zero for a disposed session would
    // hide exactly the stale-handler bug this method exists to detect.
    return this.#require(sessionId).listeners.size;
  }

  #require(sessionId: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`unknown or disposed session ${sessionId}`);
    return session;
  }

  #emit(sessionId: string, event: WorkerEvent): void {
    for (const listener of this.#sessions.get(sessionId)?.listeners ?? []) {
      listener(event);
    }
  }
}

function chunkText(text: string, size = 12): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [""];
}
