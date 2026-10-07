import {
  type ActionProposal,
  type AppIntentDecision,
  type AppIntentLocale,
  type AttachmentRef,
  type CapabilityRef,
  type ConversationId,
  type HostWrittenMessage,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type MessageSurface,
  type Principal,
  type ReferenceBlock,
  type TaskRecord,
  type TurnOrigin,
  type WidgetDefinition,
  type WidgetPerformRequest,
  ContractViolation,
  MODEL_NOTE_VERSION,
  assertBlockProvenance,
  attachmentRefSchema,
  isTerminal,
  messageBlockSchema,
  nowInstant,
  referenceBlockSchema,
} from "@clarkcant/contracts";

import {
  type Database,
  appendMessage,
  getTask,
  nextMessageSequence,
  touchConversation,
} from "@clarkcant/storage";

import { type CapabilitySummary, type RegistryDeps, listCapabilitySummaries } from "./capability-registry.ts";
import type { ChannelTurnAuthority } from "./channel-authority.ts";
import { conductorText } from "./conductor-text.ts";
import { settleReconciledTask } from "./effect-reconciliation.ts";
import type { TaskSettleReason } from "./task-settle-reason.ts";
import {
  type TaskServiceDeps,
  advanceResolving,
  applyTaskEvent,
  checkSuccessPreconditions,
  createTask,
  recordEvidence,
} from "./task-service.ts";
import { type WidgetDeps, captureSnapshot, createInstance } from "./widget-service.ts";

/**
 * The conductor.
 *
 * It turns a user utterance into either an answered message or a durable task, and it is
 * the only place that decides which. Three constraints shape it:
 *
 * 1. **It cannot approve its own effects, and it cannot declare success.** Approval needs a
 *    user principal and success needs verified evidence with no unsettled effect. Both
 *    checks live below this layer, which is why the conductor is allowed to be
 *    straightforward rather than defensive.
 * 2. **It does not invent a capability.** If a request needs something the registry does
 *    not have, the answer is to park the task and propose an install, never to guess.
 * 3. **A scripted sample is labelled as a sample.** The blueprint is explicit that a demo
 *    must not be dressed up as inference over the user's real data, so the sample path
 *    emits a host-owned card saying so.
 */

export interface SampleRecipe {
  id: string;
  matches: (text: string) => boolean;
  /**
   * A recipe that matches anything, kept for a node with no model.
   *
   * A catch-all exists so an empty install still answers something useful instead of
   * refusing. That is only the right behaviour when there is nothing better to answer with:
   * once a model is configured, a recipe matching everything would swallow every message and
   * the model would never be consulted. Marking it lets the conductor drop it in that case
   * rather than relying on recipe ordering to be lucky.
   */
  catchAll?: boolean;
  /**
   * `locale` is the language the person reads the interface in: a recipe's titles, labels and sentence are shown to
   * them, so they are written in it.
   */
  build: (context: { nodeId: string; principalId: string; locale: AppIntentLocale }) => {
    definition: WidgetDefinition;
    packageDigest: string;
    props: Record<string, unknown>;
    /** Plain-language answer shown alongside the widget. */
    text: string;
    /** Optional view-only actions. A recipe may not bind a capability it does not own. */
    actions?: { label: string; proposal: ActionProposal }[];
  };
}

export interface ConductorDeps extends TaskServiceDeps, WidgetDeps, RegistryDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** Scripted paths that need no provider account. Empty means model-only. */
  sampleRecipes: readonly SampleRecipe[];
  /**
   * The interface language of the person a turn answers, for the words the host writes into it itself.
   *
   * Read once per turn and handed to every host-written block and recipe that turn produces, so one reply never mixes
   * languages. Absent means Vietnamese, the preference's own default.
   */
  locale?: (principalId: string) => AppIntentLocale;
  /**
   * Optional worker bridge. Absent means an install is proposed instead of a run.
   *
   * Called once, immediately after `dispatch.acknowledged`, and deliberately not awaited by the
   * conductor: the message announcing the dispatch has already been appended, and this call is the
   * host's own background work, reported back into the conversation whenever it settles. The
   * capability and node are passed explicitly rather than re-read from the registry, because the
   * choice was already made by `chooseExecutionNode` and re-reading it here could disagree with what
   * the conversation was just told.
   */
  runTask?: (input: { taskId: string; capabilityRef: string; executionNodeId: string }) => void;
  /**
   * Answers a turn with a model, when this node has one.
   *
   * Absent means the node has no model, and the conductor then says so rather than inventing
   * an answer. It is consulted only after a scripted recipe has declined and no installed
   * capability can do the work, so a model never displaces something that could have done it
   * for real.
   */
  respondWithModel?: (input: ModelTurnInput) => Promise<ModelTurnReply>;
  /**
   * A deterministic composer the host may provide.
   *
   * Consulted before the scripted recipes and before the model. It exists because a composed surface
   * can only be produced by a turn, and a node with no provider still has to be able to show one —
   * for the browser suite, and for any host that wants a direct "show me the overview" affordance
   * without a model call. It returns a block or nothing: nothing means "not my message", and the
   * ordinary path continues exactly as it did.
   */
  composeFromIntent?: (input: {
    conversationId: ConversationId;
    principal: Principal;
    text: string;
    messageId: string;
    at: Instant;
    /**
     * See `UserMessageInput.emit`, carried through unchanged.
     *
     * A composed surface is not a model turn, so most of this is never called for one — but a fixture
     * standing in for the agent may still call a real tool that reports through it (`control_app` is
     * the case this exists for), and that call has to reach the same place a model turn's tool call
     * would: the host stream, or the voice session, watching this conversation.
     */
    emit?: (event: ConductorEmit) => void;
    /** See `UserMessageInput.channel`, carried through unchanged. */
    channel?: "voice" | "chat";
    /** See `UserMessageInput.origin`, carried through unchanged: a fixture's real tool hands it to the policy too. */
    origin?: TurnOrigin;
    /** See `UserMessageInput.note`, carried through unchanged: a fixture standing in for the model reads it too. */
    note?: string;
    /** See `UserMessageInput.data`, carried through unchanged for the same reason. */
    data?: string;
    /** The turn's interface language (`ConductorDeps.locale`), for the words a composed surface shows the person. */
    locale: AppIntentLocale;
  }) => Promise<{ block: MessageBlock; text: string } | undefined>;
  /**
   * Choose between several usable capabilities, when there is a real choice.
   *
   * A hook rather than an import because deciding is the runtime's business and this layer must not
   * depend on a selector, a provider or a configuration file. It is consulted only when more than one
   * capability is usable, and it may only name one of the candidates it was given: a decider that
   * returns an unknown id is ignored in favour of the deterministic order. Lease and dispatch
   * semantics are untouched — whatever is chosen here goes through the same authorization path.
   */
  chooseExecutionNode?: (input: {
    intent: string;
    candidates: readonly { capabilityRef: string; executionNodeId: string; effectCategory: string }[];
  }) => Promise<{ capabilityRef: string; executionNodeId: string } | undefined>;
  /**
   * Told when a card a host tool built during a model turn fails its own contract and is left out of the reply.
   *
   * That is a node bug, not something the person did or can fix, so it is reported to whoever runs the node instead
   * of being drawn: the reply keeps the model's words, and the person is not shown schema internals. The diagnostic
   * names where the card failed and never carries a value from it.
   */
  reportRejectedHostCard?: (diagnostic: RejectedHostCardDiagnostic) => void;
}

/**
 * Why a host card was left out of a reply, without anything it held.
 *
 * Paths and zod issue codes are the node's own field names; an unrecognised key is named, because "the card carries a
 * key its contract does not declare" is the usual cause and the key is what to fix. Values never appear.
 */
export interface RejectedHostCardDiagnostic {
  conversationId: ConversationId;
  messageId: string;
  /** The card's `type` when it is a plain short name, otherwise `"unknown"`. */
  blockType: string;
  issues: { path: string; code: string; keys?: string[] }[];
  /** How many issues there were, when there were more than `issues` lists. */
  issueCount: number;
}

/** The parts of a zod issue a diagnostic reads; the message is left out because it can quote a value. */
interface ZodIssueLike {
  code: string;
  path: readonly PropertyKey[];
  keys?: readonly string[];
}

const DIAGNOSTIC_MAX_ISSUES = 10;
const DIAGNOSTIC_MAX_KEYS = 10;
const DIAGNOSTIC_NAME_MAX = 120;

/** A field name fit for a log line: bounded, and only printable characters. */
function diagnosticName(value: string): string {
  const printable = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : char;
  }).join("");
  return printable.length <= DIAGNOSTIC_NAME_MAX ? printable : `${printable.slice(0, DIAGNOSTIC_NAME_MAX)}…`;
}

export function rejectedHostCardDiagnostic(
  context: { conversationId: ConversationId; messageId: string },
  block: Record<string, unknown>,
  issues: readonly ZodIssueLike[],
): RejectedHostCardDiagnostic {
  const type = block["type"];
  return {
    conversationId: context.conversationId,
    messageId: context.messageId,
    blockType: typeof type === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(type) ? type : "unknown",
    issues: issues.slice(0, DIAGNOSTIC_MAX_ISSUES).map((issue) => ({
      path: diagnosticName(issue.path.map((segment) => (typeof segment === "symbol" ? "?" : String(segment))).join(".")),
      code: diagnosticName(issue.code),
      ...(issue.keys === undefined ? {} : { keys: issue.keys.slice(0, DIAGNOSTIC_MAX_KEYS).map(diagnosticName) }),
    })),
    issueCount: issues.length,
  };
}

/** What a model turn is asked to answer. */
export interface ModelTurnInput {
  conversationId: ConversationId;
  principal: Principal;
  text: string;
  /**
   * The identifier the reply's message will be stored under.
   *
   * Allocated before the turn rather than after it, because a view the model asks for is captured
   * as a snapshot, and a snapshot records which message it belongs to. Capturing against a
   * placeholder and rewriting it afterwards would leave a window where the snapshot points at a
   * message that does not exist.
   */
  messageId: string;
  /**
   * The identifier the message being answered was stored under.
   *
   * What the turn reads its attachments and references from. A turn may wait for another to finish, and by the time it
   * starts a later message can be the newest one in the conversation; reading by this id keeps each turn on its own
   * message. Optional for callers that answer without a stored message.
   */
  userMessageId?: string;
  /**
   * Guidance for this turn, appended to the prompt by whoever runs it.
   *
   * Carried through rather than interpreted here: the conductor decides what is asked and the runner decides
   * how the model is addressed, and a mode enum would have to be taught to both.
   */
  note?: string;
  /** See `UserMessageInput.data`, which this carries through unchanged. */
  data?: string;
  /**
   * Everything the turn does while it runs: text, reasoning, and tool calls.
   *
   * Separate from `ModelTurnReply` rather than a replacement for it. The reply is what the message is
   * built from, and these are the events on the way there: a provider that emits nothing still produces
   * a reply, and a caller that ignores this still gets one.
   */
  onEvent?: (event: ModelTurnEvent) => void;
  /** See `UserMessageInput.channel`, which this carries through unchanged. */
  channel?: "voice" | "chat";
  /** See `UserMessageInput.origin`, which this carries through unchanged. */
  origin?: TurnOrigin;
  /** See `UserMessageInput.channelAuthority`, which this carries through unchanged. */
  channelAuthority?: ChannelTurnAuthority;
  /**
   * The message carries attachments or references. Its turn reads them for its own prompt, so it is never joined to a
   * turn that is already running: it waits for that turn to end and is answered with what it carries.
   */
  attached?: true;
}

/**
 * One piece of a model reply, in the order the model produced it.
 *
 * The order is the point. Concatenating the text and appending the cards afterwards would put
 * every card below the whole reply, which is not what the model said — it said a sentence, asked
 * for a view, then said another sentence. A list of segments is that order today and the streaming
 * order later, so the shape does not have to change when replies stream.
 */
export type ModelSegment =
  | { kind: "text"; text: string }
  | { kind: "block"; block: MessageBlock }
  /**
   * A block the **host** built during the turn, not the model.
   *
   * An approval card is the case this exists for: the model may ask for an operation, and only the host
   * may put the card that asks the user about it into the transcript. `block` travels through the
   * provenance screen unexamined because the screen's rule is "a model turn may not mint a host card" and
   * this segment is by construction not model output — it is produced by a tool the host registered, and
   * the model has no vocabulary for segments at all. The kind is validated by the schema where it is
   * built, so a malformed one is dropped rather than drawn.
   */
  | { kind: "host-card"; block: Record<string, unknown> };

/** What a model turn produced.
 *
 * The provider and model are reported back rather than assumed, because the card that records
 * the turn has to name what actually answered. A node whose configuration changed between
 * startup and this turn would otherwise label the reply with the wrong model.
 */
export interface ModelTurnReply {
  /** The reply's prose, for callers that only want the words. Derived from `segments`. */
  text: string;
  /** Everything the reply produced, in order. This is what becomes the message. */
  segments: ModelSegment[];
  provider: string;
  model: string;
  elapsedMs: number;
  /** What the provider reported about the turn, when it reported anything. */
  metrics?: TurnMetrics;
  /**
   * Present when a person stopped the turn. The segments are what it had said by then, possibly nothing, and the
   * record says it was stopped on request rather than that it finished or failed.
   */
  stopped?: true;
  /**
   * With `stopped`: the sentence the stopped card says in place of its default, in the person's language. Given when
   * the turn never started — a message that waited behind another and was stopped first — so the card does not say the
   * model wrote anything.
   */
  stoppedDetail?: string;
  /**
   * Present when the message was added to a turn that was already running rather than answered on its own. The running
   * turn's reply answers it, so this one carries nothing and no message is written for it.
   */
  steered?: true;
  /**
   * Present when the model the person chose refused this turn (or did moments ago) and another one answered it. The
   * reply's own `provider`/`model` name the one that answered; this names the choice and why it did not, so the card
   * can say so instead of the person discovering it.
   */
  fallback?: { from: string; reason: string };
  /**
   * Present when something the answering model's session would have been given — a context file, a `SYSTEM.md`, a
   * skill, the person's own instructions — was left out for its data class: one sentence, in the person's language,
   * naming each by file name and class only. Said once per session, on the first reply after it was left out.
   */
  withheldNote?: string;
}

/**
 * What a turn cost, as far as the provider is willing to say.
 *
 * Every field is optional and stays absent when it was not reported. A missing cache hit rate is not zero
 * percent: it is "the provider said nothing about a cache", and a statusline that prints 0% for it is wrong
 * with confidence, which is worse than being quiet.
 */
export interface TurnMetrics {
  /** The reasoning effort the turn ran at, when the session has one. */
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** What the session has cost so far, in US dollars. */
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** Output tokens a second, over this turn's own wall clock. */
  tokensPerSecond?: number;
  /** The folder the agent worked in. */
  cwd?: string;
}

/**
 * A model turn that failed.
 *
 * Returned rather than thrown, because a provider being down is an outcome the conversation
 * has to be able to show. A thrown error would leave the user with a message they sent and no
 * record of why nothing came back.
 */
export interface ModelTurnFailure {
  error: string;
  provider: string;
  model: string;
}

export interface UserMessageInput {
  conversationId: ConversationId;
  principal: Principal;
  text: string;
  at?: Instant;
  /**
   * Called as the answer is produced, for a caller holding an open stream.
   *
   * Absent for every other caller, and nothing about the turn changes when it is absent: a turn that
   * streams produces exactly the same message as one that does not. What arrives here is text as the
   * model emits it, before it is stored, which is why it is reported rather than kept — the durable
   * message is still the one appended below, built from the same segments.
   */
  emit?: (event: ConductorEmit) => void;
  /**
   * Extra guidance for this turn, appended to the prompt.
   *
   * It exists because a turn that will be read aloud has to be shorter than one that will be read, and only
   * the caller knows which it is. Nothing else about the turn changes - the same model, the same tools, the
   * same stored message - so this is a sentence of guidance rather than a mode.
   *
   * Host-authored only. Words that came from anywhere else — a widget's view of itself, a value on the screen — go in
   * `data`, never here: the runner frames this as guidance for the turn.
   */
  note?: string;
  /**
   * Material the host read for this turn, handed to the model as data rather than as guidance.
   *
   * The runner places it after everything the person said and labels it as data, the same way the screen's context is
   * placed; it is never folded into `note`. Its text may have been written by an isolated widget, so it is the caller's
   * job to have made it inert (see `renderActionContext`), and the model's to read it as a quotation, not an order.
   */
  data?: string;
  /**
   * Which surface this message came in on: the composer, or a spoken sentence the deterministic
   * matcher and the widget resolver both passed on.
   *
   * Defaults to `"chat"`. Carried through to `control_app`'s own audit record via `extraTools`'
   * `channel` getter, so a tool call the voice agent made is distinguishable from one the same
   * conductor answered for the text composer — the two are the same tools and the same executor, and
   * this is the one fact about the request that is not otherwise recoverable from a turn already in
   * flight.
   */
  channel?: "voice" | "chat";
  /**
   * The person's own surface this message was typed or said on, stored on the message (`MessageRecord.surface`). Set
   * only by the composer's route and the voice path; every other caller leaves it out, so its message never counts as
   * the person's own words.
   */
  surface?: MessageSurface;
  /**
   * Who asked for this turn (`TurnOrigin`), decided by the caller from the code path that accepted the message — the
   * gateway's surface mark, the voice path, an automation, a peer — and never from a body. Stored on the message and
   * carried to the model turn's tools, which hand it to the execution policy. Absent is read as the person.
   */
  origin?: TurnOrigin;
  /**
   * Set when the host writes this message itself so a turn can run — the continuation after an approved command —
   * rather than relaying something anyone said. Stored on the message (`MessageRecord.hostWritten`) so the transcript
   * never shows the text as the person's words; the turn itself runs exactly as it would without it.
   */
  hostWritten?: HostWrittenMessage;
  /**
   * Who wrote this message when it was not the owner here: the principal an external channel's sender maps to
   * (`MessageRecord.authorPrincipalId`). Set only by the host's channel intake.
   */
  authorPrincipalId?: string;
  /** The message in this conversation this one answers (`MessageRecord.inReplyToMessageId`). Set only by the host. */
  inReplyToMessageId?: string;
  /**
   * For a turn an external channel started: the sender's standing and what the binding grants (`ChannelTurnAuthority`).
   * Set only by the host's channel intake and the continuation after an owner approved a participant's call. A
   * participant's message is always answered by the model turn, which enforces the standing: it never reaches an
   * installed task runner or a host composer, which would act as the owner.
   */
  channelAuthority?: ChannelTurnAuthority;
  /**
   * Told the stored user message as soon as it is appended, before the turn runs: for a caller that links it to
   * something outside — a channel's provider message — so the link exists even when the turn fails or is stopped.
   */
  onAccepted?: (message: MessageRecord) => void;
  /**
   * Files this message carries.
   *
   * The refs arrive already authorised — the gateway resolves each id against the conversation and the
   * principal before the turn is asked for — and they are stored on the message rather than passed
   * alongside the turn. That is the whole point: the timeline and the prompt then read the same rows, so
   * a reloaded conversation shows the attachment and a model turn over it sees the same files. Passed
   * separately, the two could disagree the moment either one changed.
   */
  attachmentRefs?: readonly AttachmentRef[];
  /**
   * What this message points at: skills, projects, files and the rest (#210).
   *
   * Already checked by the gateway at send time, and stored on the message for the reason attachments are: the
   * timeline and the prompt then read the same row.
   */
  referenceBlocks?: readonly ReferenceBlock[];
  /**
   * Whether this message is the onboarding demo asking for a scripted sample.
   *
   * The samples are labelled and useful, and they are also fake data. A message in a real conversation that merely
   * sounded like a request for a chart was answered with a sample chart and no model at all: the person could not
   * tell it apart from a real answer until they read the small print, and the agent's own follow-up work was
   * replaced by a fixture. So the demo path has to say that it is the demo path, and nothing else gets samples.
   */
  demo?: boolean;
}

/**
 * One thing that happened while a turn was still running.
 *
 * The same union is what the conductor forwards to a streaming caller, because there is nothing to
 * translate: a caller watching a turn sees exactly the events the turn produced, in order.
 */
export type ModelTurnEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-start";
      toolCallId: string;
      name: string;
      label: string;
      args: Record<string, unknown>;
    }
  | { type: "tool-end"; toolCallId: string; status: "done" | "failed"; result: string }
  /**
   * An app-control action the agent asked the host to carry out, delivered as an ephemeral event
   * rather than stored in a message block: replaying the transcript must not repeat the side effect,
   * so this travels only to a foreground stream that is watching the turn as it runs.
   */
  | { type: "host-control"; decision: AppIntentDecision }
  /**
   * An action an isolated widget offers, which Clark asked its frame to perform after the node's gate, input check and
   * policy said yes. Ephemeral for the same reason: only the page showing the widget now can hand it to the frame, and a
   * replayed transcript must not perform it again.
   */
  | { type: "widget-perform"; request: WidgetPerformRequest };

/** What the conductor reports to a caller that is watching. */
export type ConductorEmit = ModelTurnEvent;

export interface ConductorOutcome {
  /** Messages the host appended, in timeline order. */
  messages: MessageRecord[];
  /** Set when a durable task was created rather than answered immediately. */
  taskId: string | undefined;
  /** How the utterance was resolved, for tests and for the UI's honest labelling. */
  resolution: "sample" | "model" | "model-failed" | "steered" | "task-dispatched" | "task-parked" | "clarification";
}

/** Append an assistant message and return the stored record. */
function appendAssistant(
  deps: ConductorDeps,
  conversationId: ConversationId,
  blocks: MessageBlock[],
  options: { taskId?: string; at: Instant; messageId?: string },
): MessageRecord {
  const message: MessageRecord = {
    messageId: (options.messageId ?? deps.newId("msg")) as MessageRecord["messageId"],
    conversationId,
    role: "assistant",
    blocks,
    authorNodeId: deps.nodeId as MessageRecord["authorNodeId"],
    ...(options.taskId === undefined ? {} : { taskId: options.taskId as MessageRecord["taskId"] }),
    createdAt: options.at,
    delivery: "accepted",
  };
  appendMessage(deps.db, message, nextMessageSequence(deps.db, conversationId));
  touchConversation(deps.db, conversationId, options.at);
  return message;
}

/**
 * Pick the capability that will handle this message.
 *
 * One usable capability needs no decision. Several do, and the decider is asked — but only for a
 * capability it was actually offered, because anything else would be a way to dispatch to something
 * the registry never listed.
 */
async function chooseExecutionNode(
  deps: ConductorDeps,
  intent: string,
  usable: readonly CapabilitySummary[],
): Promise<CapabilitySummary | undefined> {
  const first = usable[0];
  if (first === undefined || usable.length === 1) return first;

  const decide = deps.chooseExecutionNode;
  if (decide === undefined) return first;

  const candidates = usable.map((summary) => ({
    capabilityRef: summary.ref,
    executionNodeId: summary.executionNodeId,
    effectCategory: summary.effectCategory,
  }));
  const chosen = await decide({ intent, candidates });
  if (chosen === undefined) return first;
  // Both halves have to match. The same capability can be registered on two nodes, and naming only
  // the capability would leave the choice ambiguous — which is the case this hook exists for.
  return (
    usable.find(
      (summary) => summary.ref === chosen.capabilityRef && summary.executionNodeId === chosen.executionNodeId,
    ) ?? first
  );
}

function appendUser(
  deps: ConductorDeps,
  conversationId: ConversationId,
  text: string,
  at: Instant,
  extraBlocks: readonly MessageBlock[] = [],
  surface?: MessageSurface,
  origin?: TurnOrigin,
  hostWritten?: HostWrittenMessage,
  authorship: { authorPrincipalId?: string; inReplyToMessageId?: string } = {},
): MessageRecord {
  const message: MessageRecord = {
    messageId: deps.newId("msg") as MessageRecord["messageId"],
    conversationId,
    role: "user",
    // Markdown, because the transcript renders both sides the same way and a message typed into a
    // field is markdown anyway: `breaks` keeps its real newlines, and its punctuation formats. Blocks
    // stored before this was changed carry `plain` and keep rendering as pre-wrapped text.
    //
    // Attachments follow the text in the same message rather than becoming messages of their own: one
    // thing a person sent is one turn, and two rows would make the model answer the file instead of the
    // request.
    blocks: [
      { type: "text", format: "markdown", content: text, streaming: false },
      ...extraBlocks,
    ],
    authorNodeId: deps.nodeId as MessageRecord["authorNodeId"],
    createdAt: at,
    delivery: "accepted",
    ...(surface === undefined ? {} : { surface }),
    ...(origin === undefined ? {} : { origin }),
    ...(hostWritten === undefined ? {} : { hostWritten }),
    ...(authorship.authorPrincipalId === undefined ? {} : { authorPrincipalId: authorship.authorPrincipalId }),
    ...(authorship.inReplyToMessageId === undefined ? {} : { inReplyToMessageId: authorship.inReplyToMessageId }),
  };
  appendMessage(deps.db, message, nextMessageSequence(deps.db, conversationId));
  return message;
}

/**
 * The blocks an authorised set of refs becomes.
 *
 * Each ref is re-validated against the schema rather than trusted because it came from this process:
 * the ref is read back from a row that a client's ids selected, and a row is storage, which is not a
 * type. A ref that does not validate is dropped instead of stored, because an attachment block that
 * cannot be rendered is a gap in the timeline that no later phase can repair.
 */
function attachmentBlocks(refs: readonly AttachmentRef[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const ref of refs) {
    const parsed = attachmentRefSchema.safeParse(ref);
    if (parsed.success) blocks.push({ type: "attachment", attachment: parsed.data });
  }
  return blocks;
}

/** The reference blocks a message stores, re-validated for the reason attachment refs are. */
function referenceBlocks(blocks: readonly ReferenceBlock[]): MessageBlock[] {
  return blocks.flatMap((block) => {
    const parsed = referenceBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Record a finished voice session, without answering it.
 *
 * This is deliberately not `handleUserMessage`. That path runs a model turn, which is right for
 * something the user just typed and wrong for something already said: the session has ended, the
 * model already replied out loud, and re-asking would produce a second answer nobody heard while
 * charging the operator for it. So this appends what was said and stops.
 *
 * Both halves are appended here rather than by two callers, so the order is decided in one place.
 * They are two rows and not one transaction, which is worth knowing: a crash between them leaves
 * a recorded question with no recorded answer.
 *
 * Empty sides are skipped rather than stored as empty messages, because a session of silence is
 * not a conversation and a blank message in the timeline reads as a bug.
 */
export function recordVoiceTranscript(
  deps: ConductorDeps,
  input: {
    conversationId: ConversationId;
    userText: string;
    assistantText: string;
    at: Instant;
  },
): MessageRecord[] {
  const recorded: MessageRecord[] = [];

  if (input.userText.trim() !== "") {
    // Said aloud in a voice session: the person's own words, on their own surface.
    recorded.push(appendUser(deps, input.conversationId, input.userText, input.at, [], "voice", "person"));
  }

  if (input.assistantText.trim() !== "") {
    recorded.push(
      appendAssistant(
        deps,
        input.conversationId,
        [{ type: "text", format: "plain", content: input.assistantText, streaming: false }],
        { at: input.at },
      ),
    );
  }

  return recorded;
}

/**
 * Handle one user utterance.
 *
 * The order of resolution is deliberate: a scripted sample first, then the registry. A
 * sample never shadows a real capability the user has installed — that would be the demo
 * pretending to be the product — so samples are only consulted when the registry cannot
 * satisfy the request at all.
 */
export async function handleUserMessage(
  deps: ConductorDeps,
  input: UserMessageInput,
): Promise<ConductorOutcome> {
  const at = input.at ?? nowInstant();
  const locale = deps.locale?.(input.principal.principalId) ?? "vi";
  const say = conductorText(locale);
  const userMessage = appendUser(
    deps,
    input.conversationId,
    input.text,
    at,
    [...attachmentBlocks(input.attachmentRefs ?? []), ...referenceBlocks(input.referenceBlocks ?? [])],
    input.surface,
    input.origin,
    input.hostWritten,
    {
      ...(input.authorPrincipalId === undefined ? {} : { authorPrincipalId: input.authorPrincipalId }),
      ...(input.inReplyToMessageId === undefined ? {} : { inReplyToMessageId: input.inReplyToMessageId }),
    },
  );
  input.onAccepted?.(userMessage);


  // A host composer gets the first look, and only when one is configured. In production there is
  // none, so nothing about the ordering below changes.
  const participant = input.channelAuthority?.standing === "participant";
  if (deps.composeFromIntent !== undefined && !participant) {
    // The id is allocated once and used for the message that is appended. Allocating a second one
    // inside `appendAssistant` would leave the snapshot the composer captured — which records the
    // message it belongs to — pointing at a message id nothing ever stores, and history would then
    // silently drop every composed surface.
    const messageId = deps.newId("msg");
    const composed = await deps.composeFromIntent({
      conversationId: input.conversationId,
      principal: input.principal,
      text: input.text,
      messageId,
      at,
      ...(input.emit === undefined ? {} : { emit: input.emit }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.data === undefined ? {} : { data: input.data }),
      locale,
    });
    if (composed !== undefined) {
      // A reply that is only its sentence is said once: leading with the same text again would print it twice.
      const onlyText = composed.block.type === "text" && composed.block.content === composed.text;
      const message = appendAssistant(
        deps,
        input.conversationId,
        onlyText
          ? [composed.block]
          : [{ type: "text", format: "plain", content: composed.text, streaming: false }, composed.block],
        { at, messageId },
      );
      // No task: composing a view runs nothing, and claiming one would be a lie about what happened.
      return { messages: [message], taskId: undefined, resolution: "sample" };
    }
  }

  // A package service's capabilities are left to the model's tools: without this, installing one package with a service
  // would turn every message into a "task" handed to whichever of its capabilities sorted first.
  const usable = listCapabilitySummaries(deps, { usableOnly: true, taskRunnersOnly: true });
  const executionNode = participant ? undefined : await chooseExecutionNode(deps, input.text, usable);

  // A scripted recipe is only considered when nothing installed can answer, so an
  // installed integration is never shadowed by a demo.
  if (!executionNode) {
    // A catch-all recipe is dropped once a model is available. It matches every message, so
    // leaving it in would mean the model was never consulted at all — which is exactly what
    // happened before this was marked.
    const candidates = deps.sampleRecipes.filter(
      (candidate) => !(candidate.catchAll === true && deps.respondWithModel !== undefined),
    );
    // And no sample runs unless the message came from the demo path: a scripted reply is fake data, and a real
    // conversation must never be answered with it by accident.
    const recipe = input.demo === true ? candidates.find((candidate) => candidate.matches(input.text)) : undefined;
    if (recipe) {
      return runSampleRecipe(deps, { ...input, at }, recipe, locale);
    }
  }

  // The model answers the conversation itself. Reached only after a recipe has declined and
  // nothing installed can do the work, so the ordering is: real capability, then scripted
  // demo, then the model's own words.
  const answer = deps.respondWithModel;
  if (!executionNode && answer !== undefined) {
    return runModelTurn(deps, { ...input, at }, userMessage.messageId, answer, locale);
  }

  const task = createTask(deps, {
    conversationId: input.conversationId,
    goal: input.text,
    principal: input.principal,
    ...(input.origin === undefined
      ? {}
      : { origin: { kind: "interactive", principalId: input.principal.principalId, turnOrigin: input.origin } }),
  });

  // Resolution. A task with no eligible capability parks on a capability rather than
  // inventing one, which is what makes the install proposal honest.
  applyTaskEvent(deps, task.taskId, "resolve.start");

  if (!executionNode) {
    const parked = advanceResolving(deps, task.taskId, {
      kind: "needs-capability",
      capabilityRef: "project.code.change@1" as CapabilityRef,
    });
    const message = appendAssistant(
      deps,
      input.conversationId,
      [
        // Said in the person's terms: what is missing is a model to answer with, not an abstract "capability".
        { type: "text", format: "plain", content: say.noModel.text, streaming: false },
        {
          type: "system-card",
          owner: "host",
          cardId: deps.newId("card"),
          subject: "capability",
          title: say.noModel.title,
          status: "blocked",
          // Reached only with no model to fall back on, so the next step is the one that unblocks a conversation.
          detail: say.noModel.detail,
          fields: [
            { label: "Task", value: task.taskId },
            { label: "Node", value: deps.nodeId },
          ],
          cancellable: true,
          updatedAt: at,
        },
      ],
      { taskId: parked.ok ? parked.task.taskId : task.taskId, at },
    );
    return { messages: [message], taskId: task.taskId, resolution: "task-parked" };
  }

  // A capability is available: dispatch, and let the worker bridge take it from here.
  advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: executionNode.executionNodeId });
  applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");

  // Started, not awaited: the message below is what tells the conversation the task is running, and
  // the run itself reports its own outcome later. A host with no worker bridge leaves the task
  // sitting in `dispatched` — honest, because nothing here would otherwise move it further.
  deps.runTask?.({
    taskId: task.taskId,
    capabilityRef: executionNode.ref,
    executionNodeId: executionNode.executionNodeId,
  });

  const message = appendAssistant(
    deps,
    input.conversationId,
    [
      {
        type: "text",
        format: "plain",
        content: say.runningOn(executionNode.executionNodeId),
        streaming: false,
      },
    ],
    { taskId: task.taskId, at },
  );

  return { messages: [message], taskId: task.taskId, resolution: "task-dispatched" };
}

/**
 * Render a scripted sample.
 *
 * Every sample carries a host-owned card stating that it is sample data. That card is a
 * host-owned block type, so a pack or a model cannot forge one, and the labelling is not
 * something a recipe can opt out of.
 */
/**
 * Answer a turn with the configured model.
 *
 * This is the only path where the assistant's own words reach a conversation. It is entered
 * last, after a real capability has been ruled out and a scripted recipe has declined, so a
 * model never displaces something that could have done the work for real.
 *
 * The reply is appended as a new message rather than written into a placeholder that was
 * added when the turn started. Messages are append-only in storage, and the alternative would
 * mean putting a mutable row into a log that everything else is entitled to treat as final.
 * The cost is that the client learns about the reply by asking again, which is why the route
 * that starts a turn is described as accepted rather than complete.
 */
/**
 * The reported numbers, as fields, in the order a reader asks about them.
 *
 * Absent numbers produce no field at all rather than a field saying "không rõ": the card exists to say what
 * is known, and a row of unknowns would bury what is.
 */
function turnMetricFields(metrics: TurnMetrics | undefined, locale: AppIntentLocale): { label: string; value: string }[] {
  if (metrics === undefined) return [];
  const say = conductorText(locale).metrics;
  const fields: { label: string; value: string }[] = [];
  if (metrics.contextTokens !== undefined && metrics.contextWindow !== undefined && metrics.contextWindow > 0) {
    const share = Math.round((metrics.contextTokens / metrics.contextWindow) * 100);
    fields.push({
      label: say.contextLabel,
      value: `${formatTokens(metrics.contextTokens)} / ${formatTokens(metrics.contextWindow)} (${share}%)`,
    });
  }
  if (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined) {
    fields.push({
      label: say.tokensLabel,
      value: say.tokens(formatTokens(metrics.inputTokens ?? 0), formatTokens(metrics.outputTokens ?? 0)),
    });
  }
  const cacheRead = metrics.cacheReadTokens;
  const cacheWrite = metrics.cacheWriteTokens;
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    const reusable = (cacheRead ?? 0) + (metrics.inputTokens ?? 0);
    const rate = reusable === 0 ? undefined : Math.round(((cacheRead ?? 0) / reusable) * 100);
    fields.push({
      label: "Cache",
      value: say.cache(rate, formatTokens(cacheRead ?? 0), formatTokens(cacheWrite ?? 0)),
    });
  }
  if (metrics.tokensPerSecond !== undefined) {
    fields.push({ label: say.speedLabel, value: `${metrics.tokensPerSecond.toFixed(1)} tok/s` });
  }
  if (metrics.costUsd !== undefined) {
    fields.push({ label: say.costLabel, value: `$${metrics.costUsd.toFixed(4)}` });
  }
  if (metrics.cwd !== undefined) {
    fields.push({ label: say.cwdLabel, value: metrics.cwd });
  }
  return fields;
}

/** Tokens at a glance: nobody reads five digits when three will do. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

async function runModelTurn(
  deps: ConductorDeps,
  input: UserMessageInput & { at: Instant },
  userMessageId: string,
  answer: NonNullable<ConductorDeps["respondWithModel"]>,
  locale: AppIntentLocale,
): Promise<ConductorOutcome> {
  const say = conductorText(locale);
  let reply: Awaited<ReturnType<typeof answer>>;
  // Allocated here so a view captured during the turn can name the message it will live in.
  const messageId = deps.newId("msg");
  try {
    reply = await answer({
      conversationId: input.conversationId,
      principal: input.principal,
      text: input.text,
      messageId,
      userMessageId,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.data === undefined ? {} : { data: input.data }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.channelAuthority === undefined ? {} : { channelAuthority: input.channelAuthority }),
      ...((input.attachmentRefs?.length ?? 0) > 0 || (input.referenceBlocks?.length ?? 0) > 0 ? { attached: true as const } : {}),
      // Always supplied, and a no-op when nobody is streaming. A conditional spread here would have
      // to exist only to keep the optional field absent, which is a distinction nothing reads.
      onEvent: (event: ModelTurnEvent) => input.emit?.(event),
    });
  } catch (cause) {
    // A throw is turned into a message. The user has already been told their message was
    // accepted, so failing silently here would leave the conversation claiming something is
    // coming when nothing is.
    // A typed refusal keeps its code on the card and its own sentence as the detail (a message that was never sent to a
    // model because of its data class says so); anything else is a failed model turn.
    const typed = cause instanceof ContractViolation ? cause.contract : undefined;
    const message = appendAssistant(
      deps,
      input.conversationId,
      [
        {
          type: "system-card",
          owner: "host",
          cardId: deps.newId("card"),
          subject: "connection",
          title: say.modelFailed.title,
          status: "blocked",
          detail: typed?.message ?? (cause instanceof Error ? cause.message : String(cause)),
          fields: [{ label: say.modelFailed.kindLabel, value: typed?.code ?? "model-turn-failed" }],
          cancellable: false,
          updatedAt: input.at,
        },
      ],
      { at: input.at },
    );
    return { messages: [message], taskId: undefined, resolution: "model-failed" };
  }

  // Joined to the turn already running: that turn's reply is the answer, and an empty message here would read as the
  // assistant having nothing to say.
  if (reply.steered === true) return { messages: [], taskId: undefined, resolution: "steered" };

  const message = appendAssistant(
    deps,
    input.conversationId,
    [
      // The card that records what answered comes last, not first.
      //
      // It is bookkeeping: which model, how long it took. At the top of a reply it is the first thing
      // read and it is not the answer — the interface then leads with provenance and buries the text.
      // The renderer draws it as one muted line that expands (see `SystemCardBlock`).
      ...modelSegmentsToBlocks(reply, locale, (block, issues) => {
        // The report is a side channel: the card is dropped either way, and a reporter that throws must not
        // cost the person the reply it was reporting on.
        try {
          deps.reportRejectedHostCard?.(
            rejectedHostCardDiagnostic({ conversationId: input.conversationId, messageId }, block, issues),
          );
        } catch {
          // Nothing to fall back to: reporting is what failed.
        }
      }),
      modelReplyCard(deps, reply, input.at, locale),
    ],
    { at: input.at, messageId },
  );

  return { messages: [message], taskId: undefined, resolution: "model" };
}

/**
 * The card that records which model answered a turn, or that a person stopped it.
 *
 * Exported so every path that ends a model turn labels it the same way: a stopped reply reads as stopped wherever it
 * was produced, rather than as a finished answer on one path and a stopped one on another. Its words follow `locale`,
 * Vietnamese when none is named.
 */
export function modelReplyCard(
  deps: Pick<ConductorDeps, "newId">,
  reply: ModelTurnReply,
  at: Instant,
  locale: AppIntentLocale = "vi",
): MessageBlock {
  const fallback = reply.stopped === true ? undefined : reply.fallback;
  const say = conductorText(locale).reply;
  // One figure for the readable row and the typed note, so a reader can tell the row by its value.
  const elapsedMs = Math.max(0, Math.round(reply.elapsedMs));
  return {
    type: "system-card",
    owner: "host",
    cardId: deps.newId("card"),
    subject: "connection",
    // A stopped turn says so on the one line that is always visible, so the partial reply above it is not read
    // as the whole answer.
    title: reply.stopped === true ? say.stoppedTitle : fallback !== undefined ? say.fallbackTitle : say.answeredTitle,
    status: "done",
    detail:
      (reply.stopped === true
        ? (reply.stoppedDetail ?? say.stoppedDetail)
        : fallback !== undefined
          ? say.fallbackDetail(fallback.from, fallback.reason, `${reply.provider}/${reply.model}`)
          : say.answeredDetail) +
      // What the model was not given for its data class, said after what answered, on the same card.
      (reply.stopped !== true && reply.withheldNote !== undefined ? ` ${reply.withheldNote}` : ""),
    fields: [
      ...(reply.stopped === true ? [{ label: say.endedLabel, value: say.endedValue }] : []),
      ...(fallback === undefined ? [] : [{ label: say.chosenModelLabel, value: fallback.from }]),
      { label: "Provider", value: reply.provider },
      {
        label: "Model",
        // The effort belongs with the model, because it is part of which model answered: the same model
        // at a different effort is a different answer to the same question.
        value: reply.metrics?.thinkingLevel === undefined ? reply.model : `${reply.model} · ${reply.metrics.thinkingLevel}`,
      },
      { label: say.elapsedLabel, value: `${elapsedMs} ms` },
      ...turnMetricFields(reply.metrics, locale),
    ],
    // The typed copy, for the statusline: the rows above are written to be read, these to be drawn.
    ...(reply.metrics === undefined ? {} : { metrics: reply.metrics }),
    // The same for the note itself: the rows are in the person's language, so an interface reads these instead.
    modelNote: {
      version: MODEL_NOTE_VERSION,
      elapsedMs,
      ...(fallback === undefined ? {} : { fallback: { from: fallback.from } }),
    },
    cancellable: false,
    updatedAt: at,
  };
}

/**
 * Turn a model reply into message blocks, screening what the model is not allowed to claim.
 *
 * This is where the model path meets the trust boundary, so this is where the boundary is
 * enforced. A block that is host-owned cannot appear in a model turn: the node builds those from
 * its own state, and a model turn has no state to build one from. Any that arrive here anyway are
 * dropped and reported in the prose rather than drawn, because a card asserting something about
 * the node is exactly the shape an injected instruction would try to produce.
 *
 * The screen is deliberately `builtByHost: false`, not `true`. These blocks came from a model
 * turn, and marking them host-built because the node happened to assemble the array would make
 * the check agree with itself and prove nothing.
 */
function modelSegmentsToBlocks(
  reply: ModelTurnReply,
  locale: AppIntentLocale,
  onRejectedHostCard: (block: Record<string, unknown>, issues: readonly ZodIssueLike[]) => void,
): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  for (const segment of reply.segments) {
    if (segment.kind === "text") {
      if (segment.text.trim() === "") continue;
      // A settled turn is not a stream: `prompt()` resolves when the run finishes, so nothing
      // here is still arriving and claiming otherwise would make the UI wait for more.
      blocks.push({ type: "text", format: "markdown", content: segment.text, streaming: false });
      continue;
    }

    if (segment.kind === "host-card") {
      // Validated rather than trusted by type: the segment comes from a tool result, and a shape that
      // does not satisfy the schema is dropped instead of drawn. There is no provenance screen here
      // because the screen protects against model output, and this is not model output.
      const parsed = messageBlockSchema.safeParse(segment.block);
      if (parsed.success) blocks.push(parsed.data as MessageBlock);
      // A host card failing its own contract is a node bug: reported, not drawn and not silently lost.
      else onRejectedHostCard(segment.block, parsed.error.issues);
      continue;
    }

    const verdict = assertBlockProvenance(segment.block, { builtByHost: false });
    if (!verdict.ok) {
      // Said out loud rather than dropped in silence: a model that repeatedly asks for a card it
      // cannot have is a fact the user should be able to see.
      blocks.push({
        type: "text",
        format: "plain",
        content: conductorText(locale).rejectedBlock(verdict.message),
        streaming: false,
      });
      continue;
    }
    blocks.push(segment.block);
  }

  return blocks;
}

function runSampleRecipe(
  deps: ConductorDeps,
  input: UserMessageInput & { at: Instant },
  recipe: SampleRecipe,
  locale: AppIntentLocale,
): ConductorOutcome {
  const say = conductorText(locale).sample;
  const built = recipe.build({
    nodeId: deps.nodeId,
    principalId: input.principal.principalId,
    locale,
  });

  const instance = createInstance(deps, {
    definition: built.definition,
    packageDigest: built.packageDigest,
    ownerPrincipalId: input.principal.principalId,
    props: built.props,
    at: input.at,
  });

  const snapshot = captureSnapshot(deps, {
    messageId: deps.newId("msg"),
    instance,
    textAlternative: built.definition.textFallback,
    presentationRef: `${built.definition.id}@${built.definition.version}`,
  });

  const message = appendAssistant(
    deps,
    input.conversationId,
    [
      {
        type: "system-card",
        owner: "host",
        cardId: deps.newId("card"),
        subject: "onboarding",
        title: say.title,
        status: "done",
        detail: say.detail(recipe.id),
        fields: [
          { label: "Recipe", value: recipe.id },
          { label: say.sourceLabel, value: "sample", freshness: "sample" },
        ],
        cancellable: false,
        updatedAt: input.at,
      },
      { type: "text", format: "markdown", content: built.text, streaming: false },
      {
        type: "surface",
        definitionRef: { id: built.definition.id, version: built.definition.version },
        snapshot,
      },
      {
        type: "widget-ref",
        instanceId: instance.instanceId,
        displayMode: "inline",
        textAlternative: built.definition.textFallback,
      },
    ],
    { at: input.at },
  );

  return { messages: [message], taskId: undefined, resolution: "sample" };
}

/* ------------------------------------------------------------------ *
 * Task execution
 * ------------------------------------------------------------------ */

export interface RunTaskResult {
  taskId: string;
  /** Mirrors the contract's disposition, so the caller never invents a status. */
  outcome: "succeeded" | "failed" | "uncertain" | "cancelled";
  /** Evidence the run actually produced. A run with none cannot succeed. */
  evidenceKinds: string[];
  /**
   * The run's own words, or the host's when it had none to settle on. The host's are what a peer that handed the task
   * over is sent, in the one language each was always written in: English for the conductor's own sentences, Vietnamese
   * for a settlement on what the person recorded about its effects (`ReconciledSettlement.message`).
   */
  message: string;
  /** Present when `message` is the host's own words: the same thing as data, for the owner to be told in their language. */
  reason?: TaskSettleReason;
}

/** What a run reported about itself: the only evidence a dispatched task is settled on. */
export interface ReportedEvidence {
  kind: "exit-status" | "file-diff" | "api-receipt" | "read-after-write" | "test-output";
  summary: string;
  verified: boolean;
}

/**
 * Drive one dispatched task to a terminal state.
 *
 * `collectEvidence` is supplied by the caller and is the only source of evidence. The
 * conductor does not manufacture any: if the callback returns nothing, the task is
 * reported as failed with the reason "no evidence", not as succeeded because the worker
 * exited cleanly.
 */
export async function runDispatchedTask(
  deps: ConductorDeps,
  input: {
    taskId: string;
    collectEvidence: (task: TaskRecord) => Promise<ReportedEvidence | undefined>;
  },
): Promise<RunTaskResult> {
  const task = getTask(deps.db, input.taskId);
  if (!task) {
    return { taskId: input.taskId, outcome: "failed", evidenceKinds: [], message: "task does not exist", reason: { code: "task-missing" } };
  }
  const reported = await input.collectEvidence(task);
  return settleDispatchedTask(deps, task.taskId, reported);
}

/**
 * Settle a dispatched task on what its run reported, in one synchronous step.
 *
 * The task is read again here rather than trusted from before the run: a stop asked for while the run was working has
 * moved it to `cancel_requested`, and the report is then the executor's answer to that stop. A run that verified
 * nothing confirms the stop; a run that verified something finished anyway, and what it did is called unknown rather
 * than reported as a success or as stopped.
 *
 * The outcome returned is always the state the task is actually in: a transition the machine refuses is never
 * reported as if it had happened.
 */
export function settleDispatchedTask(deps: ConductorDeps, taskId: string, reported: ReportedEvidence | undefined): RunTaskResult {
  const task = getTask(deps.db, taskId);
  if (!task) {
    return { taskId, outcome: "failed", evidenceKinds: [], message: "task does not exist", reason: { code: "task-missing" } };
  }
  const evidenceKinds = reported === undefined ? [] : [reported.kind];
  const record = (): ReturnType<typeof recordEvidence> | undefined =>
    reported === undefined
      ? undefined
      : recordEvidence(deps, {
          taskId,
          evidence: { kind: reported.kind, summary: reported.summary, verdict: reported.verified ? "verified" : "not-verified" },
        });

  if (task.state === "cancel_requested") {
    const recorded = record();
    if (reported?.verified === true || recorded?.blocked !== undefined) {
      applyTaskEvent(deps, taskId, "effect.unknown");
      const done = reported === undefined ? "an effect it started is unsettled" : reported.summary;
      return settledAs(deps, taskId, evidenceKinds, `the run finished after it was asked to stop (${done}); what it did is not confirmed`, {
        code: "finished-after-stop",
        ...(reported === undefined ? {} : { runSummary: reported.summary }),
      });
    }
    applyTaskEvent(deps, taskId, "cancel.confirmed");
    return reported === undefined
      ? settledAs(deps, taskId, evidenceKinds, "stopped on request; the run reported nothing", { code: "stopped-unreported" })
      : settledAs(deps, taskId, evidenceKinds, reported.summary);
  }
  if (isTerminal(task.state)) {
    return settledAs(deps, taskId, evidenceKinds, "the task had already ended before its run reported", { code: "already-ended" });
  }
  if (task.state === "uncertain") {
    // An effect went unknown while the run kept going. The run's report is recorded either way; if the person has
    // already answered for every unknown effect by now, it is what settles the task, on their answer.
    const recorded = record();
    const settled = recorded?.blocked === undefined ? settleReconciledTask(deps, taskId) : undefined;
    if (settled !== undefined) return settledAs(deps, taskId, evidenceKinds, settled.message, settled.reason);
    return reported === undefined
      ? settledAs(deps, taskId, evidenceKinds, NO_EVIDENCE_MESSAGE, { code: "no-evidence" })
      : settledAs(deps, taskId, evidenceKinds, reported.summary);
  }

  if (!reported) {
    const failed = applyTaskEvent(deps, taskId, "run.verifying");
    if (failed.ok) applyTaskEvent(deps, taskId, "verify.failed");
    return settledAs(deps, taskId, [], NO_EVIDENCE_MESSAGE, { code: "no-evidence" });
  }

  const recorded = record();
  const verifying = task.state === "verifying" ? { ok: true } : applyTaskEvent(deps, taskId, "run.verifying");
  if (!verifying.ok) return settledAs(deps, taskId, evidenceKinds, reported.summary);

  // The ledger decides: an unsettled effect blocks success no matter how clean the run was.
  if (recorded?.blocked) {
    return {
      taskId,
      outcome: "uncertain",
      evidenceKinds,
      message: `effect ${recorded.blocked.effectId} is still ${recorded.blocked.state}; the outcome is undetermined and must be reconciled`,
      reason: { code: "effect-unsettled", effectId: recorded.blocked.effectId, state: recorded.blocked.state },
    };
  }

  const gate = checkSuccessPreconditions(deps, taskId, recorded === undefined ? [] : [recorded.evidence]);
  if (!gate.allowed) {
    applyTaskEvent(deps, taskId, "verify.failed");
    // What went wrong comes first: "nothing was verified" alone does not tell a person which step it was.
    return reported.verified
      ? settledAs(deps, taskId, evidenceKinds, gate.message, { code: "not-accepted", gate: gate.reason })
      : settledAs(deps, taskId, evidenceKinds, `${reported.summary} — ${gate.message}`, {
          code: "not-accepted",
          gate: gate.reason,
          runSummary: reported.summary,
        });
  }

  applyTaskEvent(deps, taskId, "verify.passed");
  return settledAs(deps, taskId, evidenceKinds, reported.summary);
}

/** The outcome a task's actual state stands for. Anything not ended is not known to have ended, so it is uncertain. */
function settledAs(
  deps: ConductorDeps,
  taskId: string,
  evidenceKinds: string[],
  message: string,
  reason?: TaskSettleReason,
): RunTaskResult {
  const state = getTask(deps.db, taskId)?.state;
  const outcome = state === "succeeded" || state === "failed" || state === "cancelled" ? state : "uncertain";
  return { taskId, outcome, evidenceKinds, message, ...(reason === undefined ? {} : { reason }) };
}

const NO_EVIDENCE_MESSAGE = "the run produced no evidence, so it is reported as failed rather than as success";
export { nowInstant };
