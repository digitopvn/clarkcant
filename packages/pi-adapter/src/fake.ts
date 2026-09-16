import type { Instant } from "@clarkcant/contracts";

import type {
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

  /** Test-only driver: run the scripted reply for a session. */
  async run(sessionId: string, prompt: string): Promise<string> {
    const session = this.#require(sessionId);
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

  /** Test-only: run a registered tool the way the agent loop would. */
  async callTool(sessionId: string, toolName: string, params: Record<string, unknown>): Promise<string> {
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
    return result.text;
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
