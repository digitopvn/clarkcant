import { redactSecrets } from "@clarkcant/contracts";

import {
  type JevBudget,
  type JevConfig,
  type JevDeps,
  type JevTelemetry,
  NONE_OPTION,
  askChoice,
  askNoul,
  createJevBudget,
  jevCallRefusal,
} from "./jev-selector.ts";
import { sanitizeIntent } from "./mini-app-candidates.ts";
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
 * How long a *decision* may take.
 *
 * Deliberately shorter than the composition budget. Composing may legitimately spend two calls inside
 * four seconds, but a search has already produced a ranked answer before the selector is consulted,
 * and the plan puts that decision at two seconds with the whole path under two and a half. Waiting
 * four seconds for a second opinion on a list that is already on screen is the worst case a user
 * actually feels, and the selector is never load-bearing here: running out of time returns the
 * ranking, not an error. The measured live p95 for a call was 824 ms, so the deadline is not tight.
 */
export const SEARCH_DECISION_TIMEOUT_MS = 2000;

/** The plan's ceiling for the whole search path: ranking plus one decision. */
export const SEARCH_TOTAL_BUDGET_MS = 2500;

/**
 * The decision deadline, overridable by an operator.
 *
 * A value that is not a positive number falls back to the default rather than to zero: an unparsable
 * override must not silently disable the selector, and it must not be read as "no deadline".
 */
export function decisionTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLARKCANT_JEV_SEARCH_TIMEOUT_MS;
  if (raw === undefined) return SEARCH_DECISION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SEARCH_DECISION_TIMEOUT_MS;
}

/** A budget for one decision call, on the decision deadline rather than the composition one. */
export function searchDecisionBudget(
  config: JevConfig,
  options: { timeoutMs?: number; now?: () => number } = {},
): JevBudget {
  return createJevBudget(
    { ...config, timeoutMs: options.timeoutMs ?? SEARCH_DECISION_TIMEOUT_MS },
    options.now ?? Date.now,
  );
}

/**
 * Which decider runs on the search path.
 *
 * Defaults to `rank`, and that default is a measurement rather than a preference: the Phase 8
 * baseline answered 96.8% of lexical queries correctly with BM25 alone, the live calibration with
 * `jev-1.13.0` tied it at 31/34, and the cases both miss are missing vocabulary — which choosing
 * between the results cannot repair. `jev` is opt-in and its calibration is recorded in the phase
 * report.
 *
 * `none` is the plan's name for the off switch and `rank` is what this code calls the same thing, so
 * both are accepted. Anything unrecognised is also `rank`, because a typo in an environment variable
 * must not be able to switch a paid provider on.
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
  /**
   * The deadline for one decision, built when the decision starts.
   *
   * A function rather than a value, and that is the whole point: a budget carries an absolute
   * `deadlineAt`, so one built when the node booted has already expired by the time anybody asks
   * anything. Wiring a value here reads as "a two-second deadline" and behaves as "no selector, ever"
   * — every call refused with "the budget for this turn was exhausted" from two seconds of uptime
   * onward, which is indistinguishable from a provider outage.
   */
  budget: () => JevBudget;
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

  // One budget for the whole decision, built now rather than at boot and shared by every call this
  // decision makes. Per call would let the choice and the follow-up question spend a full deadline
  // each, and the plan's ceiling is for the whole search path; per boot is worse still, because an
  // absolute `deadlineAt` captured then has expired by the time the first query arrives.
  const budget = deps.budget();

  const outcome = await askChoice(deps.jev, {
    state: {
      // The intent is the only free text, and it goes through the same sanitizer the composition path
      // uses rather than a bare redaction: control characters stripped, whitespace collapsed, capped,
      // and then redacted. Claiming that parity while doing less is how a privacy boundary quietly
      // narrows.
      intent: sanitizeIntent(input.intent, 500),
      running: live.slice(0, 12).map((candidate) => ({ id: candidate.id, kind: candidate.kind, busy: candidate.load > 0 })),
    },
    instructions:
      "Choose which running thing on this machine the request is about. Choose none if the request is not about anything that is running.",
    criteria,
    questionId: "runtime",
    budget,
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
    // Directory names and markers are filesystem text the user never wrote for a third party, so the
    // whole description goes through the same redaction as every other payload field. `relPath` stays
    // relative, which is what the plan allows and what keeps an absolute home path out of the request.
    criteria[candidate.id] = redactSecrets(
      `${candidate.name} (${candidate.kind}${markers === "" ? "" : `, ${markers}`}) ở ~/${candidate.relPath}`,
    );
  }

  const budget = deps.budget();

  const outcome = await askChoice(deps.jev, {
    state: {
      intent: redactSecrets(input.intent).slice(0, 300),
      // The directory name is the one free-text field here, and it is filesystem text the user wrote
      // for themselves rather than for a third party. Redacting only the criteria would leave the
      // same name travelling verbatim in the state beside it.
      candidates: offered.map((candidate) => ({
        id: candidate.id,
        name: redactSecrets(candidate.name),
        kind: candidate.kind,
      })),
    },
    instructions: "Which directory is the user referring to? Choose none if none of them is what they meant.",
    criteria,
    questionId: "project",
    budget,
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

/** The three things that can happen to a message that arrives while something is running. */
export type TurnAction = "steer" | "interrupt" | "background";

/**
 * What should happen to a message sent while the assistant is still working.
 *
 * The three answers are genuinely different and none is a safe default: steering changes work already under way,
 * interrupting throws it away, and a background worker spends a provider call on something the person may not have
 * meant as a separate job. That is why this is a decision rather than a rule, and why an undecided answer is reported
 * as undecided - the caller decides what to do with that, and choosing here on the model's behalf would hide it.
 *
 * How long the current work has been running belongs to the question because it changes the cost of the answer: a
 * turn that started a second ago is cheap to stop, and one that has been going for a minute has something worth
 * keeping or steering.
 */
export async function decideTurnAction(
  deps: DecideDeps,
  input: { text: string; runningMs: number },
): Promise<
  | { status: "decided"; action: TurnAction; confidence: number | undefined; model: string }
  | { status: "fallback"; reason: string }
> {
  const refused = jevCallRefusal(deps.jev.config);
  if (refused !== undefined) return { status: "fallback", reason: refused };

  const outcome = await askChoice(deps.jev, {
    state: {
      message: redactSecrets(input.text).slice(0, 400),
      runningForSeconds: String(Math.max(0, Math.round(input.runningMs / 1000))),
    },
    instructions:
      "Trợ lý đang làm dở một việc trong hội thoại này và người dùng vừa gửi thêm một tin. Chọn cách xử lý tin mới.",
    criteria: {
      steer: "tin mới bổ sung, chỉnh lại hoặc nói rõ thêm cho việc đang làm",
      interrupt: "tin mới thay thế việc đang làm; làm tiếp là làm thừa",
      background: "tin mới là việc khác, có thể làm song song",
    },
    questionId: "turn-action",
    budget: deps.budget(),
  });

  if (outcome.status !== "answered") {
    return {
      status: "fallback",
      reason: outcome.status === "unavailable" ? outcome.reason : `the selector did not decide: ${outcome.reason}`,
    };
  }
  if (!outcome.value.substantive) return { status: "fallback", reason: "the selector had no preference" };

  const decisive = isDecisive(
    outcome.value.top,
    outcome.value.runnerUp,
    deps.jev.config.confidenceFloor,
    deps.jev.config.marginFloor,
  );
  if (!decisive.decisive) return { status: "fallback", reason: decisive.reason };

  const choice = outcome.value.choice;
  if (choice !== "steer" && choice !== "interrupt" && choice !== "background") {
    return { status: "fallback", reason: "the selector chose something that was not an action" };
  }
  return {
    status: "decided",
    action: choice,
    confidence: outcome.value.confidence ?? outcome.value.top,
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

  const budget = deps.budget();

  const choice = await askChoice(deps.jev, {
    state: { query: redactSecrets(input.query).slice(0, 300) },
    instructions: "Which of these earlier records is the one the question is about? Choose none if none of them is.",
    criteria,
    questionId: "result",
    budget,
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
    budget,
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
  /** Overrides the decision deadline; defaults to the plan's value, not the composition one. */
  timeoutMs?: number;
}): DeciderWiring {
  const deps: DecideDeps = {
    jev: input.onTelemetry === undefined ? input.jev : { ...input.jev, onTelemetry: input.onTelemetry },
    // A decision, so it gets the decision deadline: a factory that defaulted to the composition
    // budget would hand whoever wired it next four seconds for a second opinion.
    budget: () =>
      searchDecisionBudget(input.jev.config, {
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.now === undefined ? {} : { now: input.now }),
      }),
  };
  return {
    deps,
    available: () => jevCallRefusal(input.jev.config) === undefined,
  };
}

export { NONE_OPTION };
