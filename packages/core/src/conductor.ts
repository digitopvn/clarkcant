import {
  type ActionProposal,
  type CapabilityRef,
  type ConversationId,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type Principal,
  type TaskRecord,
  type WidgetDefinition,
  nowInstant,
} from "@clarkcant/contracts";

import {
  type Database,
  appendMessage,
  getTask,
  nextMessageSequence,
  touchConversation,
} from "@clarkcant/storage";

import { type RegistryDeps, listCapabilitySummaries } from "./capability-registry.ts";
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
  /** Optional worker bridge. Absent means an install is proposed instead of a run. */
  runTask?: (taskId: string) => Promise<void>;
}

export interface UserMessageInput {
  conversationId: ConversationId;
  principal: Principal;
  text: string;
  at?: Instant;
}

export interface ConductorOutcome {
  /** Messages the host appended, in timeline order. */
  messages: MessageRecord[];
  /** Set when a durable task was created rather than answered immediately. */
  taskId: string | undefined;
  /** How the utterance was resolved, for tests and for the UI's honest labelling. */
  resolution: "sample" | "task-dispatched" | "task-parked" | "clarification";
}

/** Append an assistant message and return the stored record. */
function appendAssistant(
  deps: ConductorDeps,
  conversationId: ConversationId,
  blocks: MessageBlock[],
  options: { taskId?: string; at: Instant },
): MessageRecord {
  const message: MessageRecord = {
    messageId: deps.newId("msg") as MessageRecord["messageId"],
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

function appendUser(
  deps: ConductorDeps,
  conversationId: ConversationId,
  text: string,
  at: Instant,
): MessageRecord {
  const message: MessageRecord = {
    messageId: deps.newId("msg") as MessageRecord["messageId"],
    conversationId,
    role: "user",
    blocks: [{ type: "text", format: "plain", content: text, streaming: false }],
    authorNodeId: deps.nodeId as MessageRecord["authorNodeId"],
    createdAt: at,
    delivery: "accepted",
  };
  appendMessage(deps.db, message, nextMessageSequence(deps.db, conversationId));
  return message;
}

/**
 * Handle one user utterance.
 *
 * The order of resolution is deliberate: a scripted sample first, then the registry. A
 * sample never shadows a real capability the user has installed — that would be the demo
 * pretending to be the product — so samples are only consulted when the registry cannot
 * satisfy the request at all.
 */
export function handleUserMessage(deps: ConductorDeps, input: UserMessageInput): ConductorOutcome {
  const at = input.at ?? nowInstant();
  const userMessage = appendUser(deps, input.conversationId, input.text, at);
  void userMessage;

  const usable = listCapabilitySummaries(deps, { usableOnly: true });
  const executionNode = usable[0];

  // A scripted recipe is only considered when nothing installed can answer, so an
  // installed integration is never shadowed by a demo.
  if (!executionNode) {
    const recipe = deps.sampleRecipes.find((candidate) => candidate.matches(input.text));
    if (recipe) {
      return runSampleRecipe(deps, { ...input, at }, recipe);
    }
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
