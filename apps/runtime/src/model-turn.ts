/**
 * A conversation turn answered by a live model.
 *
 * The turn runs in the node's own process rather than in a spawned worker. That is a
 * deliberate split: a conversation turn is short, has no tool access, and must be able to
 * reach the model without the execution supervisor's environment allowlist deciding whether
 * a credential is permitted. A worker is for work that touches a project, and that path keeps
 * the allowlist it has.
 *
 * No built-in tools are registered. The model answers in words; work that touches anything is
 * done by a capability, which is where approval, evidence and budgets live. Giving a
 * conversation turn a filesystem tool by default would route around all three.
 */

import { RealPiAdapter, modelFromEnv, type ModelSelection, type WorkerEvent } from "@clarkcant/pi-adapter";

import type { ModelTurnInput, ModelTurnReply } from "@clarkcant/core";

export interface ModelTurn {
  /** What the node is configured to run on, recorded on the card for each reply. */
  selection: ModelSelection;
  answer: (input: ModelTurnInput) => Promise<ModelTurnReply>;
  dispose: () => Promise<void>;
}

interface Turn {
  sessionId: string;
  /** Text deltas accumulated for the turn currently in flight. */
  buffer: string[];
  unsubscribe: () => void;
}

function isTextDelta(event: WorkerEvent): event is WorkerEvent & { delta: string } {
  return event.type === "text-delta";
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
}): Promise<ModelTurn | undefined> {
  const selection = modelFromEnv(options.env);
  if (selection === undefined) return undefined;

  const adapter = new RealPiAdapter({ cwd: options.cwd, model: selection, builtinTools: [] });
  const availability = await adapter.availability();
  const turns = new Map<string, Turn>();

  const describe = (): string => `${selection.provider}/${selection.id}`;

  async function turnFor(conversationId: string): Promise<Turn> {
    const existing = turns.get(conversationId);
    if (existing !== undefined) return existing;

    const handle = await adapter.createWorkerSession({
      // The brief is per conversation rather than per message, so the model keeps the thread
      // it is already in instead of meeting the user again on every turn.
      goal: "Answer the user in this conversation.",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });

    const entry: Turn = { sessionId: handle.sessionId, buffer: [], unsubscribe: () => {} };
    entry.unsubscribe = adapter.subscribe(handle.sessionId, (event) => {
      if (isTextDelta(event)) entry.buffer.push(event.delta);
    });
    turns.set(conversationId, entry);
    return entry;
  }

  return {
    selection,

    async answer(input: ModelTurnInput): Promise<ModelTurnReply> {
      if (!availability.available) {
        throw new Error(
          `this node is configured for ${describe()} but that model is not reachable: ${availability.reason ?? "no reason given"}`,
        );
      }

      const startedAt = Date.now();
      const turn = await turnFor(input.conversationId);
      // Cleared before the prompt rather than after, so a turn that throws still leaves the
      // buffer empty for the next one instead of prepending the previous reply to it.
      turn.buffer.length = 0;

      await adapter.prompt(turn.sessionId, input.text);

      const text = turn.buffer.join("").trim();
      const elapsedMs = Date.now() - startedAt;

      if (text === "") {
        // A settled run with no text is not a reply. Saying so is better than appending an
        // empty message that reads as the assistant having nothing to say.
        throw new Error(`${describe()} ended the turn without producing any text after ${elapsedMs} ms`);
      }

      return { text, provider: selection.provider, model: selection.id, elapsedMs };
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
