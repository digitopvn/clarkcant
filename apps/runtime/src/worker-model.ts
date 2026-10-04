import { keyVariableFor, type ModelCatalogue, workerBudgetFromEnv } from "@clarkcant/pi-adapter";

import { toolCallsIn } from "./model-router.ts";
import type { ModelTurn } from "./model-turn.ts";
import type { WorkerModelLaunch, WorkerModelSource } from "./task-dispatch.ts";
import { MODEL_CONFIG_DIR_VARIABLE } from "./worker-process.ts";

/**
 * Where a dispatched task's worker gets its model and the key for it.
 *
 * The model is the model turn's own background choice (`ModelTurn.workerModel`): the policy layer's route among the
 * node's pool when it gives one, else what the node runs. There is no second setting for it, because a second setting
 * is a second place that can disagree.
 *
 * The key is looked up the way the rest of the node looks one up: the provider's variable in this node's environment,
 * else a credential stored under the provider's name — the same two places model routing counts as "this provider has a
 * key". Neither is ever put into a child's environment; the dispatcher hands it to the worker over stdin. When the node
 * holds neither, the worker's model runtime reads its own configuration directory, which is the directory this node's
 * runtime reads too.
 */
export function nodeWorkerModel(input: {
  /**
   * Absent on a node with no model; every task it is given is then refused before a worker starts. Its catalogue, when
   * it has one, is what says whether a model can call tools.
   */
  modelTurn: (Pick<ModelTurn, "workerModel"> & Partial<Pick<ModelTurn, "catalogue">>) | undefined;
  /**
   * Every model a worker could be started on: the one the node runs and the enabled profiles of its pool. Absent means
   * nobody said, and whether the node's workers can call tools is then unknown.
   */
  candidates?: () => readonly { provider: string; id: string }[];
  /** Where the provider key, the model runtime's directory and the worker budget (`CC_WORKER_MAX_*`) are read from. */
  env: NodeJS.ProcessEnv;
  /** The node's stored credential with this name, read at the moment a worker starts. */
  storedCredential: (name: string) => string | undefined;
}): WorkerModelSource {
  return {
    available: () => input.modelTurn !== undefined,
    toolCalls: async (): Promise<boolean | undefined> => {
      const turn = input.modelTurn;
      if (turn === undefined || input.candidates === undefined) return undefined;
      const catalogue = await catalogueOf(turn);
      if (catalogue === undefined) return undefined;
      const stated = input.candidates().map((model) => toolCallsIn(catalogue, model.provider, model.id));
      if (stated.length === 0) return undefined;
      if (stated.every((value) => value === false)) return false;
      if (stated.every((value) => value === true)) return true;
      return undefined;
    },
    launch: async (work): Promise<WorkerModelLaunch | undefined> => {
      const turn = input.modelTurn;
      if (turn === undefined) return undefined;
      const chosen = await turn.workerModel(work);
      const catalogue = await catalogueOf(turn);
      const toolCalls = catalogue === undefined ? undefined : toolCallsIn(catalogue, chosen.provider, chosen.id);
      const variable = keyVariableFor(chosen.provider);
      const fromEnvironment = variable === undefined ? undefined : nonEmpty(input.env[variable]);
      const stored = fromEnvironment === undefined ? nonEmpty(input.storedCredential(chosen.provider)) : undefined;
      const credential = fromEnvironment ?? stored;
      const agentDir = nonEmpty(input.env[MODEL_CONFIG_DIR_VARIABLE]);
      const budget = workerBudgetFromEnv(input.env);
      return {
        model: {
          provider: chosen.provider,
          id: chosen.id,
          ...(chosen.thinkingLevel === undefined ? {} : { thinkingLevel: chosen.thinkingLevel }),
        },
        via: chosen.via,
        ...(chosen.fallback === undefined ? {} : { fallback: chosen.fallback }),
        ...(credential === undefined ? {} : { credential }),
        credentialSource: fromEnvironment !== undefined ? "environment" : stored !== undefined ? "stored" : "model-config",
        ...(agentDir === undefined ? {} : { agentDir }),
        maxTokens: budget.maxTokens,
        maxWallClockMs: budget.maxWallClockMs,
        ...(toolCalls === undefined ? {} : { toolCalls }),
      };
    },
  };
}

/** The model catalogue, or nothing when there is none or it cannot be read: a catalogue that cannot say states nothing. */
async function catalogueOf(turn: Partial<Pick<ModelTurn, "catalogue">>): Promise<ModelCatalogue | undefined> {
  if (turn.catalogue === undefined) return undefined;
  try {
    return await turn.catalogue();
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
