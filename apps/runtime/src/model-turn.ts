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

import { type ProviderAuthPort, providerAuthPort } from "./application/provider-sign-in.ts";
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
  redactSecrets,
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
  type ContextGuard,
  ModelSwitchUnsureError,
  type WorkerBrief,
  type WorkerEvent,
  type WorkerSessionHandle,
} from "@clarkcant/pi-adapter";

import type { ModelSegment, ModelTurnEvent, ModelTurnInput, ModelTurnReply, TurnMetrics } from "@clarkcant/core";

import { attachmentBrief } from "./attachments.ts";
import { hostText } from "./host-text.ts";
import { type ContextReader, type ContextSource, readContextTool } from "./context-bundle.ts";
import {
  type InstructionTouch,
  type TurnInstructions,
  instructionsNonceNote,
  rememberTouch,
  touchOfToolCall,
} from "./conditional-instructions.ts";
import { legacyRecap, planRecap } from "./context-planner.ts";
import { type PersonalInstructionsPin, createPersonalInstructionsPin } from "./personal-instructions-pin.ts";
import {
  PERSONAL_INSTRUCTIONS,
  type WithheldItem,
  contextGuardFor,
  dataClassUnavailable,
  dataClassUnavailableText,
  enforceSendBoundary,
  isDataClassUnavailable,
  modelName,
  toolResultGuardFor,
  withheldContextText,
} from "./send-boundary.ts";
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
 * routes nothing: no model in the pool may receive the work's data class, or the route itself failed. Either way the
 * configured model runs it only because it may itself receive the work; when it may not, nothing runs
 * (`MODEL_DATA_CLASS_UNAVAILABLE`).
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
  /**
   * The conversations a Stop can reach: a turn answering, or one still being set up (a session being created or a model
   * switch pending).
   */
  running: () => string[];
  /**
   * The conversations whose turn is answering — claimed and running, not only being set up. What a new message is
   * steered into or stops; a conversation that is only being set up answers its next message as a turn of its own,
   * after the setup, so a quick second message never stops the first.
   */
  answering: () => string[];
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
   *
   * Rejects with `MODEL_DATA_CLASS_UNAVAILABLE` (`DataClassUnavailable`), before any session exists, when neither the
   * routed nor the configured model may receive what the run would send.
   */
  runInBackground: (input: BackgroundRunInput) => Promise<string>;

  /**
   * The model a dispatched task's worker runs, decided as it is about to start.
   *
   * The same choice `runInBackground` makes, because a dispatched worker is background work too and nobody is watching
   * it: the policy layer's route among the node's pool when it gives one, else the model this node runs now (the
   * person's pick, else the environment's). Never a separate setting, so there is one place that decides.
   *
   * Either one only if it may receive `work.dataClass`: when neither may, this throws `MODEL_DATA_CLASS_UNAVAILABLE`
   * (`DataClassUnavailable`) and the task's worker is never started.
   */
  workerModel: (
    work?: { dataClass?: DataClass },
  ) => Promise<ModelSelection & { via: "routed" | "configured"; fallback?: BackgroundFallback }>;

  /** The model this node runs now, the person's pick else the environment's: what a worker falls back to when routing chooses nothing. */
  configuredModel: () => ModelSelection;

  /** The wall clock the next turn runs under, in milliseconds: the person's setting, else the operator's, else none. */
  turnLimitMs: () => number | undefined;

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

  /** Signing in to and out of providers through this turn's own runtime, so a sign-in is the one the next turn finds. */
  providerAuth: ProviderAuthPort | undefined;

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
   * The stored message this turn answers, when the caller knows it. What that message references is read from it, not
   * from whatever message was stored last: a turn that waited behind another one answers its own words.
   */
  userMessageId?: string | undefined;
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
  /**
   * Settles when the running turn ends, however it ends; `endRun` is what settles it and clears `inFlight`. A message
   * that cannot be steered into the running turn waits on this and then becomes a turn of its own.
   */
  ended: Promise<void>;
  endRun: () => void;
  /**
   * Whether the running turn's prompt has been sent and its run has not yet settled, including whatever Pi still held
   * queued from a steer. Only then can a sentence join it: before, there is no run to join; after, it would be queued
   * into a session nobody is reading.
   */
  streaming: boolean;
  /** Steers on their way to the adapter, which the turn waits for before it decides whether anything is still queued. */
  steersPending: Set<Promise<void>>;
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
  /** A provider has refused a run of this session. A change of model after that starts a session of its own. */
  refused: boolean;
  /** A change of model in place failed part-way, so which model the session runs is not known: it is only replaced. */
  unsure: boolean;
  /** A move of this session to another model that has not finished; nothing else looks at the session until it has. */
  switching: Promise<void> | undefined;
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
   * What the provider said when it refused this turn, cleared when a turn starts. Pi settles a refused turn the way it
   * settles an answer, so without this the person would hear that nothing was written rather than why.
   */
  providerError: string | undefined;
  /**
   * Replace the session with a fresh one, at a turn boundary: the new one is briefed by the recap like any fresh
   * session, and the old one is let go. The transcript is not touched.
   */
  rebuild: () => Promise<boolean>;
  /** What the current session's model was not given for its data class, and which of it the person has been told. */
  withheld: SessionWithheld;
}

/**
 * What one session's model was not given for its data class — a context file, a `SYSTEM.md`, a skill, the person's own
 * instructions — by name and class only. Each is said to the person once per session: `pending` until a reply carries
 * it, then `said`. A new session starts with a new record, so the same file withheld again is said again.
 */
interface SessionWithheld {
  pending: Map<string, WithheldItem>;
  said: Set<string>;
  /** The model whose ceiling the session's loader is held to: the one it runs now. */
  runs: { provider: string; id: string };
  /**
   * Every class this session was allowed on any send, under any model it has run. The session may hold any of it — in its transcript, its
   * prompt, a picture a tool returned — and a session cannot be narrowed, so another model takes it over in place only
   * if it may receive all of these.
   */
  ceiling: Set<DataClass>;
  /**
   * Every class of a file or instruction the session's loader left out, so a model that may receive it is given a
   * session made with it. A message left out of a recap or a withheld tool result is not counted here.
   */
  left: Set<DataClass>;
}

function newSessionWithheld(runs: { provider: string; id: string }, allowed: readonly DataClass[]): SessionWithheld {
  return { pending: new Map(), said: new Set(), runs, ceiling: new Set(allowed), left: new Set() };
}

function recordWithheld(record: SessionWithheld, item: WithheldItem): void {
  record.left.add(item.dataClass);
  const key = `${item.name}\u0000${item.dataClass}`;
  if (record.said.has(key) || record.pending.has(key)) return;
  record.pending.set(key, item);
}

/** The withheld items not yet said in this session, marked as said; empty when there are none. */
function takeWithheld(record: SessionWithheld): WithheldItem[] {
  const items = [...record.pending.values()];
  for (const key of record.pending.keys()) record.said.add(key);
  record.pending.clear();
  return items;
}

/** How a conversation's generation records its model: `provider/id`, or empty when nobody chose one. */
function modelKey(model: { provider: string; id: string } | undefined): string {
  return model === undefined ? "" : `${model.provider}/${model.id}`;
}

/*
 * A path may hold spaces ("C:\Users\An Nguyen\..."), so a path runs on through each following word that still has a
 * separator in it and is not a web address; a word without one ("or", "(see") ends it. A folder named with three or
 * more words ("C:\Users\Nguyen Van An\...") has words with no separator in the middle: up to three capitalised words
 * are taken too, but only when a capitalised word holding a separator follows them, so lower-case prose after a path
 * is left alone. Best effort: a quoted path is taken whole whatever its words.
 */
const PATH_CHAR = "[^\\s\"'`<>|]";
const NAME_WORD = "\\p{Lu}[^\\s\"'`<>|\\\\/]*";
const PATH_MORE =
  "(?: (?:" +
  NAME_WORD +
  " ){0,3}(?!\\S*://)" +
  NAME_WORD +
  "[\\\\/]" +
  PATH_CHAR +
  "*| (?!\\S*://)" +
  PATH_CHAR +
  "*[\\\\/]" +
  PATH_CHAR +
  "*)*";
const LOCAL_PATHS = [
  // file:// URLs name a place on a machine as surely as a bare path does.
  /\bfile:\/\/[^\s"'`<>|]*/gi,
  new RegExp("(?<![\\w.:/\\\\])[A-Za-z]:[\\\\/]" + PATH_CHAR + "*" + PATH_MORE, "gu"),
  new RegExp("(?<![\\w.:/\\\\])\\\\\\\\" + PATH_CHAR + "+" + PATH_MORE, "gu"),
  new RegExp("(?<![\\w.:/\\\\])~[\\\\/]" + PATH_CHAR + "*" + PATH_MORE, "gu"),
  new RegExp("(?<![\\w.:/\\\\<])/(?:[^\\s/\"'`<>|]+/)+[^\\s/\"'`<>|]*" + PATH_MORE, "gu"),
];

/**
 * An adapter's reason with local paths taken out, for an error the person reads: a session directory or a config file
 * says where things live on this machine and nothing about what went wrong. Web addresses are left alone; a `file://`
 * address is a local path and is not.
 */
export function redactLocalPaths(reason: string): string {
  // A quoted path is taken whole, spaces and all; its quotes stay so the sentence still reads.
  const unquoted = reason.replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|file:\/\/|\/(?!\/))[^"'`\n]*\1/gi, "$1<path>$1");
  return LOCAL_PATHS.reduce((text, pattern) => text.replace(pattern, "<path>"), unquoted);
}

/** A setup a Stop or the node's shutdown ended before it was done: the caller answers as a stopped turn does. */
class SetupStopped extends Error {}

/**
 * A turn the model's provider refused outright: it said why, and nothing was written. The message is the person's
 * sentence; `model` and `reason` are what a fallback needs to decide what to try next and to say what happened.
 */
class ProviderRefusal extends Error {
  readonly model: string;
  readonly reason: string;
  constructor(message: string, model: string, reason: string) {
    super(message);
    this.model = model;
    this.reason = reason;
  }
}

/** How long a model that refused a turn is passed over before it is tried again. */
const REFUSAL_COOLDOWN_MS = 10 * 60_000;
/** Models tried for one message: the chosen one and at most two fallbacks, so a bad night costs seconds, not minutes. */
const MAX_MODELS_PER_MESSAGE = 3;

/** Settles once `signal` aborts, and lets go of its listener when `settled` does, so a long-lived signal collects none. */
function untilAborted(signal: AbortSignal, settled: Promise<unknown>): Promise<"stopped"> {
  return new Promise<"stopped">((resolve) => {
    if (signal.aborted) {
      resolve("stopped");
      return;
    }
    const onAbort = (): void => resolve("stopped");
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then(
      () => signal.removeEventListener("abort", onAbort),
      () => signal.removeEventListener("abort", onAbort),
    );
  });
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
 *
 * `rowLanguage` is the language of the label the call's row shows, read when the call starts. The tool itself keeps
 * the label it was defined with, since that one is also what the SDK holds.
 *
 * What of a call's answer the model is then sent is the session's tool-result guard's to decide, in the adapter, after
 * this: the send boundary may withhold a result above the answering model's ceiling. The transcript keeps the result
 * either way — it is the person's.
 */
function withActivity(
  turn: Turn,
  tool: ToolDefinition,
  rowLanguage: () => "vi" | "en",
  afterCall?: (name: string, params: Record<string, unknown>) => string,
): ToolDefinition {
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
      const label = hostText(rowLanguage()).toolLabel(tool.name, tool.label);
      turn.onEvent?.({ type: "tool-start", toolCallId, name: tool.name, label, args: params });

      const record = (status: "done" | "failed", result: string): MessageBlock => ({
        type: "tool-activity",
        toolCallId,
        name: tool.name,
        label,
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
 * A turn limit in the unit a person says it in: "5 phút" or "1 s", never "300000 ms".
 *
 * Whole minutes read as minutes; anything shorter or uneven reads as seconds, rounded up so a limit is never stated as
 * shorter than it was.
 */
export function readableLimit(ms: number, language: "vi" | "en"): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return language === "vi" ? `${minutes} phút` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return language === "vi" ? `${seconds} giây` : `${seconds} s`;
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
    /** `messageId` is the stored message being answered; absent, the conversation's newest user message is read. */
    refsFor: (conversationId: string, messageId: string | undefined) => readonly AttachmentRef[];
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
    /** `messageId` is read the same way as `attachments.refsFor`'s. */
    briefFor: (
      conversationId: string,
      skillBody: (name: string, revision: string) => Promise<PiSkillBody>,
      messageId: string | undefined,
    ) => Promise<string>;
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
   * Models a conversation may answer on when the chosen one refuses a turn, best first — the node's enabled pool
   * profiles it holds credentials for. Read only after a refusal. The model the environment names is always tried
   * last, so a node with no pool still has somewhere to go.
   */
  fallbackModels?: () => Promise<readonly ModelSelection[]>;
  /**
   * The language the person reads, for the few errors this module words itself (a failed model switch, a preparation
   * that ran out of time). Read when the error is raised; absent is English.
   *
   * Also the language of the label a tool call's row shows, read when the call starts; absent is Vietnamese there, as
   * for all host-written text.
   */
  language?: () => "vi" | "en";
  /**
   * The user's own instructions, read fresh on every turn.
   *
   * A function for the same reason `model` is, and one more: the promise of the feature is that a
   * preference written while the app is open reaches the next turn rather than the next session, so the
   * value has to be read when a turn starts rather than when this module is built.
   */
  personalInstructions?: () => string | undefined;
  /**
   * Where the instructions each session is given are pinned once the send boundary checked them for its model; the
   * adapter this module builds reads them from here, never from the preference. Injected so a test can read what each
   * session was given; absent is a pin of this module's own.
   */
  personalInstructionsPin?: PersonalInstructionsPin;
  /**
   * The thinking level the person chose (Settings or `/thinking`), read when a session is created. A change reaches the
   * conversation's next turn through a handoff, like a model change. Absent keeps the level the node started with.
   */
  thinkingLevel?: () => ModelSelection["thinkingLevel"];
  /**
   * The wall clock the person set on a turn, in milliseconds, read when a turn starts. Absent falls back to the
   * operator's `CC_MODEL_MAX_WALL_CLOCK_MS`, and neither means no wall clock: tokens and Stop still bound the turn.
   */
  turnLimitMs?: () => number | undefined;
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

  /*
   * Automatic fallback.
   *
   * A model that refuses a turn — a provider error with nothing written — is passed over for a while, and the same
   * message is answered on the next usable model instead of leaving the person with an error. It is never silent: the
   * reply says which model was chosen, why it did not answer, and which one did. The person's choice is not rewritten;
   * the chosen model is tried again once its pause ends, or at once when the node restarts.
   */
  const refusals = new Map<string, { reason: string; untilMs: number }>();
  const refusalOf = (model: ModelSelection | undefined): { reason: string; untilMs: number } | undefined => {
    const key = modelKey(model);
    const refusal = refusals.get(key);
    if (refusal === undefined) return undefined;
    if (refusal.untilMs > Date.now()) return refusal;
    refusals.delete(key);
    return undefined;
  };
  /** The fallbacks, read when a refusal is first met and kept until the next one; the environment's model is last. */
  let fallbackChain: readonly ModelSelection[] = [];
  const readFallbackChain = async (): Promise<readonly ModelSelection[]> => {
    const pool = await (options.fallbackModels?.() ?? Promise.resolve([])).catch(() => []);
    const fromEnv = modelFromEnv(options.env);
    const seen = new Set<string>();
    return [...pool, ...(fromEnv === undefined ? [] : [fromEnv])].filter((model) => {
      const key = modelKey(model);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  /**
   * The model a conversation's next session runs: the person's choice, unless it refused a turn moments ago — then the
   * first fallback that has not. Nothing usable left is the choice again, so its own error is what the person reads.
   */
  const chosenModel = (): ModelSelection | undefined => {
    const preferred = options.model?.();
    const base = preferred ?? selection;
    if (refusalOf(base) === undefined) return preferred;
    return fallbackChain.find((model) => modelKey(model) !== modelKey(base) && refusalOf(model) === undefined) ?? preferred;
  };

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
  const turnLimitMs = (): number | undefined => options.turnLimitMs?.() ?? budget.maxWallClockMs;
  const chosenThinking = (): ModelSelection["thinkingLevel"] => options.thinkingLevel?.();
  // What each session's run is given of the person's instructions: the value checked for it (`personalFor`, below).
  const personalPin = options.personalInstructionsPin ?? createPersonalInstructionsPin();
  const pinPersonal = personalPin.pin;
  const adapter =
    options.adapter ??
    new RealPiAdapter({
      cwd: options.cwd,
      model: selection,
      builtinTools: [],
      ...(options.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
      ...(options.onSessionFile === undefined ? {} : { onSessionFile: options.onSessionFile }),
      // The value the send boundary checked for the session whose run is starting, never a fresh read.
      ...(options.personalInstructions === undefined
        ? {}
        : { personalInstructions: personalPin.get }),
    });
  /**
   * Let a session go, with the personal instructions pinned for it: every path that ends a session — a failed or stopped
   * turn, a handoff, idle eviction, a background run and shutdown — goes through here, so no pin outlives its session.
   */
  const disposeSession = (sessionId: string): Promise<void> => {
    personalPin.forget(sessionId);
    return adapter.dispose(sessionId);
  };
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
      generationThinking.delete(turn.conversationId);
      turn.unsubscribe();
      void disposeSession(turn.sessionId).catch(() => undefined);
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
  /** The thinking level each conversation's session runs at, compared like the model on every turn. */
  const generationThinking = new Map<string, string>();

  /**
   * The model a conversation's turn runs on: its current generation's, else the one the person chose, else the one this
   * node started with. Read per turn rather than captured at boot, so a reply and an error name the model that actually
   * answered — a choice made after the node started is otherwise misreported as the boot model.
   */
  const runningModel = (conversationId: string): ModelSelection => {
    const generation = generationModels.get(conversationId) ?? "";
    const slash = generation.indexOf("/");
    if (slash > 0 && slash < generation.length - 1) {
      return { provider: generation.slice(0, slash), id: generation.slice(slash + 1) };
    }
    return options.model?.() ?? selection;
  };
  const describe = (conversationId?: string): string => {
    const model = conversationId === undefined ? (options.model?.() ?? selection) : runningModel(conversationId);
    return `${model.provider}/${model.id}`;
  };

  const language = (): "vi" | "en" => {
    try {
      return options.language?.() ?? "en";
    } catch {
      return "en";
    }
  };
  // The rows tool calls leave are host text, and host text is Vietnamese when no language is named.
  const rowLanguage = (): "vi" | "en" => {
    try {
      return options.language?.() ?? "vi";
    } catch {
      return "vi";
    }
  };
  /*
   * The errors this module words for the person. Both say the message is kept — the conductor stored it before the turn
   * began — so the next step is to retry, not to type it again.
   */
  const switchFailed = (model: string | undefined, reason: string): string =>
    language() === "vi"
      ? `Không chuyển được cuộc trò chuyện này sang ${model ?? "model đã chọn"}: ${reason}. ` +
        "Tin nhắn của bạn đã được lưu và cuộc trò chuyện vẫn giữ nguyên. Hãy thử lại, hoặc chọn model khác."
      : `Could not switch this conversation to ${model ?? "the chosen model"}: ${reason}. ` +
        "Your message is saved and the conversation is unchanged. Retry, or choose another model.";
  /** The stopped card's sentence for a message whose turn never started. */
  const notStarted = (): string =>
    language() === "vi"
      ? "Tin nhắn này đã được dừng trước khi bắt đầu, nên model chưa viết gì cho nó. Tin nhắn vẫn được lưu."
      : "This message was stopped before it started, so the model wrote nothing for it. The message is still saved.";
  /** A turn that ran but brought back no reply: what failed and why, that the message is kept, and what to do next. */
  const turnFailed = (model: string, reason: string): string =>
    language() === "vi"
      ? `${model} không trả lời được tin nhắn này: ${reason}. ` +
        "Tin nhắn của bạn đã được lưu và cuộc trò chuyện vẫn giữ nguyên. Hãy thử lại, hoặc chọn model khác trong Cài đặt."
      : `${model} could not answer this message: ${reason}. ` +
        "Your message is saved and the conversation is unchanged. Retry, or choose another model in Settings.";
  /** Every model tried for one message refused it: each one and why, that the message is kept, and what to do next. */
  const noModelAnswered = (tried: readonly { model: string; reason: string }[]): string => {
    const list = tried.map((entry) => `${entry.model}: ${entry.reason}`).join("; ");
    return language() === "vi"
      ? `Không model nào trả lời được tin nhắn này — ${list}. ` +
          "Tin nhắn của bạn đã được lưu và cuộc trò chuyện vẫn giữ nguyên. Hãy thử lại sau, hoặc chọn model khác trong Cài đặt."
      : `No model could answer this message — ${list}. ` +
          "Your message is saved and the conversation is unchanged. Retry later, or choose another model in Settings.";
  };
  /** The models that refused a message before the one it could not be sent to: each one and why. */
  const refusedBefore = (tried: readonly { model: string; reason: string }[]): string => {
    const list = tried.map((entry) => `${entry.model}: ${entry.reason}`).join("; ");
    return language() === "vi" ? `Model đã chọn không trả lời — ${list}.` : `The chosen model did not answer — ${list}.`;
  };
  const startFailed = (model: string, reason: string): string =>
    language() === "vi"
      ? `Không bắt đầu được cuộc trò chuyện này trên ${model}: ${reason}. ` +
        "Tin nhắn của bạn đã được lưu. Hãy thử lại, hoặc chọn model khác."
      : `Could not start this conversation on ${model}: ${reason}. ` +
        "Your message is saved. Retry, or choose another model.";
  const setupTimedOut = (limitMs: number): string => {
    const limit = readableLimit(limitMs, language());
    return language() === "vi"
      ? `Không chuẩn bị xong để trả lời trong ${limit}, nên lượt này đã dừng. ` +
          "Tin nhắn của bạn đã được lưu. Hãy thử lại, hoặc chọn model khác nếu lỗi này lặp lại."
      : `Could not get ready to answer within ${limit}, so this turn was stopped. ` +
          "Your message is saved. Retry, or choose another model if this keeps happening.";
  };

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
        ...(turn.userMessageId === undefined ? {} : { messageId: turn.userMessageId }),
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
   * conversation holds is: rather than a guess at what was allowed, nothing is sent, and the person is told the ceiling
   * could not be read (`read: false`) rather than that it refused.
   */
  const ceilingOf = (model: { provider: string; id: string }): { allowed: readonly DataClass[]; read: boolean } => {
    try {
      return { allowed: options.allowedDataClasses?.(model) ?? DEFAULT_ALLOWED_DATA_CLASSES, read: true };
    } catch {
      return { allowed: ["public"], read: false };
    }
  };

  /*
   * The person's own instructions for one send, read once and narrowed like the rest of the guidance a send carries: a
   * model that may not receive what they contain is given none of them for this send, said on stderr by class and model
   * like any withheld text, and the send goes ahead without them. The caller checks the value with everything else the
   * send carries and pins it under the session it prompts (`pinPersonal`), so what the adapter appends is what was checked.
   */
  const personalFor = (
    model: { provider: string; id: string },
    allowed: readonly DataClass[],
  ): { text: string | undefined; withheld?: DataClass } => {
    let text: string | undefined;
    try {
      text = options.personalInstructions?.();
    } catch {
      return { text: undefined };
    }
    if (text === undefined || text.trim() === "") return { text: undefined };
    const check = enforceSendBoundary({ path: "personal-instructions", model, allowed, texts: [text] });
    return check.ok ? { text } : { text: undefined, withheld: check.dataClass };
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

  /** The models background work may run on, in the order they are tried: the routed one, then the configured one. */
  const backgroundCandidates = (
    routed: { provider: string; id: string } | undefined,
    configured: ModelSelection,
  ): ModelSelection[] =>
    routed === undefined ? [configured] : modelKey(routed) === modelKey(configured) ? [routed] : [routed, configured];

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
      label: "Hiển thị một khung nhìn",
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

  /**
   * The conversation's turn, with a session that runs the model the person chose. `setup` aborts when a Stop or the
   * setup's time limit ends the wait: a session created after that is let go rather than adopted.
   */
  /** Whether everything this session was ever allowed is still within the ceiling of the model it runs. */
  const holdsOnlyWhatItsModelMay = (turn: Turn): boolean => {
    const may = ceilingOf(turn.withheld.runs).allowed;
    return [...turn.withheld.ceiling].every((dataClass) => may.includes(dataClass));
  };

  async function turnFor(conversationId: string, principal: Principal, setup: AbortSignal): Promise<Turn> {
    // A move to another model that an ended setup left behind finishes first: until it has, which model the session
    // runs, and so what it may be sent, is not settled.
    for (let moving = turns.get(conversationId)?.switching; moving !== undefined; moving = turns.get(conversationId)?.switching) {
      await moving;
    }
    const existing = turns.get(conversationId);
    const preferred = chosenModel();
    const preferredModel = preferred === undefined ? undefined : `${preferred.provider}/${preferred.id}`;

    /*
     * The fast path, and the only one that may return a session untouched.
     *
     * A model change is answered below rather than here, because it needs the brief and the listener that a session
     * is created with — and those are built after this line so a cached turn costs nothing to reuse.
     */
    if (
      existing !== undefined &&
      modelChangeNeedsGeneration({ currentModel: generationModels.get(conversationId), preferredModel }) === "none" &&
      (generationThinking.get(conversationId) ?? "") === (chosenThinking() ?? "") &&
      !existing.unsure &&
      // A model allowed less than it was when this session was sent something gets a successor, as a narrower model would.
      holdsOnlyWhatItsModelMay(existing)
    ) {
      return existing;
    }
    /*
     * A change of model waits for a turn boundary. A message that arrives while a turn is running is steered into that
     * turn (see `answer`); swapping and disposing the session underneath it would cut the running reply off. The model
     * this conversation runs is not recorded as changed, so the next turn that starts makes the handoff.
     */
    if (existing?.inFlight === true) return existing;

    const views = readViews();
    const viewById = new Map(views.map((entry) => [entry.id, entry]));
    const datasetRefs = readDatasetRefs();

    // The turn is created before the session because the tool has to be handed over *at* session
    // creation — the SDK fixes its custom tool set then, and a tool added afterwards never reaches
    // the registry the allowlist consults. The tool writes into this object, so it has to exist
    // first; the session id is filled in once there is one.
    //
    // A handoff keeps the conversation's turn rather than building another: the successor's tools write into the turn
    // the person is watching, so its tool activity, its views and the tools it used land where they are read (#448).
    const turn: Turn = existing ?? {
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
      ended: Promise.resolve(),
      endRun: () => undefined,
      streaming: false,
      steersPending: new Set(),
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
      refused: false,
      unsure: false,
      switching: undefined,
      sessionCreatedAtMs: Date.now(),
      answered: 0,
      recentTexts: [],
      lastLatencyMs: undefined,
      lastBrief: "",
      providerError: undefined,
      rebuild: async () => false,
      // Replaced by the first session's own record before anything is prompted.
      withheld: newSessionWithheld(runningModel(conversationId), []),
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
    /*
     * What a call's result is sent back to the model as, for every tool the session holds: the result itself when the
     * model may receive every class it carries, else a note that it was withheld. The model is the one the conversation
     * runs when the call returns, and the ceiling is `turn.allowed` as the current turn's preparation read it for that
     * model — correct for the whole turn, because a session's model cannot change mid-turn: a change is made at
     * the next turn boundary, in place or as a new generation, and that turn's preparation reads the ceiling again.
     */
    const toolResultGuard = toolResultGuardFor({ model: () => runningModel(conversationId), allowed: () => turn.allowed });
    // The view tool is only registered when there is a catalog; the extra tools stand on their own
    // and are registered whatever the catalog says.
    const customTools = [
      ...(views.length === 0 ? [] : [showViewTool(turn, principal, views, viewById, datasetRefs)]),
      ...readExtraTools(turn),
    ].map((tool) => withActivity(turn, tool, rowLanguage, afterCall));
    // Recorded on the turn once a session holds these tools: a handoff that fails leaves the previous generation's.
    const registeredTools = customTools.map((tool) => tool.name);

    const chosen = chosenModel();

    /**
     * The brief this conversation's session is created with — and re-created with after a model change.
     *
     * One function rather than two literals, because a successor session created by a handoff with a different
     * brief would be a generation with different tools, and the model would find out mid-conversation.
     */
    const briefFor = (
      model: { provider: string; id: string } | undefined,
    ): { brief: WorkerBrief; withheld: SessionWithheld } => {
      /*
       * What the SDK loads from the machine into this session's prompt is held to the ceiling of the model this session
       * will run, read now: a file is left out only for a model that may not receive it. What is left out is recorded
       * for this session, so the person is told once, by name and class, on the session's next reply.
       */
      const runs = model ?? options.model?.() ?? runningModel(conversationId);
      const withheld = newSessionWithheld(runs, ceilingOf(runs).allowed);
      // Read when a file is checked, not when the session is created: a session moved to another model in place is
      // held to that model's ceiling from then on, for a skill read again as much as for a reload.
      const contextGuard: ContextGuard = (item) => {
        // A model's ceiling can be widened between two reads, so what this read lets in counts towards what the
        // session may hold.
        const allowed = ceilingOf(withheld.runs).allowed;
        for (const dataClass of allowed) withheld.ceiling.add(dataClass);
        return contextGuardFor({
          model: withheld.runs,
          allowed,
          onWithheld: (left) => recordWithheld(withheld, left),
        })(item);
      };
      return {
        withheld,
        brief: {
          // The brief is per conversation rather than per message, so the model keeps the thread
          // it is already in instead of meeting the user again on every turn.
          goal: "Answer the user in this conversation.",
          projectRoots: [],
          allowedCapabilityRefs: [],
          // Resolved here rather than when the turn was built: this is the moment a model can actually be chosen for a
          // session, and it is also the moment `services` exists to say what was chosen.
          ...(model === undefined ? {} : { model }),
          ...(customTools.length === 0 ? {} : { customTools }),
          toolResultGuard,
          contextGuard,
          // Carried on the brief as well as held here, because the adapter enforces it at the
          // turn boundary and that is where a runaway turn is actually stopped.
          ...thinkingAndLimit(),
          maxTokens: budget.maxTokens,
        },
      };
    };
    /** The person's thinking level and turn limit as they stand now; absent ones are left off the brief. */
    const thinkingAndLimit = (): Pick<WorkerBrief, "thinkingLevel" | "maxWallClockMs"> => {
      const thinkingLevel = chosenThinking();
      const maxWallClockMs = turnLimitMs();
      return {
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
      };
    };

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
          return;
        }
        if (event.type === "error") target.providerError = event.message;
      });

    /*
     * A model change happens at the turn boundary: this function is only reached when a turn is starting, never
     * underneath a running one.
     *
     * The session is kept and moved to the new model when that is safe (see the change in place, below). Otherwise the
     * change is a new generation: the adapter creates a successor and keeps the previous session subscribed until the
     * swap is finished, which is what makes a change mid-conversation safe to observe.
     */
    /**
     * Moves this conversation's turn onto a new session — a rebuild's or a handoff's successor — and lets the previous
     * one go.
     *
     * Everything the old session had been told goes with it: the new one hears the recap, the pinned and active
     * instructions, every tool and the screen as if for the first time. What the conversation's work touched is kept,
     * because it describes the work rather than the session.
     */
    const adopt = (sessionId: string, withheld: SessionWithheld): void => {
      const previous = turn.sessionId;
      // What the new session's model was not given, said on its own replies.
      turn.withheld = withheld;
      turn.unsubscribe();
      turn.sessionId = sessionId;
      turn.unsubscribe = listen(turn, sessionId);
      turn.fresh = true;
      turn.stated.clear();
      // A new session has not heard the code: a new one is drawn and stated on its first turn.
      turn.instructionNonce = randomBytes(8).toString("hex");
      turn.nonceStated = false;
      turn.uiSeen.clear();
      // A new session starts with every tool its brief names, so a disclosure plan starts over with it.
      turn.activeTools = undefined;
      turn.sessionCreatedAtMs = Date.now();
      turn.answered = 0;
      turn.recentTexts = [];
      turn.lastBrief = "";
      // A new session has been sent nothing yet, and no provider has refused it.
      turn.refused = false;
      turn.unsure = false;
      void disposeSession(previous).catch(() => undefined);
    };

    // Taken on by a handoff as well, so a later rebuild creates the session with this generation's tools.
    const rebuild = async (): Promise<boolean> => {
      const model = chosenModel();
      const { brief, withheld } = briefFor(model);
      const handle = await adapter.createWorkerSession(brief);
      // A Stop while the fresh session was being created ended this turn: the old session is the stop's to dispose,
      // and the fresh one nobody will prompt goes now. The same when the node shut down meanwhile (its turn aborted).
      if (turn.stopped || turn.abort.signal.aborted) {
        void disposeSession(handle.sessionId).catch(() => undefined);
        return false;
      }
      adopt(handle.sessionId, withheld);
      // The model the new session runs, so a change made meanwhile is not mistaken for one still to make.
      generationModels.set(conversationId, modelKey(model));
      generationThinking.set(conversationId, chosenThinking() ?? "");
      return true;
    };

    if (existing !== undefined) {
      /*
       * The change in place, when the same session can simply go on: Pi moves a session to another model between runs,
       * and it keeps its transcript, its tools and what it was already told, so nothing is briefed again.
       *
       * Only to a model that may receive every class any model this session has run could: a session cannot be
       * narrowed, and what it holds is not only what was typed, so a model with a lower ceiling gets a successor with a
       * recap narrowed to it, below. A model that may receive something this session was made without gets a successor
       * too, which is made with it. A failover after a refusal is a successor as well: its session ends on a prompt the
       * provider refused, and the message is sent again whole.
       */
      const thinking = chosenThinking();
      const sameModel = generationModels.get(conversationId) === modelKey(preferred);
      const wanted = preferred === undefined ? undefined : ceilingOf(preferred);
      const record = existing.withheld;
      const keeps =
        preferred !== undefined &&
        wanted !== undefined &&
        wanted.read &&
        !existing.refused &&
        !existing.unsure &&
        // Back to a model's own default level is not something a session can be told; a successor starts on it.
        (thinking !== undefined || (generationThinking.get(conversationId) ?? "") === "") &&
        [...record.ceiling].every((dataClass) => wanted.allowed.includes(dataClass)) &&
        ![...record.left].some((dataClass) => wanted.allowed.includes(dataClass));
      if (keeps) {
        /*
         * Marked on the turn while it runs: a message sent next must not move or prompt a session Pi is still moving.
         * What the session runs and may hold is recorded before anything waiting on it goes on.
         *
         * A Stop, or the setup's time limit, cannot end a move: Pi offers no way to. It ends the wait instead and
         * lets the turn go, so the conversation is not held by a move that never finishes — a slow check of the new
         * model's account, say. The next message starts a session of its own, told what the conversation holds, and
         * this one is disposed once Pi is done with it.
         */
        let release: () => void = () => undefined;
        const marker = new Promise<void>((resolve) => {
          release = resolve;
        });
        const unmark = (): void => {
          if (existing.switching === marker) existing.switching = undefined;
          release();
        };
        let retired = false;
        const retire = (): void => {
          retired = true;
          if (turns.get(conversationId) === existing) {
            turns.delete(conversationId);
            generationModels.delete(conversationId);
            generationThinking.delete(conversationId);
            existing.unsubscribe();
          }
          unmark();
        };
        existing.switching = marker;
        setup.addEventListener("abort", retire, { once: true });
        const move = (async (): Promise<boolean> => {
          try {
            await adapter.switchModel(existing.sessionId, {
              ...(sameModel ? {} : { model: preferred }),
              ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
            });
          } catch (cause) {
            // The successor below is tried instead, and says what failed if it fails too. A session Pi had already
            // moved when it failed is not answered on again, whatever comes of the successor.
            if (cause instanceof ModelSwitchUnsureError) existing.unsure = true;
            return false;
          } finally {
            setup.removeEventListener("abort", retire);
            if (retired) void disposeSession(existing.sessionId).catch(() => undefined);
          }
          record.runs = preferred;
          for (const dataClass of wanted.allowed) record.ceiling.add(dataClass);
          if (turns.get(conversationId) === existing) {
            generationModels.set(conversationId, modelKey(preferred));
            generationThinking.set(conversationId, thinking ?? "");
          }
          return true;
        })().finally(unmark);
        const moved = await move;
        if (setup.aborted) throw new SetupStopped("stopped while switching model");
        // Idle eviction may have let this turn go while Pi checked the new model's account.
        if (turns.get(conversationId) !== existing) return await turnFor(conversationId, principal, setup);
        if (moved) return existing;
      }
      let successor: WorkerSessionHandle;
      const next = briefFor(preferred);
      try {
        ({ successor } = await adapter.handoff(existing.sessionId, next.brief));
      } catch (cause) {
        /*
         * Nothing on the turn has changed yet, so the previous session is intact. It is not used in place of the model
         * the person chose, though: answering on another model without saying so would misreport who answered. The
         * person hears what failed, that nothing was lost, and what to do next.
         */
        if (setup.aborted) throw new SetupStopped("stopped while switching model", { cause });
        const reason = redactLocalPaths(cause instanceof Error ? cause.message : String(cause));
        throw new Error(switchFailed(preferredModel, reason), { cause });
      }
      // Stopped, or out of time, while the successor was being created: nobody will prompt it.
      if (setup.aborted) {
        void disposeSession(successor.sessionId).catch(() => undefined);
        throw new SetupStopped("stopped while switching model");
      }
      /*
       * Idle eviction may have let this turn go while the successor was being created. Then the successor belongs to
       * nothing that a Stop, a steer or shutdown could reach: it goes now, and the conversation starts a session the way
       * any evicted one does.
       */
      if (turns.get(conversationId) !== existing) {
        void disposeSession(successor.sessionId).catch(() => undefined);
        return await turnFor(conversationId, principal, setup);
      }
      adopt(successor.sessionId, next.withheld);
      turn.registeredTools = registeredTools;
      turn.rebuild = rebuild;
      generationModels.set(conversationId, modelKey(preferred));
      generationThinking.set(conversationId, chosenThinking() ?? "");
      return turn;
    }

    turn.registeredTools = registeredTools;
    turn.rebuild = rebuild;
    evictIdleTurns(Date.now());
    let handle: WorkerSessionHandle;
    const first = briefFor(chosen);
    try {
      handle = await adapter.createWorkerSession(first.brief);
    } catch (cause) {
      // Worded like a failed switch: what failed, in the person's language and without this machine's paths, and that
      // the message is kept.
      if (setup.aborted) throw new SetupStopped("stopped while creating the session", { cause });
      const reason = redactLocalPaths(cause instanceof Error ? cause.message : String(cause));
      throw new Error(startFailed(preferredModel ?? describe(), reason), { cause });
    }
    if (setup.aborted) {
      void disposeSession(handle.sessionId).catch(() => undefined);
      throw new SetupStopped("stopped while creating the session");
    }

    turn.sessionId = handle.sessionId;
    turn.withheld = first.withheld;
    turn.unsubscribe = listen(turn, handle.sessionId);
    generationModels.set(conversationId, preferredModel ?? "");
    generationThinking.set(conversationId, chosenThinking() ?? "");

    turns.set(conversationId, turn);
    return turn;
  }

  /**
   * Adds a sentence to a running turn of the same origin, answering whether it was added (see `steer`).
   *
   * Only into a run that is going: the sentence waits for the preparation, and is refused if the turn was stopped
   * meanwhile or its run has already settled. A steer on its way is recorded on the turn, so the turn does not end until
   * it has landed and been answered.
   */
  async function steerInto(turn: Turn, text: string, origin: TurnOrigin | undefined): Promise<boolean> {
    if (!turn.inFlight || turn.sessionId === "") return false;
    if ((origin ?? "person") !== (turn.origin ?? "person")) return false;
    await turn.preparing;
    if (!turn.inFlight || turn.stopped || !turn.streaming) return false;
    // A spoken turn is answered as speech: typed words never join it, they wait for a turn of their own. Read after the
    // preparation, which is when the turn's channel is set.
    if (turn.channel === "voice") return false;
    // A sentence the running model may not receive does not join its run: it becomes a turn of its own, which refuses it
    // with the reason rather than sending it. `turn.allowed` is the ceiling this turn's preparation read for the model it
    // runs, and it still holds: a session's model cannot change mid-turn, only at the next turn boundary.
    const model = runningModel(turn.conversationId);
    if (!enforceSendBoundary({ path: "steer", model, allowed: turn.allowed, texts: [text] }).ok) return false;
    // Recorded in the same tick as the check above, so the turn's last look for queued steers cannot miss it.
    const sending = adapter.steer(turn.sessionId, text);
    turn.steersPending.add(sending);
    try {
      await sending;
    } finally {
      turn.steersPending.delete(sending);
    }
    return true;
  }

  /**
   * Each conversation's stop scope: aborted by `interrupt`, which an emergency stop calls for every running
   * conversation, and replaced by a new one. A message records the scope when it arrives; one whose scope was aborted
   * while it waited was sent before the Stop, and never starts its turn.
   */
  const stops = new Map<string, AbortController>();
  /** How many messages of each conversation are in a turn, waiting included; the scope goes when none is. */
  const stopHolders = new Map<string, number>();
  /** Set by `dispose`: from then on every message is stopped before it starts. */
  let shuttingDown = false;
  const holdStopScope = (conversationId: string): (() => void) => {
    stopHolders.set(conversationId, (stopHolders.get(conversationId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (stopHolders.get(conversationId) ?? 1) - 1;
      if (left > 0) {
        stopHolders.set(conversationId, left);
        return;
      }
      stopHolders.delete(conversationId);
      stops.delete(conversationId);
    };
  };
  const stopScope = (conversationId: string): AbortSignal => {
    if (shuttingDown) return AbortSignal.abort();
    let scope = stops.get(conversationId);
    if (scope === undefined) {
      scope = new AbortController();
      stops.set(conversationId, scope);
    }
    return scope.signal;
  };

  /**
   * Setups under way: a turn being claimed, which may wait on a handoff or on a session being created. Running as far as
   * a Stop or an emergency stop is concerned, so either reaches it: the setup is aborted, and the session it was making
   * is let go once the adapter hands it over.
   */
  const setups = new Map<string, { controller: AbortController; startedAtMs: number }>();

  type Claim =
    | { kind: "claimed"; turn: Turn; prepared: () => void; endRun: () => void }
    | { kind: "running"; turn: Turn }
    | { kind: "stopped" };

  /**
   * One preparation at a time per conversation, ending with the turn claimed.
   *
   * Preparing can wait on a handoff, and a second message in that wait would otherwise start a second handoff from the
   * same session and dispose the first one's successor while it streams. A caller that finds a preparation pending
   * waits for it and decides again. The claim is made before the next caller may look, so it either claims an idle
   * turn or finds it running — never both callers claiming it.
   *
   * The wait and the setup both end on a Stop (`stop`, or the setup's own abort), and the setup on its time limit: a
   * provider that never finishes creating a session cannot hold the conversation, or the messages queued behind it.
   */
  const preparing = new Map<string, Promise<unknown>>();
  async function claimTurn(
    conversationId: string,
    principal: Principal,
    origin: TurnOrigin | undefined,
    stop: AbortSignal,
  ): Promise<Claim> {
    for (let pending = preparing.get(conversationId); pending !== undefined; pending = preparing.get(conversationId)) {
      const settled = pending.then(
        () => "ready" as const,
        () => "ready" as const,
      );
      if ((await Promise.race([settled, untilAborted(stop, settled)])) === "stopped") return { kind: "stopped" };
    }
    if (stop.aborted) return { kind: "stopped" };

    const controller = new AbortController();
    setups.set(conversationId, { controller, startedAtMs: Date.now() });
    const work = (async (): Promise<Claim> => {
      const turn = await turnFor(conversationId, principal, controller.signal);
      // Ended while the session was being found: nothing is claimed, so nothing is left looking busy.
      if (controller.signal.aborted) return { kind: "stopped" };
      if (turn.inFlight) return { kind: "running", turn };
      // Running from here: a Stop reaches it, and a message steered meanwhile waits for `preparing` and then joins the
      // session that is actually prompted. The origin is the claim's, so a message arriving next is compared with it.
      turn.inFlight = true;
      turn.origin = origin;
      let endRun: () => void = () => undefined;
      turn.ended = new Promise<void>((resolve) => {
        let done = false;
        // Once per claim, whichever path ends the run first; a second call is a no-op rather than ending a later run.
        endRun = () => {
          if (done) return;
          done = true;
          turn.inFlight = false;
          turn.streaming = false;
          resolve();
        };
      });
      turn.endRun = endRun;
      let prepared: () => void = () => undefined;
      turn.preparing = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      return { kind: "claimed", turn, prepared, endRun };
    })();
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    // Out of time is an abort too, so a setup finishing in the same moment lets its session go rather than claiming a
    // turn nobody will run; the flag tells the caller which of the two it was.
    let timedOut = false;
    // No limit set means no deadline on the setup either; Stop still ends it.
    const limitMs = turnLimitMs();
    const timer =
      limitMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, limitMs);
    const outcome = Promise.race([work, untilAborted(controller.signal, settled)]);
    preparing.set(conversationId, outcome);
    try {
      const result = await outcome;
      if (timedOut && limitMs !== undefined && result === "stopped") throw new Error(setupTimedOut(limitMs));
      return result === "stopped" ? { kind: "stopped" } : result;
    } catch (cause) {
      if (cause instanceof SetupStopped) {
        if (timedOut && limitMs !== undefined) throw new Error(setupTimedOut(limitMs), { cause });
        return { kind: "stopped" };
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      if (setups.get(conversationId)?.controller === controller) setups.delete(conversationId);
      if (preparing.get(conversationId) === outcome) preparing.delete(conversationId);
    }
  }

  /** One message's turn; see `answer`, which holds the conversation's stop scope around it. */
  const answerHeld = async (input: ModelTurnInput): Promise<ModelTurnReply> => {
    if (!availability.available) {
      throw new Error(
        `this node is configured for ${describe()} but that model is not reachable: ${availability.reason ?? "no reason given"}`,
      );
    }

    const startedAt = Date.now();
    // Read when asked rather than here: the claim below may hand this conversation to a new generation.
    const runsOn = (): ModelSelection => runningModel(input.conversationId);
    /*
     * Running from the claim, before anything is read for the prompt.
     *
     * Reading the recap, the memory and the tool plan can take a selector call each when an operator opted in, and a
     * message or a Stop arriving meanwhile must see a turn in flight: a second message is steered rather than started
     * alongside, and a Stop is honoured — the prompt below is then never sent.
     */
    // The Stop scope this message arrived under: a Stop from here on means it never starts.
    const stop = stopScope(input.conversationId);
    const stoppedBeforeStart = (): ModelTurnReply => ({
      text: "",
      segments: [],
      provider: runsOn().provider,
      model: runsOn().id,
      elapsedMs: Date.now() - startedAt,
      stopped: true,
      // Never started, so the card must not say the model wrote anything.
      stoppedDetail: notStarted(),
    });
    /*
     * Only bare words can join a running turn. A message with guidance (an approval's continuation, an answered
     * question), data, attachments or references is read for a prompt of its own, and a steer would carry its words
     * without them; a spoken one is answered as speech, not folded into a typed reply.
     */
    const steerable =
      (input.note ?? "") === "" && (input.data ?? "") === "" && input.attached !== true && input.channel !== "voice";
    let claimed = await claimTurn(input.conversationId, input.principal, input.origin, stop);
    /*
     * A turn is already running. A second prompt on a session that is answering is refused by Pi, and it would make
     * two replies out of one conversation, so bare words of the same origin join the running turn the way a steer
     * does. Anything else waits for the running turn to end and then becomes a turn of its own — unless a Stop comes
     * first.
     */
    while (claimed.kind !== "claimed") {
      if (claimed.kind === "stopped") return stoppedBeforeStart();
      const running = claimed.turn;
      if (steerable && (await steerInto(running, input.text, input.origin))) {
        return {
          text: "",
          segments: [],
          provider: runsOn().provider,
          model: runsOn().id,
          elapsedMs: Date.now() - startedAt,
          steered: true,
        };
      }
      const ended = running.ended.then(() => "ended" as const);
      if ((await Promise.race([ended, untilAborted(stop, ended)])) === "stopped") return stoppedBeforeStart();
      claimed = await claimTurn(input.conversationId, input.principal, input.origin, stop);
    }
    const turn = claimed.turn;
    const preparedResolve = claimed.prepared;
    const endRun = claimed.endRun;
    // Whatever ends this run below — a reply, a failure, a Stop, or a throw nobody planned for — ends it here too, so
    // the conversation never keeps a turn that nothing is running.
    let timer: NodeJS.Timeout | undefined;
    try {
      turn.startedAtMs = startedAt;
      // Cleared before the prompt rather than after, so a turn that throws still leaves the
      // buffer empty for the next one instead of prepending the previous reply to it.
      turn.pending.length = 0;
      turn.reasoning.length = 0;
      turn.segments.length = 0;
      turn.providerError = undefined;
      turn.messageId = input.messageId;
      turn.userMessageId = input.userMessageId;
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
      // At the turn boundary, before anything is read: a rebuilt session is fresh, so the recap below briefs it. Any
      // failure of the policy is reuse, which is what the session would have done without it. The claim never hands
      // over a running turn, so the policy always sees one that is not.
      const policy = await applySessionPolicy(turn, input.text, false).catch(() => undefined);
      // Once, on the first turn this session answers: the second turn already has the first in its context,
      // and repeating the brief each time would push the conversation out with its own summary. Cleared only once the
      // prompt that carries it is sent, so a preparation that fails leaves the recap for the next turn.
      const fresh = turn.fresh;
      // What the model this conversation runs may be sent (#433), read now: the recap and the memory brief withhold
      // anything of another class before a selector or the provider sees it. The model the claim left the conversation
      // on — after any handoff, rebuild or fallback — which is the one the prompt goes to.
      const ceiling = ceilingOf(runsOn());
      const allowed = ceiling.allowed;
      turn.allowed = allowed;
      // Read again each turn, so a ceiling widened since the session was made counts towards what the session holds.
      for (const dataClass of allowed) turn.withheld.ceiling.add(dataClass);

      let recap: { text: string; earlier: string };
      let memoryPart: string;
      let referencePart: string;
      let attachmentPart: string;
      try {
        // Read once, before the prompt, from the message the conductor has already stored — this turn's own message by
        // its id, never the newest one: a turn that waited may start after a later message was stored.
        attachmentPart =
          options.attachments === undefined
            ? ""
            : attachmentBrief({
                refs: options.attachments.refsFor(input.conversationId, input.userMessageId),
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
            : options.references.briefFor(
                input.conversationId,
                (name, revision) => adapter.skillBody(name, revision),
                input.userMessageId,
              ),
          discloseTools(turn, input.conversationId, input.text),
        ]);
      } catch (cause) {
        // Nothing was sent: the turn was never running as far as anyone else is concerned.
        endRun();
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
        const metrics = turnMetrics({ adapter, sessionId, elapsedMs, model: runsOn().id });
        turn.lastUsedAtMs = Date.now();
        turn.unsubscribe();
        void (turn.stopping ?? Promise.resolve()).then(() => disposeSession(sessionId)).catch(() => undefined);
        return {
          text: "",
          segments: [],
          provider: runsOn().provider,
          model: runsOn().id,
          elapsedMs,
          metrics,
          stopped: true,
          // The prompt was never sent.
          stoppedDetail: notStarted(),
        };
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
      // What the session had been told before this prompt was put together, so a prompt that is not sent leaves the
      // session's record as it was: nothing in it reached the model.
      const statedBefore = [...turn.stated];
      const seenBefore = [...turn.uiSeen];
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

      /*
       * The send boundary, on everything this prompt carries: the person's words, the host's guidance with the recap,
       * the attachments, memory, references and project instructions, the data and the screen. Narrowing withheld what it
       * could above; what is left is checked against the model the prompt goes to, and a prompt it may not receive is not
       * sent. The person's choice of model is not changed and no other model is tried for it here: a fallback is for a
       * model that refused, and one that would answer only after a send is not a reason to send.
       */
      // The person's own instructions go in the session's system prompt, so they are part of this send too.
      const personalRead = personalFor(runsOn(), allowed);
      const personal = personalRead.text;
      // Left out of this send for its class: the person hears it once in this session, by name and class only.
      if (personalRead.withheld !== undefined) {
        recordWithheld(turn.withheld, { name: PERSONAL_INSTRUCTIONS, dataClass: personalRead.withheld });
      }
      const boundary = enforceSendBoundary({
        path: "turn",
        model: runsOn(),
        allowed,
        texts: [input.text, note, brief, data, ui, personal],
      });
      if (!boundary.ok) {
        turn.stated.clear();
        for (const id of statedBefore) turn.stated.add(id);
        turn.uiSeen = new Map(seenBefore);
        throw dataClassUnavailable({
          dataClass: boundary.dataClass,
          model: modelName(runsOn()),
          message: dataClassUnavailableText(language(), {
            dataClass: boundary.dataClass,
            model: modelName(runsOn()),
            subject: "message",
            ...(ceiling.read ? {} : { unread: true }),
          }),
        });
      }


      // The adapter stops a turn that overruns its brief, but this is the layer holding an open
      // HTTP request, so it does not delegate the guarantee: without a deadline here a provider
      // that never settles would hold the request until the client gives up, and the user would
      // see a hung page rather than a limit being reached.
      // Read when the turn starts, so a limit set in Settings applies to the next message. No limit, no deadline.
      const limitMs = turnLimitMs();
      const deadline = new Promise<never>((_, reject) => {
        if (limitMs === undefined) return;
        timer = setTimeout(() => {
          // The build is told as well as the adapter: a composition in flight would otherwise
          // finish its own work after the turn it belongs to has already been stopped.
          turn.abort.abort();
          void adapter.abort(turn.sessionId, `turn exceeded ${limitMs} ms`);
          reject(
            new Error(
              turnFailed(
                describe(input.conversationId),
                language() === "vi"
                  ? `chưa xong sau ${readableLimit(limitMs, "vi")} nên lượt này đã được dừng`
                  : `it did not finish within ${readableLimit(limitMs, "en")}, so the turn was stopped`,
              ),
            ),
          );
        }, limitMs);
      });

      // Marked only when the prompt that carries it is sent: a stopped turn leaves it for the next one.
      if (statesNonce && !turn.stopped) turn.nonceStated = true;
      if (fresh && !turn.stopped) turn.fresh = false;
      // The session this turn prompts, held so that whatever ends the turn lets go of this one and never another.
      const promptedSession = turn.sessionId;
      // What this run's system prompt is given of the person's instructions: the value checked above, for this session.
      pinPersonal(promptedSession, personal);
      const promptText = promptForTurn({
        text: input.text,
        ...(note === undefined ? {} : { note }),
        ...(brief === "" ? {} : { brief }),
        ...(data === "" ? {} : { data }),
        ...(ui === "" ? {} : { ui }),
      });
      /*
       * The run, and then whatever Pi still holds from a steer. Pi's loop reads its steering queue between model calls,
       * so a sentence that lands after its last read is queued and answered by nobody; the turn waits for every steer on
       * its way, runs the session again on what is queued, and stops taking steers in the same tick it last finds the
       * queue empty, so none can land in between.
       */
      /*
       * A drain that fails never costs the reply that already finished: the answer is kept, and the session the drain
       * failed on is let go below, as a failed run's is. A late sentence steered through the conductor (the streaming,
       * voice and waiting paths) was stored as a message of its own, so the next turn's fresh session hears it in the
       * recap. One steered on the plain HTTP route was never stored, so it goes with the session and nothing answers
       * it; the person has to send it again.
       */
      let replied = false;
      let drainFailed = false;
      const runAndDrain = async (): Promise<void> => {
        await adapter.prompt(promptedSession, promptText);
        replied = true;
        try {
          for (;;) {
            while (turn.steersPending.size > 0) await Promise.allSettled([...turn.steersPending]);
            if (turn.stopped || !adapter.hasQueuedMessages(promptedSession)) break;
            await adapter.continueQueued(promptedSession);
          }
        } catch {
          drainFailed = true;
        } finally {
          // In the same tick as the last look at the queue, so no steer lands between it and the end of the run.
          turn.streaming = false;
        }
      };
      // A Stop that arrived while the prompt was being prepared means the prompt is never sent.
      if (!turn.stopped) turn.streaming = true;
      const prompted = turn.stopped ? Promise.resolve() : runAndDrain();
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
        // Out of time while draining: the reply had finished, so it is kept, the same as a drain that failed.
        if (!turn.stopped && replied) drainFailed = true;
        else if (!turn.stopped) {
          // Only this turn's entry: a stop may already have handed the conversation to the next message's session.
          if (turns.get(input.conversationId) === turn) turns.delete(input.conversationId);
          turn.unsubscribe();
          void disposeSession(promptedSession).catch(() => undefined);
          // The provider said why before the run failed: a refusal, which a fallback may answer.
          if (turn.providerError !== undefined) {
            const reason = redactSecrets(redactLocalPaths(turn.providerError));
            const model = describe(input.conversationId);
            throw new ProviderRefusal(turnFailed(model, reason), model, reason);
          }
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
        endRun();
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
        const metrics = turnMetrics({ adapter, sessionId: promptedSession, elapsedMs, model: runsOn().id });
        turn.unsubscribe();
        void (turn.stopping ?? Promise.resolve()).then(() => disposeSession(promptedSession)).catch(() => undefined);
        // Stopped with nothing said yet is still an answer: the person asked for the stop, so it is not a failure.
        return { text, segments, provider: runsOn().provider, model: runsOn().id, elapsedMs, metrics, stopped: true };
      }

      if (drainFailed) {
        // The session a drain failed on is not prompted again; the next message opens a fresh one, briefed with the recap.
        if (turns.get(input.conversationId) === turn) turns.delete(input.conversationId);
        turn.unsubscribe();
        void adapter
          .abort(promptedSession, "the run on a late message failed")
          .catch(() => undefined)
          .then(() => disposeSession(promptedSession))
          .catch(() => undefined);
      }

      if (segments.length === 0) {
        // A settled run that produced nothing at all is not a reply. Saying so is better than
        // appending an empty message that reads as the assistant having nothing to say.
        // The provider's own refusal when there is one — the reason a person can act on — else that nothing came back.
        if (turn.providerError !== undefined) {
          turn.refused = true;
          const reason = redactSecrets(redactLocalPaths(turn.providerError));
          const model = describe(input.conversationId);
          throw new ProviderRefusal(turnFailed(model, reason), model, reason);
        }
        throw new Error(
          turnFailed(
            describe(input.conversationId),
            language() === "vi"
              ? `model kết thúc lượt mà không viết gì sau ${elapsedMs} ms`
              : `the model ended its turn without writing anything after ${elapsedMs} ms`,
          ),
        );
      }

      // What this session's model was not given for its data class and the person has not yet been told, said once on
      // this reply by name and class, in their language.
      const withheld = takeWithheld(turn.withheld);
      // A reply that is only a view is a reply. Refusing it would make the one thing this node
      // was just taught to do look like a failure.
      return {
        text,
        segments,
        provider: runsOn().provider,
        model: runsOn().id,
        elapsedMs,
        metrics: turnMetrics({ adapter, sessionId: turn.sessionId, elapsedMs, model: runsOn().id }),
        ...(withheld.length === 0
          ? {}
          : { withheldNote: withheldContextText(language(), { model: modelName(runsOn()), items: withheld }) }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      endRun();
      preparedResolve();
      turn.settleStop = undefined;
      turn.onEvent = undefined;
    }
  };

  return {
    selection,
    budget,
    viewCatalogSize: () => readViews().length,
    catalogue: (): Promise<ModelCatalogue> => adapter.catalogue(),
    providerAuth: providerAuthPort(adapter),
    extensions: (): Promise<readonly PiExtension[]> => adapter.extensions(),
    piSettings: (): Promise<readonly PiSetting[]> => adapter.piSettings(),
    skills: (): Promise<readonly PiSkill[]> => adapter.skills(),
    skillBody: (name: string, revision: string): Promise<PiSkillBody> => adapter.skillBody(name, revision),

    /** The conversations a Stop can reach: answering, or still being set up. */
    running: (): string[] => [
      ...new Set([
        ...[...turns.values()].filter((turn) => turn.inFlight).map((turn) => turn.conversationId),
        ...setups.keys(),
      ]),
    ],

    /** The conversations whose turn is answering; a setup alone is not one. */
    answering: (): string[] => [...turns.values()].filter((turn) => turn.inFlight).map((turn) => turn.conversationId),

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
      // Every message waiting for this conversation was sent before the Stop: none of them starts its turn.
      stops.get(conversationId)?.abort();
      stops.delete(conversationId);
      // A setup still finding or creating the session ends here, and lets that session go when it arrives.
      const setup = setups.get(conversationId);
      setup?.controller.abort();
      const turn = turns.get(conversationId);
      if (turn === undefined || !turn.inFlight) return setup !== undefined;
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
      return turn === undefined ? false : await steerInto(turn, text, origin);
    },

    runningMs: (conversationId: string): number | undefined => {
      const turn = turns.get(conversationId);
      if (turn?.inFlight === true && turn.startedAtMs !== undefined) return Date.now() - turn.startedAtMs;
      const setup = setups.get(conversationId);
      return setup === undefined ? undefined : Date.now() - setup.startedAtMs;
    },

    workerModel: async (
      work?: { dataClass?: DataClass },
    ): Promise<ModelSelection & { via: "routed" | "configured"; fallback?: BackgroundFallback }> => {
      const { routed, fallback } = await routeBackground(work ?? {});
      const current = options.model?.() ?? selection;
      const classes = work?.dataClass === undefined ? [] : [work.dataClass];
      /*
       * The routed model, else the configured one — each only if it may receive what the task carries. A route that
       * failed, or found nothing, is an availability fallback; it never widens what a model may be sent, so the
       * configured model passes the same check or the task does not start on it.
       */
      let blocked: DataClass | undefined;
      // Whether every refusal came from a ceiling that could not be read, which is then what the refusal says.
      let unread = true;
      for (const candidate of backgroundCandidates(routed, current)) {
        const ceiling = ceilingOf(candidate);
        const check = enforceSendBoundary({ path: "worker-route", model: candidate, allowed: ceiling.allowed, classes });
        if (!check.ok) {
          blocked ??= check.dataClass;
          unread &&= !ceiling.read;
          continue;
        }
        if (routed !== undefined && candidate === routed) return { provider: routed.provider, id: routed.id, via: "routed" };
        // A routed model refused by the check is the reason routing would have given had it known.
        const reason: BackgroundFallback | undefined =
          fallback ?? (blocked === undefined ? undefined : { reason: "data-class", dataClass: blocked });
        return { ...current, via: "configured", ...(reason === undefined ? {} : { fallback: reason }) };
      }
      const dataClass = blocked ?? "secret";
      throw dataClassUnavailable({
        dataClass,
        model: modelName(current),
        unread,
        // Said as what was found: a ceiling that could not be read is not a ceiling that refused.
        message: unread
          ? `the task carries ${dataClass} data, and what the models this node could start the worker on may receive could not be read, so nothing was sent`
          : `no model this node could start the worker on may receive ${dataClass} data (${modelName(current)} may not), so nothing was sent`,
      });
    },

    configuredModel: (): ModelSelection => {
      const { provider, id } = options.model?.() ?? selection;
      const thinkingLevel = chosenThinking() ?? selection.thinkingLevel;
      return thinkingLevel === undefined ? { provider, id } : { provider, id, thinkingLevel };
    },

    turnLimitMs,

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
      // A route that fails is a run on the configured model, the same as one that found nothing eligible — if that model
      // may receive what the run sends.
      const { routed } = await routeBackground({ dataClass });
      const configured = options.model?.() ?? selection;
      /*
       * The routed model, else the configured one, each with the retrieved context narrowed to what it may receive and
       * then checked on everything the run sends it: the request, the caller's data and the list of what was retrieved.
       * Narrowing keeps most runs under the ceiling; the check is what holds when the request itself is above it. No
       * eligible model is a run that does not start, never one on a model that may not receive it.
       */
      let prepared:
        | {
            runsOn: ModelSelection;
            allowed: readonly DataClass[];
            reader: ContextReader | undefined;
            retrieved: string;
            personal: string | undefined;
          }
        | undefined;
      let blocked: { dataClass: DataClass; model: ModelSelection } | undefined;
      // Whether every refusal came from a ceiling that could not be read, which is then what the refusal says: one
      // candidate whose ceiling was read and refused is a ceiling that refused.
      let unread = true;
      for (const candidate of backgroundCandidates(routed, configured)) {
        const { allowed, read } = ceilingOf(candidate);
        const narrowed = context?.readerFor(allowed);
        const reader = narrowed === undefined || narrowed.items === 0 ? undefined : narrowed;
        // The list of what was retrieved goes with the data, after the caller's own: material, not a goal. An item is read
        // in full only when the run asks for it.
        const listed = reader?.answer({});
        const retrieved = listed?.kind === "done" ? listed.text : "";
        // The person's own instructions reach a background session's system prompt as they do a conversation's.
        const personal = personalFor(candidate, allowed).text;
        const check = enforceSendBoundary({
          path: "background",
          model: candidate,
          allowed,
          texts: [input.text, input.data, retrieved, personal],
        });
        if (check.ok) {
          prepared = { runsOn: candidate, allowed, reader, retrieved, personal };
          break;
        }
        blocked ??= { dataClass: check.dataClass, model: candidate };
        unread &&= !read;
      }
      if (prepared === undefined) {
        const blockedClass = blocked?.dataClass ?? "secret";
        const model = modelName(blocked?.model ?? configured);
        throw dataClassUnavailable({
          dataClass: blockedClass,
          model,
          unread,
          message: dataClassUnavailableText(language(), {
            dataClass: blockedClass,
            model,
            subject: "background",
            // A ceiling that could not be read is said as that, never as a ceiling the model has.
            ...(unread ? { unread: true } : {}),
          }),
        });
      }
      const { runsOn, allowed, reader, retrieved, personal } = prepared;
      const handle = await adapter.createWorkerSession({
        goal: input.text.slice(0, 2000),
        // No folders and no capabilities: starting a worker is not a way to acquire either, and the request that
        // needs them goes through the same approval path as any other. The one tool it may get reads what the host
        // retrieved from this conversation for this request, and nothing else.
        projectRoots: [],
        allowedCapabilityRefs: [],
        ...(reader === undefined ? {} : { customTools: [readContextTool(reader)] }),
        // Whatever a tool hands back reaches this model only if it may receive it, a picture included.
        toolResultGuard: toolResultGuardFor({ model: () => runsOn, allowed: () => allowed }),
        // And what the SDK loads from the machine into its prompt, held to the same model's ceiling.
        contextGuard: contextGuardFor({ model: runsOn, allowed }),
        // Routed only for background work. Foreground honours the person's choice, and nobody is watching this run —
        // which is exactly why the model for it is a decision rather than a setting. Named even when nothing was routed,
        // so the model that runs is the one whose data classes narrowed what it reads, not the adapter's boot default.
        model: runsOn,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      });
      backgroundSessions.set(workId, handle.sessionId);
      pinPersonal(handle.sessionId, personal);
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
        const data = [input.data ?? "", retrieved].map((part) => part.trim()).filter((part) => part !== "").join("\n\n");
        await adapter.prompt(handle.sessionId, promptForTurn({ text: input.text, ...(data === "" ? {} : { data }) }));
        // A prompt that settles quietly after an abort is still a stopped run, not a result to report.
        signal?.throwIfAborted();
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        backgroundSessions.delete(workId);
        // Disposed whatever happened: a worker nobody will ask again is a provider connection held open for nothing.
        void disposeSession(handle.sessionId).catch(() => undefined);
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
        void disposeSession(sessionId).catch(() => undefined);
      }
      return started.length;
    },

    async answer(input: ModelTurnInput): Promise<ModelTurnReply> {
      // The conversation's stop scope is held while this message is anywhere in its turn, waiting included, and let go
      // once nothing holds it: an idle conversation keeps no scope.
      const release = holdStopScope(input.conversationId);
      try {
        const tried: { model: string; reason: string }[] = [];
        for (;;) {
          let reply: ModelTurnReply;
          try {
            reply = await answerHeld(input);
          } catch (cause) {
            /*
             * The fallback this refusal moved to may not receive what the message carries: the send boundary holds on a
             * fallback as on the chosen model, so nothing went to it. The person hears both — why the chosen model did
             * not answer, and why the fallback was not sent the message — under the same not-sent outcome.
             */
            if (isDataClassUnavailable(cause) && tried.length > 0) {
              throw dataClassUnavailable({
                dataClass: cause.dataClass,
                model: cause.model,
                message: `${refusedBefore(tried)} ${cause.contract.message}`,
              });
            }
            if (!(cause instanceof ProviderRefusal)) throw cause;
            tried.push({ model: cause.model, reason: cause.reason });
            refusals.set(cause.model, { reason: cause.reason, untilMs: Date.now() + REFUSAL_COOLDOWN_MS });
            fallbackChain = await readFallbackChain();
            const next = chosenModel() ?? selection;
            // Nothing left that has not refused, or as many models as one message may cost: the person hears all of it.
            if (refusalOf(next) !== undefined || tried.length >= MAX_MODELS_PER_MESSAGE) {
              throw tried.length === 1 ? cause : new Error(noModelAnswered(tried), { cause });
            }
            process.stderr.write(
              `${JSON.stringify({ event: "model-fallback", from: cause.model, to: modelKey(next) })}\n`,
            );
            continue;
          }
          // Answered on another model while the chosen one is paused: said on the reply, never left to be guessed.
          const preferred = options.model?.() ?? selection;
          const refusal = refusalOf(preferred);
          if (refusal !== undefined && `${reply.provider}/${reply.model}` !== modelKey(preferred) && reply.steered !== true) {
            return { ...reply, fallback: { from: modelKey(preferred), reason: refusal.reason } };
          }
          return reply;
        }
      } finally {
        release();
      }
    },

    /*
     * Every session this process holds, foreground and background.
     *
     * A running turn is aborted before its session is disposed, so a provider stream in flight is cancelled rather
     * than left writing into a session that no longer exists; the background workers go the same way, because a
     * shutdown that disposed only the conversations would leave the workers nobody is awaiting.
     */
    async dispose(): Promise<void> {
      // Every message still waiting is stopped before it starts, and none that arrives now starts: nothing begins
      // during shutdown.
      shuttingDown = true;
      for (const scope of stops.values()) scope.abort();
      stops.clear();
      // A setup still under way lets its session go when the adapter hands it over, rather than adopting it.
      for (const setup of setups.values()) setup.controller.abort();
      for (const turn of turns.values()) {
        turn.unsubscribe();
        if (turn.inFlight) turn.abort.abort();
        await disposeSession(turn.sessionId).catch(() => undefined);
      }
      turns.clear();
      for (const [workId, sessionId] of [...backgroundSessions.entries()]) {
        backgroundSessions.delete(workId);
        await adapter.abort(sessionId, "node đang tắt").catch(() => undefined);
        await disposeSession(sessionId).catch(() => undefined);
      }
    },
  };
}
