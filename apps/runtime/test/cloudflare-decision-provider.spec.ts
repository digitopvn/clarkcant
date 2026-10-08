import { describe, expect, it } from "vitest";

import { cloudflareDecisionProvider, workersAiEndpoint } from "../src/cloudflare-decision-provider.ts";
import { type DecisionConfig, decisionCallRefusal, decisionConfigFromEnv } from "../src/decision-config.ts";
import type { DecisionTransport } from "../src/decision-transport.ts";
import { createFetchTransport } from "../src/decision-transport.ts";
import { type JevTelemetry, askNoul, createJevBudget, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";
import { JEV_DEFAULT_ENDPOINT, JEV_EXACT_MODEL } from "../src/typesafe-decision-provider.ts";

/**
 * The Cloudflare Workers AI decision provider.
 *
 * Every provider call here goes through a recording transport, or through `fetch` replaced in place for the one test
 * about headers, so what is asserted is exactly what would have crossed the wire and nothing reaches the network. No
 * test here is evidence that Clef answers; that is the opt-in `clef-live.spec.ts`.
 */

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-not-a-real-one";

function cloudflareEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CLARKCANT_DECISION_PROVIDER: "cloudflare",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLARKCANT_DECISION_MODEL: "clef",
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  apiKey: string;
  body: { state: unknown; model: string; questions: Record<string, { type: string; criteria?: Record<string, string | null> }> };
}

function recordedTransport(
  responses: readonly { status: number; body?: unknown }[],
): { transport: DecisionTransport; calls: RecordedCall[] } {
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

/** A successful Workers AI REST response: the System One answer inside Cloudflare's envelope. */
function envelope(answers: Record<string, unknown>, model = "clef"): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      success: true,
      errors: [],
      messages: [],
      result: { model, answers, usage: { input_tokens: 40, output_tokens: 6 } },
    },
  };
}

function candidates(): MiniAppCandidateSet {
  return {
    locale: "vi-VN",
    templates: [
      { templateId: "overview", templateVersion: "1", label: "Work overview", slots: ["metrics", "trend"] },
      { templateId: "focused", templateVersion: "1", label: "One chart only", slots: ["trend"] },
    ],
    definitions: [{ id: "canvas.line@1", version: "1.0.0", family: "trend", fields: ["datasetRef:string!"] }],
    data: [{ ref: "ds_tasks", kind: "tasks", label: "Tasks", scale: "small", freshness: "live" }],
  };
}

const decisiveTemplate = {
  template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.95, "focused@1": 0.04, none: 0.01 }, confidence: 0.93 },
};

async function selectWith(config: DecisionConfig, responses: readonly { status: number; body?: unknown }[]) {
  const recorded = recordedTransport(responses);
  const telemetry: JevTelemetry[] = [];
  const outcome = await selectTemplate(
    { config, transport: recorded.transport, onTelemetry: (event) => telemetry.push(event) },
    { intent: "cho tôi tổng quan công việc", candidateSet: candidates(), budget: createJevBudget(config) },
  );
  return { outcome, calls: recorded.calls, telemetry };
}

describe("the default configuration", () => {
  it("still builds the TypeSafe provider with the unchanged model and endpoint", async () => {
    const config = decisionConfigFromEnv({ TYPESAFE_API_KEY: "sk-test-not-a-real-key" });
    expect(config.provider).toBe("typesafe");
    expect(config.model).toBe(JEV_EXACT_MODEL);
    expect(config.model).toBe("jev-1.13.0");
    expect(config.endpoint).toBe(JEV_DEFAULT_ENDPOINT);
    expect(config.endpoint).toBe("https://api.typesafe.ai/v1/systemone");
    expect(decisionCallRefusal(config)).toBeUndefined();

    const { outcome, calls, telemetry } = await selectWith(config, [
      { status: 200, body: { model: "jev-1.13.0", answers: decisiveTemplate } },
    ]);
    expect(outcome.status).toBe("selected");
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]?.body.model).toBe("jev-1.13.0");
    // A default node's telemetry reads exactly as it did before a second provider existed.
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.every((event) => !Object.hasOwn(event, "provider"))).toBe(true);
  });

  it("ignores Cloudflare settings that are present but not selected", () => {
    const config = decisionConfigFromEnv({
      TYPESAFE_API_KEY: "sk-test-not-a-real-key",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: TOKEN,
    });
    expect(config.provider).toBe("typesafe");
    expect(config.endpoint).toBe(JEV_DEFAULT_ENDPOINT);
    expect(config.apiKey).toBe("sk-test-not-a-real-key");
  });

  it("keeps the Jev model name working, and lets the provider-neutral one win", () => {
    expect(decisionConfigFromEnv({ CLARKCANT_JEV_MODEL: "jev-latest" }).model).toBe("jev-latest");
    expect(decisionConfigFromEnv({ CLARKCANT_JEV_MODEL: "jev-latest", CLARKCANT_DECISION_MODEL: "jev-1.13.0" }).model).toBe(
      "jev-1.13.0",
    );
  });
});

describe("selecting Cloudflare", () => {
  it.each(["clef", "clef-flash"] as const)("builds the Workers AI endpoint for %s from validated values", (model) => {
    const config = decisionConfigFromEnv(cloudflareEnv({ CLARKCANT_DECISION_MODEL: model }));
    expect(config.provider).toBe("cloudflare");
    expect(config.model).toBe(model);
    expect(config.endpoint).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/${model}`);
    expect(config.endpoint).toBe(workersAiEndpoint(ACCOUNT, model));
    expect(config.enabled).toBe(true);
    expect(decisionCallRefusal(config)).toBeUndefined();
  });

  it("refuses, before any call, a configuration that does not name a usable model or account", async () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [cloudflareEnv({ CLARKCANT_DECISION_MODEL: undefined }), "CLARKCANT_DECISION_MODEL"],
      [cloudflareEnv({ CLARKCANT_DECISION_MODEL: "jev-1.13.0" }), "CLARKCANT_DECISION_MODEL"],
      [cloudflareEnv({ CLARKCANT_DECISION_MODEL: "@cf/meta/llama" }), "CLARKCANT_DECISION_MODEL"],
      [cloudflareEnv({ CLOUDFLARE_ACCOUNT_ID: undefined }), "CLOUDFLARE_ACCOUNT_ID"],
      [cloudflareEnv({ CLOUDFLARE_ACCOUNT_ID: "../../evil.example/x" }), "CLOUDFLARE_ACCOUNT_ID"],
      [cloudflareEnv({ CLOUDFLARE_ACCOUNT_ID: `${ACCOUNT}/ai/run/@cf/meta` }), "CLOUDFLARE_ACCOUNT_ID"],
      [cloudflareEnv({ CLARKCANT_DECISION_PROVIDER: "cloudfare" }), "CLARKCANT_DECISION_PROVIDER"],
    ];
    for (const [env, named] of cases) {
      const config = decisionConfigFromEnv(env);
      expect(decisionCallRefusal(config)).toContain(named);
      const { outcome, calls } = await selectWith(config, [envelope(decisiveTemplate)]);
      expect(outcome.status).toBe("unavailable");
      expect(calls).toHaveLength(0);
    }
  });

  it("does not fall back to the TypeSafe key, or send to TypeSafe, when Cloudflare has no token", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv({ CLOUDFLARE_API_TOKEN: undefined, TYPESAFE_API_KEY: "sk-test-not-a-real-key" }));
    expect(config.apiKey).toBeUndefined();
    expect(config.enabled).toBe(false);
    const { calls } = await selectWith(config, [envelope(decisiveTemplate)]);
    expect(calls).toHaveLength(0);
  });

  it("refuses Cloudflare too when the node is local-only", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv({ CLARKCANT_JEV_LOCAL_ONLY: "1" }));
    expect(decisionCallRefusal(config)).toContain("local-only");
    // An explicit enable does not reverse it either.
    const forced = decisionConfigFromEnv(cloudflareEnv({ CLARKCANT_JEV_LOCAL_ONLY: "1", CLARKCANT_JEV_ENABLED: "1" }));
    expect(decisionCallRefusal(forced)).toContain("local-only");
    const { outcome, calls } = await selectWith(forced, [envelope(decisiveTemplate)]);
    expect(outcome.status).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("never takes another provider's stored key as the Cloudflare token", async () => {
    // The vault answers by provider; a key saved for TypeSafe must not become Cloudflare's bearer.
    const stored = (provider: string): string | undefined => (provider === "typesafe" ? "stored-typesafe-key" : undefined);
    const config = decisionConfigFromEnv(cloudflareEnv({ CLOUDFLARE_API_TOKEN: undefined }), stored);
    expect(config.apiKey).toBeUndefined();
    expect(config.enabled).toBe(false);
    const { calls } = await selectWith(config, [envelope(decisiveTemplate)]);
    expect(calls).toHaveLength(0);
    expect(decisionConfigFromEnv(cloudflareEnv(), stored).apiKey).toBe(TOKEN);
  });

  it("uses the token saved in its own card over the environment's, and the environment's when none is saved", () => {
    const stored = (provider: string): string | undefined => (provider === "cloudflare" ? "cf-card-token" : undefined);
    expect(decisionConfigFromEnv(cloudflareEnv(), stored).apiKey).toBe("cf-card-token");
    expect(decisionConfigFromEnv(cloudflareEnv(), () => undefined).apiKey).toBe(TOKEN);
  });
});

describe("the Workers AI wire shape", () => {
  it.each(["clef", "clef-flash"] as const)("sends a System One request for %s and maps a Choice answer", async (model) => {
    const config = decisionConfigFromEnv(cloudflareEnv({ CLARKCANT_DECISION_MODEL: model }));
    const { outcome, calls, telemetry } = await selectWith(config, [envelope(decisiveTemplate, model)]);

    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") expect(`${outcome.templateId}@${outcome.templateVersion}`).toBe("overview@1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(workersAiEndpoint(ACCOUNT, model));
    expect(Object.keys(call.body).sort()).toEqual(["model", "questions", "state"]);
    expect(call.body.model).toBe(model);
    expect(call.body.questions.template?.type).toBe("choice");
    // The credential travels separately from the body and the URL, and never into telemetry.
    expect(call.apiKey.length).toBeGreaterThan(0);
    expect(call.url).not.toContain(call.apiKey);
    expect(JSON.stringify(call.body)).not.toContain(call.apiKey);
    expect(JSON.stringify(telemetry)).not.toContain(call.apiKey);
    expect(telemetry.find((event) => event.event === "call")).toMatchObject({ provider: "cloudflare", model, inputTokens: 40 });
  });

  it("maps a Noul answer, keeping the middle band uncertain", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv());
    const { transport } = recordedTransport([envelope({ noul: { type: "noul", noul: 0.58 } })]);
    const outcome = await askNoul(
      { config, transport },
      { state: { intent: "thêm lịch" }, instructions: "Should a calendar be shown?", budget: createJevBudget(config) },
    );
    expect(outcome).toEqual({ status: "answered", probability: 0.58, verdict: "uncertain" });
  });

  it("maps a Score answer to the same System One shape", () => {
    const answer = {
      type: "score",
      score: 2.3,
      legend: { "0": "No impact", "1": "Minor", "2": "Major", "3": "Critical" },
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.35, "3": 0.5 },
      confidence: 0.5,
    };
    const read = cloudflareDecisionProvider.readResponse(envelope({ severity: answer }).body);
    expect(read?.answers.severity).toEqual(answer);
    expect(read?.usage).toEqual({ input_tokens: 40, output_tokens: 6 });
  });

  it("reads the namespaced model id as the pinned one, and nothing wider", () => {
    expect(cloudflareDecisionProvider.readResponse(envelope({}, "@cf/cloudflare/clef").body)?.model).toBe("clef");
    expect(cloudflareDecisionProvider.readResponse(envelope({}, "@cf/cloudflare/clef-flash").body)?.model).toBe("clef-flash");
    expect(cloudflareDecisionProvider.readResponse(envelope({}, "@cf/meta/clef").body)?.model).toBe("@cf/meta/clef");
  });

  it("refuses an answer from a model other than the pinned one", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv({ CLARKCANT_DECISION_MODEL: "clef-flash" }));
    const { outcome, telemetry } = await selectWith(config, [envelope(decisiveTemplate, "@cf/cloudflare/clef")]);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.reason).toContain("this node pinned clef-flash");
    expect(telemetry.some((event) => event.event === "model_drift")).toBe(true);
  });

  it("treats anything but a successful envelope as malformed, and falls back the way Jev does", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv());
    const malformed = [
      // A bare System One body: the REST API wraps its result, so an unwrapped one is not what was documented.
      { status: 200, body: { model: "clef", answers: decisiveTemplate } },
      { status: 200, body: { success: false, errors: [{ code: 5007, message: "no such model" }], messages: [], result: null } },
      { status: 200, body: { success: true, result: { answers: decisiveTemplate } } },
      { status: 200, body: { success: true, result: "clef said yes" } },
      { status: 200, body: undefined },
    ];
    for (const response of malformed) {
      const { outcome, calls } = await selectWith(config, [response]);
      expect(outcome).toEqual({ status: "unavailable", reason: "the provider response did not match the documented answer shape" });
      expect(calls).toHaveLength(1);
    }
  });

  it("abstains on an unoffered choice or an invalid probability, exactly as for Jev", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv());
    const unoffered = await selectWith(config, [
      envelope({ template: { type: "choice", choice: "canvas.hostcard@1", probabilities: { "overview@1": 1, "focused@1": 0, none: 0 }, confidence: 1 } }),
    ]);
    expect(unoffered.outcome.status).toBe("abstained");
    const invalid = await selectWith(config, [
      envelope({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 1.4, "focused@1": -0.4, none: 0 }, confidence: 1 } }),
    ]);
    expect(invalid.outcome.status).toBe("abstained");
    if (invalid.outcome.status === "abstained") expect(invalid.outcome.reason).toContain("not a value in [0,1]");
  });

  it("reports an auth failure, a rate limit and an outage as unavailable without retrying", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv());
    for (const [status, says] of [
      [401, "credential"],
      [429, "rate limiting"],
      [503, "HTTP 503"],
    ] as const) {
      const { outcome, calls } = await selectWith(config, [{ status }]);
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") expect(outcome.reason).toContain(says);
      expect(calls).toHaveLength(1);
    }
  });

  it("stops a hanging call at the decision deadline", async () => {
    const config = { ...decisionConfigFromEnv(cloudflareEnv()), timeoutMs: 40 };
    const hanging: DecisionTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by the decision deadline")));
      });
    const outcome = await selectTemplate(
      { config, transport: hanging },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(config) },
    );
    expect(outcome).toEqual({ status: "unavailable", reason: "the selector call exceeded the 40 ms deadline for this decision" });
  });

  it("sends the token as a bearer header through the shared fetch transport, and nowhere else", async () => {
    const config = decisionConfigFromEnv(cloudflareEnv());
    const originalFetch = globalThis.fetch;
    const seen: { url: string; authorization: string | undefined; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: { headers?: Record<string, string>; body?: unknown }) => {
      seen.push({ url, authorization: init.headers?.authorization, body: String(init.body) });
      return new Response(JSON.stringify(envelope(decisiveTemplate).body), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const outcome = await selectTemplate(
        { config, transport: createFetchTransport() },
        { intent: "x", candidateSet: candidates(), budget: createJevBudget(config) },
      );
      expect(outcome.status).toBe("selected");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.url).toBe(workersAiEndpoint(ACCOUNT, "clef"));
    expect(request.authorization).toMatch(/^Bearer \S+$/);
    const token = request.authorization!.slice("Bearer ".length);
    expect(request.url).not.toContain(token);
    expect(request.body).not.toContain(token);
  });
});
