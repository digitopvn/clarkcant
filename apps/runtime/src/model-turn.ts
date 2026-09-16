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
}

export const SHOW_VIEW_TOOL = "show_view";

export interface ModelTurn {
  /** What the node is configured to run on, recorded on the card for each reply. */
  selection: ModelSelection;
  /** The ceiling on one turn, so a caller can report what the limit was. */
  budget: ModelBudget;
  /** Whether a view catalog was supplied, so the interface can say so rather than guess. */
  viewCatalogSize: number;
  answer: (input: ModelTurnInput) => Promise<ModelTurnReply>;
  dispose: () => Promise<void>;
}

interface Turn {
  sessionId: string;
  /** Text deltas since the last block, not yet turned into a segment. */
  pending: string[];
  /** Finished segments, in the order the model produced them. */
  segments: ModelSegment[];
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
function showViewParameters(views: readonly ViewDescriptor[]): Record<string, unknown> {
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
        description: "Values for the view. These are rendered as sample data, not as live data.",
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
  /** Views the model may ask for. Absent means the tool is not registered at all. */
  views?: readonly ViewDescriptor[];
}): Promise<ModelTurn | undefined> {
  const selection = modelFromEnv(options.env);
  if (selection === undefined) return undefined;

  const views = options.views ?? [];
  const budget = modelBudgetFromEnv(options.env);
  const adapter =
    options.adapter ?? new RealPiAdapter({ cwd: options.cwd, model: selection, builtinTools: [] });
  const availability = await adapter.availability();
  const turns = new Map<string, Turn>();

  const describe = (): string => `${selection.provider}/${selection.id}`;
  const viewById = new Map(views.map((entry) => [entry.id, entry]));

  /**
   * The one tool.
   *
   * It refuses in three ways — an unknown view, props that do not fit, and a view whose build
   * threw — and every refusal comes back to the model as text in the same turn, so the model can
   * correct itself instead of the user seeing nothing. A refusal never appends a block: a failed
   * request must not leave a card behind that looks like it succeeded.
   */
  function showViewTool(onBlock: (block: MessageBlock) => void, principal: Principal): ToolDefinition {
    return {
      name: SHOW_VIEW_TOOL,
      label: "Show a view",
      description:
        "Show a visual view in the conversation. Use the exact view name from the list. The values you pass are shown as sample data, so never describe them as live.",
      parameters: showViewParameters(views),
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        const requested = typeof params.view === "string" ? params.view : "";
        const descriptor = viewById.get(requested);
        if (descriptor === undefined) {
          return {
            text: `No view named "${requested}". Available: ${views.map((entry) => entry.id).join(", ") || "(none)"}.`,
          };
        }
        const props =
          typeof params.props === "object" && params.props !== null
            ? (params.props as Record<string, unknown>)
            : {};
        const caption = typeof params.caption === "string" ? params.caption : descriptor.label;
        try {
          onBlock(descriptor.build({ props, caption, at: new Date().toISOString() as Instant, principal }));
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

    const handle = await adapter.createWorkerSession({
      // The brief is per conversation rather than per message, so the model keeps the thread
      // it is already in instead of meeting the user again on every turn.
      goal: "Answer the user in this conversation.",
      projectRoots: [],
      allowedCapabilityRefs: [],
      // Carried on the brief as well as held here, because the adapter enforces it at the
      // turn boundary and that is where a runaway turn is actually stopped.
      maxWallClockMs: budget.maxWallClockMs,
      maxTokens: budget.maxTokens,
    });

    const turn: Turn = { sessionId: handle.sessionId, pending: [], segments: [], unsubscribe: () => {} };
    turn.unsubscribe = adapter.subscribe(handle.sessionId, (event) => {
      if (isTextDelta(event)) turn.pending.push(event.delta);
    });

    if (views.length > 0) {
      await adapter.registerTool(
        handle.sessionId,
        showViewTool((block) => {
          // Flushed first: the text the model wrote before asking for this view belongs above it.
          flushText(turn);
          turn.segments.push({ kind: "block", block });
        }, principal),
      );
    }

    turns.set(conversationId, turn);
    return turn;
  }

  return {
    selection,
    budget,
    viewCatalogSize: views.length,

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
