import {
  type ActionProposal,
  type AppIntentDecision,
  type AttachmentRef,
  type CapabilityRef,
  type ConversationId,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type Principal,
  type TaskRecord,
  type WidgetDefinition,
  assertBlockProvenance,
  attachmentRefSchema,
  messageBlockSchema,
  nowInstant,
} from "@clarkcant/contracts";

import {
  type Database,
  appendMessage,
  getTask,
  nextMessageSequence,
  touchConversation,
} from "@clarkcant/storage";

import { type CapabilitySummary, type RegistryDeps, listCapabilitySummaries } from "./capability-registry.ts";
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
  build: (context: { nodeId: string; principalId: string }) => {
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
   * Guidance for this turn, appended to the prompt by whoever runs it.
   *
   * Carried through rather than interpreted here: the conductor decides what is asked and the runner decides
   * how the model is addressed, and a mode enum would have to be taught to both.
   */
  note?: string;
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
   */
  note?: string;
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
  | { type: "host-control"; decision: AppIntentDecision };

/** What the conductor reports to a caller that is watching. */
export type ConductorEmit = ModelTurnEvent;

export interface ConductorOutcome {
  /** Messages the host appended, in timeline order. */
  messages: MessageRecord[];
  /** Set when a durable task was created rather than answered immediately. */
  taskId: string | undefined;
  /** How the utterance was resolved, for tests and for the UI's honest labelling. */
  resolution: "sample" | "model" | "model-failed" | "task-dispatched" | "task-parked" | "clarification";
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
    recorded.push(appendUser(deps, input.conversationId, input.userText, input.at));
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
  const userMessage = appendUser(
    deps,
    input.conversationId,
    input.text,
    at,
    attachmentBlocks(input.attachmentRefs ?? []),
  );
  void userMessage;

  // A host composer gets the first look, and only when one is configured. In production there is
  // none, so nothing about the ordering below changes.
  if (deps.composeFromIntent !== undefined) {
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
    });
    if (composed !== undefined) {
      const message = appendAssistant(
        deps,
        input.conversationId,
        [
          { type: "text", format: "plain", content: composed.text, streaming: false },
          composed.block,
        ],
        { at, messageId },
      );
      // No task: composing a view runs nothing, and claiming one would be a lie about what happened.
      return { messages: [message], taskId: undefined, resolution: "sample" };
    }
  }

  const usable = listCapabilitySummaries(deps, { usableOnly: true });
  const executionNode = await chooseExecutionNode(deps, input.text, usable);

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
      return runSampleRecipe(deps, { ...input, at }, recipe);
    }
  }

  // The model answers the conversation itself. Reached only after a recipe has declined and
  // nothing installed can do the work, so the ordering is: real capability, then scripted
  // demo, then the model's own words.
  const answer = deps.respondWithModel;
  if (!executionNode && answer !== undefined) {
    return runModelTurn(deps, { ...input, at }, answer);
  }

  const task = createTask(deps, {
    conversationId: input.conversationId,
    goal: input.text,
    principal: input.principal,
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
        { type: "text", format: "plain", content: "Để làm việc này tui cần thêm một capability chưa có trên máy này.", streaming: false },
        {
          type: "system-card",
          owner: "host",
          cardId: deps.newId("card"),
          subject: "capability",
          title: "Cần một capability chưa cài",
          status: "blocked",
          detail:
            "Chưa có capability nào đang dùng được trên node này, nên task đang chờ. Tui sẽ không tự chạy bằng một công cụ tui không có.",
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
        content: `Đang chạy trên ${executionNode.executionNodeId}.`,
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
function turnMetricFields(metrics: TurnMetrics | undefined): { label: string; value: string }[] {
  if (metrics === undefined) return [];
  const fields: { label: string; value: string }[] = [];
  if (metrics.contextTokens !== undefined && metrics.contextWindow !== undefined && metrics.contextWindow > 0) {
    const share = Math.round((metrics.contextTokens / metrics.contextWindow) * 100);
    fields.push({
      label: "Ngữ cảnh",
      value: `${formatTokens(metrics.contextTokens)} / ${formatTokens(metrics.contextWindow)} (${share}%)`,
    });
  }
  if (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined) {
    fields.push({
      label: "Token",
      value: `${formatTokens(metrics.inputTokens ?? 0)} vào · ${formatTokens(metrics.outputTokens ?? 0)} ra`,
    });
  }
  const cacheRead = metrics.cacheReadTokens;
  const cacheWrite = metrics.cacheWriteTokens;
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    const reusable = (cacheRead ?? 0) + (metrics.inputTokens ?? 0);
    const rate = reusable === 0 ? undefined : Math.round(((cacheRead ?? 0) / reusable) * 100);
    fields.push({
      label: "Cache",
      value:
        `${rate === undefined ? "chưa đo được" : `${rate}% đọc lại`}` +
        ` · ${formatTokens(cacheRead ?? 0)} đọc · ${formatTokens(cacheWrite ?? 0)} ghi`,
    });
  }
  if (metrics.tokensPerSecond !== undefined) {
    fields.push({ label: "Tốc độ", value: `${metrics.tokensPerSecond.toFixed(1)} tok/s` });
  }
  if (metrics.costUsd !== undefined) {
    fields.push({ label: "Chi phí", value: `$${metrics.costUsd.toFixed(4)}` });
  }
  if (metrics.cwd !== undefined) {
    fields.push({ label: "Thư mục làm việc", value: metrics.cwd });
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
  answer: NonNullable<ConductorDeps["respondWithModel"]>,
): Promise<ConductorOutcome> {
  let reply: Awaited<ReturnType<typeof answer>>;
  // Allocated here so a view captured during the turn can name the message it will live in.
  const messageId = deps.newId("msg");
  try {
    reply = await answer({
      conversationId: input.conversationId,
      principal: input.principal,
      text: input.text,
      messageId,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      // Always supplied, and a no-op when nobody is streaming. A conditional spread here would have
      // to exist only to keep the optional field absent, which is a distinction nothing reads.
      onEvent: (event: ModelTurnEvent) => input.emit?.(event),
    });
  } catch (cause) {
    // A throw is turned into a message. The user has already been told their message was
    // accepted, so failing silently here would leave the conversation claiming something is
    // coming when nothing is.
    const message = appendAssistant(
      deps,
      input.conversationId,
      [
        {
          type: "system-card",
          owner: "host",
          cardId: deps.newId("card"),
          subject: "connection",
          title: "Không gọi được model",
          status: "blocked",
          detail: cause instanceof Error ? cause.message : String(cause),
          fields: [{ label: "Loại lỗi", value: "model-turn-failed" }],
          cancellable: false,
          updatedAt: input.at,
        },
      ],
      { at: input.at },
    );
    return { messages: [message], taskId: undefined, resolution: "model-failed" };
  }

  const message = appendAssistant(
    deps,
    input.conversationId,
    [
      // The card that records what answered comes last, not first.
      //
      // It is bookkeeping: which model, how long it took. At the top of a reply it is the first thing
      // read and it is not the answer — the interface then leads with provenance and buries the text.
      // The renderer draws it as one muted line that expands (see `SystemCardBlock`).
      ...modelSegmentsToBlocks(reply),
      {
        type: "system-card",
        owner: "host",
        cardId: deps.newId("card"),
        subject: "connection",
        title: "Trả lời bằng model",
        status: "done",
        detail:
          "Câu trả lời này do model sinh ra. Không capability nào trên máy này được dùng, và không dữ liệu thật nào của bạn được đọc.",
        fields: [
          { label: "Provider", value: reply.provider },
          {
            label: "Model",
            // The effort belongs with the model, because it is part of which model answered: the same model
            // at a different effort is a different answer to the same question.
            value: reply.metrics?.thinkingLevel === undefined ? reply.model : `${reply.model} · ${reply.metrics.thinkingLevel}`,
          },
          { label: "Thời gian", value: `${reply.elapsedMs} ms` },
          ...turnMetricFields(reply.metrics),
        ],
        // The typed copy, for the statusline: the rows above are written to be read, these to be drawn.
        ...(reply.metrics === undefined ? {} : { metrics: reply.metrics }),
        cancellable: false,
        updatedAt: input.at,
      },
    ],
    { at: input.at, messageId },
  );

  return { messages: [message], taskId: undefined, resolution: "model" };
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
function modelSegmentsToBlocks(reply: ModelTurnReply): MessageBlock[] {
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
      continue;
    }

    const verdict = assertBlockProvenance(segment.block, { builtByHost: false });
    if (!verdict.ok) {
      // Said out loud rather than dropped in silence: a model that repeatedly asks for a card it
      // cannot have is a fact the user should be able to see.
      blocks.push({
        type: "text",
        format: "plain",
        content: `Một khối nội dung đã bị từ chối: ${verdict.message}`,
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
): ConductorOutcome {
  const built = recipe.build({
    nodeId: deps.nodeId,
    principalId: input.principal.principalId,
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
        title: "Dữ liệu mẫu / demo tương tác",
        status: "done",
        detail: `Chạy recipe "${recipe.id}" trên dữ liệu mẫu. Đây không phải dữ liệu thật của bạn và không có model nào được gọi.`,
        fields: [
          { label: "Recipe", value: recipe.id },
          { label: "Nguồn dữ liệu", value: "sample", freshness: "sample" },
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
  message: string;
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
    collectEvidence: (task: TaskRecord) => Promise<{ kind: "exit-status" | "file-diff" | "api-receipt" | "read-after-write" | "test-output"; summary: string; verified: boolean } | undefined>;
  },
): Promise<RunTaskResult> {
  const task = getTask(deps.db, input.taskId);
  if (!task) {
    return { taskId: input.taskId, outcome: "failed", evidenceKinds: [], message: "task does not exist" };
  }

  const reported = await input.collectEvidence(task);
  if (!reported) {
    const failed = applyTaskEvent(deps, task.taskId, "run.verifying");
    if (failed.ok) applyTaskEvent(deps, task.taskId, "verify.failed");
    return {
      taskId: task.taskId,
      outcome: "failed",
      evidenceKinds: [],
      message: "the run produced no evidence, so it is reported as failed rather than as success",
    };
  }

  const recorded = recordEvidence(deps, {
    taskId: task.taskId,
    evidence: {
      kind: reported.kind,
      summary: reported.summary,
      verdict: reported.verified ? "verified" : "not-verified",
    },
  });

  applyTaskEvent(deps, task.taskId, "run.verifying");

  // The ledger decides: an unsettled effect blocks success no matter how clean the run was.
  if (recorded.blocked) {
    return {
      taskId: task.taskId,
      outcome: "uncertain",
      evidenceKinds: [reported.kind],
      message: `effect ${recorded.blocked.effectId} is still ${recorded.blocked.state}; the outcome is undetermined and must be reconciled`,
    };
  }

  const gate = checkSuccessPreconditions(deps, task.taskId, [recorded.evidence]);
  if (!gate.allowed) {
    applyTaskEvent(deps, task.taskId, "verify.failed");
    return {
      taskId: task.taskId,
      outcome: "failed",
      evidenceKinds: [reported.kind],
      message: gate.message,
    };
  }

  applyTaskEvent(deps, task.taskId, "verify.passed");
  return {
    taskId: task.taskId,
    outcome: "succeeded",
    evidenceKinds: [reported.kind],
    message: reported.summary,
  };
}

export { nowInstant };
