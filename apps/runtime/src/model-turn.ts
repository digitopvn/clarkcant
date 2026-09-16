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

import { type Instant, type MessageBlock, type Principal } from "@clarkcant/contracts";

import {
  RealPiAdapter,
  modelBudgetFromEnv,
  modelFromEnv,
  type ModelBudget,
  type ModelSelection,
  type PiAdapter,
  type ToolDefinition,
  type WorkerEvent,
} from "@clarkcant/pi-adapter";

import type { ModelSegment, ModelTurnInput, ModelTurnReply } from "@clarkcant/core";

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
  build: (input: ViewRequest) => MessageBlock;
}

export interface ViewRequest {
  props: Record<string, unknown>;
  caption: string;
  at: Instant;
  principal: Principal;
  /** The message this view will be captured into, allocated before the turn. */
  messageId: string;
}

export const SHOW_VIEW_TOOL = "show_view";

export interface ModelTurn {
  /** What the node is configured to run on, recorded on the card for each reply. */
  selection: ModelSelection;
  /** The ceiling on one turn, so a caller can report what the limit was. */
  budget: ModelBudget;
  /** Whether a view catalog is available, so the interface can say so rather than guess. */
  viewCatalogSize: () => number;
  answer: (input: ModelTurnInput) => Promise<ModelTurnReply>;
  dispose: () => Promise<void>;
}

interface Turn {
  sessionId: string;
  /** Text deltas since the last block, not yet turned into a segment. */
  pending: string[];
  /** Finished segments, in the order the model produced them. */
  segments: ModelSegment[];
  /** The message this turn is being written into. Set before the prompt. */
  messageId?: string;
  unsubscribe: () => void;
}

function isTextDelta(event: WorkerEvent): event is WorkerEvent & { delta: string } {
  return event.type === "text-delta";
}

/**
 * Move whatever text has accumulated into a segment.
 *
 * Called before a block is appended, so a block lands where the model actually asked for it
 * rather than below the whole reply.
 */
function flushText(turn: Turn): void {
  if (turn.pending.length === 0) return;
  const text = turn.pending.join("");
  turn.pending.length = 0;
  if (text.trim() === "") return;
  turn.segments.push({ kind: "text", text });
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
        description: `Which view to show. One of: ${views.map((entry) => entry.id).join(", ")}.`,
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
   * Dataset references the node actually holds.
   *
   * Told to the model rather than left to be guessed. A view that needs data can only be honest if
   * the data exists, and a model that has to invent a reference produces a card that resolves to
   * nothing — which looks like a broken widget rather than a missing fact.
   */
  datasetRefs?: () => readonly string[];
}): Promise<ModelTurn | undefined> {
  const selection = modelFromEnv(options.env);
  if (selection === undefined) return undefined;

  const readViews = (): readonly ViewDescriptor[] => options.views?.() ?? [];
  const readDatasetRefs = (): readonly string[] => options.datasetRefs?.() ?? [];
  const budget = modelBudgetFromEnv(options.env);
  const adapter =
    options.adapter ?? new RealPiAdapter({ cwd: options.cwd, model: selection, builtinTools: [] });
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
          const block = descriptor.build({
            props,
            caption,
            at: new Date().toISOString() as Instant,
            principal,
            messageId: turn.messageId,
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
    const turn: Turn = { sessionId: "", pending: [], segments: [], unsubscribe: () => {} };
    const customTools =
      views.length === 0 ? [] : [showViewTool(turn, principal, views, viewById, datasetRefs)];

    const handle = await adapter.createWorkerSession({
      // The brief is per conversation rather than per message, so the model keeps the thread
      // it is already in instead of meeting the user again on every turn.
      goal: "Answer the user in this conversation.",
      projectRoots: [],
      allowedCapabilityRefs: [],
      ...(customTools.length === 0 ? {} : { customTools }),
      // Carried on the brief as well as held here, because the adapter enforces it at the
      // turn boundary and that is where a runaway turn is actually stopped.
      maxWallClockMs: budget.maxWallClockMs,
      maxTokens: budget.maxTokens,
    });

    turn.sessionId = handle.sessionId;
    turn.unsubscribe = adapter.subscribe(handle.sessionId, (event) => {
      if (isTextDelta(event)) turn.pending.push(event.delta);
    });

    turns.set(conversationId, turn);
    return turn;
  }

  return {
    selection,
    budget,
    viewCatalogSize: () => readViews().length,

    async answer(input: ModelTurnInput): Promise<ModelTurnReply> {
      if (!availability.available) {
        throw new Error(
          `this node is configured for ${describe()} but that model is not reachable: ${availability.reason ?? "no reason given"}`,
        );
      }

      const startedAt = Date.now();
      const turn = await turnFor(input.conversationId, input.principal);
      // Cleared before the prompt rather than after, so a turn that throws still leaves the
      // buffer empty for the next one instead of prepending the previous reply to it.
      turn.pending.length = 0;
      turn.segments.length = 0;
      turn.messageId = input.messageId;

      // The adapter stops a turn that overruns its brief, but this is the layer holding an open
      // HTTP request, so it does not delegate the guarantee: without a deadline here a provider
      // that never settles would hold the request until the client gives up, and the user would
      // see a hung page rather than a limit being reached.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void adapter.abort(turn.sessionId, `turn exceeded ${budget.maxWallClockMs} ms`);
          reject(
            new Error(`${describe()} did not finish within ${budget.maxWallClockMs} ms; the turn was stopped`),
          );
        }, budget.maxWallClockMs);
      });

      try {
        await Promise.race([adapter.prompt(turn.sessionId, input.text), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      // Trailing prose after the last view.
      flushText(turn);
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
      return { text, segments, provider: selection.provider, model: selection.id, elapsedMs };
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
