import { redactSecrets } from "@clarkcant/contracts";

import {
  type JevBudget,
  type JevDeps,
  type JevTelemetry,
  NONE_OPTION,
  askChoice,
  askNoul,
  createJevBudget,
  jevCallRefusal,
} from "./jev-selector.ts";
import { describeRuntimeCandidate, type RuntimeCandidate } from "./runtime-candidates.ts";

/**
 * The decision layer.
 *
 * Retrieval finds candidates; this layer chooses between them. It is deliberately small, and it is
 * deliberately last: it never searches, never generates content, never grants permission and never
 * decides a side effect. Everything it can do is pick one of the ids it was handed, say that none of
 * them fits, or ask the user a question.
 *
 * Two paths use it, and they differ only in what the candidates are:
 *
 * - **A: runtime coordination.** Which running worker a request is meant for.
 * - **B: history search.** Which retrieved result the user meant when several are close.
 *
 * Both paths share the same refusals: no candidates means no call, one candidate means no call, and
 * an answer that is not decisive is reported as undecided rather than rounded into a choice.
 */

export type SearchDeciderMode = "rank" | "jev";

/**
 * Which decider runs on the search path.
 *
 * Defaults to `rank`, and that default is a measurement rather than a preference: the Phase 8
 * baseline answered 96.8% of lexical queries correctly with BM25 alone, and the cases it missed were
 * missing vocabulary, which choosing between the results cannot repair. `jev` is opt-in and its
 * calibration is recorded in the phase report.
 */
export function searchDeciderFromEnv(env: NodeJS.ProcessEnv = process.env): SearchDeciderMode {
  return env.CLARKCANT_SEARCH_DECIDER?.trim().toLowerCase() === "jev" ? "jev" : "rank";
}

/**
 * How much better the top result must be before the ranking counts as decisive.
 *
 * A **relative** gap, because BM25 scores are small and scale with the query: an absolute floor of
 * any useful size would never be cleared by a real score, and every search would then pay for a
 * selector call it did not need. Two results within a quarter of each other are close enough that a
 * reader would not know which one the ranking preferred.
 */
export const RANK_GAP_RATIO = 0.25;

/** Whether the ranking already separated the top result from the next one. */
export function rankGapIsClear(first: number, second: number): boolean {
  const largest = Math.max(Math.abs(first), Math.abs(second));
  if (largest === 0) return false;
  return Math.abs(first - second) / largest >= RANK_GAP_RATIO;
}

export interface DecideDeps {
  jev: JevDeps;
  budget: JevBudget;
}

export interface RuntimeDecisionInput {
  intent: string;
  candidates: readonly RuntimeCandidate[];
  /** Re-checked after a selection: the world can move while a selector is thinking. */
  verify?: (id: string) => boolean;
}

export type RuntimeTargetDecision =
  | { status: "selected"; id: string; confidence: number | undefined; margin: number | undefined; model: string }
  | { status: "fallback"; reason: string; ordered: readonly RuntimeCandidate[] }
  | { status: "none"; reason: string };

/**
 * Choose which running runtime a request is meant for.
 *
 * The verification step is not optional in spirit: without it, a selection could dispatch work to a
 * lease that was released while the selector was reading. A candidate that no longer verifies is
 * reported as a fallback with the reason, so the caller falls back to rank rather than dispatching
 * to a target that has gone.
 */
export async function decideRuntimeTarget(
  deps: DecideDeps,
  input: RuntimeDecisionInput,
): Promise<RuntimeTargetDecision> {
  const live = input.candidates.filter((candidate) => candidate.live);
  if (live.length === 0) return { status: "none", reason: "nothing is running on this node" };

  // One candidate is not a decision. Asking a provider to confirm it would spend the budget to
  // learn what the caller can see.
  if (live.length === 1) {
    const only = live[0]!;
    if (input.verify !== undefined && !input.verify(only.id)) {
      return { status: "fallback", reason: "the only candidate stopped being live before it could be used", ordered: live };
    }
    return { status: "selected", id: only.id, confidence: undefined, margin: undefined, model: deps.jev.config.model };
  }

  const refused = jevCallRefusal(deps.jev.config);
  if (refused !== undefined) return { status: "fallback", reason: refused, ordered: live };

  const criteria: Record<string, string | null> = {};
  for (const candidate of live.slice(0, 12)) {
    criteria[candidate.id] = describeRuntimeCandidate(candidate);
  }

  const outcome = await askChoice(deps.jev, {
    state: {
      // The intent is the only free text, and it is sanitized on the way out by the same function
      // the composition path uses.
      intent: redactSecrets(input.intent).slice(0, 500),
      running: live.slice(0, 12).map((candidate) => ({ id: candidate.id, kind: candidate.kind, busy: candidate.load > 0 })),
    },
    instructions:
      "Choose which running thing on this machine the request is about. Choose none if the request is not about anything that is running.",
    criteria,
    questionId: "runtime",
    budget: deps.budget,
  });

  if (outcome.status !== "answered") {
    return {
      status: "fallback",
      reason: outcome.status === "unavailable" ? outcome.reason : `the selector did not decide: ${outcome.reason}`,
      ordered: live,
    };
  }
  if (!outcome.value.substantive) {
    return { status: "none", reason: "the selector said the request is not about anything that is running" };
  }

  const decisive = isDecisive(outcome.value.top, outcome.value.runnerUp, deps.jev.config.confidenceFloor, deps.jev.config.marginFloor);
  if (!decisive.decisive) return { status: "fallback", reason: decisive.reason, ordered: live };

  const chosen = live.find((candidate) => candidate.id === outcome.value.choice);
  if (chosen === undefined) {
    return { status: "fallback", reason: "the selector chose something that was not a candidate", ordered: live };
  }
  if (input.verify !== undefined && !input.verify(chosen.id)) {
    return {
      status: "fallback",
      reason: "the chosen target stopped being live before anything was dispatched to it",
      ordered: live,
    };
  }

  return {
    status: "selected",
    id: chosen.id,
    confidence: outcome.value.confidence ?? outcome.value.top,
    margin: outcome.value.margin,
    model: deps.jev.config.model,
  };
}

export interface SearchDecisionInput {
  query: string;
  results: readonly { ref: string; snippet: string; score: number; source: string }[];
}

export type SearchDecision =
  | { status: "chosen"; ref: string; confidence: number | undefined; margin: number | undefined; model: string }
  | { status: "clarify"; question: string }
  | { status: "rank"; reason: string };

/**
 * Choose which directory the user meant.
 *
 * Path B of the finder: the same shape as the runtime decision, with names instead of leases. The
 * candidates are described by name, relative path, kind and markers — which is what a person would
 * recognise — and never by an absolute path.
 */
export async function decideProject(
  deps: DecideDeps,
  input: {
    intent: string;
    candidates: readonly { id: string; name: string; relPath: string; kind: string; markers: readonly string[] }[];
    verify?: (id: string) => boolean;
  },
): Promise<
  | { status: "selected"; id: string; confidence: number | undefined; margin: number | undefined; model: string }
  | { status: "none"; reason: string }
  | { status: "fallback"; reason: string }
> {
  if (input.candidates.length === 0) return { status: "none", reason: "there were no candidates" };
  if (input.candidates.length === 1) {
    const only = input.candidates[0]!;
    if (input.verify !== undefined && !input.verify(only.id)) {
      return { status: "fallback", reason: "the only candidate no longer verifies" };
    }
    return { status: "selected", id: only.id, confidence: undefined, margin: undefined, model: deps.jev.config.model };
  }

  const refused = jevCallRefusal(deps.jev.config);
  if (refused !== undefined) return { status: "fallback", reason: refused };

  const offered = input.candidates.slice(0, 12);
  const criteria: Record<string, string | null> = {};
  for (const candidate of offered) {
    const markers = candidate.markers.slice(0, 4).join(", ");
    criteria[candidate.id] =
      `${candidate.name} (${candidate.kind}${markers === "" ? "" : `, ${markers}`}) ở ~/${candidate.relPath}`;
  }

  const outcome = await askChoice(deps.jev, {
    state: {
      intent: redactSecrets(input.intent).slice(0, 300),
      candidates: offered.map((candidate) => ({ id: candidate.id, name: candidate.name, kind: candidate.kind })),
    },
    instructions: "Which directory is the user referring to? Choose none if none of them is what they meant.",
    criteria,
    questionId: "project",
    budget: deps.budget,
  });

  if (outcome.status !== "answered") {
    return {
      status: "fallback",
      reason: outcome.status === "unavailable" ? outcome.reason : `the selector did not decide: ${outcome.reason}`,
    };
  }
  if (!outcome.value.substantive) {
    return { status: "none", reason: "the selector said none of the directories is the one meant" };
  }

  const decisive = isDecisive(
    outcome.value.top,
    outcome.value.runnerUp,
    deps.jev.config.confidenceFloor,
    deps.jev.config.marginFloor,
  );
  if (!decisive.decisive) return { status: "fallback", reason: decisive.reason };

  const chosen = offered.find((candidate) => candidate.id === outcome.value.choice);
  if (chosen === undefined) return { status: "fallback", reason: "the selector chose something that was not a candidate" };
  if (input.verify !== undefined && !input.verify(chosen.id)) {
    return { status: "fallback", reason: "the chosen directory no longer verifies" };
  }

  return {
    status: "selected",
    id: chosen.id,
    confidence: outcome.value.confidence ?? outcome.value.top,
    margin: outcome.value.margin,
    model: deps.jev.config.model,
  };
}


/**
 * Choose which retrieved result the user meant.
 *
 * The order of the refusals is the design. One result needs no decision, a ranking with a clear
 * winner needs no decision, and only then is a provider asked — and if it is not sure, the next
 * question is whether the user should be asked rather than which result to show.
 */
export async function decideSearchResult(
  deps: DecideDeps,
  input: SearchDecisionInput,
): Promise<SearchDecision> {
  if (input.results.length === 0) return { status: "rank", reason: "there was nothing to choose between" };
  if (input.results.length === 1) {
    return { status: "rank", reason: "one result is already unambiguous" };
  }

  const [first, second] = input.results;
  if (first !== undefined && second !== undefined && rankGapIsClear(first.score, second.score)) {
    // BM25 already separated them by more than the floor. A second opinion here would be paying for
    // a decision that has been made.
    return { status: "rank", reason: "the ranking already separated the top result from the next one" };
  }

  const refused = jevCallRefusal(deps.jev.config);
  if (refused !== undefined) return { status: "rank", reason: refused };

  // Snippets are the user's own history, so they are redacted before they leave the node and only
  // the first few results are offered.
  const offered = input.results.slice(0, 10);
  const criteria: Record<string, string | null> = {};
  for (const result of offered) {
    criteria[`result:${result.ref}`] = redactSecrets(result.snippet).slice(0, 200);
  }

  const choice = await askChoice(deps.jev, {
    state: { query: redactSecrets(input.query).slice(0, 300) },
    instructions: "Which of these earlier records is the one the question is about? Choose none if none of them is.",
    criteria,
    questionId: "result",
    budget: deps.budget,
  });

  if (choice.status !== "answered") {
    return {
      status: "rank",
      reason: choice.status === "unavailable" ? choice.reason : `the selector did not decide: ${choice.reason}`,
    };
  }
  if (choice.value.substantive) {
    const decisive = isDecisive(choice.value.top, choice.value.runnerUp, deps.jev.config.confidenceFloor, deps.jev.config.marginFloor);
    if (decisive.decisive) {
      const ref = choice.value.choice.replace(/^result:/, "");
      if (offered.some((result) => result.ref === ref)) {
        return {
          status: "chosen",
          ref,
          confidence: choice.value.confidence ?? choice.value.top,
          margin: choice.value.margin,
          model: deps.jev.config.model,
        };
      }
    }
  }

  // Either the selector declined every result, or it was not sure. The next question is whether the
  // user should be asked, and Noul's middle band is what decides that — a probability in the middle
  // means "do not guess".
  const noul = await askNoul(deps.jev, {
    state: {
      query: redactSecrets(input.query).slice(0, 300),
      resultCount: offered.length,
    },
    instructions:
      "Are these search results ambiguous enough that the user should be asked which one they meant?",
    criteria: { true: "The question could plausibly mean more than one of them", false: "One of them is clearly the answer" },
    questionId: "ambiguous",
    budget: deps.budget,
  });

  if (noul.status === "answered" && noul.verdict === "on") {
    return {
      status: "clarify",
      question: `Có ${offered.length} kết quả gần nhau. Bạn muốn nói tới kết quả nào?`,
    };
  }

  return {
    status: "rank",
    reason:
      noul.status === "answered"
        ? `the selector was not decisive and clarification was declined (${noul.verdict})`
        : `the selector was not decisive and ${noul.reason}`,
  };
}

function isDecisive(
  top: number,
  runnerUp: number | undefined,
  floor: number,
  margin: number,
): { decisive: true } | { decisive: false; reason: string } {
  if (top < floor) return { decisive: false, reason: `top probability ${top.toFixed(3)} is below the ${floor} floor` };
  if (runnerUp !== undefined && top - runnerUp < margin) {
    return {
      decisive: false,
      reason: `the margin ${(top - runnerUp).toFixed(3)} is below the ${margin} floor`,
    };
  }
  return { decisive: true };
}

export interface DeciderWiring {
  deps: DecideDeps;
  /** True when a provider call is even possible, so a caller can skip the decision path entirely. */
  available: () => boolean;
}

/**
 * Build the decider for a node.
 *
 * `budget` is a function rather than a value so each request gets its own deadline: one slow search
 * must not consume the next one's budget.
 */
export function buildDecider(input: {
  jev: JevDeps;
  now?: () => number;
  onTelemetry?: (event: JevTelemetry) => void;
}): DeciderWiring {
  const deps: DecideDeps = {
    jev: input.onTelemetry === undefined ? input.jev : { ...input.jev, onTelemetry: input.onTelemetry },
    budget: createJevBudget(input.jev.config, input.now),
  };
  return {
    deps,
    available: () => jevCallRefusal(input.jev.config) === undefined,
  };
}

export { NONE_OPTION };
