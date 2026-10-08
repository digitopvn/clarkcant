import { describe, expect, it } from "vitest";

import { type DecisionConfig, decisionCallRefusal, decisionConfigFromEnv } from "../src/decision-config.ts";
import type { DecisionTransport } from "../src/decision-transport.ts";
import { type JevTelemetry, askNoul, createJevBudget, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";
import { OPENROUTER_DECISIONS_ENDPOINT, openrouterDecisionProvider } from "../src/openrouter-decision-provider.ts";

/**
 * OpenRouter's decisions API as a decision provider.
 *
 * The two fixtures below are OpenRouter's own documented example request and response for
 * `POST https://openrouter.ai/api/alpha/decisions` (API reference, "Submit a Decisions request", read 2026-10-08),
 * copied as written. They are the evidence that the wire shape is the System One shape Clark already sends and reads;
 * nothing here reaches the network. Live evidence is the opt-in `openrouter-live.spec.ts`.
 */

const DOCUMENTED_REQUEST = {
  model: "typesafe/jev-1.13",
  state: "My checkout page shows a blank screen after I click Pay. I have tried two browsers.",
  questions: {
    is_bug: {
      type: "noul",
      instructions: "Is the customer reporting a software defect?",
      criteria: {
        true: "The customer describes broken or unexpected product behavior.",
        false: "The customer is asking a question or requesting a feature.",
      },
    },
    team: {
      type: "choice",
      instructions: "Which team should own this ticket?",
      criteria: {
        account: "Login, permissions, or profile issues.",
        frontend: "Rendering, layout, or browser compatibility issues.",
        payments: "Checkout, billing, or payment processing issues.",
      },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["Can wait for the next release", "Should be fixed this week", "Blocking revenue right now"],
    },
  },
};

const DOCUMENTED_RESPONSE = {
  id: "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    is_bug: { type: "noul", noul: 0.96 },
    team: {
      type: "choice",
      choice: "payments",
      confidence: 0.75,
      probabilities: { account: 0, frontend: 0.16, payments: 0.84 },
    },
    urgency: {
      type: "score",
      score: 1.99,
      confidence: 0.99,
      probabilities: { "0": 0, "1": 0.01, "2": 0.99 },
      legend: { "0": "Can wait for the next release", "1": "Should be fixed this week", "2": "Blocking revenue right now" },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

const MODEL = "typesafe/jev-1.13";
const KEY = "or-test-key-not-a-real-one";

function openrouterEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CLARKCANT_DECISION_PROVIDER: "openrouter", CLARKCANT_DECISION_MODEL: MODEL, OPENROUTER_API_KEY: KEY, ...overrides };
}

interface RecordedCall {
  url: string;
  apiKey: string;
  body: { state: unknown; model: string; questions: Record<string, { type: string }> };
}

function recordedTransport(responses: readonly { status: number; body?: unknown }[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const transport: DecisionTransport = async (request) => {
    calls.push({ url: request.url, apiKey: request.apiKey, body: request.body as RecordedCall["body"] });
    const response = responses[Math.min(index, responses.length - 1)] ?? { status: 503 };
    index += 1;
    return { status: response.status, body: response.body };
  };
  return { transport, calls };
}

/** OpenRouter's envelope-free answer, with the fields it adds beside System One's. */
function answered(answers: Record<string, unknown>, model = `${MODEL}-20260917`): { status: number; body: unknown } {
  return {
    status: 200,
    body: { id: "gen-dec-test", model, provider: "TypeSafe", answers, usage: { input_tokens: 30, output_tokens: 4, cost: 0.00001 } },
  };
}

const CANDIDATES: MiniAppCandidateSet = {
  locale: "vi-VN",
  templates: [
    { templateId: "overview", templateVersion: "1", label: "Work overview", slots: ["trend"] },
    { templateId: "focused", templateVersion: "1", label: "One chart only", slots: ["trend"] },
  ],
  definitions: [{ id: "canvas.line@1", version: "1.0.0", family: "trend", fields: ["datasetRef:string!"] }],
  data: [{ ref: "ds_tasks", kind: "tasks", label: "Tasks", scale: "small", freshness: "live" }],
};

const decisiveTemplate = {
  template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.95, "focused@1": 0.04, none: 0.01 }, confidence: 0.93 },
};

async function selectWith(config: DecisionConfig, responses: readonly { status: number; body?: unknown }[]) {
  const recorded = recordedTransport(responses);
  const telemetry: JevTelemetry[] = [];
  const outcome = await selectTemplate(
    { config, transport: recorded.transport, onTelemetry: (event) => telemetry.push(event) },
    { intent: "cho tôi tổng quan công việc", candidateSet: CANDIDATES, budget: createJevBudget(config) },
  );
  return { outcome, calls: recorded.calls, telemetry };
}

describe("OpenRouter's documented wire shape", () => {
  it("is the System One request Clark already sends: model, state and typed questions", () => {
    expect(Object.keys(DOCUMENTED_REQUEST).sort()).toEqual(["model", "questions", "state"]);
    for (const question of Object.values(DOCUMENTED_REQUEST.questions)) {
      expect(["noul", "choice", "score"]).toContain(question.type);
    }
  });

  it("reads the documented response as a System One answer, dropping only OpenRouter's extra fields", () => {
    const read = openrouterDecisionProvider.readResponse(DOCUMENTED_RESPONSE);
    expect(read).toBeDefined();
    expect(read?.model).toBe("typesafe/jev-1.13-20260917");
    expect(read?.answers).toEqual(DOCUMENTED_RESPONSE.answers);
    expect(read?.usage).toEqual({ input_tokens: 476, output_tokens: 70 });
    expect(read).not.toHaveProperty("id");
    expect(read).not.toHaveProperty("provider");
  });

  it("accepts the dated snapshot of the pinned model, and nothing looser", () => {
    const same = openrouterDecisionProvider.answersAs!;
    expect(same(MODEL, MODEL)).toBe(true);
    expect(same(MODEL, "typesafe/jev-1.13-20260917")).toBe(true);
    expect(same(MODEL, "typesafe/jev-1.14")).toBe(false);
    expect(same(MODEL, "typesafe/jev-1.13-latest")).toBe(false);
    expect(same(MODEL, "typesafe/jev-1.13-2026091")).toBe(false);
    expect(same(MODEL, "typesafe/jev-1.13.1")).toBe(false);
    expect(same(MODEL, "cloudflare/clef")).toBe(false);
  });
});

describe("selecting OpenRouter", () => {
  it("calls the one fixed endpoint with the pinned model and the key as a bearer only", async () => {
    const config = decisionConfigFromEnv(openrouterEnv());
    expect(config.provider).toBe("openrouter");
    expect(config.endpoint).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(decisionCallRefusal(config)).toBeUndefined();

    const { outcome, calls, telemetry } = await selectWith(config, [answered(decisiveTemplate)]);
    expect(outcome.status).toBe("selected");
    const call = calls[0]!;
    expect(call.url).toBe(OPENROUTER_DECISIONS_ENDPOINT);
    expect(Object.keys(call.body).sort()).toEqual(["model", "questions", "state"]);
    expect(call.body.model).toBe(MODEL);
    expect(call.apiKey).toBe(KEY);
    expect(JSON.stringify(call.body)).not.toContain(KEY);
    expect(JSON.stringify(telemetry)).not.toContain(KEY);
    // The resolved snapshot is what telemetry records, beside the provider that served it.
    expect(telemetry.find((event) => event.event === "call")).toMatchObject({
      provider: "openrouter",
      model: `${MODEL}-20260917`,
      inputTokens: 30,
    });
  });

  it("maps a Noul answer", async () => {
    const config = decisionConfigFromEnv(openrouterEnv());
    const { transport } = recordedTransport([answered({ noul: { type: "noul", noul: 0.96 } })]);
    const outcome = await askNoul(
      { config, transport },
      { state: { intent: "lịch" }, instructions: "Is this about a calendar?", budget: createJevBudget(config) },
    );
    // The outcome names the provider and pinned model whose call answered, which provenance records.
    expect(outcome).toEqual({ status: "answered", probability: 0.96, verdict: "on", decidedBy: { model: MODEL, provider: "openrouter" } });
  });

  it("refuses an answer from another model as drift", async () => {
    const config = decisionConfigFromEnv(openrouterEnv());
    const { outcome, telemetry } = await selectWith(config, [answered(decisiveTemplate, "typesafe/jev-1.14-20261001")]);
    expect(outcome.status).toBe("unavailable");
    expect(telemetry.some((event) => event.event === "model_drift")).toBe(true);
  });

  it("refuses, before any call, a missing, unpinned or malformed model slug", async () => {
    for (const model of [undefined, "", "~typesafe/jev-latest", "jev-1.13.0", "https://evil.example/x", "Typesafe/Jev", "a/".padEnd(200, "b"), "openrouter/auto"]) {
      const config = decisionConfigFromEnv(openrouterEnv({ CLARKCANT_DECISION_MODEL: model }));
      expect(decisionCallRefusal(config)).toContain("CLARKCANT_DECISION_MODEL");
      const { outcome, calls } = await selectWith(config, [answered(decisiveTemplate)]);
      expect(outcome.status).toBe("unavailable");
      expect(calls).toHaveLength(0);
    }
  });

  it("uses its own card's key over the environment's, and never another provider's", () => {
    const own = (provider: string): string | undefined => (provider === "openrouter" ? "or-card-key" : undefined);
    expect(decisionConfigFromEnv(openrouterEnv(), own).apiKey).toBe("or-card-key");
    const other = (provider: string): string | undefined => (provider === "typesafe" ? "ts-card-key" : undefined);
    const config = decisionConfigFromEnv(openrouterEnv({ OPENROUTER_API_KEY: undefined, TYPESAFE_API_KEY: "ts-env" }), other);
    expect(config.apiKey).toBeUndefined();
    expect(config.enabled).toBe(false);
  });

  it("stays local-only when the operator says so", () => {
    expect(decisionCallRefusal(decisionConfigFromEnv(openrouterEnv({ CLARKCANT_JEV_LOCAL_ONLY: "1" })))).toContain("local-only");
  });

  it("falls back on every documented failure without reading the error body", async () => {
    const config = decisionConfigFromEnv(openrouterEnv());
    for (const status of [400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529]) {
      const { outcome, calls } = await selectWith(config, [{ status, body: { error: { message: "echo of the request" } } }]);
      expect(outcome.status).toBe("unavailable");
      expect(calls).toHaveLength(1);
      if (outcome.status === "unavailable") expect(outcome.reason).not.toContain("echo of the request");
    }
  });

  it("treats a response that is not the documented shape as malformed", async () => {
    const config = decisionConfigFromEnv(openrouterEnv());
    for (const body of [
      { success: true, result: DOCUMENTED_RESPONSE },
      { model: MODEL, answers: { template: { type: "choice", choice: "overview@1" } } },
      { model: MODEL },
      "yes",
    ]) {
      const { outcome } = await selectWith(config, [{ status: 200, body }]);
      expect(outcome).toEqual({
        status: "unavailable",
        reason: "the provider response did not match the documented answer shape",
        decidedBy: { model: MODEL, provider: "openrouter" },
      });
    }
  });
});
