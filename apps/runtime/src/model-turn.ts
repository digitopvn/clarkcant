/**
 * A conversation turn answered by a live model.
 *
 * The turn runs in the node's own process rather than in a spawned worker. That is a
 * deliberate split: a conversation turn is short, has no tool access, and must be able to
 * reach the model without the execution supervisor's environment allowlist deciding whether
 * a credential is permitted. A worker is for work that touches a project, and that path keeps
 * the allowlist it has.
 *
 * Exactly one tool is registered, and it is the only way a model reply can contain anything
 * other than prose. `show_view` takes a view *name* from a catalog the host supplies; the host
 * builds the block. No parameter in that tool's schema is called `type`, `owner` or `status`, so
 * the model has no vocabulary for describing a host-owned card — the forgery is not rejected, it
 * is unrepresentable. A filesystem or capability tool is still not registered: that is where
 * approval, evidence and budgets live, and a conversation turn has none of them.
 */

import { type AttachmentRef, type Instant, type MessageBlock, type Principal } from "@clarkcant/contracts";

import {
  RealPiAdapter,
  modelBudgetFromEnv,
  modelFromEnv,
  type ModelBudget,
  type ModelSelection,
  type ModelCatalogue,
  type PiExtension,
  type PiSetting,
  type PiAdapter,
  type ToolDefinition,
  type WorkerEvent,
} from "@clarkcant/pi-adapter";

import type { ModelSegment, ModelTurnEvent, ModelTurnInput, ModelTurnReply, TurnMetrics } from "@clarkcant/core";

import { attachmentBrief } from "./attachments.ts";

/**
 * One view a model may ask for.
 *
 * `build` is the host's, never the model's. The model supplies props; this function decides what
 * that becomes, which is what keeps the trust decision on the host's side of the line.
 */
export interface ViewDescriptor {
  /** The name the model uses, e.g. `canvas.table@1`. */
  id: string;
  /** Human label, quoted back in the tool's description so the model knows it exists. */
  label: string;
  /**
   * Extra sentence about this view's props, quoted in the tool description.
   *
   * A view whose props are a controlled vocabulary has to say so: a model that does not know the
   * names it may use will invent one, and the refusal then costs the user a turn.
   */
  notes?: string;
  /**
   * Build the block.
   *
   * Maybe asynchronous because one view — the composed surface — has to consult a selector and read
   * records before it can say what to draw. It is awaited inside the tool handler, which is the only
   * place with a turn to cancel; putting that work in a React renderer or a synchronous build would
   * mean an abandoned turn could still write a surface.
   */
  build: (input: ViewRequest) => MessageBlock | Promise<MessageBlock>;
}

export interface ViewRequest {
  props: Record<string, unknown>;
  caption: string;
  at: Instant;
  principal: Principal;
  /** The message this view will be captured into, allocated before the turn. */
  messageId: string;
  /** The conversation the turn belongs to, so a view can be persisted against it. */
  conversationId: string;
  /** Aborted when the turn is stopped, so a build in flight does not persist anything. */
  signal?: AbortSignal;
}

export const SHOW_VIEW_TOOL = "show_view";

export interface ModelTurn {
  /** What the node is configured to run on, recorded on the card for each reply. */
  selection: ModelSelection;
  /** The ceiling on one turn, so a caller can report what the limit was. */
  budget: ModelBudget;
  /** Whether a view catalog is available, so the interface can say so rather than guess. */
  viewCatalogSize: () => number;
  /** The conversations with a turn still running. */
  running: () => string[];
  /** Stops the running turn for a conversation, answering whether there was one. */
  interrupt: (conversationId: string) => boolean;
  /** Adds a sentence to the running turn, answering whether there was one to add it to. */
  steer: (conversationId: string, text: string) => Promise<boolean>;
  /**
   * Runs one request in a worker of its own, answering with what that worker said.
   *
   * The request does not belong to the conversation's session and does not wait for it: this is what lets a person
   * ask for something else while the assistant is busy, and it is deliberately not part of the turn machinery -
   * nothing here touches `turns` or the in-flight marker, so a background request cannot make the conversation look
   * busy or steal the turn that is running.
   */
  runInBackground: (input: { conversationId: string; principal: Principal; text: string }) => Promise<string>;

  /**
   * The providers and models this node can run, read from the SDK's own catalogue.
   *
   * Read on demand rather than held as a snapshot, for the same reason the view catalog is: the list belongs to the
   * SDK and this is only a way to ask it.
   */
  catalogue: () => Promise<ModelCatalogue>;

  /**
   * What pi loads from its own agent directory.
   *
   * Here because this is where the adapter lives, not because it is about a turn: the extension list belongs to pi's
   * installation rather than to any conversation, and the only thing that can reach it without importing the SDK twice
   * is the adapter this turn holds.
   */
  extensions: () => Promise<readonly PiExtension[]>;

  /** pi's own configuration, as far as it is safe to report it. */
  piSettings: () => Promise<readonly PiSetting[]>;
  answer: (input: ModelTurnInput) => Promise<ModelTurnReply>;
  dispose: () => Promise<void>;
}

interface Turn {
  sessionId: string;
  /** Text deltas since the last block, not yet turned into a segment. */
  pending: string[];
  /** Reasoning deltas since the last block. Flushed into a segment the same way text is. */
  reasoning: string[];
  /** Finished segments, in the order the model produced them. */
  segments: ModelSegment[];
  /** The message this turn is being written into. Set before the prompt. */
  messageId?: string;
  /**
   * Where events go while the turn is still running, when somebody is watching.
   *
   * Held per turn rather than per session because it belongs to the request that is waiting, and a
   * request that has ended must not keep receiving events: the session outlives the stream.
   */
  onEvent: ((event: ModelTurnEvent) => void) | undefined;
  /** Numbers the tool calls this turn made, so a start and an end can name the same widget. */
  toolSequence: number;
  unsubscribe: () => void;
  /** Aborted when the turn is stopped, so an in-flight build knows not to commit. */
  abort: AbortController;
  conversationId: string;
  /**
   * Whether the session behind this turn was just created, and so knows nothing about the conversation.
   *
   * A session is dropped when a turn fails, because a session that failed a turn is the thing that is broken.
   * The thread is not broken, so a new session has to be told what it is joining.
   */
  fresh: boolean;
  /**
   * Whether a turn is running for this conversation right now.
   *
   * On the turn rather than in a map keyed by conversation, because the lifetime is the turn's own: the session and
   * this flag are cleared by different paths, and a marker kept somewhere else is a marker that can outlive what it
   * describes - which is exactly what a first attempt at this did.
   */
  inFlight: boolean;
}

function isTextDelta(event: WorkerEvent): event is WorkerEvent & { type: "text-delta"; delta: string } {
  return event.type === "text-delta";
}

/**
 * Move whatever text has accumulated into a segment.
 *
 * Called before a block is appended, so a block lands where the model actually asked for it
 * rather than below the whole reply.
 */
/**
 * The prompt for one turn: what the person said, plus whatever guidance the caller attached.
 *
 * The note is marked as an instruction rather than left as plain text, because a model that reads guidance as
 * part of the message answers a question nobody asked. Today the only caller that sets one is the voice path,
 * which asks for the short version - the session has to read it aloud.
 */
/** Reads the conversation so far, newest last, for briefing a session that has just been created. */
type HistoryReader = (
  conversationId: string,
) => Promise<readonly { role: "user" | "assistant"; text: string }[]>;

/**
 * The note a turn is prompted with: the brief for a new session first, then whatever this turn was given.
 *
 * Both are instructions to the model rather than things the user said, and the brief goes first because it is
 * the context the rest is read in.
 */
function withRecap(recap: string, note: string | undefined): string | undefined {
  const parts = [recap, note ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * A brief of the conversation so far, short enough to read and specific enough to continue from.
 *
 * The last few messages only: a brief that grows with the conversation stops being a brief, and the point is
 * to place the model in the thread rather than to reproduce it. Each line is clipped for the same reason.
 */
async function recapFor(options: { history?: HistoryReader }, conversationId: string): Promise<string> {
  if (options.history === undefined) return "";
  let messages: readonly { role: "user" | "assistant"; text: string }[];
  try {
    messages = await options.history(conversationId);
  } catch {
    // A brief that cannot be read is not a reason to refuse the turn: the answer is still an answer, only a
    // less informed one, and failing here would turn a storage hiccup into a conversation that stops.
    return "";
  }
  const recent = messages.slice(-12);
  if (recent.length === 0) return "";
  const lines = recent.map(
    (message) =>
      `${message.role === "user" ? "Người dùng" : "Trợ lý"}: ${message.text.replace(/\s+/g, " ").trim().slice(0, 400)}`,
  );
  return `Mạch hội thoại trước đó, để bạn tiếp tục đúng việc đang làm:\n${lines.join("\n")}`;
}

function promptForTurn(input: { text: string; note?: string; brief?: string }): string {
  const note = input.note?.trim() ?? "";
  const brief = input.brief?.trim() ?? "";
  const parts = [input.text];
  if (note !== "") parts.push(`[Hướng dẫn cho lượt này: ${note}]`);
  // The attachment section is appended, never prepended: the person's own words stay first, so a file
  // whose content contains something that reads like an instruction is still arriving after the request
  // it belongs to.
  if (brief !== "") parts.push(brief);
  return parts.join("\n\n");
}

function flushText(turn: Turn): void {
  if (turn.pending.length === 0) return;
  const text = turn.pending.join("");
  turn.pending.length = 0;
  if (text.trim() === "") return;
  turn.segments.push({ kind: "text", text });
}

/**
 * Move accumulated reasoning into a segment, and note how long it took.
 *
 * Reasoning is kept apart from the reply rather than folded into it. It is what the model said to
 * itself, and an interface that prints the two together is showing the user text the model did not
 * address to them.
 */
function flushReasoning(turn: Turn): void {
  if (turn.reasoning.length === 0) return;
  const content = turn.reasoning.join("");
  turn.reasoning.length = 0;
  if (content.trim() === "") return;
  turn.segments.push({
    kind: "block",
    block: {
      type: "reasoning",
      content,
      startedAt: new Date().toISOString() as Instant,
      endedAt: new Date().toISOString() as Instant,
    },
  });
}

/**
 * Wrap a tool so the transcript records what it was asked and what it answered.
 *
 * The adapter reports that a tool ran, but not its arguments or its result — which is most of what a
 * reader wants when they open a call afterwards. Wrapping is the only place that has all three, and it
 * is why tool activity is captured here rather than from the adapter's own events: forwarding both
 * would draw every call twice.
 */
function withActivity(turn: Turn, tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      turn.toolSequence += 1;
      const toolCallId = `${tool.name}-${turn.toolSequence}`;
      const startedAt = new Date().toISOString() as Instant;
      // Text written before the call belongs above it, and the call belongs above whatever the model
      // says next: flushing here is what keeps the transcript in the order the turn actually ran.
      flushText(turn);
      flushReasoning(turn);
      turn.onEvent?.({ type: "tool-start", toolCallId, name: tool.name, label: tool.label, args: params });

      const record = (status: "done" | "failed", result: string): MessageBlock => ({
        type: "tool-activity",
        toolCallId,
        name: tool.name,
        label: tool.label,
        status,
        args: params,
        result: result.slice(0, 20_000),
        ...(pathOf(params) === undefined ? {} : { path: pathOf(params) as string }),
        startedAt,
        endedAt: new Date().toISOString() as Instant,
      });

      try {
        const answer = await tool.execute(params);
        turn.onEvent?.({ type: "tool-end", toolCallId, status: "done", result: answer.text });
        // A card the host built during the call goes in before the call's own receipt: it is the thing the
        // user has to act on, and the receipt is the record that it was asked.
        if (answer.hostCard !== undefined) {
          turn.segments.push({ kind: "host-card", block: answer.hostCard });
        }
        turn.segments.push({ kind: "block", block: record("done", answer.text) });
        return answer;
      } catch (cause) {
        // Returned rather than re-thrown, which is what `show_view` already does by hand: the model
        // gets the reason in the same turn and can correct itself, instead of the turn failing with
        // nothing said. The transcript records it as a failure either way.
        const message = cause instanceof Error ? cause.message : String(cause);
        turn.onEvent?.({ type: "tool-end", toolCallId, status: "failed", result: message });
        turn.segments.push({ kind: "block", block: record("failed", message) });
        return { text: `${tool.name} lỗi: ${message}` };
      }
    },
  };
}

/** The path a call touched, when one of its arguments is one. */
function pathOf(params: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "projectPath", "directory", "cwd"]) {
    const value = params[key];
    if (typeof value === "string" && value !== "") return value.slice(0, 1000);
  }
  return undefined;
}

/** The JSON Schema the model sees. Deliberately carries no field it could use to claim state. */
function showViewParameters(
  views: readonly ViewDescriptor[],
  datasetRefs: readonly string[],
): Record<string, unknown> {
  const datasetNote =
    datasetRefs.length === 0
      ? "This node holds no datasets, so pass no dataset reference."
      : `Dataset references that exist: ${datasetRefs.join(", ")}. Use one of these or the view will render nothing.`;
  return {
    type: "object",
    additionalProperties: false,
    required: ["view"],
    properties: {
      view: {
        type: "string",
        description:
          `Which view to show. One of: ${views.map((entry) => entry.id).join(", ")}. ` +
          views
            .filter((entry) => entry.notes !== undefined)
            .map((entry) => `${entry.id}: ${entry.notes}`)
            .join(" "),
        enum: views.map((entry) => entry.id),
      },
      caption: {
        type: "string",
        description:
          "One short sentence describing what this shows, written for a reader who cannot see it.",
      },
      props: {
        type: "object",
        description: `Values for the view. These are rendered as sample data, not as live data. ${datasetNote}`,
      },
    },
  };
}

/**
 * Build the turn handler, or nothing when this node has no model configured.
 *
 * A model that is configured but unusable does not return nothing. The difference matters:
 * "no model here" is a state the interface can show, and "a model is configured and cannot be
 * reached" is a fault the operator has to see, with the reason.
 */
/**
 * What the turn cost, from the adapter's own accounting.
 *
 * Read after the run settles, because that is when the provider has reported it. Anything the SDK did not
 * report is left out rather than defaulted: a cache hit rate of "0%" for a provider that never mentioned a
 * cache is a number that is wrong on purpose, and this card exists to be trusted.
 */
function turnMetrics(input: { adapter: PiAdapter; sessionId: string; elapsedMs: number; model: string }): TurnMetrics {
  const usage = input.adapter.usage(input.sessionId);
  const seconds = input.elapsedMs / 1000;
  const effort = effortFromModel(input.model);
  return {
    ...(effort === undefined ? {} : { thinkingLevel: effort }),
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
    ...(usage.outputTokens === undefined || seconds <= 0 ? {} : { tokensPerSecond: usage.outputTokens / seconds }),
    cwd: process.cwd(),
  };
}

/** The reasoning effort a model identifier carries, if it carries one (`model:high`). */
function effortFromModel(model: string): string | undefined {
  const separator = model.lastIndexOf(":");
  if (separator === -1) return undefined;
  const effort = model.slice(separator + 1);
  return effort === "" ? undefined : effort;
}

export async function createModelTurn(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Injected so a turn can be tested without a provider account. */
  adapter?: PiAdapter;
  /**
   * Views the model may ask for, read at the moment a turn starts.
   *
   * A provider rather than a list because the catalog is built from widget dependencies that only
   * exist after the node boots, and the node boots with the model turn already in hand. Reading it
   * lazily keeps that ordering honest instead of requiring one half to be constructed before it can
   * exist.
   */
  views?: () => readonly ViewDescriptor[];
  /**
   * The conversation so far, newest last, for briefing a session that has just been created.
   *
   * A session dropped after a failure, or one created for a conversation resumed on a node that has since
   * restarted, starts empty. Without this the next message meets an agent that has never heard of the thread,
   * which is what "it forgot we had just done that" looks like from the outside.
   */
  history?: HistoryReader;
  /**
   * The files the current message carries, read back from the stored message.
   *
   * Read from storage rather than handed in by the caller on purpose. The refs were written into the
   * message the conductor stored, so the timeline after a reload and the prompt for this turn are two
   * readings of one row; passing them alongside the turn would make them two accounts that can disagree.
   *
   * `dataDir` is here so a text attachment's content can be inlined, and it is the one thing this option
   * must never leak into a prompt: `attachmentBrief` names ids and never a path.
   */
  attachments?: {
    dataDir: string;
    refsFor: (conversationId: string) => readonly AttachmentRef[];
  };
  /**
   * Dataset references the node actually holds.
   *
   * Told to the model rather than left to be guessed. A view that needs data can only be honest if
   * the data exists, and a model that has to invent a reference produces a card that resolves to
   * nothing — which looks like a broken widget rather than a missing fact.
   */
  datasetRefs?: () => readonly string[];
  /**
   * Where a worker transcript is written.
   *
   * A conversation turn runs in this process, so its transcript is the one that lets a restart
   * resume the thread instead of introducing the user to a new assistant on every start.
   */
  sessionDir?: string;
  /** Called once a transcript exists on disk, so the runtime can index it. */
  onSessionFile?: (input: { sessionId: string; sessionFile: string }) => void;
  /**
   * Further tools the turn may call, read at the moment a turn starts.
   *
   * Supplied by the composition root rather than imported here, so this module stays the seam rather
   * than the place that decides which capabilities exist.
   *
   * Given the conversation, because one of those tools reads the files attached to *this* conversation
   * and has nothing to check without it. A tool that took the conversation from somewhere else would be a
   * second source of truth for which turn is running.
   */
  extraTools?: (turn: { conversationId: string }) => readonly ToolDefinition[];
  /**
   * What was remembered, for the turn about to run.
   *
   * A function rather than a string because it must be read per turn: a record somebody deleted has to stop
   * being sent on the very next turn, and a value captured once would keep sending it until a restart.
   */
  memoryBrief?: (conversationId: string) => string;
  /**
   * The model to run for sessions created from now on, when somebody chose one.
   *
   * A function rather than a value, and read at session creation rather than here: the composition root builds the
   * model turn before the services that own the database and the identity the choice is stored against, so a value
   * would have to exist before the thing it comes from does.
   */
  model?: () => ModelTurn["selection"] | undefined;
}): Promise<ModelTurn | undefined> {
  const selection = modelFromEnv(options.env);
  if (selection === undefined) return undefined;

  const readViews = (): readonly ViewDescriptor[] => options.views?.() ?? [];
  const readDatasetRefs = (): readonly string[] => options.datasetRefs?.() ?? [];
  const readExtraTools = (conversationId: string): readonly ToolDefinition[] =>
    options.extraTools?.({ conversationId }) ?? [];
  const budget = modelBudgetFromEnv(options.env);
  const adapter =
    options.adapter ??
    new RealPiAdapter({
      cwd: options.cwd,
      model: selection,
      builtinTools: [],
      ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
      ...(options.onSessionFile === undefined ? {} : { onSessionFile: options.onSessionFile }),
    });
  const availability = await adapter.availability();
  const turns = new Map<string, Turn>();

  const describe = (): string => `${selection.provider}/${selection.id}`;

  /**
   * The one tool.
   *
   * It refuses in three ways — an unknown view, props that do not fit, and a view whose build
   * threw — and every refusal comes back to the model as text in the same turn, so the model can
   * correct itself instead of the user seeing nothing. A refusal never appends a block: a failed
   * request must not leave a card behind that looks like it succeeded.
   */
  function showViewTool(
    turn: Turn,
    principal: Principal,
    views: readonly ViewDescriptor[],
    viewById: ReadonlyMap<string, ViewDescriptor>,
    datasetRefs: readonly string[],
  ): ToolDefinition {
    return {
      name: SHOW_VIEW_TOOL,
      label: "Show a view",
      description:
        `Show a visual view in the conversation. Use the exact view name from the list. ` +
        `The values you pass are shown as sample data, so never describe them as live. ` +
        (datasetRefs.length === 0
          ? "This node holds no datasets."
          : `Available dataset references: ${datasetRefs.join(", ")}.`),
      parameters: showViewParameters(views, datasetRefs),
      // Without this the SDK omits the tool from the system prompt's "Available tools" list, and a
      // model that cannot see its tools answers with invented tool syntax instead of calling one.
      promptSnippet: "show_view — show a chart or table in the conversation",
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        const requested = typeof params.view === "string" ? params.view : "";
        const descriptor = viewById.get(requested);
        if (descriptor === undefined) {
          return {
            text: `No view named "${requested}". Available: ${views.map((entry) => entry.id).join(", ") || "(none)"}.`,
          };
        }
        if (turn.messageId === undefined) {
          // A programming error rather than a model error, but the model still gets a reason
          // instead of a view that would be captured against nothing.
          return { text: `The view "${requested}" could not be captured: the turn has no message yet.` };
        }
        const props =
          typeof params.props === "object" && params.props !== null
            ? (params.props as Record<string, unknown>)
            : {};
        const caption = typeof params.caption === "string" ? params.caption : descriptor.label;
        try {
          const block = await descriptor.build({
            props,
            caption,
            at: new Date().toISOString() as Instant,
            principal,
            messageId: turn.messageId,
            conversationId: turn.conversationId,
            signal: turn.abort.signal,
          });
          // Flushed first: the text the model wrote before asking for this view belongs above it.
          flushText(turn);
          turn.segments.push({ kind: "block", block });
        } catch (cause) {
          return {
            text: `The view "${requested}" could not be built: ${cause instanceof Error ? cause.message : String(cause)}.`,
          };
        }
        return { text: `Shown: ${requested}. It is sample data and is labelled that way.` };
      },
    };
  }

  async function turnFor(conversationId: string, principal: Principal): Promise<Turn> {
    const existing = turns.get(conversationId);
    if (existing !== undefined) return existing;

    const views = readViews();
    const viewById = new Map(views.map((entry) => [entry.id, entry]));
    const datasetRefs = readDatasetRefs();

    // The turn is created before the session because the tool has to be handed over *at* session
    // creation — the SDK fixes its custom tool set then, and a tool added afterwards never reaches
    // the registry the allowlist consults. The tool writes into this object, so it has to exist
    // first; the session id is filled in once there is one.
    const turn: Turn = {
      sessionId: "",
      pending: [],
      reasoning: [],
      segments: [],
      onEvent: undefined,
      toolSequence: 0,
      unsubscribe: () => {},
      abort: new AbortController(),
      conversationId,
      fresh: true,
      inFlight: false,
    };
    // The view tool is only registered when there is a catalog; the extra tools stand on their own
    // and are registered whatever the catalog says.
    const customTools = [
      ...(views.length === 0 ? [] : [showViewTool(turn, principal, views, viewById, datasetRefs)]),
      ...readExtraTools(conversationId),
    ].map((tool) => withActivity(turn, tool));

    const chosen = options.model?.();

    const handle = await adapter.createWorkerSession({
      // The brief is per conversation rather than per message, so the model keeps the thread
      // it is already in instead of meeting the user again on every turn.
      goal: "Answer the user in this conversation.",
      projectRoots: [],
      allowedCapabilityRefs: [],
      // Resolved here rather than when the turn was built: this is the moment a model can actually be chosen for a
      // session, and it is also the moment `services` exists to say what was chosen.
      ...(chosen === undefined ? {} : { model: chosen }),
      ...(customTools.length === 0 ? {} : { customTools }),
      // Carried on the brief as well as held here, because the adapter enforces it at the
      // turn boundary and that is where a runaway turn is actually stopped.
      maxWallClockMs: budget.maxWallClockMs,
      maxTokens: budget.maxTokens,
    });

    turn.sessionId = handle.sessionId;
    turn.unsubscribe = adapter.subscribe(handle.sessionId, (event) => {
      if (isTextDelta(event)) {
        // Both, and in this order: the buffer is what the stored message is built from, and the
        // callback is what the reader sees now. Dropping the buffer to stream would lose the text a
        // caller that is not watching never receives.
        // Reasoning already in hand is closed first, so the two never interleave inside one block.
        flushReasoning(turn);
        turn.pending.push(event.delta);
        turn.onEvent?.({ type: "text-delta", text: event.delta });
        return;
      }
      if (event.type === "thinking-delta") {
        flushText(turn);
        turn.reasoning.push(event.delta);
        turn.onEvent?.({ type: "reasoning-delta", text: event.delta });
      }
    });

    turns.set(conversationId, turn);
    return turn;
  }

  return {
    selection,
    budget,
    viewCatalogSize: () => readViews().length,
    catalogue: (): Promise<ModelCatalogue> => adapter.catalogue(),
    extensions: (): Promise<readonly PiExtension[]> => adapter.extensions(),
    piSettings: (): Promise<readonly PiSetting[]> => adapter.piSettings(),

    /** The conversations with a turn still running. */
    running: (): string[] => [...turns.values()].filter((turn) => turn.inFlight).map((turn) => turn.conversationId),

    /**
     * Stops the running turn for a conversation, answering whether there was one.
     *
     * The turn's own controller rather than a new one, because the point is to stop the work that is happening, and
     * the paths that watch for cancellation already watch this one.
     */
    interrupt: (conversationId: string): boolean => {
      const turn = turns.get(conversationId);
      if (turn === undefined || !turn.inFlight) return false;
      turn.abort.abort();
      return true;
    },

    /**
     * Adds a sentence to the turn that is already running, answering whether there was one to add it to.
     *
     * What the adapter does with it is the adapter's business; the answer is what lets a caller decide what to do
     * when there was nothing to steer.
     */
    steer: async (conversationId: string, text: string): Promise<boolean> => {
      const turn = turns.get(conversationId);
      if (turn === undefined || !turn.inFlight || turn.sessionId === "") return false;
      await adapter.steer(turn.sessionId, text);
      return true;
    },

    runInBackground: async (input: { conversationId: string; principal: Principal; text: string }): Promise<string> => {
      const handle = await adapter.createWorkerSession({
        goal: input.text.slice(0, 2000),
        // No folders and no capabilities: starting a worker is not a way to acquire either, and the request that
        // needs them goes through the same approval path as any other.
        projectRoots: [],
        allowedCapabilityRefs: [],
      });
      let said = "";
      const unsubscribe = adapter.subscribe(handle.sessionId, (event) => {
        if (event.type === "text-delta") said += event.delta;
      });
      try {
        await adapter.prompt(handle.sessionId, input.text);
      } finally {
        unsubscribe();
        // Disposed whatever happened: a worker nobody will ask again is a provider connection held open for nothing.
        void adapter.dispose(handle.sessionId).catch(() => undefined);
      }
      return said.trim();
    },

    async answer(input: ModelTurnInput): Promise<ModelTurnReply> {
      if (!availability.available) {
        throw new Error(
          `this node is configured for ${describe()} but that model is not reachable: ${availability.reason ?? "no reason given"}`,
        );
      }

      const startedAt = Date.now();
      const turn = await turnFor(input.conversationId, input.principal);
      // Once, on the first turn this session answers: the second turn already has the first in its context,
      // and repeating the brief each time would push the conversation out with its own summary.
      const recap = turn.fresh ? await recapFor(options, input.conversationId) : "";
      turn.fresh = false;
      // Built here rather than at the call, because `note` is optional under exactOptionalPropertyTypes: a
      // present key holding undefined is a different type from an absent key, and only one of them means
      // "this turn carries no extra instruction".
      const note = withRecap(recap, input.note);
      // Read once, before the prompt, from the message the conductor has already stored.
      const attachmentPart =
        options.attachments === undefined
          ? ""
          : attachmentBrief({
              refs: options.attachments.refsFor(input.conversationId),
              dataDir: options.attachments.dataDir,
            });
      // Read fresh every turn, not captured once: a record the person deleted must stop being sent on the next
      // turn, which is what the Memory tab's promise to let them see the source and delete it has to mean.
      const memoryPart = options.memoryBrief?.(input.conversationId) ?? "";
      const brief = [attachmentPart, memoryPart].filter((part) => part !== "").join("\n\n");
      // Set before the prompt rather than after it, so a message arriving while the first tokens are being written
      // already sees a turn in flight.
      turn.inFlight = true;
      // Cleared before the prompt rather than after, so a turn that throws still leaves the
      // buffer empty for the next one instead of prepending the previous reply to it.
      turn.pending.length = 0;
      turn.reasoning.length = 0;
      turn.segments.length = 0;
      turn.messageId = input.messageId;
      turn.onEvent = input.onEvent;
      turn.toolSequence = 0;
      turn.abort = new AbortController();

      // The adapter stops a turn that overruns its brief, but this is the layer holding an open
      // HTTP request, so it does not delegate the guarantee: without a deadline here a provider
      // that never settles would hold the request until the client gives up, and the user would
      // see a hung page rather than a limit being reached.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // The build is told as well as the adapter: a composition in flight would otherwise
          // finish its own work after the turn it belongs to has already been stopped.
          turn.abort.abort();
          void adapter.abort(turn.sessionId, `turn exceeded ${budget.maxWallClockMs} ms`);
          reject(
            new Error(`${describe()} did not finish within ${budget.maxWallClockMs} ms; the turn was stopped`),
          );
        }, budget.maxWallClockMs);
      });

      try {
        await Promise.race([
          adapter.prompt(
            turn.sessionId,
            promptForTurn({
              text: input.text,
              ...(note === undefined ? {} : { note }),
              ...(brief === "" ? {} : { brief }),
            }),
          ),
          deadline,
        ]);
      } catch (cause) {
        /*
         * A failed turn takes its session with it.
         *
         * A run that was stopped mid-flight — over its budget, or with an error from the provider —
         * leaves a session that is not usable again, and reusing it means every later message fails the
         * same way. That is what a user experiences as the conversation breaking and never coming back,
         * and it is what this drops: the next message opens a fresh session instead of inheriting a
         * wedged one. The transcript is unaffected; it lives in the database, not in the session.
         *
         * Disposed rather than kept for a retry, because there is no retry that could work: the session
         * is the thing that is broken.
         */
        turns.delete(input.conversationId);
        turn.unsubscribe();
        void adapter.dispose(turn.sessionId).catch(() => undefined);
        throw cause;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Detached before the segments are read, so an event arriving after the race resolved cannot
        // be delivered to a reader that has already been told the answer is complete.
        turn.onEvent = undefined;
        // Cleared here, in the one path that every outcome goes through: success, failure and cancellation all leave
        // `answer` through this block, and a stale marker would make the next message think a turn was still running.
        turn.inFlight = false;
      }

      // Trailing prose after the last view, and reasoning that never got closed by a later block.
      flushText(turn);
      flushReasoning(turn);
      const segments = [...turn.segments];
      const elapsedMs = Date.now() - startedAt;
      const text = segments
        .filter((segment): segment is Extract<ModelSegment, { kind: "text" }> => segment.kind === "text")
        .map((segment) => segment.text)
        .join("\n")
        .trim();

      if (segments.length === 0) {
        // A settled run that produced nothing at all is not a reply. Saying so is better than
        // appending an empty message that reads as the assistant having nothing to say.
        throw new Error(`${describe()} ended the turn without producing any text after ${elapsedMs} ms`);
      }

      // A reply that is only a view is a reply. Refusing it would make the one thing this node
      // was just taught to do look like a failure.
      return {
        text,
        segments,
        provider: selection.provider,
        model: selection.id,
        elapsedMs,
        metrics: turnMetrics({ adapter, sessionId: turn.sessionId, elapsedMs, model: selection.id }),
      };
    },

    async dispose(): Promise<void> {
      for (const turn of turns.values()) {
        turn.unsubscribe();
        await adapter.dispose(turn.sessionId).catch(() => undefined);
      }
      turns.clear();
    },
  };
}
