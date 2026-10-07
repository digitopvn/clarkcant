import { describe, expect, it } from "vitest";

import { liveDecisionConfig } from "../src/decision-config.ts";
import type { DecisionTransport } from "../src/decision-transport.ts";
import { createJevBudget, jevConfigFromEnv, selectTemplate } from "../src/jev-selector.ts";
import type { MiniAppCandidateSet } from "../src/mini-app-candidates.ts";
import { JEV_EXACT_MODEL } from "../src/typesafe-decision-provider.ts";

/**
 * The key a person types into the interface.
 *
 * The decider read its credential from the environment only, which made the TypeSafe field in settings pointless: a
 * key that is stored, reported as saved, and then never used is worse than no field at all, because the interface
 * said it worked.
 */
describe("the decider's key", () => {
  it("comes from the interface when the environment has none", () => {
    expect(jevConfigFromEnv({}, () => "stored-key").apiKey).toBe("stored-key");
  });

  it("uses the key saved in the interface over one in the environment", () => {
    // The person saved this key here, after whatever the environment was started with, and the card says it is in use;
    // every provider credential takes the saved key first.
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: "env-key" }, () => "stored-key").apiKey).toBe("stored-key");
  });

  it("falls back to the environment when nothing is saved", () => {
    expect(jevConfigFromEnv({ TYPESAFE_API_KEY: "env-key" }, () => undefined).apiKey).toBe("env-key");
  });

  it("enables the provider, because a key with no local-only flag means it may be used", () => {
    expect(jevConfigFromEnv({}, () => "stored-key").enabled).toBe(true);
  });

  it("treats a blank stored value as no key at all", () => {
    expect(jevConfigFromEnv({}, () => "   ").apiKey).toBeUndefined();
    expect(jevConfigFromEnv({}, () => "   ").enabled).toBe(false);
    expect(jevConfigFromEnv({}).apiKey).toBeUndefined();
  });
});

/**
 * A key saved or removed while the node runs.
 *
 * The card says "Saved - the node is using the new key." A decider that read its key once at start-up would make that
 * sentence untrue until a restart, and would keep sending a key the person had taken back.
 */
describe("the running decider's key", () => {
  const candidates: MiniAppCandidateSet = {
    locale: "en-US",
    templates: [
      { templateId: "overview", templateVersion: "1", label: "Work overview", slots: ["metrics"] },
      { templateId: "focused", templateVersion: "1", label: "One chart only", slots: ["trend"] },
    ],
    definitions: [],
    data: [],
  };
  const answer = {
    model: JEV_EXACT_MODEL,
    answers: {
      template: {
        type: "choice",
        choice: "overview@1",
        probabilities: { "overview@1": 0.95, "focused@1": 0.04, none: 0.01 },
        confidence: 0.93,
      },
    },
  };

  it("uses a key saved after it was built on the next decision, and stops when the key is removed", async () => {
    // The vault, as the decider sees it: read through the same function the node passes in.
    let vault: string | undefined;
    const config = liveDecisionConfig({}, () => vault);
    const bearers: string[] = [];
    const transport: DecisionTransport = async (request) => {
      bearers.push(request.apiKey);
      return { status: 200, body: answer };
    };
    const decide = () =>
      selectTemplate(
        { config, transport },
        { intent: "show me an overview of my work", candidateSet: candidates, budget: createJevBudget(config) },
      );

    expect((await decide()).status).toBe("unavailable");
    expect(bearers).toEqual([]);

    vault = "saved-after-start";
    expect((await decide()).status).toBe("selected");
    expect(bearers).toEqual(["saved-after-start"]);

    vault = "saved-again";
    await decide();
    expect(bearers).toEqual(["saved-after-start", "saved-again"]);

    vault = undefined;
    const removed = await decide();
    expect(removed.status).toBe("unavailable");
    expect(config.enabled).toBe(false);
    expect(bearers).toHaveLength(2);
  });

  it("keeps a field a caller pinned", () => {
    let vault: string | undefined = "saved";
    const config = liveDecisionConfig({}, () => vault, { enabled: false });
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBe("saved");
    vault = undefined;
    expect(config.apiKey).toBeUndefined();
  });
});
