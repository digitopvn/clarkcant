import { describe, expect, it } from "vitest";

import type { CompositionSlot } from "@clarkcant/contracts";

import { askNoul, createJevBudget, jevConfigFromEnv, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";

/**
 * The live provider check.
 *
 * Opt-in twice over: it needs `CLARKCANT_JEV_LIVE=1` *and* a real `TYPESAFE_API_KEY`. Both are
 * required because either one alone would be a mistake — a key in the environment should not
 * cause every local test run to call a paid provider, and an explicit opt-in with no key can only
 * fail.
 *
 * What this test may and may not claim:
 *
 * - It may claim that the configured model id answers, that the response parses, and that the
 *   result is one of the ids that was offered.
 * - It may not claim anything about accuracy, latency, or reliability. One request is a smoke
 *   test; the calibration corpus in Phase 6 is what measures the selector.
 *
 * It also must not contain sensitive data. The state below is synthetic and names nothing that
 * exists on this machine, which is what makes it safe to send.
 */

const LIVE = process.env.CLARKCANT_JEV_LIVE === "1";
const config = jevConfigFromEnv(process.env).apiKey === undefined ? undefined : jevConfigFromEnv(process.env);
const canRun = LIVE && config !== undefined && !config.localOnly;

const SLOTS: CompositionSlot[] = ["metrics", "trend", "calendar"];

const CANDIDATES: MiniAppCandidateSet = {
  locale: "vi-VN",
  templates: [
    { templateId: "overview", templateVersion: "1", label: "Tổng quan công việc theo tuần", slots: SLOTS },
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

describe.skipIf(!canRun)("live provider (opt-in)", () => {
  it("answers with a template that was offered, or abstains", async () => {
    const budget = createJevBudget(config!);
    const outcome = await selectTemplate(
      { config: config! },
      {
        intent: "cho tôi xem tổng quan công việc trong tuần này",
        candidateSet: CANDIDATES,
        budget,
      },
    );

    // Both of these are acceptable. The assertion that matters is that a selection is one of the
    // ids the host offered: an answer naming anything else would mean the boundary had failed.
    if (outcome.status === "selected") {
      expect(["overview", "focused", "agenda"]).toContain(outcome.templateId);
      expect(outcome.templateVersion).toBe("1");
      // Recorded, not asserted: the threshold is a policy, not a property of the provider.
      process.stderr.write(
        `[jev-live] selected ${outcome.templateId}@${outcome.templateVersion} confidence=${
          outcome.confidence === undefined ? "n/a" : outcome.confidence.toFixed(3)
        } margin=${outcome.margin === undefined ? "n/a" : outcome.margin.toFixed(3)}\n`,
      );
    } else {
      expect(["abstained", "unavailable"]).toContain(outcome.status);
      process.stderr.write(`[jev-live] ${outcome.status}: ${outcome.reason}\n`);
    }
  });

  it("returns a Noul probability in range without inventing a confidence", async () => {
    const budget = createJevBudget(config!);
    const outcome = await askNoul(
      { config: config! },
      {
        state: { intent: "người dùng hỏi về lịch và các sự kiện trong tuần" },
        instructions: "Does this intent concern a calendar or scheduled events?",
        criteria: { true: "It concerns dates or events", false: "It does not" },
        budget,
      },
    );
    if (outcome.status === "answered") {
      expect(outcome.probability).toBeGreaterThanOrEqual(0);
      expect(outcome.probability).toBeLessThanOrEqual(1);
      expect(["on", "off", "uncertain"]).toContain(outcome.verdict);
      process.stderr.write(`[jev-live] noul=${outcome.probability.toFixed(3)} verdict=${outcome.verdict}\n`);
    } else {
      process.stderr.write(`[jev-live] noul ${outcome.status}: ${outcome.reason}\n`);
    }
  });

  it("refuses a model id it cannot pin rather than accepting whatever answers", async () => {
    // Deliberately wrong id. The adapter must report drift, not silently use the answer.
    const drifted = { ...config!, model: "jev-0.0.0-does-not-exist" };
    const outcome = await selectTemplate(
      { config: drifted },
      { intent: "tổng quan", candidateSet: CANDIDATES, budget: createJevBudget(drifted) },
    );
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      process.stderr.write(`[jev-live] wrong-model refusal: ${outcome.reason}\n`);
    }
  });
});

describe.skipIf(canRun)("live provider (skipped)", () => {
  it("names what it is waiting for", () => {
    const missing = [
      LIVE ? undefined : "CLARKCANT_JEV_LIVE=1",
      config === undefined ? "TYPESAFE_API_KEY" : undefined,
      config?.localOnly === true ? "a non-local-only configuration" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    // Reported rather than silently passed: "no live evidence" and "live evidence is fine" must
    // not look the same in a test report.
    expect(missing.length).toBeGreaterThan(0);
    process.stderr.write(
      `[jev-live] BLOCKED: live provider evidence was not produced. Set ${missing.join(" and ")} to run it.\n`,
    );
  });
});
