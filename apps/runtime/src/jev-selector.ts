import {
  type CompositionSlot,
  type MiniAppSelection,
  checkSelectionAgainstCandidates,
  findSecretShapes,
  noulVerdict,
  selectionIsDecisive,
} from "@clarkcant/contracts";

import {
  type JevSelectionState,
  type MiniAppCandidateSet,
  buildSelectionState,
  checkSelectionStateSize,
  sanitizeIntent,
  stateLooksRedacted,
} from "./mini-app-candidates.ts";
import { type DecisionConfig, JEV_POLICY_VERSION, decisionCallRefusal, decisionConfigFromEnv } from "./decision-config.ts";
import {
  DEFAULT_DECISION_PROVIDER,
  type DecisionProviderId,
  decisionProviderFor,
  recordedDecisionProvider,
} from "./decision-provider.ts";
import {
  type DecisionTransport,
  type DecisionTransportRequest,
  type DecisionTransportResponse,
  EndpointRefusedError,
  createFetchTransport,
  validateProviderEndpoint,
} from "./decision-transport.ts";
import { type SystemOneAnswer, type SystemOneResponse, systemOneAnswerSchema, systemOneResponseSchema } from "./system-one-wire.ts";
import { JEV_DEFAULT_ENDPOINT, JEV_EXACT_MODEL } from "./typesafe-decision-provider.ts";

/**
 * The selector: Clark's side of every typed decision.
 *
 * A decision provider makes one kind of decision: choose among options the host has already
 * authorized, or say that none of them fits. Everything in this file exists to keep that sentence true — the model
 * is handed opaque ids and field names, its answer is checked against the candidates that were
 * offered, and a low-confidence or malformed answer is reported as such rather than rounded into
 * a choice.
 *
 * Three decisions are worth naming because they are choices, not defaults:
 *
 * 1. **Native fetch, no SDK.** The SDK retries and owns its own timeout; the host needs one
 *    bounded call with a deadline it can reason about, and a redaction path it can point at.
 * 2. **No retry.** A 429 or 529 becomes `unavailable` with a reason. Retrying inside a four-second
 *    budget turns one slow answer into a late one.
 * 3. **The model id in the response is compared to the configured one.** The smoke test resolved
 *    `jev-latest` to `jev-1.13.0`; silently accepting whatever answers means a policy tuned
 *    against one model is eventually evaluated against another.
 */

/*
 * The names this module has always exported. Configuration, transport and wire parsing now live in provider-neutral
 * modules, and every existing importer keeps working through these.
 */
export type JevConfig = DecisionConfig;
export type JevTransportRequest = DecisionTransportRequest;
export type JevTransportResponse = DecisionTransportResponse;
export type JevTransport = DecisionTransport;
export type JevAnswer = SystemOneAnswer;
export const jevConfigFromEnv = decisionConfigFromEnv;
export const jevCallRefusal = decisionCallRefusal;
export const jevAnswerSchema = systemOneAnswerSchema;
export const jevResponseSchema = systemOneResponseSchema;
export { JEV_DEFAULT_ENDPOINT, JEV_EXACT_MODEL, JEV_POLICY_VERSION, createFetchTransport, validateProviderEndpoint };

/* ------------------------------------------------------------------ *
 * Budget and telemetry
 * ------------------------------------------------------------------ */

export interface JevBudget {
  /** Absolute deadline for the whole composition step, in the caller's clock. */
  deadlineAt: number;
  /**
   * The total this budget was created with.
   *
   * Recorded because a decision budget is shorter than the configured composition timeout, and a
   * refusal that reported the configured value would name a deadline that was never enforced.
   */
  timeoutMs?: number;
}

export function createJevBudget(config: JevConfig, now: () => number = Date.now): JevBudget {
  return { deadlineAt: now() + config.timeoutMs, timeoutMs: config.timeoutMs };
}

/**
 * Milliseconds left, read from the *deps* clock rather than from the clock the budget was created
 * with. One clock per call site: a budget that kept its own time would disagree with an injected
 * test clock, and the disagreement would show up as a call that should have been refused.
 */
export function remainingBudget(deps: JevDeps, budget: JevBudget): number {
  return budget.deadlineAt - (deps.now ?? Date.now)();
}

/** One line per call. Contains no request body, no prompt, no headers and no key. */
export interface JevTelemetry {
  requestId: string;
  event: "call" | "refusal" | "policy" | "model_drift" | "error" | "oversized_state";
  model: string;
  policyVersion: string;
  durationMs: number;
  status: "answered" | "abstained" | "unavailable";
  questionCount: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The enum that was selected, when there was one. Never free text from a model. */
  selection?: string;
  reason?: string;
  /** Which provider was asked. Absent means TypeSafe, so a line from a default node reads exactly as it always has. */
  provider?: DecisionProviderId;
}

export interface JevDeps {
  config: JevConfig;
  transport?: JevTransport;
  now?: () => number;
  /** Injected so a test can read the telemetry rather than mock the logger. */
  onTelemetry?: (event: JevTelemetry) => void;
  newRequestId?: () => string;
}

/** The longest provider-supplied model id this node records; a real id is far shorter. */
const MAX_RECORDED_MODEL_LENGTH = 64;

let requestCounter = 0;

function defaultRequestId(): string {
  requestCounter += 1;
  return `jevreq_${Date.now().toString(36)}${requestCounter.toString(36)}`;
}

/** The provider a configuration selects; a configuration that names none means TypeSafe. */
function providerOf(config: JevConfig): DecisionProviderId {
  return config.provider ?? DEFAULT_DECISION_PROVIDER;
}

function emit(deps: JevDeps, event: JevTelemetry): void {
  const provider = recordedDecisionProvider(deps.config);
  deps.onTelemetry?.(provider === undefined ? event : { ...event, provider });
}

/* ------------------------------------------------------------------ *
 * Question shapes
 * ------------------------------------------------------------------ */

export interface ChoiceQuestion {
  instructions: string;
  /** Option id to rubric description. The host always adds the `none` option itself. */
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export const NONE_OPTION = "none";

/** Every template question offers `none`, which is what makes abstaining representable. */
export function withNoneOption(criteria: Record<string, string | null>): Record<string, string | null> {
  if (Object.hasOwn(criteria, NONE_OPTION)) return criteria;
  return { ...criteria, [NONE_OPTION]: "None of these fits what the user asked for" };
}

/* ------------------------------------------------------------------ *
 * Call results
 * ------------------------------------------------------------------ */

export interface ChoiceAnswerValue {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | undefined;
  /** Highest probability, read from the distribution rather than from `confidence`. */
  top: number;
  runnerUp: number | undefined;
  margin: number | undefined;
  substantive: boolean;
}

export type ChoiceOutcome =
  | { status: "answered"; value: ChoiceAnswerValue }
  | { status: "abstained"; reason: string }
  | { status: "unavailable"; reason: string };

export type NoulOutcome =
  | { status: "answered"; probability: number; verdict: "on" | "off" | "uncertain" }
  | { status: "abstained"; reason: string }
  | { status: "unavailable"; reason: string };

interface CallInput {
  state: JevSelectionState | Record<string, unknown> | string;
  questions: Record<string, unknown>;
  budget: JevBudget;
}

/** Why a call could not be made, without saying anything about the request contents. */
function refusalReason(deps: JevDeps, budget: JevBudget): string | undefined {
  const refused = jevCallRefusal(deps.config);
  if (refused !== undefined) return refused;
  if (remainingBudget(deps, budget) <= 0) {
    return "the selector budget for this turn was exhausted before the call";
  }
  return undefined;
}

/** The shapes no id, model name or description takes by accident, which the last look before a send refuses outright. */
const CREDENTIAL_ONLY_SHAPES: ReadonlySet<string> = new Set([
  "jwt",
  "private-key",
  "aws-access-key",
  "github-token",
  "google-api-key",
  "url-credentials",
  "bearer",
  "named-secret",
]);

/**
 * Make one bounded call.
 *
 * The abort timer is set from the *remaining budget*, not from a per-call timeout, so two calls
 * in one turn cannot each spend the full deadline. Cancellation propagates into fetch, which is
 * why the deadline is an AbortSignal rather than a race against a promise that keeps running.
 */
async function callProvider(
  deps: JevDeps,
  input: CallInput,
): Promise<{ ok: true; response: SystemOneResponse } | { ok: false; status: "abstained" | "unavailable"; reason: string }> {
  const now = deps.now ?? Date.now;
  const refused = refusalReason(deps, input.budget);
  const requestId = (deps.newRequestId ?? defaultRequestId)();
  const questionCount = Object.keys(input.questions).length;

  if (refused !== undefined) {
    emit(deps, {
      event: "refusal",
      requestId,
      model: deps.config.model,
      policyVersion: deps.config.policyVersion,
      durationMs: 0,
      status: "unavailable",
      questionCount,
      reason: refused,
    });
    return { ok: false, status: "unavailable", reason: refused };
  }

  const body = { state: input.state, model: deps.config.model, questions: input.questions };
  /*
   * One last look at exactly what would leave the node, whichever provider receives it.
   *
   * Each caller redacts its own free text first; this is the backstop for a field that did not, such as an option's
   * description. It looks only for shapes that are a credential and nothing else. The broad shapes are left to the
   * callers: a request is mostly ids and descriptions, and a dated model id reads as a phone number and a widget
   * called `key-metrics-overview` as a prefixed token, so matching those here would refuse ordinary decisions.
   *
   * A hit is not sent redacted - redaction already ran and missed it - it is not sent at all, and the caller falls
   * back as it would for any provider failure. Only the shape labels are recorded: the detector's match text is the
   * beginning of the very value being withheld.
   */
  const secretShapes = findSecretShapes(JSON.stringify(body))
    .map((match) => match.split(":")[0] ?? "secret")
    .filter((label) => CREDENTIAL_ONLY_SHAPES.has(label));
  if (secretShapes.length > 0) {
    const reason = `the decision request still carried a secret-shaped value (${[...new Set(secretShapes)].join(", ")}), so it was not sent`;
    emit(deps, {
      event: "refusal",
      requestId,
      model: deps.config.model,
      policyVersion: deps.config.policyVersion,
      durationMs: 0,
      status: "unavailable",
      questionCount,
      reason,
    });
    return { ok: false, status: "unavailable", reason };
  }

  const transport = deps.transport ?? createFetchTransport();
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("jev deadline")),
    Math.max(1, remainingBudget(deps, input.budget)),
  );

  try {
    const response = await transport({
      url: deps.config.endpoint,
      apiKey: deps.config.apiKey as string,
      body,
      signal: controller.signal,
    });
    const durationMs = now() - startedAt;

    if (response.status !== 200) {
      /*
       * A request the provider refused is named together with the model this node pinned.
       *
       * "HTTP 400" on its own leaves an operator guessing whether the key, the body or the pinned id was wrong, and
       * this node pins a model precisely so that it is never evaluated against a different one. A transient status
       * keeps its own reason: a rate limit has nothing to do with which model was pinned.
       */
      const requestRefused = response.status === 400 || response.status === 404 || response.status === 422;
      const reason = requestRefused
        ? `${reasonForStatus(response.status)} but this node pinned ${deps.config.model}`
        : reasonForStatus(response.status);
      emit(deps, {
        event: "error",
        requestId,
        model: deps.config.model,
        policyVersion: deps.config.policyVersion,
        durationMs,
        status: "unavailable",
        questionCount,
        reason,
      });
      return { ok: false, status: "unavailable", reason };
    }

    // The adapter unwraps its provider's envelope; what comes back is System One or nothing.
    const answered = decisionProviderFor(providerOf(deps.config)).readResponse(response.body);
    if (answered === undefined) {
      const reason = "the provider response did not match the documented answer shape";
      emit(deps, {
        event: "error",
        requestId,
        model: deps.config.model,
        policyVersion: deps.config.policyVersion,
        durationMs,
        status: "unavailable",
        questionCount,
        reason,
      });
      return { ok: false, status: "unavailable", reason };
    }

    const usage = answered.usage;
    const drift = answered.model !== deps.config.model;
    // The id is the provider's text, so it is bounded before it is recorded or repeated in a reason.
    const answeredModel = answered.model.slice(0, MAX_RECORDED_MODEL_LENGTH);
    emit(deps, {
      event: drift ? "model_drift" : "call",
      requestId,
      model: answeredModel,
      policyVersion: deps.config.policyVersion,
      durationMs,
      status: "answered",
      questionCount,
      ...(usage === undefined ? {} : { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }),
      ...(drift ? { reason: `the provider answered with ${answeredModel}, not the pinned ${deps.config.model}` } : {}),
    });

    if (drift) {
      // Refused rather than accepted. A pinned id exists so the same policy is not silently
      // evaluated against a different model.
      return {
        ok: false,
        status: "unavailable",
        reason: `the provider answered with ${answeredModel} but this node pinned ${deps.config.model}`,
      };
    }

    return { ok: true, response: answered };
  } catch (cause) {
    const durationMs = now() - startedAt;
    const aborted = controller.signal.aborted;
    const reason = aborted
      ? `the selector call exceeded the ${input.budget.timeoutMs ?? deps.config.timeoutMs} ms deadline for this decision`
      : cause instanceof EndpointRefusedError
        ? `the selector endpoint was refused before the call: ${cause.message}`
        : "the selector call failed before a response arrived";
    emit(deps, {
      event: "error",
      requestId,
      model: deps.config.model,
      policyVersion: deps.config.policyVersion,
      durationMs,
      status: "unavailable",
      questionCount,
      reason,
    });
    void cause;
    return { ok: false, status: "unavailable", reason };
  } finally {
    clearTimeout(timer);
  }
}

function reasonForStatus(status: number): string {
  switch (status) {
    case 401:
      return "the provider rejected the credential (401); check the key rather than the request";
    case 422:
      return "the provider rejected the request body (422)";
    case 429:
      return "the provider is rate limiting this node (429)";
    case 529:
      return "the provider reported itself overloaded (529)";
    default:
      return `the provider answered with HTTP ${status}`;
  }
}

/**
 * Ask a Choice question.
 *
 * The returned value carries the whole distribution, not just the winner, because the decision to
 * act needs the margin and the caller should not have to re-derive it. `substantive` is false when
 * the winner is `none`, which is a legitimate answer rather than a failure to answer.
 */
export async function askChoice(
  deps: JevDeps,
  request: ChoiceQuestion & { state: JevSelectionState | Record<string, unknown> | string; budget: JevBudget; questionId?: string },
): Promise<ChoiceOutcome> {
  const questionId = request.questionId ?? "choice";
  const criteria = withNoneOption(request.criteria);
  const options = Object.keys(criteria);
  if (options.length < 2) {
    return { status: "abstained", reason: "a Choice question needs at least two options besides none" };
  }

  const result = await callProvider(deps, {
    state: request.state,
    questions: { [questionId]: { type: "choice", instructions: request.instructions, criteria } },
    budget: request.budget,
  });
  if (!result.ok) return { status: result.status, reason: result.reason };

  const answer = result.response.answers[questionId];
  if (answer === undefined || answer.type !== "choice") {
    return { status: "abstained", reason: `the provider returned no Choice answer for ${questionId}` };
  }
  if (!criteria[answer.choice] && !Object.hasOwn(criteria, answer.choice)) {
    return { status: "abstained", reason: `the provider chose ${answer.choice}, which was not an option` };
  }

  const probabilities: Record<string, number> = {};
  for (const [option, probability] of Object.entries(answer.probabilities)) {
    if (!Object.hasOwn(criteria, option)) continue;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { status: "abstained", reason: `the probability for ${option} was not a value in [0,1]` };
    }
    probabilities[option] = probability;
  }
  const missing = options.filter((option) => probabilities[option] === undefined);
  if (missing.length > 0) {
    return { status: "abstained", reason: `the distribution omitted ${missing.join(", ")}` };
  }

  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const runnerUp = ranked[1]?.[1];
  const margin = runnerUp === undefined ? undefined : top - runnerUp;

  return {
    status: "answered",
    value: {
      choice: answer.choice,
      probabilities,
      confidence: answer.confidence,
      top,
      runnerUp,
      margin,
      substantive: answer.choice !== NONE_OPTION,
    },
  };
}

/**
 * Ask a Noul question.
 *
 * A Noul answer has no confidence field, so the middle band is reported as `uncertain`. The smoke
 * test returned 0.58 for a general calendar question, which is exactly the answer that must not be
 * rounded to a boolean.
 */
export async function askNoul(
  deps: JevDeps,
  request: NoulQuestion & { state: JevSelectionState | Record<string, unknown> | string; budget: JevBudget; questionId?: string },
): Promise<NoulOutcome> {
  const questionId = request.questionId ?? "noul";
  const result = await callProvider(deps, {
    state: request.state,
    questions: {
      [questionId]: {
        type: "noul",
        instructions: request.instructions,
        ...(request.criteria === undefined ? {} : { criteria: request.criteria }),
      },
    },
    budget: request.budget,
  });
  if (!result.ok) return { status: result.status, reason: result.reason };

  const answer = result.response.answers[questionId];
  if (answer === undefined || answer.type !== "noul") {
    return { status: "abstained", reason: `the provider returned no Noul answer for ${questionId}` };
  }
  if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    return { status: "abstained", reason: "the Noul answer was not a probability in [0,1]" };
  }

  return {
    status: "answered",
    probability: answer.noul,
    verdict: noulVerdict(answer.noul, { on: deps.config.noulOnFloor, off: deps.config.noulOffFloor }),
  };
}

/* ------------------------------------------------------------------ *
 * Template selection
 * ------------------------------------------------------------------ */

export type TemplateSelectionOutcome =
  | { status: "selected"; templateId: string; templateVersion: string; confidence: number | undefined; margin: number | undefined; probedAt: number }
  | { status: "abstained"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Ask which template fits an intent.
 *
 * The criteria are the templates themselves, nothing else. `none` is always offered by
 * `askChoice`, and a decisive `none` is reported as an abstention so the caller falls back rather
 * than compiling a template the model did not actually choose.
 */
export async function selectTemplate(
  deps: JevDeps,
  input: {
    intent: string;
    candidateSet: MiniAppCandidateSet;
    budget: JevBudget;
    instructions?: string;
  },
): Promise<TemplateSelectionOutcome> {
  if (input.candidateSet.templates.length === 0) {
    return { status: "abstained", reason: "no templates were offered, so there was nothing to choose" };
  }
  // One candidate is not a decision. Calling the provider to confirm it would spend the budget to
  // learn what the caller already knows.
  if (input.candidateSet.templates.length === 1) {
    const only = input.candidateSet.templates[0]!;
    return {
      status: "selected",
      templateId: only.templateId,
      templateVersion: only.templateVersion,
      confidence: undefined,
      margin: undefined,
      probedAt: (deps.now ?? Date.now)(),
    };
  }

  const state = buildSelectionState(input.candidateSet, input.intent);
  const sizeCheck = checkSelectionStateSize(state);
  if (!sizeCheck.ok) {
    emit(deps, {
      event: "oversized_state",
      requestId: (deps.newRequestId ?? defaultRequestId)(),
      model: deps.config.model,
      policyVersion: deps.config.policyVersion,
      durationMs: 0,
      status: "unavailable",
      questionCount: 1,
      reason: sizeCheck.message,
    });
    return { status: "unavailable", reason: sizeCheck.message };
  }
  const redaction = stateLooksRedacted(state);
  if (!redaction.ok) {
    return {
      status: "abstained",
      reason: `the sanitised state still matched a secret-shaped value (${redaction.matches.map((match) => match.split(":")[0]).join(", ")}); refusing to send it`,
    };
  }

  const criteria: Record<string, string | null> = {};
  for (const template of input.candidateSet.templates) {
    criteria[`${template.templateId}@${template.templateVersion}`] = template.label;
  }

  const outcome = await askChoice(deps, {
    state,
    budget: input.budget,
    questionId: "template",
    instructions:
      input.instructions ??
      "Choose the presentation template that best fits what the user asked for. Choose none if no template fits.",
    criteria,
  });

  if (outcome.status !== "answered") return outcome;

  const decision = selectionIsDecisive({
    top: outcome.value.top,
    ...(outcome.value.runnerUp === undefined ? {} : { runnerUp: outcome.value.runnerUp }),
    floor: deps.config.confidenceFloor,
    margin: deps.config.marginFloor,
  });

  const emitPolicy = (selection: string | undefined, reason: string | undefined): void => {
    emit(deps, {
      event: "policy",
      requestId: (deps.newRequestId ?? defaultRequestId)(),
      model: deps.config.model,
      policyVersion: deps.config.policyVersion,
      durationMs: 0,
      status: selection === undefined ? "abstained" : "answered",
      questionCount: 1,
      ...(selection === undefined ? {} : { selection }),
      ...(reason === undefined ? {} : { reason }),
    });
  };

  if (!outcome.value.substantive) {
    emitPolicy(undefined, "the selector chose none of the offered templates");
    return { status: "abstained", reason: "the selector chose none of the offered templates" };
  }
  if (!decision.decisive) {
    emitPolicy(undefined, decision.reason);
    return { status: "abstained", reason: decision.reason };
  }

  const chosen = input.candidateSet.templates.find(
    (template) => `${template.templateId}@${template.templateVersion}` === outcome.value.choice,
  );
  if (chosen === undefined) {
    emitPolicy(undefined, "the selector chose a template that was not a candidate");
    return { status: "abstained", reason: "the selector chose a template that was not a candidate" };
  }

  emitPolicy(outcome.value.choice, undefined);
  return {
    status: "selected",
    templateId: chosen.templateId,
    templateVersion: chosen.templateVersion,
    confidence: outcome.value.confidence ?? outcome.value.top,
    margin: outcome.value.margin,
    probedAt: (deps.now ?? Date.now)(),
  };
}

/* ------------------------------------------------------------------ *
 * Section selection
 * ------------------------------------------------------------------ */

export interface SectionSelectionInput {
  intent: string;
  candidateSet: MiniAppCandidateSet;
  template: { templateId: string; templateVersion: string; slots: readonly CompositionSlot[] };
  budget: JevBudget;
  /** Slots that must be filled by the template itself and are not offered to the model. */
  fixedSlots?: readonly CompositionSlot[];
}

/**
 * Ask which renderer fills each slot.
 *
 * One batch, one question per slot. The provider evaluates questions independently against the
 * same state, so there is no order dependency between them and no reason to spend a second round
 * trip. The combination is validated afterwards rather than being assumed to be coherent.
 */
export async function selectSections(
  deps: JevDeps,
  input: SectionSelectionInput,
): Promise<{ status: "selected"; selection: Extract<MiniAppSelection, { status: "selected" }> } | { status: "abstained" | "unavailable"; reason: string }> {
  const fixed = new Set(input.fixedSlots ?? []);
  const slots = input.template.slots.filter((slot) => !fixed.has(slot));
  if (slots.length === 0) {
    return {
      status: "abstained",
      reason: "every slot in this template is fixed, so there was nothing to select",
    };
  }

  const state = buildSelectionState(input.candidateSet, input.intent);
  const sizeCheck = checkSelectionStateSize(state);
  if (!sizeCheck.ok) return { status: "unavailable", reason: sizeCheck.message };

  const questions: Record<string, unknown> = {};
  const definitionsBySlot = new Map<CompositionSlot, { id: string; version: string }[]>();
  for (const slot of slots) {
    const candidates = input.candidateSet.definitions.filter((definition) => definition.family === slot);
    if (candidates.length === 0) continue;
    definitionsBySlot.set(slot, candidates);
    const criteria: Record<string, string | null> = {};
    for (const candidate of candidates) criteria[`${candidate.id}@${candidate.version}`] = candidate.family;
    questions[`section.${slot}`] = {
      type: "choice",
      instructions: `Choose the renderer for the "${slot}" region. Choose none if nothing fits.`,
      criteria: withNoneOption(criteria),
    };
  }

  if (Object.keys(questions).length === 0) {
    return { status: "abstained", reason: "no slot had a candidate renderer, so there was nothing to select" };
  }

  const result = await callProvider(deps, { state, questions, budget: input.budget });
  if (!result.ok) return { status: result.status, reason: result.reason };

  const sections: { slot: CompositionSlot; definitionId: string; definitionVersion: string }[] = [];
  for (const [slot, candidates] of definitionsBySlot) {
    const answer = result.response.answers[`section.${slot}`];
    if (answer === undefined || answer.type !== "choice") continue;
    if (answer.choice === NONE_OPTION) continue;
    const match = candidates.find((candidate) => `${candidate.id}@${candidate.version}` === answer.choice);
    if (match === undefined) {
      return { status: "abstained", reason: `the selector chose an unoffered renderer for ${slot}` };
    }
    sections.push({ slot, definitionId: match.id, definitionVersion: match.version });
  }

  if (sections.length === 0) {
    return { status: "abstained", reason: "the selector declined every offered renderer" };
  }

  const selection: MiniAppSelection = {
    status: "selected",
    templateId: input.template.templateId,
    templateVersion: input.template.templateVersion,
    sections,
  };

  const check = checkSelectionAgainstCandidates(
    selection as Extract<MiniAppSelection, { status: "selected" }>,
    {
      templates: [{ templateId: input.template.templateId, templateVersion: input.template.templateVersion }],
      definitions: input.candidateSet.definitions.map((definition) => ({ id: definition.id, version: definition.version })),
      dataRefs: input.candidateSet.data.map((entry) => entry.ref),
      slotsForTemplate: () => input.template.slots,
    },
  );
  if (!check.ok) {
    return { status: "abstained", reason: `the selected combination was not valid: ${check.problems.join("; ")}` };
  }

  return { status: "selected", selection: selection as Extract<MiniAppSelection, { status: "selected" }> };
}

/** Exposed so a caller can decide local-first behaviour without importing the sanitiser twice. */
export { sanitizeIntent };
