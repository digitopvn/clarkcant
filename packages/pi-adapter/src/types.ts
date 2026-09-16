import type { Instant } from "@clarkcant/contracts";

/**
 * The Pi seam.
 *
 * Only this package imports the Pi SDK. Everything else depends on `PiAdapter`, so
 * a breaking SDK change is an adapter change rather than a refactor of the core.
 *
 * The interface is deliberately narrower than the SDK. It exposes the lifecycle the
 * application actually relies on — create a worker session, decide which tools are
 * active, refresh resources at a safe boundary, subscribe, abort — and nothing
 * else, because every additional SDK surface is another thing a future SDK release
 * can break.
 */

export interface WorkerBrief {
  /** Bounded task description. Context is curated, not dumped. */
  goal: string;
  /** Directories the worker may touch, already policy-approved. */
  projectRoots: string[];
  /** Capability refs the worker may call. Anything else is not registered. */
  allowedCapabilityRefs: string[];
  /** Token budget for the run. */
  maxTokens?: number;
  maxWallClockMs?: number;
}

export interface WorkerSessionHandle {
  sessionId: string;
  /** Resume target, if the session is backed by a file. */
  sessionFile: string | undefined;
  createdAt: Instant;
}

export type WorkerEvent =
  | { type: "text-delta"; sessionId: string; delta: string }
  | { type: "thinking-delta"; sessionId: string; delta: string }
  | { type: "tool-start"; sessionId: string; toolName: string; toolCallId: string }
  | { type: "tool-end"; sessionId: string; toolName: string; toolCallId: string; isError: boolean }
  | { type: "turn-end"; sessionId: string; hadToolCalls: boolean }
  /** Pi will not continue on its own. Not the same as success. */
  | { type: "settled"; sessionId: string }
  | { type: "error"; sessionId: string; message: string };

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for parameters, so the contract stays runtime-validated. */
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<{ text: string }>;
}

export interface ResourceRefreshRequest {
  /** `ui` and `tool-service` do not need a Pi restart. */
  scope: "ui" | "tool-service" | "pi-resources" | "pi-worker";
  reason: string;
}

export interface PiAdapter {
  /** Whether the SDK is actually usable in this process. */
  availability(): Promise<{ available: boolean; reason?: string; sdkVersion?: string }>;

  createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle>;

  /** Replace the active tool set. Cheaper than reloading resources. */
  setActiveTools(sessionId: string, toolNames: readonly string[]): Promise<void>;

  registerTool(sessionId: string, tool: ToolDefinition): Promise<void>;

  /**
   * Refresh resources at a command/idle boundary.
   *
   * Returns the strategy that was actually applied, so the caller can report what
   * happened rather than assume a full restart occurred.
   */
  refreshResources(
    sessionId: string,
    request: ResourceRefreshRequest,
  ): Promise<{ applied: ResourceRefreshRequest["scope"]; note: string }>;

  /**
   * Create a successor session that carries the task forward.
   *
   * Used when an update genuinely needs a new worker generation. The task identity
   * is preserved by the caller; this only produces the new session.
   */
  handoff(
    sessionId: string,
    brief: WorkerBrief,
  ): Promise<{ successor: WorkerSessionHandle; note: string }>;

  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void;

  steer(sessionId: string, text: string): Promise<void>;

  abort(sessionId: string, reason: string): Promise<void>;

  dispose(sessionId: string): Promise<void>;

  /** Turn count and cost for budget enforcement, when the SDK reports them. */
  usage(sessionId: string): { turns: number; tokens?: number };
}

export class NotImplementedError extends Error {
  constructor(what: string, phase: string) {
    super(`${what} is not implemented yet; it belongs to milestone ${phase}`);
    this.name = "NotImplementedError";
  }
}
