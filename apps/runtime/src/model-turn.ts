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

import { randomBytes } from "node:crypto";

import {
  type AttachmentRef,
  type DataClass,
  DEFAULT_ALLOWED_DATA_CLASSES,
  dataClassOfText,
  maxDataClass,
  type Instant,
  type MessageBlock,
  type Principal,
  type TurnOrigin,
  type WidgetSemanticDoc,
  modelChangeNeedsGeneration,
  uiContextNote,
} from "@clarkcant/contracts";

import {
  RealPiAdapter,
  modelBudgetFromEnv,
  modelFromEnv,
  type ModelBudget,
  type ModelSelection,
  type ModelCatalogue,
  type PiExtension,
  type PiSetting,
  type PiSkill,
  type PiSkillBody,
  type PiAdapter,
  type ToolDefinition,
  type WorkerBrief,
  type WorkerEvent,
} from "@clarkcant/pi-adapter";

import type { ModelSegment, ModelTurnEvent, ModelTurnInput, ModelTurnReply, TurnMetrics } from "@clarkcant/core";

import { attachmentBrief } from "./attachments.ts";
import { type ContextSource, readContextTool } from "./context-bundle.ts";
import {
  type InstructionTouch,
  type TurnInstructions,
  instructionsNonceNote,
  rememberTouch,
  touchOfToolCall,
} from "./conditional-instructions.ts";
import { legacyRecap, planRecap } from "./context-planner.ts";
import {
  SESSION_POLICY_LIMITS,
  type SessionDecision,
  type SessionPolicyMode,
  type SessionTelemetry,
  decideSession,
  linesChanged,
  reportSessionTelemetry,
  topicShift,
} from "./session-policy.ts";

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
   * What the model is told once the view is shown, when "it is sample data" would be wrong: a button shows no data,
   * and saying otherwise would have the model describe it as something it is not.
   */
  shownText?: string;
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

export interface BackgroundRunInput {
  conversationId: string;
  principal: Principal;
  text: string;
  /** The supervisor's id for this run, which a stop names. A fresh one is made when absent. */
  workId?: string;
  /** Aborted when the run is stopped, overruns its deadline or the node shuts down; the reason says which. */
  signal?: AbortSignal;
  /** The token budget the request that started this run set, handed to the worker's brief. */
  maxTokens?: number;
  /**
   * Material the host read for this run, sent after the request as data (see `ModelTurnInput.data`).
   *
   * Kept apart from `text` so it never becomes part of the worker's goal: the goal is the request, and this is what the
   * request is about.
   */
  data?: string;
}

/**
 * Why background work runs on the configured model for a reason worth recording, rather than because the node simply
 * routes nothing: no model in the pool may receive the work's data class, or the route itself failed.
 */
export type BackgroundFallback = { reason: "data-class"; dataClass: DataClass } | { reason: "route-failed" };

/** What routing answers for background work: a model to run, or the reason it falls back to the configured one. */
export type BackgroundRoute = { provider: string; id: string } | { fallback: BackgroundFallback };

/**
 * How long a conversation's session is kept once nobody is using it, and how many are kept at all.
 *
 * A session is a provider connection and a context window held in memory. Keeping one per conversation for as long as
 * the process lives is a leak that grows with every conversation a person ever opened; dropping an idle one costs a
 * recap on the next message, which is what a fresh session already does after a failure.
 */
export const TURN_IDLE_MS = 30 * 60_000;
export const MAX_IDLE_TURNS = 16;

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
  /**
   * Adds a sentence to the running turn, answering whether it was added. A message whose origin differs from the
   * running turn's is never added (absent is the person).
   */
  steer: (conversationId: string, text: string, origin?: TurnOrigin) => Promise<boolean>;
  /**
   * Runs one request in a worker of its own, answering with what that worker said.
   *
   * The request does not belong to the conversation's session and does not wait for it: this is what lets a person
   * ask for something else while the assistant is busy, and it is deliberately not part of the turn machinery -
   * nothing here touches `turns` or the in-flight marker, so a background request cannot make the conversation look
   * busy or steal the turn that is running.
   */
  runInBackground: (input: BackgroundRunInput) => Promise<string>;

  /**
   * The model a dispatched task's worker runs, decided as it is about to start.
   *
   * The same choice `runInBackground` makes, because a dispatched worker is background work too and nobody is watching
   * it: the policy layer's route among the node's pool when it gives one, else the model this node runs now (the
   * person's pick, else the environment's). Never a separate setting, so there is one place that decides.
   */
  workerModel: (
    work?: { dataClass?: DataClass },
  ) => Promise<ModelSelection & { via: "routed" | "configured"; fallback?: BackgroundFallback }>;

  /** The model this node runs now, the person's pick else the environment's: what a worker falls back to when routing chooses nothing. */
  configuredModel: () => ModelSelection;

  /** How long the conversation's current turn has been running, or undefined when none is. */
  runningMs: (conversationId: string) => number | undefined;

  /**
   * Stops every background worker this process started, answering how many there were.
   *
   * The other half of the emergency stop. A background request returns as soon as it is accepted, so this is the only
   * reference to a worker nobody is awaiting — without it a stop would reach the foreground and leave the rest
   * running, which is the shape of an emergency control that cannot be trusted.
   */
  stopBackgroundSessions: () => Promise<number>;

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

  /** The skills pi discovers for this node, which the composer offers after a slash. */
  skills: () => Promise<readonly PiSkill[]>;

  /** One skill's instructions, if it is still the version a message named. */
  skillBody: (name: string, revision: string) => Promise<PiSkillBody>;
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
  /**
   * Which surface the message this turn is answering came in on. Set alongside `onEvent`, on the same
   * lifecycle: it is a property of the request in flight, not of the session, so a session that answers
   * a typed message and then a spoken one must not keep reporting the first message's channel.
   */
  channel: "voice" | "chat";
  /**
   * Who asked for the message this turn is answering (`TurnOrigin`), on the same lifecycle as `channel`: a session that
   * answers an AI client's turn and then the person's must not keep handing the first origin to its tools. Undefined is
   * the person.
   */
  origin: TurnOrigin | undefined;
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
  /** When the running turn started, so the mid-turn decider can weigh how long the work has gone on. */
  startedAtMs: number | undefined;
  /**
   * Whether a person stopped the running turn.
   *
   * Checked by the listener and by every tool call, so a token or a tool call already on its way when the stop
   * arrived is dropped rather than shown after it; and read by `answer`, so what the turn had already said is kept as
   * a stopped reply rather than reported as a failure.
   */
  stopped: boolean;
  /** Ends the running answer the moment a stop arrives, for a provider that is slow to notice its own abort. */
  settleStop: (() => void) | undefined;
  /** The provider-side abort a stop started, so the session is disposed only once the provider has let go of it. */
  stopping: Promise<void> | undefined;
  /** When this session last answered or was created, which is what idle eviction orders by. */
  lastUsedAtMs: number;
  /**
   * What this session has been told about each widget on screen, and at which revision.
   *
   * On the turn because it describes the session's own context: a new session starts with none and is told the whole
   * of what matters, a continuing one is told only what changed since, and one that has seen the current revision is
   * told nothing.
   */
  uiSeen: Map<string, { doc: WidgetSemanticDoc; revision: number }>;
  /** The tools this session was created with, by name: everything a disclosure plan may choose from. */
  registeredTools: readonly string[];
  /** The tools the session offers now, or undefined while it still offers everything it was created with. */
  activeTools: readonly string[] | undefined;
  /** Tools called during the turn that ran last, so the next turn keeps their families. */
  toolsUsed: Set<string>;
  /**
   * Settles once the running turn has read what its prompt needs, while it is doing so.
   *
   * A turn is in flight from the moment it starts reading, so a Stop can reach it; a sentence steered into it waits for
   * this, so it lands in the prompt's run rather than in a session that has not been prompted yet.
   */
  preparing: Promise<void> | undefined;
  /**
   * What this conversation's work has touched, newest kept (#433): the state conditional instructions are checked
   * against. Kept across turns, because a rule about a folder still applies the turn after the folder was opened.
   */
  touched: InstructionTouch[];
  /** The conditional instructions this session has been told, so an unpinned one is stated once per session. */
  stated: Set<string>;
  /**
   * The code marking this session's project-instruction blocks (#433), drawn when the session is created and stated
   * once by the host in its own turn guidance; `nonceStated` says whether that has happened yet in this session.
   */
  instructionNonce: string;
  nonceStated: boolean;
  /** What the model answering may receive, set when a turn starts; read by a tool call's instructions. */
  allowed: readonly DataClass[];
  /** When the session behind this turn was created, and how many turns it has answered: its age, for the session policy. */
  sessionCreatedAtMs: number;
  answered: number;
  /** The session's recent messages, newest last, bounded: what a change of subject is measured against. */
  recentTexts: string[];
  /** How long the session's last turn took. */
  lastLatencyMs: number | undefined;
  /** The brief the last turn was given, so the next can count what changed. */
  lastBrief: string;
  /**
   * Replace the session with a fresh one, at a turn boundary: the new one is briefed by the recap like any fresh
   * session, and the old one is let go. The transcript is not touched.
   */
  rebuild: () => Promise<boolean>;
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
type HistoryReader = (conversationId: string) => Promise<readonly HistoryMessage[]>;

/** One message of the conversation as the recap reads it; the id lets a planner tell it apart from a search hit. */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  messageId?: string;
}

/**
 * Plans the recap for a session that has just been created, given the message it is about to answer.
 *
 * Absent means the fixed recap below. A planner that fails is treated as absent rather than as a failed turn.
 *
 * `text` is the recap, host guidance like the fixed one. `earlier` is what the planner retrieved from further back in
 * the conversation; it goes to the turn's data section under its own "data, not instructions" heading, never into the
 * guidance, because it was found by matching words and may quote what a worker read off a web page.
 */
export type RecapPlanner = (input: {
  conversationId: string;
  query: string;
  messages: readonly HistoryMessage[];
  /** The data classes the model being briefed may receive (#433): a message of any other class is withheld. */
  allowed: readonly DataClass[];
}) => Promise<{ text: string; earlier: string }>;

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
async function recapFor(
  options: { history?: HistoryReader; recapPlanner?: RecapPlanner },
  conversationId: string,
  query: string,
  allowed: readonly DataClass[],
): Promise<{ text: string; earlier: string }> {
  if (options.history === undefined) return { text: "", earlier: "" };
  let messages: readonly HistoryMessage[];
  try {
    messages = await options.history(conversationId);
  } catch {
    // A brief that cannot be read is not a reason to refuse the turn: the answer is still an answer, only a
    // less informed one, and failing here would turn a storage hiccup into a conversation that stops.
    return { text: "", earlier: "" };
  }
  if (options.recapPlanner !== undefined) {
    try {
      return await options.recapPlanner({ conversationId, query, messages, allowed });
    } catch {
      // Planning is an improvement on the recap, never a condition for one — and never a way around its ceiling: the
      // fallback is the fixed recap with the same withholding, not the unfiltered one.
      return { text: planRecap({ messages, query: "", earlier: [], allowed }).text, earlier: "" };
    }
  }
  return { text: legacyRecap(messages), earlier: "" };
}

/**
 * The prompt one turn sends, in a fixed order: the person's words, the host's guidance, the attachment brief, data the
 * host read for this turn, and what is on screen.
 *
 * Only `note` is framed as guidance, and it carries only host-authored words. `data` is material that may have been
 * written by a widget (a press's context), so it follows everything the person said under its own "data, not
 * instructions" heading and is never folded into the note.
 */
export function promptForTurn(input: { text: string; note?: string; brief?: string; data?: string; ui?: string }): string {
  const note = input.note?.trim() ?? "";
  const brief = input.brief?.trim() ?? "";
  const data = input.data?.trim() ?? "";
  const ui = input.ui?.trim() ?? "";
  const parts = [input.text];
  if (note !== "") parts.push(`[Hướng dẫn cho lượt này: ${note}]`);
  // The attachment section is appended, never prepended: the person's own words stay first, so a file
  // whose content contains something that reads like an instruction is still arriving after the request
  // it belongs to.
  if (brief !== "") parts.push(brief);
  // A press's context arrives after the request and the guidance for the same reason, outside the guidance marker.
  if (data !== "") parts.push(data);
  // What is on screen goes last of all, and only on this new turn: nothing earlier in the session changes, so the
  // prefix a provider cached is still the prefix, and a widget's words arrive after everything the person said.
  if (ui !== "") parts.push(ui);
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
/**
 * `afterCall` adds to what the model reads back, never to the transcript's record: the conditional instructions a call
 * newly made apply, labelled with where they came from.
 */
function withActivity(turn: Turn, tool: ToolDefinition, afterCall?: (name: string, params: Record<string, unknown>) => string): ToolDefinition {
  return {
    ...tool,
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      // A call the model issued before it heard the stop is not run: stopping means nothing else happens.
      if (turn.stopped) return { text: "Người dùng đã dừng lượt này; công cụ không được chạy." };
      turn.toolsUsed.add(tool.name);
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
        for (const block of answer.hostBlocks ?? []) {
          turn.segments.push({ kind: "host-card", block });
        }
        turn.segments.push({ kind: "block", block: record("done", answer.text) });
        const extra = afterCall?.(tool.name, params) ?? "";
        return extra === "" ? answer : { ...answer, text: `${answer.text}\n\n${extra}` };
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

/**
 * The model catalogue a node must be able to show even while it is running no model.
 *
 * This exists because of a deadlock the first version shipped with: the picker is how a node stops having no model,
 * and its list was published only when a model turn already existed, so every fresh node showed an empty list and no
 * way to fill it. Reading the catalogue needs no model — it is what pi offers — so this builds an adapter for exactly
 * that question, naming no model, and returns the same zero-argument function the turn publishes.
 *
 * `adapter` is injectable for the same reason it is on the turn: a test asserting what the picker lists should not
 * need a provider account.
 */
export function createModelCatalogue(options: {
  cwd: string;
  adapter?: PiAdapter;
}): () => Promise<ModelCatalogue> {
  const adapter = options.adapter ?? new RealPiAdapter({ cwd: options.cwd, builtinTools: [] });
  return () => adapter.catalogue();
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
   * Which model a background worker should run, when the node routes that instead of configuring it.
   *
   * A function rather than a value, and asynchronous, because routing consults the pool, the catalogue and possibly
   * the policy layer — all of which are read at the moment a worker is about to start rather than at boot. Absent
   * means workers run whatever the node is configured with.
   */
  backgroundModel?: (work?: { dataClass?: DataClass }) => Promise<BackgroundRoute | undefined>;
  /**
   * The data classes a model may be sent (#433), from the profiles that name it. Read for the model about to receive
   * context: the conversation's for a turn, the routed or fallback one for a background run. Absent means everything but
   * credential-shaped text, the same default an unlabelled profile gets.
   */
  allowedDataClasses?: (model: { provider: string; id: string }) => readonly DataClass[];
  /**
   * The conversation so far, newest last, for briefing a session that has just been created.
   *
   * A session dropped after a failure, or one created for a conversation resumed on a node that has since
   * restarted, starts empty. Without this the next message meets an agent that has never heard of the thread,
   * which is what "it forgot we had just done that" looks like from the outside.
   */
  history?: HistoryReader;
  /** Focuses that recap on the message being answered; absent keeps the fixed newest-twelve recap. */
  recapPlanner?: RecapPlanner;
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
   *
   * `onEvent` is a getter rather than a value: the tool list is built once, at session creation, but a
   * foreground stream only attaches its listener per message — so a tool that captured the listener at
   * build time would find it `undefined` forever. Reading it through the getter at call time is what lets
   * `control_app` tell a live stream from none: `NO_ACTIVE_HOST_SURFACE` is `onEvent() === undefined`.
   */
  extraTools?: (turn: {
    conversationId: string;
    onEvent: () => ((event: ModelTurnEvent) => void) | undefined;
    /** See `Turn.channel`; read the same way and for the same reason. */
    channel: () => "voice" | "chat";
    /** The message this turn's answer is being written as, read at call time: a widget placed now is captured against it. */
    messageId?: () => string | undefined;
    /** See `Turn.origin`; read the same way and for the same reason. */
    origin: () => TurnOrigin | undefined;
    /** What the model answering this turn may be sent (#433), read at call time: a read tool withholds the rest. */
    allowed?: () => readonly DataClass[];
  }) => readonly ToolDefinition[];
  /**
   * What was remembered, for the turn about to run.
   *
   * A function rather than a string because it must be read per turn: a record somebody deleted has to stop
   * being sent on the very next turn, and a value captured once would keep sending it until a restart.
   */
  memoryBrief?: (conversationId: string, query: string, allowed: readonly DataClass[]) => string | Promise<string>;
  /**
   * What the host retrieved for a background request (#433): remembered notes and earlier messages that match it.
   *
   * Read on demand rather than expanded up front: the run is given the list as data and a read-only `read_context`
   * tool for an item in full, each read re-checked, so a note deleted mid-run is not sent. Undefined, or a retrieval
   * that fails, leaves the run without it.
   */
  backgroundContext?: (input: { conversationId: string; principalId: string; text: string }) => Promise<ContextSource | undefined>;
  /**
   * Which of the session's tools this turn is offered (#433), or absent to offer every one, as before.
   *
   * Given the names the session was created with and what it offers now; the answer's `active` is applied through the
   * adapter, which only ever chooses among the names the session was created with. A plan that fails leaves the
   * session's tools as they are.
   */
  toolDisclosure?: (input: {
    conversationId: string;
    text: string;
    registered: readonly string[];
    current: readonly string[] | undefined;
    usedLastTurn: readonly string[];
  }) => Promise<{ active: readonly string[] | undefined }>;
  /** Told when a tool plan could not be applied, so the session kept the tools it had; for telemetry only. */
  onToolDisclosureFailed?: (input: { conversationId: string; reason: string }) => void;
  /**
   * What the message being answered points at: skills to follow and the things it names (#210).
   *
   * Read from the stored message, as attachments are, and given the adapter's own skill reader, so the instructions a
   * turn follows come from the installation that runs it rather than from anything a client sent.
   */
  references?: {
    briefFor: (conversationId: string, skillBody: (name: string, revision: string) => Promise<PiSkillBody>) => Promise<string>;
  };
  /**
   * The widgets a person changed in this conversation, each with what it means now and its revision (#195).
   *
   * Read when a turn starts, which is when the node works out what the changes since the last turn amounted to; this
   * module decides, from what the session has already been told, whether any of it is news.
   */
  uiContext?: (conversationId: string) => readonly { doc: WidgetSemanticDoc; revision: number }[];
  /**
   * The model to run for sessions created from now on, when somebody chose one.
   *
   * A function rather than a value, and read at session creation rather than here: the composition root builds the
   * model turn before the services that own the database and the identity the choice is stored against, so a value
   * would have to exist before the thing it comes from does.
   */
  model?: () => ModelTurn["selection"] | undefined;
  /**
   * The user's own instructions, read fresh on every turn.
   *
   * A function for the same reason `model` is, and one more: the promise of the feature is that a
   * preference written while the app is open reaches the next turn rather than the next session, so the
   * value has to be read when a turn starts rather than when this module is built.
   */
  personalInstructions?: () => string | undefined;
  /**
   * Conditional instructions (#433): project guidance whose condition the conversation's work now meets. Asked when a
   * turn starts and after each tool call; absent states none, which is what the off switch does.
   */
  instructions?: TurnInstructions;
  /**
   * Whether a conversation's next turn reuses its session or starts a fresh one (#433). Absent is the behaviour before
   * it: reuse until a failure, an eviction or a model change. `observe` reports what it would decide; `rebuild` acts.
   * `ask` is consulted only in the band where the subject change is unclear.
   */
  sessionPolicy?: {
    mode: Exclude<SessionPolicyMode, "off">;
    ask?: (telemetry: SessionTelemetry) => Promise<boolean | undefined>;
  };
}): Promise<ModelTurn | undefined> {
  /*
   * What this node runs: the choice somebody made, else what the environment names.
   *
   * The choice comes first because it is the more specific statement and the one the UI collects. Without this the
   * picker was a control that stored a value nothing read unless the environment had already given the node a model —
   * which is the same as a control that does nothing. `options.model` is still called per session below, so a pick
   * made while the node is running reaches the next conversation.
   */
  const selection = options.model?.() ?? modelFromEnv(options.env);
  if (selection === undefined) return undefined;

  const readViews = (): readonly ViewDescriptor[] => options.views?.() ?? [];
  const readDatasetRefs = (): readonly string[] => options.datasetRefs?.() ?? [];
  const readExtraTools = (turn: Turn): readonly ToolDefinition[] =>
    options.extraTools?.({
      conversationId: turn.conversationId,
      onEvent: () => turn.onEvent,
      channel: () => turn.channel,
      messageId: () => turn.messageId,
      origin: () => turn.origin,
      allowed: () => turn.allowed,
    }) ?? [];
  /*
   * The note about the screen for this turn, and the session's record of what it has now been told.
   *
   * Only the widgets the note actually named are marked as seen, so one left out for the budget is still news next
   * turn. A widget that cannot be read is left out rather than failing the turn: what the person asked is still
   * answerable without it, and `inspect_ui` is there when it is not.
   */
  const uiNoteFor = (turn: Turn, conversationId: string): string => {
    if (options.uiContext === undefined) return "";
    let current: readonly { doc: WidgetSemanticDoc; revision: number }[];
    try {
      current = options.uiContext(conversationId);
    } catch {
      return "";
    }
    const note = uiContextNote(
      current.map((entry) => {
        const seen = turn.uiSeen.get(entry.doc.instanceId);
        return seen === undefined ? entry : { ...entry, seen };
      }),
    );
    for (const entry of current) {
      if (note.shown.includes(entry.doc.instanceId)) turn.uiSeen.set(entry.doc.instanceId, entry);
    }
    return note.text;
  };
  /*
   * Apply this turn's tool plan, when there is one.
   *
   * The adapter is only called when the set actually changes, because every change rebuilds the system prompt the
   * provider caches. A plan that throws leaves the tools as they were: offering what the session already offers is
   * always a safe answer.
   */
  const discloseTools = async (turn: Turn, conversationId: string, text: string): Promise<void> => {
    const usedLastTurn = [...turn.toolsUsed];
    turn.toolsUsed.clear();
    if (options.toolDisclosure === undefined || turn.registeredTools.length === 0) return;
    let active: readonly string[] | undefined;
    try {
      ({ active } = await options.toolDisclosure({
        conversationId,
        text,
        registered: turn.registeredTools,
        current: turn.activeTools,
        usedLastTurn,
      }));
    } catch {
      options.onToolDisclosureFailed?.({ conversationId, reason: "plan-failed" });
      return;
    }
    const offered = turn.activeTools ?? turn.registeredTools;
    if (active === undefined) {
      turn.activeTools = offered;
      return;
    }
    const same = active.length === offered.length && active.every((name) => offered.includes(name));
    if (same) {
      turn.activeTools = [...active];
      return;
    }
    try {
      await adapter.setActiveTools(turn.sessionId, active);
    } catch {
      // Applying is part of the plan: one that cannot be applied leaves the session offering what it offered, and the
      // turn goes ahead with that rather than failing over a narrower prompt it never needed.
      options.onToolDisclosureFailed?.({ conversationId, reason: "apply-failed" });
      return;
    }
    turn.activeTools = [...active];
  };
  const budget = modelBudgetFromEnv(options.env);
  const adapter =
    options.adapter ??
    new RealPiAdapter({
      cwd: options.cwd,
      model: selection,
      builtinTools: [],
      ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
      ...(options.onSessionFile === undefined ? {} : { onSessionFile: options.onSessionFile }),
      ...(options.personalInstructions === undefined
        ? {}
        : { personalInstructions: options.personalInstructions }),
    });
  const availability = await adapter.availability();
  const turns = new Map<string, Turn>();
  /**
   * Background workers this process started, by the work id the supervisor gave them.
   *
   * Held so a stop can reach a worker nobody is awaiting: a background request returns as soon as it is accepted, so
   * the only reference to that session is the one kept here.
   */
  const backgroundSessions = new Map<string, string>();

  /*
   * Drop sessions nobody is using: every idle one past the idle limit, then the least recently used past the count.
   *
   * Only turns that are not in flight — a session is never taken out from under a running turn. Called when a new
   * session is about to be created, which is the moment the set grows.
   */
  const evictIdleTurns = (nowMs: number): void => {
    const idle = [...turns.values()]
      .filter((turn) => !turn.inFlight)
      .sort((left, right) => left.lastUsedAtMs - right.lastUsedAtMs);
    let excess = idle.length - MAX_IDLE_TURNS;
    for (const turn of idle) {
      if (nowMs - turn.lastUsedAtMs < TURN_IDLE_MS && excess <= 0) break;
      excess -= 1;
      turns.delete(turn.conversationId);
      generationModels.delete(turn.conversationId);
      turn.unsubscribe();
      void adapter.dispose(turn.sessionId).catch(() => undefined);
    }
  };
  /**
   * Which model each conversation's current generation runs.
   *
   * Kept beside the sessions rather than on the turn, because it is the one fact that outlives a session: a model
   * change creates a successor, and the comparison that decides whether a change is needed is between what the
   * conversation is running and what the person has asked for.
   */
  const generationModels = new Map<string, string>();

  const describe = (): string => `${selection.provider}/${selection.id}`;

  /*
   * The session policy for the turn about to run: what the session looks like, what the policy decides, and the rebuild
   * when it decides one and is allowed to act. A rebuild that fails leaves the session as it was: reuse is always safe.
   */
  const applySessionPolicy = async (
    turn: Turn,
    text: string,
    alreadyRunning: boolean,
  ): Promise<{ telemetry: SessionTelemetry; decision: SessionDecision; rebuilt: boolean } | undefined> => {
    const policy = options.sessionPolicy;
    if (policy === undefined) return undefined;
    const now = Date.now();
    const usage = adapter.usage(turn.sessionId);
    const telemetry: SessionTelemetry = {
      ageMs: now - turn.sessionCreatedAtMs,
      idleMs: now - turn.lastUsedAtMs,
      turns: turn.answered,
      ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
      ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      ...(turn.lastLatencyMs === undefined ? {} : { lastLatencyMs: turn.lastLatencyMs }),
      topicShift: topicShift(turn.recentTexts, text),
    };
    const decision = await decideSession(
      telemetry,
      { firstTurn: turn.fresh || turn.answered === 0, inFlight: alreadyRunning },
      policy.ask,
    );
    let rebuilt = false;
    if (policy.mode === "rebuild" && decision.decision === "rebuild" && !turn.stopped) {
      try {
        rebuilt = await turn.rebuild();
      } catch {
        rebuilt = false;
      }
    }
    return { telemetry, decision, rebuilt };
  };

  /** The conditional instructions to state now, marked as told; nothing when there are none or they cannot be read. */
  const stateInstructions = (turn: Turn, conversationId: string, newOnly: boolean): string => {
    if (options.instructions === undefined) return "";
    try {
      const section = options.instructions({
        conversationId,
        touched: turn.touched,
        stated: turn.stated,
        allowed: turn.allowed,
        newOnly,
        nonce: turn.instructionNonce,
      });
      for (const id of section.stated) turn.stated.add(id);
      return section.text;
    } catch {
      return "";
    }
  };

  /*
   * What a model may be sent (#433). A pool that cannot be read is answered with `public` alone, which nothing the
   * conversation holds is: the turn runs without retrieved context rather than with a guess at what was allowed.
   */
  const allowedFor = (model: { provider: string; id: string }): readonly DataClass[] => {
    try {
      return options.allowedDataClasses?.(model) ?? DEFAULT_ALLOWED_DATA_CLASSES;
    } catch {
      return ["public"];
    }
  };

  /*
   * The one routing step for background work, shared by a background run and a dispatched worker so both treat a failed
   * route the same way. Routing must never be the reason work does not start: a route that rejects, or throws before it
   * returns a promise, is a run on the configured model, and the reason is kept for the record.
   */
  const routeBackground = async (work: {
    dataClass?: DataClass;
  }): Promise<{ routed?: { provider: string; id: string }; fallback?: BackgroundFallback }> => {
    if (options.backgroundModel === undefined) return {};
    let route: BackgroundRoute | undefined;
    try {
      route = await options.backgroundModel(work);
    } catch {
      return { fallback: { reason: "route-failed" } };
    }
    if (route === undefined) return {};
    if ("fallback" in route) return { fallback: route.fallback };
    return { routed: { provider: route.provider, id: route.id } };
  };

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
        return { text: descriptor.shownText ?? `Shown: ${requested}. It is sample data and is labelled that way.` };
      },
    };
  }

  async function turnFor(conversationId: string, principal: Principal): Promise<Turn> {
    const existing = turns.get(conversationId);
    const preferred = options.model?.();
    const preferredModel = preferred === undefined ? undefined : `${preferred.provider}/${preferred.id}`;

    /*
     * The fast path, and the only one that may return a session untouched.
     *
     * A model change is answered below rather than here, because it needs the brief and the listener that a session
     * is created with — and those are built after this line so a cached turn costs nothing to reuse.
     */
    if (
      existing !== undefined &&
      modelChangeNeedsGeneration({ currentModel: generationModels.get(conversationId), preferredModel }) === "none"
    ) {
      return existing;
    }

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
      channel: "chat",
      origin: undefined,
      toolSequence: 0,
      unsubscribe: () => {},
      abort: new AbortController(),
      conversationId,
      fresh: true,
      inFlight: false,
      startedAtMs: undefined,
      stopped: false,
      settleStop: undefined,
      stopping: undefined,
      lastUsedAtMs: Date.now(),
      uiSeen: new Map(),
      registeredTools: [],
      activeTools: undefined,
      toolsUsed: new Set(),
      preparing: undefined,
      touched: [],
      stated: new Set(),
      instructionNonce: randomBytes(8).toString("hex"),
      nonceStated: false,
      allowed: DEFAULT_ALLOWED_DATA_CLASSES,
      sessionCreatedAtMs: Date.now(),
      answered: 0,
      recentTexts: [],
      lastLatencyMs: undefined,
      lastBrief: "",
      rebuild: async () => false,
    };
    /*
     * After a tool call: remember what it touched, and hand back the instructions that newly apply. A failure here is a
     * call answered without them, never a failed call.
     */
    const afterCall = (name: string, params: Record<string, unknown>): string => {
      if (options.instructions === undefined) return "";
      const touch = touchOfToolCall(name, params);
      if (touch === undefined) return "";
      rememberTouch(turn.touched, touch);
      return stateInstructions(turn, conversationId, true);
    };
    // The view tool is only registered when there is a catalog; the extra tools stand on their own
    // and are registered whatever the catalog says.
    const customTools = [
      ...(views.length === 0 ? [] : [showViewTool(turn, principal, views, viewById, datasetRefs)]),
      ...readExtraTools(turn),
    ].map((tool) => withActivity(turn, tool, afterCall));
    turn.registeredTools = customTools.map((tool) => tool.name);

    const chosen = options.model?.();

    /**
     * The brief this conversation's session is created with — and re-created with after a model change.
     *
     * One function rather than two literals, because a successor session created by a handoff with a different
     * brief would be a generation with different tools, and the model would find out mid-conversation.
     */
    const briefFor = (model: { provider: string; id: string } | undefined): WorkerBrief => ({
      // The brief is per conversation rather than per message, so the model keeps the thread
      // it is already in instead of meeting the user again on every turn.
      goal: "Answer the user in this conversation.",
      projectRoots: [],
      allowedCapabilityRefs: [],
      // Resolved here rather than when the turn was built: this is the moment a model can actually be chosen for a
      // session, and it is also the moment `services` exists to say what was chosen.
      ...(model === undefined ? {} : { model }),
      ...(customTools.length === 0 ? {} : { customTools }),
      // Carried on the brief as well as held here, because the adapter enforces it at the
      // turn boundary and that is where a runaway turn is actually stopped.
      maxWallClockMs: budget.maxWallClockMs,
      maxTokens: budget.maxTokens,
    });

    /**
     * The one listener, so a session created by a handoff is watched exactly like the first one.
     *
     * A successor that nothing subscribed to would stream into nowhere: the swap would look successful and the
     * conversation would go quiet, which is the failure this function exists to make impossible.
     */
    const listen = (target: Turn, sessionId: string): (() => void) =>
      adapter.subscribe(sessionId, (event) => {
        // After a stop nothing more is taken in: the reply is what had been said when the person stopped it.
        if (target.stopped) return;
        if (isTextDelta(event)) {
          // Both, and in this order: the buffer is what the stored message is built from, and the
          // callback is what the reader sees now. Dropping the buffer to stream would lose the text a
          // caller that is not watching never receives.
          // Reasoning already in hand is closed first, so the two never interleave inside one block.
          flushReasoning(target);
          target.pending.push(event.delta);
          target.onEvent?.({ type: "text-delta", text: event.delta });
          return;
        }
        if (event.type === "thinking-delta") {
          flushText(target);
          target.reasoning.push(event.delta);
          target.onEvent?.({ type: "reasoning-delta", text: event.delta });
        }
      });

    /*
     * A model change becomes a new generation, at the turn boundary.
     *
     * Pi resolves the model when a session is created, so it cannot be applied to the session underneath a running
     * turn — and this function is only reached when a turn is starting, which is the boundary the design names.
     * Nothing is mutated in place: the adapter creates a successor and keeps the previous session subscribed until
     * the swap is finished, which is what makes a change mid-conversation safe to observe.
     */
    if (existing !== undefined) {
      const successor = await adapter.handoff(existing.sessionId, briefFor(preferred));
      existing.unsubscribe();
      existing.sessionId = successor.successor.sessionId;
      // A successor starts with every tool its brief names, so a disclosure plan starts over with it.
      existing.registeredTools = turn.registeredTools;
      existing.activeTools = undefined;
      // A successor session has not heard the code: a new one is drawn and stated on its first turn.
      existing.instructionNonce = randomBytes(8).toString("hex");
      existing.nonceStated = false;
      existing.unsubscribe = listen(existing, existing.sessionId);
      generationModels.set(conversationId, preferredModel ?? "");
      return existing;
    }

    turn.rebuild = async (): Promise<boolean> => {
      const handle = await adapter.createWorkerSession(briefFor(options.model?.()));
      // A Stop while the fresh session was being created ended this turn: the old session is the stop's to dispose,
      // and the fresh one nobody will prompt goes now. The same when the node shut down meanwhile (its turn aborted).
      if (turn.stopped || turn.abort.signal.aborted) {
        void adapter.dispose(handle.sessionId).catch(() => undefined);
        return false;
      }
      const previous = turn.sessionId;
      turn.unsubscribe();
      turn.sessionId = handle.sessionId;
      turn.unsubscribe = listen(turn, handle.sessionId);
      // Everything the old session had been told goes with it: the new one hears the recap, the pinned and active
      // instructions, every tool and the screen as if for the first time.
      turn.fresh = true;
      turn.stated.clear();
      turn.instructionNonce = randomBytes(8).toString("hex");
      turn.nonceStated = false;
      turn.uiSeen.clear();
      turn.activeTools = undefined;
      turn.sessionCreatedAtMs = Date.now();
      turn.answered = 0;
      turn.recentTexts = [];
      turn.lastBrief = "";
      void adapter.dispose(previous).catch(() => undefined);
      return true;
    };

    evictIdleTurns(Date.now());
    const handle = await adapter.createWorkerSession(briefFor(chosen));

    turn.sessionId = handle.sessionId;
    turn.unsubscribe = listen(turn, handle.sessionId);
    generationModels.set(conversationId, preferredModel ?? "");

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
    skills: (): Promise<readonly PiSkill[]> => adapter.skills(),
    skillBody: (name: string, revision: string): Promise<PiSkillBody> => adapter.skillBody(name, revision),

    /** The conversations with a turn still running. */
    running: (): string[] => [...turns.values()].filter((turn) => turn.inFlight).map((turn) => turn.conversationId),

    /**
     * Stops the running turn for a conversation, answering whether there was one.
     *
     * The turn's own controller rather than a new one, because the point is to stop the work that is happening, and
     * the paths that watch for cancellation already watch this one. The provider is aborted too: a stop that only
     * cancelled the builds would leave the model generating, and paying for, an answer nobody will see.
     *
     * The session is let go of here rather than reused, the same way a failed turn's is: a message sent to stop this
     * one arrives immediately, and a session whose previous run is still winding down is not one to prompt again. The
     * next message opens a fresh session that is told what the conversation already holds, the stopped reply included.
     */
    interrupt: (conversationId: string): boolean => {
      const turn = turns.get(conversationId);
      if (turn === undefined || !turn.inFlight) return false;
      turn.stopped = true;
      turn.abort.abort();
      turns.delete(conversationId);
      turn.stopping = adapter.abort(turn.sessionId, "người dùng đã dừng lượt này").catch(() => undefined);
      turn.settleStop?.();
      return true;
    },

    /**
     * Adds a sentence to the turn that is already running, answering whether there was one to add it to.
     *
     * What the adapter does with it is the adapter's business; the answer is what lets a caller decide what to do
     * when there was nothing to steer.
     *
     * Only a message from the same origin joins: a program's words steered into the person's turn would run as the
     * person, past "Ask me first", and would be recorded as the person's. A message of another origin answers false,
     * so the caller makes it a turn of its own with its own origin.
     */
    steer: async (conversationId: string, text: string, origin?: TurnOrigin): Promise<boolean> => {
      const turn = turns.get(conversationId);
      if (turn === undefined || !turn.inFlight || turn.sessionId === "") return false;
      if ((origin ?? "person") !== (turn.origin ?? "person")) return false;
      await turn.preparing;
      // A Stop while it was being prepared ended the turn this was meant for.
      if (!turn.inFlight || turn.stopped) return false;
      await adapter.steer(turn.sessionId, text);
      return true;
    },

    runningMs: (conversationId: string): number | undefined => {
      const turn = turns.get(conversationId);
      return turn?.inFlight === true && turn.startedAtMs !== undefined ? Date.now() - turn.startedAtMs : undefined;
    },

    workerModel: async (
      work?: { dataClass?: DataClass },
    ): Promise<ModelSelection & { via: "routed" | "configured"; fallback?: BackgroundFallback }> => {
      const { routed, fallback } = await routeBackground(work ?? {});
      if (routed !== undefined) return { provider: routed.provider, id: routed.id, via: "routed" };
      const current = options.model?.() ?? selection;
      return { ...current, via: "configured", ...(fallback === undefined ? {} : { fallback }) };
    },

    configuredModel: (): ModelSelection => options.model?.() ?? selection,

    runInBackground: async (input: BackgroundRunInput): Promise<string> => {
      const signal = input.signal;
      const workId = input.workId ?? `bg-${input.conversationId}-${String(Date.now())}`;
      signal?.throwIfAborted();
      // What the host retrieved for this request, read before the session exists because its one tool is part of how
      // the session is created. A retrieval that fails is a run without it, not a run that fails.
      const context =
        options.backgroundContext === undefined
          ? undefined
          : await options
              .backgroundContext({ conversationId: input.conversationId, principalId: input.principal.principalId, text: input.text })
              .catch(() => undefined);
      // Routed by what the work carries (#433): the request, the caller's data and what was retrieved. The router only
      // offers profiles that may receive that class, and whichever model then runs — routed or the fallback — is
      // checked again below: the run reads only what that model may be sent.
      const dataClass = maxDataClass([
        dataClassOfText(`${input.text}\n${input.data ?? ""}`),
        ...(context === undefined ? [] : [context.dataClass]),
      ]);
      // A route that fails is a run on the configured model, the same as one that found nothing eligible.
      const { routed } = await routeBackground({ dataClass });
      const runsOn = routed ?? options.model?.() ?? selection;
      const allowed = allowedFor(runsOn);
      const narrowed = context?.readerFor(allowed);
      const reader = narrowed === undefined || narrowed.items === 0 ? undefined : narrowed;
      const handle = await adapter.createWorkerSession({
        goal: input.text.slice(0, 2000),
        // No folders and no capabilities: starting a worker is not a way to acquire either, and the request that
        // needs them goes through the same approval path as any other. The one tool it may get reads what the host
        // retrieved from this conversation for this request, and nothing else.
        projectRoots: [],
        allowedCapabilityRefs: [],
        ...(reader === undefined ? {} : { customTools: [readContextTool(reader)] }),
        // Routed only for background work. Foreground honours the person's choice, and nobody is watching this run —
        // which is exactly why the model for it is a decision rather than a setting. Named even when nothing was routed,
        // so the model that runs is the one whose data classes narrowed what it reads, not the adapter's boot default.
        model: runsOn,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      });
      backgroundSessions.set(workId, handle.sessionId);
      let said = "";
      const unsubscribe = adapter.subscribe(handle.sessionId, (event) => {
        if (event.type === "text-delta") said += event.delta;
      });
      // The supervisor's stop, deadline and shutdown all arrive as this signal; the worker is aborted with the reason's
      // own words so the adapter's record says why.
      const onAbort = (): void => {
        const reason = signal?.reason instanceof Error ? signal.reason.message : "việc nền đã bị dừng";
        void adapter.abort(handle.sessionId, reason).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Created before the signal could be observed, so an abort that landed during creation is honoured here.
        signal?.throwIfAborted();
        // The list of what was retrieved goes with the data, after the caller's own: material, not a goal. An item is read
        // in full only when the run asks for it.
        const listed = reader?.answer({});
        const retrieved = listed?.kind === "done" ? listed.text : "";
        const data = [input.data ?? "", retrieved].map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
        await adapter.prompt(handle.sessionId, promptForTurn({ text: input.text, ...(data === "" ? {} : { data }) }));
        // A prompt that settles quietly after an abort is still a stopped run, not a result to report.
        signal?.throwIfAborted();
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        backgroundSessions.delete(workId);
        // Disposed whatever happened: a worker nobody will ask again is a provider connection held open for nothing.
        void adapter.dispose(handle.sessionId).catch(() => undefined);
      }
      return said.trim();
    },

    /**
     * Stop every background worker this process started.
     *
     * The other half of the emergency stop. Aborted *and* disposed, in that order, because an abort that leaves the
     * session registered would let a later turn reach a worker the person has already stopped.
     */
    stopBackgroundSessions: async (): Promise<number> => {
      const started = [...backgroundSessions.entries()];
      for (const [workId, sessionId] of started) {
        backgroundSessions.delete(workId);
        await adapter.abort(sessionId, "người dùng đã dừng công việc đang chạy").catch(() => undefined);
        void adapter.dispose(sessionId).catch(() => undefined);
      }
      return started.length;
    },

    async answer(input: ModelTurnInput): Promise<ModelTurnReply> {
      if (!availability.available) {
        throw new Error(
          `this node is configured for ${describe()} but that model is not reachable: ${availability.reason ?? "no reason given"}`,
        );
      }

      const startedAt = Date.now();
      const turn = await turnFor(input.conversationId, input.principal);
      const alreadyRunning = turn.inFlight;
      /*
       * Running from here, before anything is read for the prompt.
       *
       * Reading the recap, the memory and the tool plan can take a selector call each when an operator opted in, and a
       * message or a Stop arriving meanwhile must see a turn in flight: a second message is steered rather than started
       * alongside, and a Stop is honoured — the prompt below is then never sent.
       */
      turn.inFlight = true;
      turn.startedAtMs = startedAt;
      // Cleared before the prompt rather than after, so a turn that throws still leaves the
      // buffer empty for the next one instead of prepending the previous reply to it.
      turn.pending.length = 0;
      turn.reasoning.length = 0;
      turn.segments.length = 0;
      turn.messageId = input.messageId;
      turn.onEvent = input.onEvent;
      turn.channel = input.channel ?? "chat";
      turn.origin = input.origin;
      turn.toolSequence = 0;
      turn.abort = new AbortController();
      turn.stopped = false;
      turn.stopping = undefined;
      const stopRequested = new Promise<void>((resolve) => {
        turn.settleStop = resolve;
      });
      // Created before the first await: a message steered while this turn is being prepared — a rebuild included —
      // waits for it, and then joins the session that is actually prompted.
      let preparedResolve: () => void = () => undefined;
      turn.preparing = new Promise<void>((resolve) => {
        preparedResolve = resolve;
      });
      // At the turn boundary, before anything is read: a rebuilt session is fresh, so the recap below briefs it. Any
      // failure of the policy is reuse, which is what the session would have done without it.
      const policy = await applySessionPolicy(turn, input.text, alreadyRunning).catch(() => undefined);
      // Once, on the first turn this session answers: the second turn already has the first in its context,
      // and repeating the brief each time would push the conversation out with its own summary.
      const fresh = turn.fresh;
      turn.fresh = false;
      // What the model this conversation runs may be sent (#433), read now: the recap and the memory brief withhold
      // anything of another class before a selector or the provider sees it.
      const allowed = allowedFor(options.model?.() ?? selection);
      turn.allowed = allowed;

      let recap: { text: string; earlier: string };
      let memoryPart: string;
      let referencePart: string;
      let attachmentPart: string;
      try {
        // Read once, before the prompt, from the message the conductor has already stored.
        attachmentPart =
          options.attachments === undefined
            ? ""
            : attachmentBrief({
                refs: options.attachments.refsFor(input.conversationId),
                dataDir: options.attachments.dataDir,
              });
        // Side by side rather than one after another, so a turn waits for the slowest of them and not their sum.
        [recap, memoryPart, referencePart] = await Promise.all([
          fresh ? recapFor(options, input.conversationId, input.text, allowed) : Promise.resolve({ text: "", earlier: "" }),
          // Read fresh every turn, not captured once: a record the person deleted must stop being sent on the next
          // turn, which is what the Memory tab's promise to let them see the source and delete it has to mean.
          // Given the turn's text, so what is remembered about this subject comes first; a brief that cannot be read is
          // a less informed turn, not a failed one.
          Promise.resolve(options.memoryBrief?.(input.conversationId, input.text, allowed))
            .catch(() => "")
            .then((part) => part ?? ""),
          options.references === undefined
            ? Promise.resolve("")
            : options.references.briefFor(input.conversationId, (name, revision) => adapter.skillBody(name, revision)),
          discloseTools(turn, input.conversationId, input.text),
        ]);
      } catch (cause) {
        // Nothing was sent: the turn was never running as far as anyone else is concerned.
        turn.inFlight = false;
        turn.startedAtMs = undefined;
        turn.settleStop = undefined;
        turn.onEvent = undefined;
        if (!turn.stopped) throw cause;
        /*
         * A person stopped the turn while it was being prepared, and the preparation then failed: they asked for a stop
         * and a stop is what they get. `interrupt` already took the session out of `turns`, so nothing else would
         * dispose of it; it goes here, once the stop it started has settled, the way a stopped turn's session does below.
         */
        const elapsedMs = Date.now() - startedAt;
        const sessionId = turn.sessionId;
        const metrics = turnMetrics({ adapter, sessionId, elapsedMs, model: selection.id });
        turn.lastUsedAtMs = Date.now();
        turn.unsubscribe();
        void (turn.stopping ?? Promise.resolve()).then(() => adapter.dispose(sessionId)).catch(() => undefined);
        return { text: "", segments: [], provider: selection.provider, model: selection.id, elapsedMs, metrics, stopped: true };
      } finally {
        preparedResolve();
        turn.preparing = undefined;
      }
      // Built here rather than at the call, because `note` is optional under exactOptionalPropertyTypes: a
      // present key holding undefined is a different type from an absent key, and only one of them means
      // "this turn carries no extra instruction".
      // The session's instruction code, said once in the host's own guidance before any block can carry it: on the first
      // turn the session is prompted, and only while conditional instructions are on.
      const statesNonce = options.instructions !== undefined && !turn.nonceStated;
      const note = withRecap(
        [recap.text, statesNonce ? instructionsNonceNote(turn.instructionNonce) : ""].filter((part) => part !== "").join("\n\n"),
        input.note,
      );
      // Project guidance whose condition holds goes with the brief, after the person's words and labelled with its
      // source: a pinned one every turn, an unpinned one the first time this session hears it.
      const instructionPart = stateInstructions(turn, input.conversationId, false);
      const brief = [referencePart, attachmentPart, memoryPart, instructionPart].filter((part) => part !== "").join("\n\n");
      if (policy !== undefined && options.sessionPolicy !== undefined) {
        try {
          reportSessionTelemetry({
            conversationId: input.conversationId,
            mode: options.sessionPolicy.mode,
            ...policy,
            linesChanged: linesChanged(turn.lastBrief, brief),
          });
        } catch {
          // A report that cannot be written is not a reason for the turn to fail.
        }
      }
      turn.lastBrief = brief;
      // What the planner retrieved from further back goes with the data, after the caller's own: material, not guidance.
      const data = [input.data ?? "", recap.earlier].map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
      const ui = uiNoteFor(turn, input.conversationId);

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

      // Marked only when the prompt that carries it is sent: a stopped turn leaves it for the next one.
      if (statesNonce && !turn.stopped) turn.nonceStated = true;
      // A Stop that arrived while the prompt was being prepared means the prompt is never sent.
      const prompted = turn.stopped
        ? Promise.resolve()
        : adapter.prompt(
            turn.sessionId,
            promptForTurn({
              text: input.text,
              ...(note === undefined ? {} : { note }),
              ...(brief === "" ? {} : { brief }),
              ...(data === "" ? {} : { data }),
              ...(ui === "" ? {} : { ui }),
            }),
          );
      // A stop settles the race before the provider does, and whatever the provider says afterwards is already
      // answered; left unobserved, its rejection would surface as an unhandled one.
      prompted.catch(() => undefined);

      try {
        await Promise.race([prompted, deadline, stopRequested]);
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
         *
         * A provider that answers its own abort with an error is not a failure when a person asked for the stop: the
         * turn ends the way a stopped turn does, below.
         */
        if (!turn.stopped) {
          // Only this turn's entry: a stop may already have handed the conversation to the next message's session.
          if (turns.get(input.conversationId) === turn) turns.delete(input.conversationId);
          turn.unsubscribe();
          void adapter.dispose(turn.sessionId).catch(() => undefined);
          throw cause;
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        turn.settleStop = undefined;
        // Detached before the segments are read, so an event arriving after the race resolved cannot
        // be delivered to a reader that has already been told the answer is complete.
        turn.onEvent = undefined;
        // Cleared here, in the one path that every outcome goes through: success, failure and cancellation all leave
        // `answer` through this block, and a stale marker would make the next message think a turn was still running.
        turn.inFlight = false;
        turn.startedAtMs = undefined;
        turn.lastUsedAtMs = Date.now();
        turn.answered += 1;
        turn.lastLatencyMs = Date.now() - startedAt;
        turn.recentTexts.push(input.text.slice(0, 2_000));
        if (turn.recentTexts.length > SESSION_POLICY_LIMITS.recentTexts) turn.recentTexts.shift();
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

      if (turn.stopped) {
        // Read before the session goes: the tokens a stopped turn spent are still worth reporting.
        const metrics = turnMetrics({ adapter, sessionId: turn.sessionId, elapsedMs, model: selection.id });
        turn.unsubscribe();
        const sessionId = turn.sessionId;
        void (turn.stopping ?? Promise.resolve()).then(() => adapter.dispose(sessionId)).catch(() => undefined);
        // Stopped with nothing said yet is still an answer: the person asked for the stop, so it is not a failure.
        return { text, segments, provider: selection.provider, model: selection.id, elapsedMs, metrics, stopped: true };
      }

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

    /*
     * Every session this process holds, foreground and background.
     *
     * A running turn is aborted before its session is disposed, so a provider stream in flight is cancelled rather
     * than left writing into a session that no longer exists; the background workers go the same way, because a
     * shutdown that disposed only the conversations would leave the workers nobody is awaiting.
     */
    async dispose(): Promise<void> {
      for (const turn of turns.values()) {
        turn.unsubscribe();
        if (turn.inFlight) turn.abort.abort();
        await adapter.dispose(turn.sessionId).catch(() => undefined);
      }
      turns.clear();
      for (const [workId, sessionId] of [...backgroundSessions.entries()]) {
        backgroundSessions.delete(workId);
        await adapter.abort(sessionId, "node đang tắt").catch(() => undefined);
        await adapter.dispose(sessionId).catch(() => undefined);
      }
    },
  };
}
