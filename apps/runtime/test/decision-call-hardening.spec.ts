import { afterEach, describe, expect, it } from "vitest";

import { type DecisionConfig, decisionCallRefusal, decisionConfigFromEnv } from "../src/decision-config.ts";
import { type DecisionTransport, MAX_DECISION_RESPONSE_BYTES, createFetchTransport } from "../src/decision-transport.ts";
import { type JevTelemetry, askNoul, createJevBudget, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";

/**
 * The single call path every decision provider shares, and the fetch transport under it.
 *
 * Nothing here reaches the network: provider calls go through a recording transport, and the transport tests replace
 * `fetch` in place and hand back a constructed `Response`.
 */

const TYPESAFE_KEY = "sk-test-not-a-real-key";

function typesafeConfig(): DecisionConfig {
  return decisionConfigFromEnv({ TYPESAFE_API_KEY: TYPESAFE_KEY });
}

function cloudflareConfig(): DecisionConfig {
  return decisionConfigFromEnv({
    CLARKCANT_DECISION_PROVIDER: "cloudflare",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_API_TOKEN: "cf-test-token-not-a-real-one",
    CLARKCANT_DECISION_MODEL: "clef",
  });
}

function recording(body: unknown): { transport: DecisionTransport; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const transport: DecisionTransport = async (request) => {
    bodies.push(request.body);
    return { status: 200, body };
  };
  return { transport, bodies };
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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a TypeSafe configuration naming a Cloudflare model", () => {
  it.each(["clef", "clef-flash", "@cf/cloudflare/clef"])("refuses %s before any call, naming the setting", async (model) => {
    const config = decisionConfigFromEnv({ TYPESAFE_API_KEY: TYPESAFE_KEY, CLARKCANT_DECISION_MODEL: model });
    expect(config.provider).toBe("typesafe");
    const refusal = decisionCallRefusal(config);
    expect(refusal).toContain("is a Cloudflare model, which TypeSafe does not serve");
    expect(refusal).toContain("CLARKCANT_DECISION_PROVIDER=cloudflare");

    const { transport, bodies } = recording({ model, answers: {} });
    const outcome = await selectTemplate(
      { config, transport },
      { intent: "cho tôi tổng quan", candidateSet: candidates(), budget: createJevBudget(config) },
    );
    expect(outcome.status).toBe("unavailable");
    expect(bodies).toHaveLength(0);
  });

  it("still accepts a TypeSafe model id", () => {
    const config = decisionConfigFromEnv({ TYPESAFE_API_KEY: TYPESAFE_KEY, CLARKCANT_DECISION_MODEL: "jev-latest" });
    expect(decisionCallRefusal(config)).toBeUndefined();
  });
});

describe("the secret-shape check on the request body", () => {
  // Secret-shaped to the detector, and plainly not a credential to anyone reading or scanning the repository.
  const SECRET = ["Bearer ", "example", "-not-a-credential"].join("");

  it.each([
    ["typesafe", typesafeConfig],
    ["cloudflare", cloudflareConfig],
  ] as const)("refuses to send a secret-shaped value to %s, and falls back", async (_name, configFor) => {
    const config = configFor();
    const { transport, bodies } = recording({ model: config.model, answers: { noul: { type: "noul", noul: 0.9 } } });
    const telemetry: JevTelemetry[] = [];
    // Instructions are one field no caller redacts before this point, so only the shared check stands in the way.
    const outcome = await askNoul(
      { config, transport, onTelemetry: (event) => telemetry.push(event) },
      { state: { intent: "thêm lịch" }, instructions: `Should the deploy key ${SECRET} be rotated?`, budget: createJevBudget(config) },
    );

    expect(bodies).toHaveLength(0);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.reason).toContain("was not sent");
    }
    // No part of the value is recorded.
    const recorded = JSON.stringify({ outcome, telemetry });
    expect(recorded).not.toContain("example-not");
    expect(telemetry.map((event) => event.event)).toEqual(["refusal"]);
  });

  // Each is a credential to the classifier the send boundary uses, and none is one the narrower shapes above name.
  it.each([
    ["an issued prefixed token", ["sk", "-live-", "4f9a8b7c6d5e4f3a2b1c"].join("")],
    ["HTTP Basic credentials", ["Authorization: ", "Basic ", Buffer.from(["admin", "hunter22x"].join(":")).toString("base64")].join("")],
  ])("refuses to send %s left in the instructions", async (_name, value) => {
    const config = typesafeConfig();
    const { transport, bodies } = recording({ model: config.model, answers: { noul: { type: "noul", noul: 0.9 } } });
    const outcome = await askNoul(
      { config, transport },
      { state: { intent: "thêm lịch" }, instructions: `Is ${value} still valid?`, budget: createJevBudget(config) },
    );
    expect(bodies).toHaveLength(0);
    expect(outcome.status).toBe("unavailable");
  });

  it("selects a template whose id only resembles a token", async () => {
    const config = typesafeConfig();
    const set = candidates();
    const renamed = { ...set, templates: [{ ...set.templates[0]!, templateId: "key-metrics-overview" }, set.templates[1]!] };
    const { transport, bodies } = recording({ model: config.model, answers: {} });
    await selectTemplate({ config, transport }, { intent: "cho tôi tổng quan", candidateSet: renamed, budget: createJevBudget(config) });
    expect(bodies).toHaveLength(1);
  });

  it("sends a request whose ids and model names only resemble a secret", async () => {
    const config = typesafeConfig();
    const { transport, bodies } = recording({ model: config.model, answers: { noul: { type: "noul", noul: 0.9 } } });
    const outcome = await askNoul(
      { config, transport },
      {
        state: { intent: "thêm lịch", widget: "key-metrics-overview@1", family: "family:token_management" },
        instructions: "Should sonnet (anthropic/claude-sonnet-4-5-20250929) answer this?",
        budget: createJevBudget(config),
      },
    );
    expect(bodies).toHaveLength(1);
    expect(outcome.status).toBe("answered");
  });

  it("lets an ordinary request through unchanged", async () => {
    const config = typesafeConfig();
    const { transport, bodies } = recording({ model: config.model, answers: { noul: { type: "noul", noul: 0.9 } } });
    const outcome = await askNoul(
      { config, transport },
      { state: { intent: "thêm lịch" }, instructions: "Should a calendar be shown?", budget: createJevBudget(config) },
    );
    expect(bodies).toHaveLength(1);
    expect(outcome).toEqual({ status: "answered", probability: 0.9, verdict: "on" });
  });
});

describe("a provider-supplied model id", () => {
  it("is cut to a bounded length before it reaches telemetry or a reason", async () => {
    const config = typesafeConfig();
    const longModel = `jev-${"x".repeat(5000)}`;
    const { transport } = recording({ model: longModel, answers: { noul: { type: "noul", noul: 0.9 } } });
    const telemetry: JevTelemetry[] = [];
    const outcome = await askNoul(
      { config, transport, onTelemetry: (event) => telemetry.push(event) },
      { state: { intent: "thêm lịch" }, instructions: "Should a calendar be shown?", budget: createJevBudget(config) },
    );

    expect(outcome.status).toBe("unavailable");
    const drift = telemetry.find((event) => event.event === "model_drift");
    expect(drift?.model.length).toBe(64);
    expect(drift?.reason?.length ?? 0).toBeLessThan(200);
    if (outcome.status === "unavailable") expect(outcome.reason.length).toBeLessThan(200);
  });
});

describe("the fetch transport", () => {
  const request = () => ({
    url: "https://api.typesafe.ai/v1/systemone",
    apiKey: TYPESAFE_KEY,
    body: { state: { intent: "x" }, model: "jev-1.13.0", questions: {} },
    signal: new AbortController().signal,
  });

  it("refuses to follow a redirect, so the bearer token cannot be carried to an unchecked host", async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await createFetchTransport()(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("error");
  });

  it("does not read an answer whose declared length is over the cap", async () => {
    let pulled = 0;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(MAX_DECISION_RESPONSE_BYTES + 1) } });
    }) as unknown as typeof fetch;
    const response = await createFetchTransport()(request());
    expect(response).toEqual({ status: 200, body: undefined });
    // At most the stream's eager first pull; the body is cancelled, not consumed.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("treats an answer that streams past the cap as malformed, and the caller falls back", async () => {
    const config = typesafeConfig();
    // A valid System One answer padded past the cap, sent without a length: only counting the stream catches it.
    const padded = JSON.stringify({
      model: config.model,
      answers: { noul: { type: "noul", noul: 0.9 } },
      padding: "x".repeat(MAX_DECISION_RESPONSE_BYTES),
    });
    globalThis.fetch = (async () => {
      const bytes = new TextEncoder().encode(padded);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024) {
            controller.enqueue(bytes.subarray(offset, offset + 16 * 1024));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await askNoul(
      { config, transport: createFetchTransport() },
      { state: { intent: "thêm lịch" }, instructions: "Should a calendar be shown?", budget: createJevBudget(config) },
    );
    expect(outcome).toEqual({ status: "unavailable", reason: "the provider response did not match the documented answer shape" });
  });

  it("still reads an answer under the cap", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), { status: 200 })) as unknown as typeof fetch;
    expect(await createFetchTransport()(request())).toEqual({ status: 200, body: { model: "jev-1.13.0", answers: {} } });
  });
});
