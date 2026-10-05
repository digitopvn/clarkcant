import type { Instant } from "@clarkcant/contracts";
import type { ContextGuard } from "./context-guard-overrides.ts";

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
   * A non-empty list is an enforced boundary rather than a description of intent: the session gets the SDK's
   * own `read`/`grep`/`find`/`ls` left out of its allowlist and only the four scoped `clarkcant_*` tools the
   * adapter itself binds to these roots, each of which re-checks the identity of the root and canonicalises
   * the candidate — through `scoped-fs.ts` — before it touches the filesystem. A root that cannot be approved
   * stops the session by name rather than being dropped, and a caller's own tool under one of those four
   * names does not replace the binding, because only the adapter's is built from this list.
   *
   * An empty list grants no filesystem access. Such a session runs only the `builtinTools` its adapter was
   * constructed with, and that allowlist is empty unless the constructor names tools on purpose: the SDK's own
   * `read`/`grep`/`find`/`ls` resolve a path against the adapter's `cwd` themselves, so nothing above could
   * bound them. `apps/runtime/src/pack-load.ts` probes the packed worker with `projectRoots: []` on purpose — the
   * probe only proves the pack runs on this node — and that probe therefore has no filesystem tool at all
   * (`packages/pi-adapter/test/pi-adapter.spec.ts`). A packed worker dispatched with a *non-empty*
   * `projectRoots` gets the same boundary the project-session lane gets, through the `scopedToRoots` check in
   * `real.ts`.
   *
   * `apps/worker/src/tools.ts`'s own custom tools (`read_project_file`, `list_project_files`) do not go through
   * this field at all — they are registered by `apps/worker/src/index.ts`'s `runWorker`, outside the adapter —
   * and they now resolve every path through `scoped-fs.ts`'s `canonicalRoots`/`resolveInsideRoots` as well, so
   * a symlink inside an approved root cannot resolve outside it (see `apps/worker/test/worker.spec.ts`).
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
   * Whether this session may reach the filesystem only through the scoped tools, with nothing added later.
   *
   * The filesystem half of the boundary does not depend on this flag: any brief carrying a root runs with the
   * scoped tools bound to it and without the SDK's own file tools. What this adds is the rest of the
   * project-session lane — `setActiveTools` can never bring back a tool the session was not created with,
   * and the adapter has no way to add one afterwards. A brief that
   * declares it without an approved root is refused by name: a session confined to nothing has no filesystem
   * tool at all, which is a configuration error rather than a constraint somebody chose.
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
  /** The thinking level the person chose, for the same reason; absent keeps the adapter's configured level. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * What the model reads of a tool result, decided by the host: applied by the adapter to every tool it hands the
   * session — the scoped filesystem tools it binds itself included — and to a failed call's message, after the tool ran
   * and before the model reads anything of it. Absent sends results as they are.
   */
  toolResultGuard?: ToolResultGuard;
  /**
   * What the session's resource loader may take from the machine into its prompt — context files (`AGENTS.md`,
   * `CLAUDE.md`), a `SYSTEM.md`/`APPEND_SYSTEM.md`, skills (description and body) and prompt templates — decided by the
   * host for this session's model (`context-guard-overrides.ts`). A session with a guard gets a loader of its own built
   * with it, so a file is left out only for a model that may not receive it, and a `/skill:` message it is prompted or
   * steered with is checked again on the skill's file as it is when the message is sent. Absent loads everything the SDK
   * finds. An isolated adapter loads none of these in the first place.
   */
  contextGuard?: ContextGuard;
}

/**
 * The host's say over a tool result on its way to the model. `withheld` replaces the whole result with `text`: nothing
 * else the call returned, an image or a structured value included, is sent.
 *
 * `text` is everything of the result a model can come to read: its text, followed by its structured value as JSON
 * when it has one. `parts` is that structured value again, as each key and each string in it on its own and as
 * written: JSON escapes a quote, a backslash and a line break, and a shape a guard looks for can stop being one once
 * escaped. A guard classifies `text` and every part.
 */
export type ToolResultGuard = (input: {
  tool: string;
  text: string;
  parts?: readonly string[];
}) => { withheld: false } | { withheld: true; text: string };

/** A JSON value, as a tool's structured result is made of. */
export type ToolJsonValue = string | number | boolean | null | ToolJsonValue[] | { [key: string]: ToolJsonValue };

/** What `switchModel` changes. A field left out keeps what the session has. */
export interface ModelSwitch {
  model?: { provider: string; id: string };
  thinkingLevel?: WorkerBrief["thinkingLevel"];
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
  /**
   * JSON Schema of the result's `structuredContent`, declared to Pi as the tool's `outputSchema`.
   *
   * Pi hands a structured value to a program that calls the tool (a codemode script) only when the tool declares one;
   * the model itself always reads `text`. A tool that declares it should return `structuredContent` with every result.
   * No session this adapter creates turns codemode on, so today the value is carried and guarded but not read.
   */
  outputSchema?: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<{
    text: string;
    /**
     * The result as data, for a program that calls the tool, matching `outputSchema`.
     *
     * Held to the same guard as `text` and dropped with it when the result is withheld. It is data only: a block the host
     * records goes in `hostCard`, never here, so nothing shaped into this value becomes a card.
     */
    structuredContent?: { [key: string]: ToolJsonValue };
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
  /**
   * Whether the model can call tools, as the catalogue states it.
   *
   * Absent means unknown, never no: a model somebody configured by hand says nothing about tools, and guessing
   * would either refuse a model that works or offer one that does not. `false` is kept for a catalogue that states
   * it; pi's own catalogue only ever states `true`, because it lists only models that can call tools.
   */
  readonly toolCalls?: boolean;
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

/**
 * One skill pi would load for this node, as the composer offers it.
 *
 * `revision` is a digest of the skill's file, so a message that names a skill can say which version it meant: a skill
 * edited between choosing it and sending the message is reported rather than silently run in its new form. No path is
 * carried, because the composer and the model only ever need the name.
 */
export interface PiSkill {
  readonly name: string;
  readonly description: string;
  /** personal is the person's own agent directory, project the node's working directory, package an installed pi package. */
  readonly source: "personal" | "project" | "package";
  readonly revision: string;
}

/** A skill's instructions, or why the version a message named cannot be read any more. */
export type PiSkillBody =
  | { readonly ok: true; readonly name: string; readonly body: string }
  | { readonly ok: false; readonly reason: "missing" | "changed" };

/** How a provider is signed in to: its own browser or device sign-in, or a key pasted in. */
export type ProviderSignInMethod = "oauth" | "api_key";

/**
 * One provider pi can sign in to, and whether it is signed in now.
 *
 * `source` says where a configured credential comes from, because only some of them can be signed out of here: a key
 * in the environment belongs to whoever set it, and removing it is theirs to do. Never the credential itself.
 */
export interface ProviderAuthEntry {
  readonly providerId: string;
  readonly name: string;
  /** Present when the provider has a sign-in of its own; `subscription` when it signs in to a plan rather than an API. */
  readonly oauth?: { readonly label: string; readonly subscription: boolean };
  readonly apiKey: boolean;
  readonly configured: boolean;
  readonly source?: "stored" | "runtime" | "environment" | "models_json" | "fallback";
}

/** What a sign-in asks the person, in the provider's words. A `secret` answer is never echoed or kept. */
export type ProviderSignInPrompt =
  | { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
    };

/** What a sign-in tells the person while it runs: a page to open, a code to type there, or progress. */
export type ProviderSignInEvent =
  | { readonly type: "info" | "progress"; readonly message: string }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string };

export interface ProviderSignInInteraction {
  readonly signal: AbortSignal;
  prompt(prompt: ProviderSignInPrompt): Promise<string>;
  notify(event: ProviderSignInEvent): void;
}

export interface PiAdapter {
  /**
   * The providers pi can sign in to, with whether each is signed in. Optional: an adapter without accounts (a test's)
   * has nothing to list, and the caller says so rather than inventing providers.
   */
  providerAuth?(): Promise<readonly ProviderAuthEntry[]>;

  /** Runs the provider's own sign-in and stores the credential where pi keeps it; rejects with what went wrong. */
  signIn?(providerId: string, method: ProviderSignInMethod, interaction: ProviderSignInInteraction): Promise<void>;

  /** Removes the credential pi stored for the provider. A key from the environment is not pi's to remove. */
  signOut?(providerId: string): Promise<void>;

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

  /** The skills pi discovers for this node, the same set a worker session loads. */
  skills(): Promise<readonly PiSkill[]>;

  /**
   * The instructions of one skill, if it is still the version a message named.
   *
   * Frontmatter is removed: it describes the skill for a listing, and the model is given the listing's words already.
   */
  skillBody(name: string, revision: string): Promise<PiSkillBody>;

  createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle>;

  /** Replace the active tool set. Cheaper than reloading resources. */
  setActiveTools(sessionId: string, toolNames: readonly string[]): Promise<void>;

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
   * Move a session onto another model or thinking level in place, between runs.
   *
   * The session keeps its transcript, tools and subscriptions, and its next run is sent to the new model with
   * everything the session already holds. Whether the new model may read all of that is the caller's decision: when
   * it may not, the caller creates a successor with `handoff()` and a narrower brief instead. Refused while a run is
   * in progress or a steered message is still queued, and when the model is unknown or its provider has no
   * credential; a refused switch leaves the session on the model it had.
   */
  switchModel(sessionId: string, selection: ModelSwitch): Promise<void>;

  /**
   * Send a prompt and resolve when the run settles.
   *
   * Without this the seam could create a session but never start one. It resolves on settle
   * rather than on success: a run that ends without accomplishing anything is a result the
   * caller has to judge, not an error the adapter should throw.
   */
  prompt(sessionId: string, text: string): Promise<void>;

  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void;

  /**
   * Add a message to the run in progress. Pi queues it and the agent loop takes it at its next check; a steer that
   * lands after the loop's last check stays queued once `prompt` has resolved, which is what `hasQueuedMessages` and
   * `continueQueued` are for.
   */
  steer(sessionId: string, text: string): Promise<void>;

  /** Whether the session still holds a steered message its last run did not take. */
  hasQueuedMessages(sessionId: string): boolean;

  /** Run the session again on what it still holds queued, and resolve once that run has settled. */
  continueQueued(sessionId: string): Promise<void>;

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

/**
 * A change of a session's model failed after the session had already left the model it was on: which model it runs is
 * not what the caller last knew. The caller replaces the session rather than answer on it.
 */
export class ModelSwitchUnsureError extends Error {
  override readonly name = "ModelSwitchUnsureError";
}

export class NotImplementedError extends Error {
  constructor(what: string, phase: string) {
    super(`${what} is not implemented yet; it belongs to milestone ${phase}`);
    this.name = "NotImplementedError";
  }
}
