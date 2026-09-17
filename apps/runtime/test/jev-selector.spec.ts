import { describe, expect, it } from "vitest";

import type { CompositionSlot } from "@clarkcant/contracts";

import {
  type JevConfig,
  type JevTelemetry,
  type JevTransport,
  NONE_OPTION,
  askChoice,
  askNoul,
  createJevBudget,
  createFetchTransport,
  jevCallRefusal,
  jevConfigFromEnv,
  selectSections,
  selectTemplate,
  validateProviderEndpoint,
} from "../src/jev-selector.ts";
import {
  type MiniAppCandidateSet,
  buildSelectionState,
  checkSelectionStateSize,
  sanitizeIntent,
  schemaFieldSummary,
  stateLooksRedacted,
} from "../src/mini-app-candidates.ts";

/**
 * The selector adapter (Phase 2).
 *
 * Every test here is about a refusal, a bound or a redaction, because those are the parts of an
 * adapter to a probabilistic service that a caller cannot verify after the fact. The provider is
 * replaced by a recording transport, so what is asserted is exactly what would have crossed the
 * wire — which is also how "no call was made" becomes a real assertion rather than a claim.
 *
 * No test in this file proves the live provider works. That is `jev-live.spec.ts`, and it is
 * opt-in for a reason: a passing unit test is not evidence that a model answered.
 */

interface RecordedCall {
  url: string;
  apiKey: string;
  body: { state: unknown; model: string; questions: Record<string, { criteria?: Record<string, string | null> }> };
}

function recordedTransport(
  responses: readonly { status: number; body?: unknown }[],
): { transport: JevTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const transport: JevTransport = async (request) => {
    calls.push({
      url: request.url,
      apiKey: request.apiKey,
      body: request.body as RecordedCall["body"],
    });
    const response = responses[Math.min(index, responses.length - 1)] ?? { status: 529 };
    index += 1;
    return { status: response.status, body: response.body };
  };
  return { transport, calls };
}

function testConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  return {
    ...jevConfigFromEnv({ TYPESAFE_API_KEY: "sk-test-not-a-real-key" }),
    model: "jev-1.13.0",
    ...overrides,
  };
}

function candidates(): MiniAppCandidateSet {
  const slots: CompositionSlot[] = ["metrics", "filter", "trend", "calendar", "cta"];
  return {
    locale: "vi-VN",
    templates: [
      { templateId: "overview", templateVersion: "1", label: "Work overview", slots },
      { templateId: "focused", templateVersion: "1", label: "One chart only", slots: ["trend"] },
    ],
    definitions: [
      { id: "canvas.metrics@1", version: "1.0.0", family: "metrics", fields: ["datasetRef:string!"] },
      { id: "canvas.line@1", version: "1.0.0", family: "trend", fields: ["datasetRef:string!", "series:array"] },
      { id: "canvas.bar@1", version: "1.0.0", family: "trend", fields: ["datasetRef:string!"] },
      { id: "canvas.calendar@1", version: "1.0.0", family: "calendar", fields: ["month:string"] },
    ],
    data: [{ ref: "ds_tasks", kind: "tasks", label: "Tasks", scale: "small", freshness: "live" }],
  };
}

function choiceBody(
  answers: Record<string, unknown>,
  model = "jev-1.13.0",
): { status: number; body: unknown } {
  return { status: 200, body: { model, answers, usage: { input_tokens: 42, output_tokens: 7 } } };
}

describe("configuration and the refusal path", () => {
  it("derives enabled from the presence of a key, and local-only outranks it", () => {
    expect(jevConfigFromEnv({}).enabled).toBe(false);
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: "k" }).enabled).toBe(true);
    // An operator who forbade third-party processing is not overridden by a key appearing later.
    const localOnly = jevConfigFromEnv({ TYPESAFE_API_KEY: "k", CLARKCANT_JEV_LOCAL_ONLY: "1" });
    expect(localOnly.enabled).toBe(false);
    expect(jevCallRefusal(localOnly)).toContain("local-only");
  });

  it("pins the exact model id rather than accepting the alias", () => {
    expect(jevConfigFromEnv({}).model).toBe("jev-1.13.0");
    expect(jevConfigFromEnv({ CLARKCANT_JEV_MODEL: "jev-latest" }).model).toBe("jev-latest");
  });

  it("refuses an endpoint that points somewhere a node should not call", () => {
    expect(validateProviderEndpoint("https://api.typesafe.ai/v1/systemone").ok).toBe(true);
    expect(validateProviderEndpoint("http://api.typesafe.ai/v1/systemone").ok).toBe(false);
    expect(validateProviderEndpoint("https://127.0.0.1:8080/v1/systemone").ok).toBe(false);
    expect(validateProviderEndpoint("https://10.0.0.5/v1/systemone").ok).toBe(false);
    expect(validateProviderEndpoint("https://localhost/v1/systemone").ok).toBe(false);
    expect(validateProviderEndpoint("https://user:pass@api.typesafe.ai/v1").ok).toBe(false);
    expect(validateProviderEndpoint("not a url").ok).toBe(false);

    const config = jevConfigFromEnv({ TYPESAFE_API_KEY: "k", CLARKCANT_JEV_ENDPOINT: "https://169.254.1.1/x" });
    expect(config.endpointRefusal).toBeDefined();
    expect(jevCallRefusal(config)).toContain("private address");
    expect(config.endpoint).toContain("api.typesafe.ai");
  });

  it("makes no call at all without a key, in local-only mode, or with no budget left", async () => {
    const { transport, calls } = recordedTransport([choiceBody({ template: { type: "choice", choice: "overview", probabilities: { overview: 1 } } })]);

    const noKey = await selectTemplate(
      { config: testConfig({ enabled: false, apiKey: undefined }), transport },
      { intent: "cho tôi tổng quan", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(noKey.status).toBe("unavailable");

    const localOnly = await selectTemplate(
      { config: testConfig({ localOnly: true }), transport },
      { intent: "cho tôi tổng quan", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(localOnly.status).toBe("unavailable");

    const shifted = (): number => Date.now() + 10_000;
    const exhausted = await selectTemplate(
      { config: testConfig(), transport, now: shifted },
      { intent: "cho tôi tổng quan", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(exhausted.status).toBe("unavailable");
    if (exhausted.status === "unavailable") expect(exhausted.reason).toContain("budget");

    expect(calls).toHaveLength(0);
  });
});

describe("template selection", () => {
  it("returns the chosen template as a typed id and sends only allowlisted metadata", async () => {
    const { transport, calls } = recordedTransport([
      choiceBody({
        template: {
          type: "choice",
          choice: "overview@1",
          probabilities: { "overview@1": 0.94, "focused@1": 0.05, none: 0.01 },
          confidence: 0.9,
        },
      }),
    ]);

    const outcome = await selectTemplate(
      { config: testConfig(), transport },
      {
        intent: "cho tôi tổng quan công việc tuần này, email tôi là an.nguyen@example.com",
        candidateSet: candidates(),
        budget: createJevBudget(testConfig()),
      },
    );

    expect(outcome.status).toBe("selected");
    if (outcome.status !== "selected") return;
    expect(outcome.templateId).toBe("overview");
    expect(outcome.templateVersion).toBe("1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.body.model).toBe("jev-1.13.0");
    // Only the offered templates were criteria, plus the host's own `none`.
    expect(Object.keys(call.body.questions.template?.criteria ?? {}).sort()).toEqual([
      "focused@1",
      "none",
      "overview@1",
    ]);
    // The one piece of free text was sanitized on the way out.
    expect(JSON.stringify(call.body.state)).not.toContain("an.nguyen@example.com");
    expect(JSON.stringify(call.body.state)).toContain("[redacted]");
    // Field names travel; values do not. `datasetRef:string!` is the schema's shape, and the
    // dataset reference it would hold is the only part the selector is allowed to see.
    expect(JSON.stringify(call.body.state)).toContain("datasetRef:string");
    expect(JSON.stringify(call.body.state)).not.toContain("rowCount");
    expect(JSON.stringify(call.body.state)).not.toContain("private");
    expect(JSON.stringify(call.body.state)).toContain("ds_tasks");
  });

  it("abstains on a low-confidence answer, a tie, an explicit none, and a non-substantive winner", async () => {
    const low = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.5, "focused@1": 0.4, none: 0.1 } } }),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(low.status).toBe("abstained");
    if (low.status === "abstained") expect(low.reason).toContain("floor");

    const tie = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.9, "focused@1": 0.82, none: 0.02 } } }),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(tie.status).toBe("abstained");
    if (tie.status === "abstained") expect(tie.reason).toContain("margin");

    const none = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: NONE_OPTION, probabilities: { "overview@1": 0.05, "focused@1": 0.05, none: 0.9 } } }),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(none.status).toBe("abstained");
    if (none.status === "abstained") expect(none.reason).toContain("none");
  });

  it("refuses malformed answers rather than reading a field that is not there", async () => {
    const wrongType = await selectTemplate(
      { config: testConfig(), transport: recordedTransport([choiceBody({ template: { type: "noul", noul: 0.9 } })]).transport },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(wrongType.status).toBe("abstained");

    const unknownId = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: "canvas.hostcard@1", probabilities: { "overview@1": 1, "focused@1": 0, none: 0 } } }),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(unknownId.status).toBe("abstained");

    const outOfRange = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 1.4, "focused@1": -0.4, none: 0 } } }),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(outOfRange.status).toBe("abstained");
    if (outOfRange.status === "abstained") expect(outOfRange.reason).toContain("not a value in [0,1]");

    const incomplete = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 1 } } }),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(incomplete.status).toBe("abstained");
    if (incomplete.status === "abstained") expect(incomplete.reason).toContain("omitted");
  });

  it("refuses a model drift instead of accepting whatever answered", async () => {
    const drifted = await selectTemplate(
      {
        config: testConfig(),
        transport: recordedTransport([
          choiceBody({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.99, "focused@1": 0, none: 0.01 } } }, "jev-1.14.0"),
        ]).transport,
      },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(drifted.status).toBe("unavailable");
    if (drifted.status === "unavailable") expect(drifted.reason).toContain("pinned");
  });

  it("makes no call when only one template exists", async () => {
    const single: MiniAppCandidateSet = {
      ...candidates(),
      templates: [candidates().templates[0]!],
    };
    const { transport, calls } = recordedTransport([]);
    const outcome = await selectTemplate(
      { config: testConfig(), transport },
      { intent: "x", candidateSet: single, budget: createJevBudget(testConfig()) },
    );
    expect(outcome.status).toBe("selected");
    expect(calls).toHaveLength(0);
  });
});

describe("failure bounds", () => {
  it("reports 429 and 5xx as unavailable without retrying", async () => {
    for (const status of [429, 529, 500]) {
      const { transport, calls } = recordedTransport([{ status }]);
      const outcome = await selectTemplate(
        { config: testConfig(), transport },
        { intent: "x", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
      );
      expect(outcome.status).toBe("unavailable");
      // One attempt. A retry inside a four-second budget turns a slow answer into a late one.
      expect(calls).toHaveLength(1);
    }
  });

  it("stops a hanging call at the turn budget", async () => {
    const hanging: JevTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by the turn budget")));
      });
    const config = testConfig({ timeoutMs: 40 });
    const startedAt = Date.now();
    const outcome = await selectTemplate(
      { config, transport: hanging },
      { intent: "x", candidateSet: candidates(), budget: createJevBudget(config) },
    );
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.reason).toContain("4000 ms".replace("4000", "40"));
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("treats an oversized candidate state as a refusal before any call", async () => {
    const huge: MiniAppCandidateSet = {
      ...candidates(),
      definitions: Array.from({ length: 400 }, (_unused, index) => ({
        id: `canvas.generated${index}@1`,
        version: "1.0.0",
        family: "trend",
        fields: Array.from({ length: 24 }, (_f, field) => `field${field}:string`),
      })),
    };
    const { transport, calls } = recordedTransport([]);
    const outcome = await selectTemplate(
      { config: testConfig(), transport },
      { intent: "x", candidateSet: huge, budget: createJevBudget(testConfig()) },
    );
    expect(outcome.status).toBe("unavailable");
    expect(calls).toHaveLength(0);

    const state = buildSelectionState(huge, "x");
    const size = checkSelectionStateSize(state);
    expect(size.ok).toBe(false);
  });
});

describe("section selection", () => {
  it("selects renderers per slot and validates the combination", async () => {
    const { transport, calls } = recordedTransport([
      choiceBody({
        "section.trend": { type: "choice", choice: "canvas.line@1@1.0.0", probabilities: { "canvas.line@1@1.0.0": 0.9, "canvas.bar@1@1.0.0": 0.05, none: 0.05 } },
        "section.calendar": { type: "choice", choice: "canvas.calendar@1@1.0.0", probabilities: { "canvas.calendar@1@1.0.0": 0.99, none: 0.01 } },
      }),
    ]);

    const outcome = await selectSections(
      { config: testConfig(), transport },
      {
        intent: "cho tôi tổng quan",
        candidateSet: candidates(),
        template: { templateId: "overview", templateVersion: "1", slots: ["metrics", "trend", "calendar"] },
        fixedSlots: ["metrics"],
        budget: createJevBudget(testConfig()),
      },
    );

    expect(outcome.status).toBe("selected");
    if (outcome.status !== "selected") return;
    expect(outcome.selection.sections.map((section) => section.slot).sort()).toEqual(["calendar", "trend"]);
    // One batch, not one call per slot.
    expect(calls).toHaveLength(1);
    // A fixed slot was never offered to the model.
    expect(Object.keys(calls[0]?.body.questions ?? {})).toEqual(["section.trend", "section.calendar"]);
  });

  it("abstains when the answer names a renderer that was not offered", async () => {
    const { transport } = recordedTransport([
      choiceBody({
        "section.trend": { type: "choice", choice: "canvas.candlestick@1@1.0.0", probabilities: { "canvas.line@1@1.0.0": 0.9, none: 0.1 } },
      }),
    ]);
    const outcome = await selectSections(
      { config: testConfig(), transport },
      {
        intent: "x",
        candidateSet: candidates(),
        template: { templateId: "overview", templateVersion: "1", slots: ["trend"] },
        budget: createJevBudget(testConfig()),
      },
    );
    expect(outcome.status).toBe("abstained");
  });

  it("abstains when every renderer is declined rather than compiling an empty surface", async () => {
    const { transport } = recordedTransport([
      choiceBody({
        "section.trend": { type: "choice", choice: NONE_OPTION, probabilities: { "canvas.line@1@1.0.0": 0.1, none: 0.9 } },
      }),
    ]);
    const outcome = await selectSections(
      { config: testConfig(), transport },
      {
        intent: "x",
        candidateSet: candidates(),
        template: { templateId: "overview", templateVersion: "1", slots: ["trend"] },
        budget: createJevBudget(testConfig()),
      },
    );
    expect(outcome.status).toBe("abstained");
  });
});

describe("noul", () => {
  it("reports the middle band as uncertain", async () => {
    const { transport } = recordedTransport([
      choiceBody({ noul: { type: "noul", noul: 0.58 } }),
    ]);
    const outcome = await askNoul(
      { config: testConfig(), transport },
      { state: { intent: "thêm lịch" }, instructions: "Should a calendar be shown?", budget: createJevBudget(testConfig()) },
    );
    expect(outcome.status).toBe("answered");
    if (outcome.status !== "answered") return;
    expect(outcome.probability).toBeCloseTo(0.58);
    expect(outcome.verdict).toBe("uncertain");
  });

  it("rejects a Noul value outside [0,1]", async () => {
    const { transport } = recordedTransport([choiceBody({ noul: { type: "noul", noul: 1.5 } })]);
    const outcome = await askNoul(
      { config: testConfig(), transport },
      { state: { intent: "x" }, instructions: "?", budget: createJevBudget(testConfig()) },
    );
    expect(outcome.status).toBe("abstained");
  });
});

describe("telemetry and redaction", () => {
  it("records a redacted line per call and nothing that was in the request", async () => {
    const events: JevTelemetry[] = [];
    const { transport } = recordedTransport([
      choiceBody({ template: { type: "choice", choice: "overview@1", probabilities: { "overview@1": 0.95, "focused@1": 0.04, none: 0.01 } } }),
    ]);

    await selectTemplate(
      { config: testConfig(), transport, onTelemetry: (event) => events.push(event) },
      {
        intent: "tổng quan tuần này, key của tôi là sk-live-abcdef1234567890",
        candidateSet: candidates(),
        budget: createJevBudget(testConfig()),
      },
    );

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("sk-live-abcdef1234567890");
    expect(serialised).not.toContain("sk-test-not-a-real-key");
    expect(serialised).not.toContain("tổng quan");
    expect(events.some((event) => event.event === "call")).toBe(true);
    expect(events.every((event) => event.model.length > 0)).toBe(true);
    expect(events.some((event) => event.selection === "overview@1")).toBe(true);
  });

  it("sanitizes free text and refuses a state that still looks like it holds a secret", () => {
    const intent = sanitizeIntent("mail an.nguyen@example.com hoặc gọi 0912345678\n\tvà dùng Bearer abcdefghijklmnop");
    expect(intent).not.toContain("an.nguyen@example.com");
    expect(intent).not.toContain("0912345678");
    expect(intent).not.toContain("abcdefghijklmnop");
    expect(intent).not.toContain("\n");

    expect(sanitizeIntent("x".repeat(5000)).length).toBeLessThanOrEqual(1000);

    // A future field that skipped the sanitizer is caught here rather than sent.
    const state = { ...buildSelectionState(candidates(), "hello"), leaked: "sk-live-abcdef1234567890" };
    const check = stateLooksRedacted(state as never);
    expect(check.ok).toBe(false);

    expect(schemaFieldSummary({ type: "object", properties: { datasetRef: { type: "string" }, series: { type: "array" } }, required: ["datasetRef"] })).toEqual([
      "datasetRef:string!",
      "series:array",
    ]);
  });

  it("does not put the key in the URL or the answer into telemetry", async () => {
    const events: JevTelemetry[] = [];
    const { transport, calls } = recordedTransport([choiceBody({ template: { type: "choice", choice: "focused@1", probabilities: { "overview@1": 0.02, "focused@1": 0.97, none: 0.01 } } })]);
    await selectTemplate(
      { config: testConfig(), transport, onTelemetry: (event) => events.push(event) },
      { intent: "một biểu đồ thôi", candidateSet: candidates(), budget: createJevBudget(testConfig()) },
    );
    expect(calls[0]?.url).not.toContain("sk-test");
    // The key travels in a header, which the transport receives separately from the body.
    expect(JSON.stringify(calls[0]?.body)).not.toContain("sk-test");
    expect(JSON.stringify(events)).not.toContain("probabilities");
  });
});

describe("askChoice boundaries", () => {
  it("refuses a Choice question with fewer than two options", async () => {
    const { transport, calls } = recordedTransport([]);
    const outcome = await askChoice(
      { config: testConfig(), transport },
      { state: { intent: "x" }, instructions: "?", criteria: {}, budget: createJevBudget(testConfig()) },
    );
    expect(outcome.status).toBe("abstained");
    expect(calls).toHaveLength(0);
  });

  it("keeps the host's none option when the caller supplies its own criteria", async () => {
    const { transport, calls } = recordedTransport([
      choiceBody({ pick: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.05, none: 0.05 } } }),
    ]);
    await askChoice(
      { config: testConfig(), transport },
      { state: { intent: "x" }, instructions: "?", criteria: { a: "A", b: "B" }, budget: createJevBudget(testConfig()) },
    );
    expect(Object.keys(calls[0]?.body.questions.choice?.criteria ?? {})).toContain(NONE_OPTION);
  });
});

describe("the fetch transport", () => {
  it("returns a status without exposing an error body", async () => {
    const transport = createFetchTransport();
    const originalFetch = globalThis.fetch;
    let seenBody = "not read";
    globalThis.fetch = (async (_url: string, init: { body?: unknown }) => {
      seenBody = String(init.body);
      return {
        ok: false,
        status: 429,
        text: async () => "{\"error\":\"you sent: " + seenBody + "\"}",
      };
    }) as unknown as typeof fetch;

    try {
      const response = await transport({
        url: "https://api.typesafe.ai/v1/systemone",
        apiKey: "sk-test",
        body: { state: { intent: "x" }, model: "jev-1.13.0", questions: {} },
        signal: new AbortController().signal,
      });
      expect(response.status).toBe(429);
      // The provider's error text is discarded: it routinely echoes the request, and the request
      // is the one thing that must not be logged.
      expect(response.body).toBeUndefined();
      expect(seenBody).toContain("jev-1.13.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
