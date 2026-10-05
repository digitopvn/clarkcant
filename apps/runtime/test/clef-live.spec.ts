import { beforeAll, describe, expect, it } from "vitest";

import { decisionCallRefusal, decisionConfigFromEnv } from "../src/decision-config.ts";
import { askNoul, createJevBudget, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";

/**
 * The live Cloudflare Clef check.
 *
 * Opt-in twice over, like the Jev one: it needs `CLARKCANT_CLEF_LIVE=1` *and* a usable Cloudflare configuration
 * (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLARKCANT_DECISION_MODEL=clef|clef-flash`). The provider is
 * selected here rather than read from `CLARKCANT_DECISION_PROVIDER`, so running this file cannot depend on, or change,
 * which provider the rest of the environment names.
 *
 * It may claim that the configured model answers through the Workers AI REST API, that the envelope unwraps, and that
 * the result is one of the ids that was offered. It may not claim anything about accuracy or latency, and a vendor's
 * benchmark is not evidence for this node either. The state below is synthetic.
 */

const LIVE = process.env.CLARKCANT_CLEF_LIVE === "1";
const config = decisionConfigFromEnv({ ...process.env, CLARKCANT_DECISION_PROVIDER: "cloudflare" });
const refusal = decisionCallRefusal(config);

const CANDIDATES: MiniAppCandidateSet = {
  locale: "vi-VN",
  templates: [
    { templateId: "overview", templateVersion: "1", label: "Tổng quan công việc theo tuần", slots: ["metrics", "trend"] },
    { templateId: "focused", templateVersion: "1", label: "Chỉ một biểu đồ xu hướng", slots: ["trend"] },
    { templateId: "agenda", templateVersion: "1", label: "Lịch và sự kiện trong tuần", slots: ["calendar"] },
  ],
  definitions: [
    { id: "canvas.metrics@1", version: "1.0.0", family: "metrics", fields: ["datasetRef:string!"] },
    { id: "canvas.line@1", version: "1.0.0", family: "trend", fields: ["datasetRef:string!"] },
    { id: "canvas.calendar@1", version: "1.0.0", family: "calendar", fields: ["month:string"] },
  ],
  data: [{ ref: "ds_fixture_tasks", kind: "tasks", label: "Tasks", scale: "small", freshness: "sample" }],
};

describe.skipIf(!LIVE)("live Clef provider (opt-in)", () => {
  beforeAll(() => {
    if (refusal !== undefined) throw new Error(`BLOCKED: ${refusal}`);
  });

  it("answers with a template that was offered, or abstains", async () => {
    const outcome = await selectTemplate(
      { config },
      { intent: "cho tôi xem tổng quan công việc trong tuần này", candidateSet: CANDIDATES, budget: createJevBudget(config) },
    );
    if (outcome.status === "unavailable") throw new Error(`BLOCKED: ${outcome.reason}`);
    if (outcome.status === "selected") {
      expect(["overview", "focused", "agenda"]).toContain(outcome.templateId);
      process.stderr.write(
        `[clef-live] ${config.model} selected ${outcome.templateId}@${outcome.templateVersion} confidence=${
          outcome.confidence === undefined ? "n/a" : outcome.confidence.toFixed(3)
        }\n`,
      );
    } else {
      expect(outcome.status).toBe("abstained");
      process.stderr.write(`[clef-live] ${config.model} abstained: ${outcome.reason}\n`);
    }
  });

  it("returns a Noul probability in range", async () => {
    const outcome = await askNoul(
      { config },
      {
        state: { intent: "người dùng hỏi về lịch và các sự kiện trong tuần" },
        instructions: "Does this intent concern a calendar or scheduled events?",
        criteria: { true: "It concerns dates or events", false: "It does not" },
        budget: createJevBudget(config),
      },
    );
    if (outcome.status !== "answered") throw new Error(`BLOCKED: Noul did not answer: ${outcome.reason}`);
    expect(outcome.probability).toBeGreaterThanOrEqual(0);
    expect(outcome.probability).toBeLessThanOrEqual(1);
    process.stderr.write(`[clef-live] ${config.model} noul=${outcome.probability.toFixed(3)} verdict=${outcome.verdict}\n`);
  });
});

describe.skipIf(LIVE)("live Clef provider (skipped)", () => {
  it("names what it is waiting for", () => {
    const missing = [LIVE ? undefined : "CLARKCANT_CLEF_LIVE=1", refusal].filter(
      (entry): entry is string => entry !== undefined,
    );
    // Reported rather than silently passed: "no live evidence" and "live evidence is fine" must not look the same.
    expect(missing.length).toBeGreaterThan(0);
    process.stderr.write(`[clef-live] BLOCKED: live Clef evidence was not produced. Needs ${missing.join("; ")}.\n`);
  });
});
