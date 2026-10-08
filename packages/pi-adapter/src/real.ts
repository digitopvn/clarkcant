import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Instant } from "@clarkcant/contracts";
import { nowInstant } from "@clarkcant/contracts";

import { ModelSwitchUnsureError, NotImplementedError, type ModelCatalogue, type ModelSwitch,
  type PiExtension,
  type PiSetting, type PiSkill, type PiSkillBody, type PiAdapter, type ProviderAuthEntry, type ProviderSignInInteraction,
  type ProviderSignInMethod, type ResourceRefreshRequest, type ToolDefinition, type WorkerBrief, type WorkerEvent, type WorkerSessionHandle, type WorkerUsage } from "./types.ts";
import { canonicalRoots, createScopedFsTools, SCOPED_FS_TOOL_NAMES } from "./scoped-fs.ts";
import { guardToolResult } from "./tool-result-guard.ts";
import { contextGuardOverrides, readSkillBody, skillCheckedText } from "./context-guard-overrides.ts";

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
 * - Which tools are active is a call to the session's `setActiveToolsByName`, not a reload.
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
type SdkTool = NonNullable<NonNullable<Parameters<SdkModule["createAgentSession"]>[0]>["customTools"]>[number];
type SdkAgent = SdkSession["agent"];
type SdkQueuedMessage = ReturnType<SdkAgent["peekQueuedMessages"]>[number];

/**
 * Take every message out of the agent's own steering and follow-up queues, in order.
 *
 * The agent offers no drain, only a peek that shows the steering queue when it holds anything and the follow-up queue
 * otherwise, and only its first message unless the queue is in "all" mode. So both queues are switched to "all" for
 * the read, the steering queue is peeked and cleared, and the follow-up queue is peeked and cleared. When the steering
 * queue was empty both peeks show the same follow-up messages, which are the same objects; each queued message is its
 * own object, so a first peek that starts with the follow-up queue's first message held no steering at all.
 */
function takeAgentQueues(agent: SdkAgent): { steering: SdkQueuedMessage[]; followUp: SdkQueuedMessage[] } {
  const modes = { steering: agent.steeringMode, followUp: agent.followUpMode };
  agent.steeringMode = "all";
  agent.followUpMode = "all";
  try {
    const first = agent.peekQueuedMessages();
    agent.clearSteeringQueue();
    const followUp = agent.peekQueuedMessages();
    agent.clearFollowUpQueue();
    const steering = first.length > 0 && first[0] !== followUp[0] ? first : [];
    return { steering, followUp };
  } finally {
    agent.steeringMode = modes.steering;
    agent.followUpMode = modes.followUp;
  }
}

type SdkImage = NonNullable<NonNullable<Parameters<SdkSession["prompt"]>[1]>["images"]>[number];

/** The text and pictures of a queued person's message, as the session queued them; undefined for any other message. */
function queuedUserParts(message: SdkQueuedMessage): { text: string; images: SdkImage[] } | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return { text: message.content, images: [] };
  return {
    text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    images: message.content.flatMap((part) => (part.type === "image" ? [part] : [])),
  };
}

/** Whether a queued message can start a run: an extension's message, or a person's message with text or a picture. */
function canStartRun(message: SdkQueuedMessage): boolean {
  if (message.role === "custom") return true;
  const parts = queuedUserParts(message);
  return parts !== undefined && (parts.text !== "" || parts.images.length > 0);
}

interface RunOptions {
  selectedTools: string[];
}

/** The private members of the SDK 1.0.2 session that `prompt()` uses after its input handlers. */
interface SessionPromptInternals {
  _flushPendingBashMessages: () => void;
  _flushPendingCustomMessages: () => void;
  _baseSystemPromptOptions: RunOptions;
  _runSystemPromptOptions: RunOptions | undefined;
  _pendingNextTurnMessages: SdkQueuedMessage[];
  _extensionRunner: {
    emitBeforeAgentStart: (
      text: string,
      images: SdkImage[] | undefined,
      options: RunOptions,
    ) => Promise<{
      messages: { customType: string; content: unknown; display: boolean; details?: unknown }[];
      systemPromptOptions: RunOptions;
    }>;
  };
  _normalizePromptImages: (images: SdkImage[] | undefined) => Promise<{ images: SdkImage[]; hints: string[] }>;
  _preparePromptAndToolLoadout: (options: RunOptions) => SdkQueuedMessage | undefined;
  _runAgentPrompt: (messages: SdkQueuedMessage[]) => Promise<void>;
}

/**
 * The session's private members `prepareRunWithoutInputHandlers` needs, when every one is there with the shape it uses;
 * undefined otherwise, so the caller can fall back to the public `prompt` before anything is taken off the queue.
 */
function sessionPromptInternals(session: SdkSession): SessionPromptInternals | undefined {
  const internals = session as unknown as Partial<Record<keyof SessionPromptInternals, unknown>>;
  const functions = [
    internals._flushPendingBashMessages,
    internals._flushPendingCustomMessages,
    internals._normalizePromptImages,
    internals._preparePromptAndToolLoadout,
    internals._runAgentPrompt,
    (internals._extensionRunner as { emitBeforeAgentStart?: unknown } | undefined)?.emitBeforeAgentStart,
  ];
  const base = internals._baseSystemPromptOptions as { selectedTools?: unknown } | undefined;
  const shaped =
    functions.every((member) => typeof member === "function") &&
    Array.isArray(base?.selectedTools) &&
    Array.isArray(internals._pendingNextTurnMessages) &&
    "_runSystemPromptOptions" in internals;
  return shaped ? (session as unknown as SessionPromptInternals) : undefined;
}

/**
 * Prepare the session's run on text that already went through the extensions' input handlers and expansion, as
 * `prompt()` does after those steps, and return the call that starts it.
 *
 * SAFETY: mirrors `AgentSession.prompt()` of `@earendil-works/pi-coding-agent` 1.0.2 from its bash and custom flush to
 * its `_runAgentPrompt` call; `test/sdk-compatibility.spec.ts` holds a copy of that code and of the members used here,
 * and fails when the installed SDK's differ. It runs `before_agent_start` and applies what it returns: the system
 * prompt (ClarkCant's personal instructions arrive this way), the injected messages and the tool loadout. It also
 * attaches pending `nextTurn` messages and normalises the pictures. Three steps are left out on purpose:
 * - the streaming and `_compactionAbortController` checks, which come before the input handlers: the caller refuses
 *   while the session streams or compacts;
 * - the auth pre-check: a provider refusal still ends the run with an error the caller reports;
 * - the pre-send `_checkCompaction(lastAssistant, false)`: it only catches a last response that was aborted, whose
 *   post-run compaction check was skipped, and a queue is only drained after a run that finished, never after a Stop.
 *   Compaction by threshold still runs before every model call of the run, from the session's next-turn preparation.
 *
 * Nothing is changed that `prompt()` would not redo until the returned call: the pending `nextTurn` messages are taken
 * and the run's system prompt options set only then. So when a step throws here, the caller can still send the same
 * text through `prompt()` with nothing lost.
 */
async function prepareRunWithoutInputHandlers(
  session: SdkSession,
  internals: SessionPromptInternals,
  text: string,
  images: SdkImage[] | undefined,
): Promise<() => Promise<void>> {
  internals._flushPendingBashMessages();
  internals._flushPendingCustomMessages();
  if (!session.model) throw new Error("no model is selected for this session");
  const selectedToolsBefore = internals._baseSystemPromptOptions.selectedTools;
  const result = await internals._extensionRunner.emitBeforeAgentStart(text, images, internals._baseSystemPromptOptions);
  const handlerEditedTools =
    result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
    result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
  if (!handlerEditedTools) result.systemPromptOptions.selectedTools = session.getActiveToolNames();
  const normalized = await internals._normalizePromptImages(images);
  const userText = normalized.hints.length > 0 ? `${text}\n\n${normalized.hints.join("\n")}` : text;
  const messages: SdkQueuedMessage[] = [
    { role: "user", content: [{ type: "text", text: userText }, ...normalized.images], timestamp: Date.now() },
  ];
  const nextTurn = [...internals._pendingNextTurnMessages];
  messages.push(...nextTurn);
  for (const message of result.messages) {
    messages.push({
      role: "custom",
      customType: message.customType,
      content: message.content ?? [],
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    } as SdkQueuedMessage);
  }
  const updateMessage = internals._preparePromptAndToolLoadout(result.systemPromptOptions);
  if (updateMessage) messages.unshift(updateMessage);
  return () => {
    internals._pendingNextTurnMessages = internals._pendingNextTurnMessages.filter((message) => !nextTurn.includes(message));
    internals._runSystemPromptOptions = result.systemPromptOptions;
    return internals._runAgentPrompt(messages);
  };
}

/**
 * Convert one of our tool definitions into the SDK's shape.
 *
 * SAFETY: `defineTool` is an identity function at runtime, and the SDK accepts the result in
 * `customTools`. The declaration's generic parameter is not inferred from
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
    ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: [...tool.promptGuidelines] }),
    // Same reason as `parameters`: a plain JSON Schema where the declaration expects a TypeBox one.
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema as never }),
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await tool.execute(params);
      // A tool that read a picture returns the picture. The SDK's content union has an image member, and
      // flattening it to the sentence beside it would tell the model that a picture exists while hiding what
      // is in it. The sentence stays, so a transcript still says which file the picture came from.
      // A structured value goes to the SDK as `structuredContent`, which it gives to a program calling the tool and
      // never to the model; the model reads the text.
      return {
        content: [
          { type: "text" as const, text: result.text },
          ...(result.image === undefined
            ? []
            : [{ type: "image" as const, data: result.image.dataBase64, mimeType: result.image.mimeType }]),
        ],
        details: {},
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
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
import { providerErrorReason } from "./provider-error.ts";

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
   * The key for the configured model's provider, when the process was handed one rather than holding it itself.
   *
   * A dispatched worker runs with an environment that carries no provider key on purpose, so the node hands it the key
   * over its stdin instead. It goes into the SDK's runtime credential overlay (`setRuntimeApiKey`), which keeps it in
   * this process's memory and writes nothing to disk; it is never put into `process.env`, where anything this process
   * started would inherit it. Applied only to `model.provider`: it is that provider's key and nobody else's.
   */
  apiKey?: string;
  /**
   * Built-in tool allowlist. Defaults to none at all.
   *
   * The SDK's own tools resolve paths against `cwd` themselves, so no project root can bound them. A session
   * reaches the filesystem through the scoped tools bound to its brief's roots, and a session without roots
   * reaches nothing — the packed-worker probe is one. An adapter that really wants the SDK's tools names them
   * here (the SDK probe CLI passes `READ_ONLY_TOOLS`), so an unconfined read is a choice somebody made rather
   * than what happens when nobody chose.
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
   *
   * Called with the id of the session whose run is starting (`undefined` when the SDK does not say), so a host
   * that checks the text against that session's model before it prompts can hand back exactly the value it
   * checked, rather than whatever the preference holds a moment later.
   */
  personalInstructions?: (sessionId: string | undefined) => string | undefined;
  /**
   * Load nothing from the machine into a session: no extension, skill, prompt template, theme or instructions file
   * (`AGENTS.md`/`CLAUDE.md`) the SDK would otherwise discover under `cwd` or `agentDir`.
   *
   * A dispatched worker sets it. Its tools, its goal and its model are the host's decision, and a file that happens to
   * sit above the directory it was started from must not add hooks, text or behaviour to it. Inline extensions this
   * adapter registers itself (`personalInstructions`) are still applied.
   */
  isolated?: boolean;
  /** Injected so tests can exercise the adapter without loading the real SDK. */
  sdk?: SdkModule;
}

/** The reasoning levels the SDK accepts. Mirrored as a union so the option is typed. */
type SdkModelRuntime = Awaited<ReturnType<SdkModule["ModelRuntime"]["create"]>>;
type SdkModel = ReturnType<SdkModelRuntime["getModels"]>[number];

/**
 * Model ids a provider retired, mapped to the catalogue id that replaced them.
 *
 * A saved pick or an `.env` written before the rename keeps working instead of failing every turn: Pi 1.0 dropped
 * DeepSeek's retired `deepseek-v4-flash` alias in favour of `deepseek-flash` (V4.1 Flash).
 */
const RETIRED_MODEL_IDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  deepseek: { "deepseek-v4-flash": "deepseek-flash" },
};

/** One key per provider and model id; the separator cannot appear in either. */
function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
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
      /**
       * The tool names the session was created with, captured once and never changed.
       *
       * `setActiveTools` chooses from this list rather than from the current one. Filtering the current list made
       * narrowing one-way: a tool left out of one turn could never come back on the next, and a per-turn tool set
       * needs to widen as often as it narrows. Choosing only from this list is also what keeps it from widening past
       * what the session was created with.
       */
      baseline: readonly string[];
      brief: WorkerBrief;
      /**
       * Whether this session's filesystem reach is the approved project roots and nothing else.
       *
       * Kept so the one path that changes the session's tools after creation — `setActiveTools` — can be
       * answered from the session's own state rather than from what a caller believed it was creating.
       */
      confined: boolean;
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
  /** Whether this adapter already warned that a queued steer went through the public `prompt` again. */
  #promptFallbackWarned = false;
  #modelRuntime: SdkModelRuntime | undefined;
  #builtins: ReadonlyMap<string, { api: string; baseUrl: string }> | undefined;
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

    // No options: the credentials this resolves against are a key handed to this adapter, else the
    // process environment's, which is the path an operator can control without editing a file in
    // their home directory. The runtime has no `agentDir` option, so the credential directory an
    // operator sets on the adapter is deliberately not threaded here — env is the contract.
    const runtime = await this.#runtime(sdk);

    const available = runtime.getModels(wanted.provider);
    if (available.length === 0) {
      const providers = runtime.getProviders().map((provider) => provider.id);
      throw new Error(
        `no models are available for provider "${wanted.provider}"; available providers: ${providers.join(", ")}`,
      );
    }
    const model =
      available.find((candidate) => candidate.id === wanted.id) ??
      available.find((candidate) => candidate.id === RETIRED_MODEL_IDS[wanted.provider]?.[wanted.id]);
    if (model === undefined) {
      const ids = available.map((candidate) => candidate.id).join(", ");
      throw new Error(
        `provider "${wanted.provider}" has no model "${wanted.id}"; it offers: ${ids}`,
      );
    }
    return { runtime, model };
  }

  /**
   * The SDK's model runtime, created once, with a handed-over key applied before anything can ask it for a model.
   *
   * Applied here rather than per session so there is exactly one moment the key enters the SDK, and it enters as a
   * runtime key: it shadows whatever the credential file holds for that provider and is never written back to it.
   */
  async #runtime(sdk: SdkModule): Promise<SdkModelRuntime> {
    if (this.#modelRuntime !== undefined) return this.#modelRuntime;
    const runtime = await sdk.ModelRuntime.create({});
    const provider = this.#options.model?.provider;
    if (this.#options.apiKey !== undefined && this.#options.apiKey !== "" && provider !== undefined) {
      await runtime.setRuntimeApiKey(provider, this.#options.apiKey);
    }
    this.#modelRuntime = runtime;
    return runtime;
  }

  /**
   * The models pi ships with, as it ships them, keyed by provider and id.
   *
   * Read from a second runtime that ignores the agent directory's `models.json` and never refreshes, so a model
   * found here is one pi's own built-in catalogue lists, not one somebody configured. pi's model library lists only
   * models that can call tools, so this is the one place a catalogue states tool support; anything else is left
   * unknown. A runtime that cannot be created leaves every model unknown rather than failing the catalogue.
   */
  async #builtinModels(sdk: SdkModule): Promise<ReadonlyMap<string, { api: string; baseUrl: string }>> {
    if (this.#builtins !== undefined) return this.#builtins;
    const builtins = new Map<string, { api: string; baseUrl: string }>();
    try {
      const pristine = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      for (const provider of pristine.getProviders()) {
        for (const model of pristine.getModels(provider.id)) {
          builtins.set(modelKey(provider.id, model.id), { api: String(model.api), baseUrl: model.baseUrl });
        }
      }
    } catch {
      // Unknown, not "no": a catalogue that cannot say leaves the question open.
    }
    this.#builtins = builtins;
    return builtins;
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
    const runtime = await this.#runtime(sdk);
    const builtins = await this.#builtinModels(sdk);
    const current = this.#options.model;

    return runtime.getProviders().map((provider) => ({
      id: provider.id,
      models: runtime.getModels(provider.id).map((model) => {
        // Built in only while it still points where pi's own entry does: a models.json override that moves a
        // built-in id to another endpoint or API is somebody else's model under the same name.
        const builtin = builtins.get(modelKey(provider.id, model.id));
        const unchanged = builtin !== undefined && builtin.api === String(model.api) && builtin.baseUrl === model.baseUrl;
        return {
          provider: provider.id,
          id: model.id,
          current: current?.provider === provider.id && current.id === model.id,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(unchanged ? { toolCalls: true } : {}),
        };
      }),
    }));
  }

  /**
   * The providers pi can sign in to, read from the same runtime the turns use, so a sign-in made here is the one the
   * next turn finds. Only providers with a way in — their own sign-in or a key — are listed.
   */
  async providerAuth(): Promise<readonly ProviderAuthEntry[]> {
    const sdk = await this.#load();
    const runtime = await this.#runtime(sdk);
    return runtime
      .getProviders()
      .filter((provider) => provider.auth.oauth !== undefined || provider.auth.apiKey !== undefined)
      .map((provider) => {
        const status = runtime.getProviderAuthStatus(provider.id);
        const oauth = provider.auth.oauth;
        const source = providerAuthSource(status.source);
        return {
          providerId: provider.id,
          name: provider.name,
          ...(oauth === undefined
            ? {}
            : { oauth: { label: oauth.loginLabel ?? oauth.name, subscription: oauth.isSubscription === true } }),
          apiKey: provider.auth.apiKey !== undefined,
          configured: status.configured,
          ...(status.configured && source !== undefined ? { source } : {}),
        };
      })
      .sort((left, right) => Number(right.configured) - Number(left.configured) || left.name.localeCompare(right.name));
  }

  /**
   * The provider's own sign-in, through pi: pi opens the page or asks for the code or key, and stores what it gets
   * where it keeps credentials. What the person types passes straight through `interaction` and is never held here.
   */
  async signIn(providerId: string, method: ProviderSignInMethod, interaction: ProviderSignInInteraction): Promise<void> {
    const sdk = await this.#load();
    const runtime = await this.#runtime(sdk);
    await runtime.login(providerId, method, {
      signal: interaction.signal,
      prompt: (prompt) =>
        interaction.prompt(
          prompt.type === "select"
            ? { type: "select", message: prompt.message, options: prompt.options }
            : { type: prompt.type, message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) },
        ),
      notify: (event) => {
        if (event.type === "auth_url") {
          interaction.notify({ type: "auth_url", url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) });
        } else if (event.type === "device_code") {
          interaction.notify({ type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri });
        } else {
          interaction.notify({ type: event.type, message: event.message });
        }
      },
    });
  }

  async signOut(providerId: string): Promise<void> {
    const sdk = await this.#load();
    const runtime = await this.#runtime(sdk);
    await runtime.logout(providerId);
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
        // What pi would load: a folder, or a script file. A backup, a note or a config file left beside them is not an
        // extension, and listing one as if it were tells the reader pi runs something it never does.
        .filter((entry) => entry.isDirectory() || (/\.(?:ts|js|mjs|cjs|mts|cts)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")))
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

  /**
   * The skills pi discovers for this node.
   *
   * Read through a loader configured like the worker's, so the list is the set a worker session would load, including
   * skills from installed pi packages and from paths in pi's settings, rather than a guess at where they live.
   * Extensions, prompt templates, themes and context files are switched off: this is a listing, and loading an
   * extension runs its code. A skill passed on a command line only (`temporary`) is not offered, because nothing the
   * composer sends can rely on it still being there.
   */
  async skills(): Promise<readonly PiSkill[]> {
    const listed: PiSkill[] = [];
    for (const skill of await this.#discoverSkills()) {
      const content = await readSkillFile(skill.filePath);
      if (content === undefined) continue;
      listed.push({ name: skill.name, description: skill.description, source: skill.source, revision: digest(content) });
    }
    return listed.sort((left, right) => left.name.localeCompare(right.name));
  }

  async skillBody(name: string, revision: string): Promise<PiSkillBody> {
    const sdk = await this.#load();
    const skill = (await this.#discoverSkills()).find((candidate) => candidate.name === name);
    const content = skill === undefined ? undefined : await readSkillFile(skill.filePath);
    if (content === undefined) return { ok: false, reason: "missing" };
    if (digest(content) !== revision) return { ok: false, reason: "changed" };
    return { ok: true, name, body: sdk.stripFrontmatter(content).trim() };
  }

  async #discoverSkills(): Promise<{ name: string; description: string; filePath: string; source: PiSkill["source"] }[]> {
    const sdk = await this.#load();
    try {
      const loader = new sdk.DefaultResourceLoader({
        cwd: this.#options.cwd,
        agentDir: this.#options.agentDir ?? sdk.getAgentDir(),
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      } as never);
      await loader.reload();
      return loader.getSkills().skills.flatMap((skill) => {
        const source =
          skill.sourceInfo.origin === "package"
            ? ("package" as const)
            : skill.sourceInfo.scope === "user"
              ? ("personal" as const)
              : skill.sourceInfo.scope === "project"
                ? ("project" as const)
                : undefined;
        return source === undefined
          ? []
          : [{ name: skill.name, description: skill.description, filePath: skill.filePath, source }];
      });
    } catch {
      // A loader that cannot read pi's configuration offers no skills: the composer then has nothing to suggest, which
      // is true, rather than an error in a picker the person only opened to type a slash.
      return [];
    }
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
    //
    // A brief with a context guard gets a loader of its own, built with that guard: what it may load is decided for
    // this session's model, and a loader shared with a session on another model would hold every session to whichever
    // guard built it. The loader is reloaded for every session anyway, so a new one costs no extra read.
    const guard = brief.contextGuard;
    const loader =
      (guard === undefined ? this.#loader : undefined) ??
      new sdk.DefaultResourceLoader({
        cwd: this.#options.cwd,
        agentDir: this.#options.agentDir ?? sdk.getAgentDir(),
        ...(this.#options.isolated === true
          ? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }
          : {}),
        ...(guard === undefined ? {} : contextGuardOverrides(guard)),
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
                    on: (
                      event: string,
                      handler: (
                        event: { systemPrompt: string },
                        ctx?: { sessionManager?: { getSessionId?: () => string } },
                      ) => { systemPrompt: string },
                    ) => void;
                  }) => {
                    api.on("before_agent_start", (event, ctx) => ({
                      systemPrompt: composePersonalInstructions({
                        base: event.systemPrompt,
                        // The SDK's session id is the one `createWorkerSession` returned for this session.
                        text: this.#options.personalInstructions?.(ctx?.sessionManager?.getSessionId?.()),
                      }),
                    }));
                  },
                },
              ],
            }),
      } as never);
    if (guard === undefined) this.#loader = loader;
    await loader.reload();

    const selection = await this.#resolveModel(sdk, brief.model ?? this.#options.model);

    /*
     * The filesystem tools are bound to the brief's roots here, so no call site can forget to opt in.
     *
     * `projectRoots` is an enforced boundary rather than a description of intent, which means the tools that
     * enforce it have to be built from the list the brief carries: a caller that built them from some other
     * directory, or that carried roots without carrying tools at all, would leave the session on the SDK's own
     * `read`/`grep`/`find`/`ls` — tools nobody can tell about an approved root. So any brief that declares a
     * root gets the four scoped tools, bound to the approval of exactly those roots, and the SDK's built-ins
     * are left out. Roots that cannot be approved stop the session by name; a root dropped silently would
     * confine the worker to something other than what was approved.
     */
    const confined = brief.confineToProjectRoots === true;
    const scopedToRoots = confined || brief.projectRoots.length > 0;
    let filesystemTools: readonly ToolDefinition[] = [];
    if (scopedToRoots) {
      const approval = await canonicalRoots(brief.projectRoots);
      if (approval.refused.length > 0) {
        throw new Error(
          `a worker session cannot start confined to ${approval.refused
            .map((entry) => `${entry.root} (${entry.reason})`)
            .join("; ")}`,
        );
      }
      if (approval.approved.length === 0) {
        throw new Error(
          "a brief confined to its approved project roots carries no approved project root, so the session it would start has no filesystem tool at all",
        );
      }
      filesystemTools = createScopedFsTools({ roots: approval.approved });
    }
    /*
     * A caller's own tool under one of the four scoped names is not consulted: two definitions cannot share a
     * name, and only this one is bound to the roots the brief declares. Any other tool the caller supplies is
     * kept as it was — a brief carrying a root and an unrelated tool loses neither.
     */
    const customTools = [
      ...filesystemTools,
      ...(brief.customTools ?? []).filter(
        (tool) => !SCOPED_FS_TOOL_NAMES.some((name) => name === tool.name),
      ),
    ];
    /*
     * A session bound to roots gets no built-in tool at all.
     *
     * `builtinTools` is the adapter's allowlist for an ordinary session and is empty unless the adapter opts in, but
     * the SDK's own `read`, `grep`, `find` and `ls` resolve paths themselves — they cannot be told about an
     * approved root, so such a session must not have them. The scoped tools in `customTools` are the whole
     * filesystem surface it has, and they re-check containment in `scoped-fs.ts` before they touch anything.
     */
    const builtinTools = scopedToRoots ? [] : [...(this.#options.builtinTools ?? [])];
    /*
     * The SDK's own tools hand their results to the model directly, past the wrapper every tool here goes through, so a
     * session whose results are guarded cannot have them: refused by name rather than run with a hole in its guard.
     */
    if (brief.toolResultGuard !== undefined && builtinTools.length > 0) {
      throw new Error(
        `a session whose tool results are guarded cannot run the SDK's own tools (${builtinTools.join(", ")}): their results would reach the model unchecked`,
      );
    }

    const thinkingLevel = brief.thinkingLevel ?? this.#options.model?.thinkingLevel;
    const { session } = await sdk.createAgentSession({
      cwd: this.#options.cwd,
      ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
      ...(selection.runtime === undefined ? {} : { modelRuntime: selection.runtime }),
      ...(selection.model === undefined ? {} : { model: selection.model }),
      // The person's choice for this session, else the level the adapter was configured with.
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      // Persistent when a directory is configured, in memory otherwise. The distinction is
      // deliberate: an in-memory session leaves nothing to resume and nothing to search, which is
      // fine for a probe and wrong for a node.
      sessionManager:
        this.#options.sessionDir === undefined
          ? sdk.SessionManager.inMemory(this.#options.cwd)
          : sdk.SessionManager.create(this.#options.cwd, this.#options.sessionDir),
      resourceLoader: loader,
      /*
       * A custom tool has to be named in `tools` as well as supplied in `customTools`. The
       * allowlist is consulted by name, and it refuses anything it does not list — so a tool that
       * is registered but not listed is invisible, and an empty allowlist refuses every tool there
       * is. That combination is what made a model answer with invented tool syntax: it was told it
       * had no tools and asked to use one.
       *
       * The concatenation is load-bearing and must not be simplified into `builtinTools` alone: the SDK's
       * `tools` option is one allowlist gating built-in, extension and custom tools alike, so a confined
       * session passing `builtinTools: []` would drop its own scoped tools with the SDK's — the spike's case D.
       * Only this line keeps the four `clarkcant_*` tools reachable while the built-ins stay out.
       */
      tools: [...builtinTools, ...customTools.map((tool) => tool.name)],
      customTools: customTools.map((tool) => toSdkTool(sdk, guardToolResult(tool, brief.toolResultGuard))),
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
      // Read through the SDK's own accessor: these are the tools it declared to the model at creation, after its
      // allowlist. The adapter keeps names only and never holds or edits the SDK's tool objects.
      baseline: Object.freeze([...session.getActiveToolNames()]),
      brief,
      confined,
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
    // Chosen from the creation-time baseline, in its order: a name the session was not created with is never
    // activated from here, so a confined session cannot be widened, and a tool narrowed away on one turn can be
    // brought back on the next.
    const wanted = entry.baseline.filter((name) => allowed.has(name));
    const session = entry.session as SdkSession & { setActiveToolsByName?: (names: string[]) => void };
    if (typeof session.setActiveToolsByName !== "function") {
      // The pinned SDK has it; one without it would leave the system prompt describing tools the model cannot call.
      throw new Error(`the agent SDK in use cannot change ${sessionId}'s active tools`);
    }
    // Only the SDK's own path: it activates from its registry and rebuilds the system prompt, so the "Available
    // tools" list the model reads matches the tools it can call. Nothing here writes the session's tool list, and
    // there is no way to add a tool after creation — the SDK's allowlist is fixed when the session is made, so a
    // tool set that has to grow belongs to a new session.
    session.setActiveToolsByName([...wanted]);
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

  async switchModel(sessionId: string, selection: ModelSwitch): Promise<void> {
    const { session } = this.#require(sessionId);
    // Pi applies a model change to the agent's state at once; mid-run that would send the rest of one answer to a
    // different model, and a queued steer would be answered by a model the person did not address it to.
    const between = (): void => {
      if (session.isStreaming || session.agent.hasQueuedMessages()) {
        throw new Error("a session's model can only change between runs; this one is still running or holds a queued message");
      }
    };
    between();
    const resolved =
      selection.model === undefined ? undefined : (await this.#resolveModel(await this.#load(), selection.model)).model;
    // Again after the wait: a run may have started while the model was being looked up. Pi still checks the model's
    // account before it changes the session, and across that wait it is the caller that keeps runs and steers away.
    between();
    const before = session.model;
    try {
      // Session-only: Pi's `persist` would rewrite the default model of the person's own pi installation.
      if (resolved !== undefined) await session.setModel(resolved);
      // After the model, which resets the level to that model's own default; Pi clamps to what the model supports.
      if (selection.thinkingLevel !== undefined) session.setThinkingLevel(selection.thinkingLevel);
    } catch (cause) {
      // Pi sets the model before it records the change, so a failure there leaves the session already moved.
      if (session.model !== before) {
        throw new ModelSwitchUnsureError(cause instanceof Error ? cause.message : String(cause), { cause });
      }
      throw cause;
    }
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
    const entry = this.#require(sessionId);
    await entry.session.steer(this.#skillCommandChecked(entry, text));
  }

  /**
   * A message as it may be handed to the SDK's prompt or steer, which expand a leading `/skill:<name>` into the skill's
   * file read from disk at that moment.
   *
   * The loader checked every skill's file when the session was created, but the file can change after that. So for a
   * session with a context guard, the file is read and checked again now, and the expansion is written here from the
   * bytes that were checked, in the SDK's own form: the SDK is handed the finished text and reads nothing itself, so a
   * file swapped after the check is never what is sent. A skill whose file fails, or can no longer be read, is not
   * expanded: the message goes as typed, with a space in front so the SDK does not take it for a command.
   * A message that names no skill the session knows is passed through by the SDK as typed already.
   */
  #skillCommandChecked(
    entry: {
      brief: WorkerBrief;
      loader: {
        getSkills(): { skills: readonly { name: string; description: string; filePath: string; baseDir: string }[] };
      };
    },
    text: string,
  ): string {
    const guard = entry.brief.contextGuard;
    if (guard === undefined || !text.startsWith("/skill:")) return text;
    const end = text.indexOf(" ");
    const name = end === -1 ? text.slice("/skill:".length) : text.slice("/skill:".length, end);
    const args = end === -1 ? "" : text.slice(end + 1).trim();
    const skill = entry.loader.getSkills().skills.find((candidate) => candidate.name === name);
    if (skill === undefined) return text;
    const file = readSkillBody(skill.filePath);
    let allowed: boolean;
    try {
      // The same text the loader checked, as the file is now.
      allowed = file !== undefined && guard({ source: `skill:${skill.name}`, text: skillCheckedText(skill, file) });
    } catch {
      // A guard that cannot decide does not let the file through.
      allowed = false;
    }
    if (!allowed || file === undefined) return ` ${text}`;
    // Without the SDK's own reader of a skill's heading the file goes whole: all of it was checked.
    const body = (this.#sdk?.stripFrontmatter?.(file) ?? file).trim();
    const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args === "" ? block : `${block}\n\n${args}`;
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
    const checked = this.#skillCommandChecked(entry, text);
    await this.#bounded(sessionId, () => entry.session.prompt(checked));
  }

  hasQueuedMessages(sessionId: string): boolean {
    return this.#require(sessionId).session.agent.hasQueuedMessages();
  }

  /**
   * Run again on a steer the last run did not take. Pi's agent loop reads its steering queue between model calls; a
   * steer that lands after its last read stays queued once the run settles.
   *
   * Answered through the session's own run rather than the agent underneath it, so retry on a transient provider error,
   * compaction, the streaming flag and its settle events apply, which a bare `agent.continue()` skips. The person's
   * messages already went through the extensions' input handlers and were expanded when they were steered, so they are
   * sent the way `prompt` sends text after those steps (`prepareRunWithoutInputHandlers`): `before_agent_start` runs
   * again and its system prompt, messages and tools apply, but the input handlers do not run a second time. When the
   * SDK no longer has what that needs, or a step before the run throws, they go through the public `prompt` instead,
   * with a warning. Bounded as a prompt is, and refused with the queue untouched while the session still streams or
   * compacts.
   *
   * The agent's queue also holds what a Pi extension queued, interleaved with the person's steers. Clearing the
   * session's queue clears the agent's too, so the whole queue is taken off, in the order Pi would deliver it: every
   * steer, then every follow-up. The run starts from its head. When the head is the person's, it and the person's
   * messages straight after it in the same queue are joined into one prompt, their pictures kept; when it is an
   * extension's message, that message starts the run itself. Everything after the head is put back in the queue it came
   * from, in its order, so a steer stays a steer and a follow-up a follow-up, and the run takes it from there exactly as
   * Pi takes any queued message — in the default one-at-a-time mode, one steer per model call. Each message is sent
   * once: from the head only, or from the queue only.
   *
   * Every call takes at least the head off the queue. A head this adapter cannot start a run with — neither an
   * extension's message nor a person's message with text or a picture — is dropped with a process warning, and the run
   * starts on the next message instead, so the rest is still answered in the same call. Only when nothing sendable is
   * left does the call fail, naming what it dropped; a caller draining the queue in a loop always finishes.
   */
  async continueQueued(sessionId: string): Promise<void> {
    const entry = this.#require(sessionId);
    const { session } = entry;
    if (!session.agent.hasQueuedMessages()) return;
    // Refused before the queue is taken off, so nothing is lost: a run cannot start while one streams or compacts.
    if (session.isStreaming || session.isCompacting) {
      throw new Error(`worker ${sessionId} is still ${session.isStreaming ? "running" : "compacting"}; its queued messages stay queued`);
    }
    // Checked before the queue is taken off too, so the choice of path below never strands a message.
    const internals = sessionPromptInternals(session);
    const queued = takeAgentQueues(session.agent);
    // The session's own text copies of the person's messages; the agent's messages carry the same text and pictures.
    session.clearQueue();

    const dropped: string[] = [];
    let headQueue = queued.steering.length > 0 ? queued.steering : queued.followUp;
    let head = headQueue[0];
    while (head !== undefined && !canStartRun(head)) {
      dropped.push(head.role);
      headQueue.shift();
      headQueue = queued.steering.length > 0 ? queued.steering : queued.followUp;
      head = headQueue[0];
    }
    const droppedNote = `worker ${sessionId} dropped ${dropped.length} queued message(s) with nothing to send (${dropped.join(", ")})`;
    if (head === undefined) {
      if (dropped.length > 0) throw new Error(`${droppedNote}, and nothing sendable was left in its queue`);
      return;
    }
    if (dropped.length > 0) process.emitWarning(`${droppedNote}; the run starts on the next queued message`);
    let headLength = 1;
    if (head.role === "user") {
      while (headQueue[headLength]?.role === "user") headLength += 1;
    }
    const joined = headQueue.splice(0, headLength);
    for (const message of queued.steering) session.agent.steer(message);
    for (const message of queued.followUp) session.agent.followUp(message);

    if (head.role === "custom") {
      const { customType, content, display, details } = head;
      await this.#bounded(sessionId, () => session.sendCustomMessage({ customType, content, display, details }, { triggerTurn: true }));
      return;
    }
    const parts = joined.flatMap((message) => {
      const part = queuedUserParts(message);
      return part === undefined ? [] : [part];
    });
    const text = parts.map((part) => part.text).filter((sentence) => sentence !== "").join("\n\n");
    const pictures = parts.flatMap((part) => part.images);
    const images = pictures.length === 0 ? undefined : pictures;
    await this.#bounded(sessionId, async () => {
      let fallbackReason = "are missing or changed shape";
      let start: (() => Promise<void>) | undefined;
      if (internals !== undefined) {
        // Only the steps before the run fall back; a failure of the run itself is the run's, reported as a prompt's is.
        try {
          start = await prepareRunWithoutInputHandlers(session, internals, text, images);
        } catch (error) {
          fallbackReason = `failed (${error instanceof Error ? error.message : String(error)})`;
        }
      }
      if (start !== undefined) {
        await start();
        return;
      }
      // SAFETY: the fallback when the session's private members `prepareRunWithoutInputHandlers` mirrors from SDK
      // 1.0.2 are missing, changed shape, or throw before the run starts. The public `prompt` runs the extensions'
      // input handlers a second time on text they already handled, but the same text and pictures are sent, so
      // nothing is lost, and the run keeps its `before_agent_start` system prompt.
      this.#warnPromptFallback(fallbackReason);
      await session.prompt(text, { expandPromptTemplates: false, ...(images === undefined ? {} : { images }) });
    });
  }

  /** Warn, once per adapter, that queued steers go through the public `prompt` again, and why. */
  #warnPromptFallback(reason: string): void {
    if (this.#promptFallbackWarned) return;
    this.#promptFallbackWarned = true;
    process.emitWarning(
      `the Pi SDK session's private members a queued steer is sent with (mirrored from SDK 1.0.2) ${reason}; ` +
        "queued steers go through prompt() again, so extensions' input handlers run on them twice",
    );
  }

  async #bounded(sessionId: string, start: () => Promise<void>): Promise<void> {
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
      await start();
      await entry.session.agent.waitForIdle();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (expired && budgetMs !== undefined) {
      throw new Error(
        `worker ${sessionId} exceeded its ${budgetMs} ms wall-clock budget; it was stopped instead of continuing without a limit`,
      );
    }

    /*
     * A turn the provider refused ends with an assistant message whose stop reason is `error`, and the SDK settles as it
     * would after an answer. Without this, a rejected key or a model that does not exist reads as a session that
     * finished having done nothing. Read once the session is idle, so an error the SDK retried past is not reported;
     * a stop this adapter asked for has already said so.
     */
    // Read structurally: an SDK stand-in in a test may keep no message list at all.
    const messages = (entry.session as { messages?: readonly unknown[] }).messages;
    const last = messages?.at(-1) as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (last?.role === "assistant" && last.stopReason === "error" && !this.#aborted.has(sessionId)) {
      const reason = providerErrorReason(last.errorMessage);
      for (const listener of entry.listeners) {
        listener({ type: "error", sessionId, message: `the model's provider refused the turn: ${reason}` });
      }
    }

    // The boundary this note used to deny is enforced where the act happens, not here: the adapter binds the
    // four `clarkcant_*` tools to the brief's approved roots and leaves the SDK's own read/grep/find/ls out of
    // the allowlist for any session that declares one. Proven by `packages/pi-adapter/test/scoped-fs.spec.ts`
    // and `packages/pi-adapter/test/pi-adapter.spec.ts`.
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

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A skill file removed between discovery and reading is simply not there, which the caller reports as missing. */
async function readSkillFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
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
 *
 * TODO(P5): the capability this refuses — chat-driven install and lifecycle — has no local implementation yet,
 * and the phase that owns it is P5, "Chat-driven install and lifecycle", in the roadmap phase map
 * (`docs/implementation-plan.md` §8, and the milestone table above it). That phase map is not this repository's
 * consolidation plan: the consolidation plan's phase 5 owns the implementation-status registry and has nothing
 * to do with this throw, so the marker says which map it names rather than leaving "P5" to be read either way.
 * The confinement work that used to carry this file's marker is done: see `scoped-fs.ts` and the note in
 * `prompt` below.
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

/** Where pi says a configured credential comes from, in the adapter's smaller vocabulary. */
function providerAuthSource(source: string | undefined): ProviderAuthEntry["source"] {
  if (source === "stored" || source === "runtime" || source === "environment" || source === "fallback") return source;
  if (source === "models_json_key" || source === "models_json_command") return "models_json";
  return undefined;
}
