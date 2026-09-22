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
  /**
   * Directories the worker may touch, already policy-approved.
   *
   * An enforced boundary rather than a description of intent. A brief that declares
   * `confineToProjectRoots` runs with the SDK's own file tools left out of its allowlist and only the
   * scoped `read`/`grep`/`find`/`ls` tools registered, each of which canonicalises the path against these
   * roots — through `scoped-fs.ts` — before it touches the filesystem. An empty list is the conversation
   * path, which reads no file of its own.
   */
  projectRoots: string[];
  /** Capability refs the worker may call. Anything else is not registered. */
  allowedCapabilityRefs: string[];
  /**
   * Tools this session may call, registered when the session is created.
   *
   * Here rather than added afterwards for two reasons found by reading the SDK. A session's custom
   * tool set is fixed at creation, so a tool added later cannot be re-enabled once the registry is
   * rebuilt. And a tool added later bypasses the allowlist — it never reaches the registry, so the
   * system prompt keeps telling the model there are no tools, and a model that cannot see its tools
   * invents them.
   */
  customTools?: readonly ToolDefinition[];
  /**
   * Whether this session may reach the filesystem only through the scoped tools built from `projectRoots`.
   *
   * A project worker is a session whose reach is a directory a person chose. The runtime builds the scoped
   * tools from the approved roots and sets this, and the adapter then leaves the SDK's own
   * `read`/`grep`/`find`/`ls` out of the allowlist and refuses to register a tool afterwards: the boundary is
   * enforced where the act happens, not promised in a prompt. A brief that declares it without carrying the
   * scoped tools is refused by name rather than started with no filesystem tool at all.
   */
  confineToProjectRoots?: boolean;
  /** Token budget for the run. */
  maxTokens?: number;
  maxWallClockMs?: number;
  /**
   * The model this session should run, when it was chosen rather than configured.
   *
   * Per session rather than per adapter: a choice made in the interface can only reach a session that does not exist
   * yet, and the adapter is constructed once, long before anybody chooses anything.
   */
  model?: { provider: string; id: string };
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
  /**
   * One line for the system prompt's "Available tools" list.
   *
   * Required in practice even though the type allows it to be absent: the SDK leaves a custom tool
   * out of that list when this is missing, and the model is then told it has no tools while being
   * asked to use one.
   */
  promptSnippet?: string;
  execute: (params: Record<string, unknown>) => Promise<{
    text: string;
    /**
     * An image the model should receive as an image rather than as a description of one.
     *
     * A tool result is a list of content blocks, and the SDK's union has an image member, so a tool that
     * read a picture hands the picture over. Without this a picture reaches the model as its file name:
     * the model is told that a picture exists while what is in it stays hidden.
     */
    image?: { mimeType: string; dataBase64: string };
    /**
     * A block the host builds as a result of the call, recorded in the reply.
     *
     * Typed loosely here rather than against the message-block union, because this package must not take
     * a dependency on the contracts package: the node that wraps these tools validates the block against
     * the schema before it reaches a transcript.
     */
    hostCard?: Record<string, unknown>;
    /**
     * More than one block, when one call has more to record than a single card.
     *
     * `run_command` is why this exists: a guarded run records what ran *and* the exit-status evidence
     * for it, and collapsing those into one block would mean either losing the evidence or inventing a
     * block type that is both. The node validates each entry before it reaches a transcript, exactly as
     * it does for `hostCard`.
     */
    hostBlocks?: Record<string, unknown>[];
  }>;
}

export interface ResourceRefreshRequest {
  /** `ui` and `tool-service` do not need a Pi restart. */
  scope: "ui" | "tool-service" | "pi-resources" | "pi-worker";
  reason: string;
}

/** One model an installation can run, and the provider that serves it. */
export interface CatalogueModel {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow?: number;
  /** Whether this is the model the adapter is configured with, so a chooser can mark the current one. */
  readonly current: boolean;
}

/** What one provider offers. Every provider is listed, including ones with no credential yet. */
export interface CatalogueProvider {
  readonly id: string;
  readonly models: readonly CatalogueModel[];
}

/**
 * Everything this installation can run.
 *
 * The list is read from the SDK's own catalogue rather than from a table kept here, so a provider added by upgrading
 * pi appears without this project changing. Hiding unavailable providers would leave a person no way to learn they
 * exist, so they are listed and it is the chooser's job to say which are ready.
 */
export type ModelCatalogue = readonly CatalogueProvider[];

/** One thing pi loads from its own agent directory. Names and kinds only, never a file's contents. */
export interface PiExtension {
  readonly name: string;
  readonly kind: "directory" | "file";
}

/**
 * One line of pi's own configuration.
 *
 * A key and a value as text, because that is what a panel shows. Any key whose name suggests a secret is reported as
 * redacted rather than as a value: a settings file on a real machine can carry a provider key.
 */
export interface PiSetting {
  readonly key: string;
  readonly value: string;
}

export interface PiAdapter {
  /** Whether the SDK is actually usable in this process. */
  availability(): Promise<{ available: boolean; reason?: string; sdkVersion?: string }>;

  /** The providers this installation offers and the models each one has. */
  catalogue(): Promise<ModelCatalogue>;

  /**
   * What pi loads from its own agent directory.
   *
   * Names and kinds only. An extension on a machine can hold a credential, and a listing that read contents would be
   * the place it leaked from, so this deliberately reports less than it could.
   */
  extensions(): Promise<readonly PiExtension[]>;

  /** pi's own configuration, as far as it is safe to report it: scalars, with anything secret-sounding redacted. */
  piSettings(): Promise<readonly PiSetting[]>;

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

  /**
   * Send a prompt and resolve when the run settles.
   *
   * Without this the seam could create a session but never start one. It resolves on settle
   * rather than on success: a run that ends without accomplishing anything is a result the
   * caller has to judge, not an error the adapter should throw.
   */
  prompt(sessionId: string, text: string): Promise<void>;

  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void;

  steer(sessionId: string, text: string): Promise<void>;

  abort(sessionId: string, reason: string): Promise<void>;

  dispose(sessionId: string): Promise<void>;

  /** Turn count and cost for budget enforcement, when the SDK reports them. */
  usage(sessionId: string): WorkerUsage;
}

/**
 * What the SDK knows about a session's consumption.
 *
 * Every field but `turns` is optional, and stays absent when the SDK did not report it: a number invented
 * for a missing field is worse than a missing field, because a statusline reading "cache 0%" when the
 * provider never mentioned a cache is a lie told calmly.
 */
export interface WorkerUsage {
  turns: number;
  /** Total tokens, when the SDK reports a total rather than components. */
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** What the session has cost so far, in US dollars, when the provider prices it. */
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export class NotImplementedError extends Error {
  constructor(what: string, phase: string) {
    super(`${what} is not implemented yet; it belongs to milestone ${phase}`);
    this.name = "NotImplementedError";
  }
}
