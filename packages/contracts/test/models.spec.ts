import { describe, expect, it } from "vitest";

import {
  EMPTY_MODEL_POOL,
  type ModelPool,
  type UserModelProfile,
  enabledProfilesByPriority,
  modelChangeNeedsGeneration,
  nextModelProfile,
  parseModelPool,
  profileByAlias,
  validateProfileAgainstCatalogue,
} from "../src/models.ts";

/**
 * The model pool.
 *
 * Two properties carry this: the pool never copies the catalogue, so a provider added by upgrading pi appears
 * without the node changing, and the hotkey walk is defined by priority over the *enabled* profiles — which is what
 * makes switching off a profile mean "not this week" rather than "forget this".
 */
function profile(overrides: Partial<UserModelProfile> = {}): UserModelProfile {
  return {
    modelProfileId: `profile_${overrides.alias ?? "fast"}`,
    alias: "fast",
    provider: "anthropic",
    modelId: "sonnet",
    enabled: true,
    roles: ["foreground"],
    priority: 10,
    ...overrides,
  };
}

const pool = (...profiles: UserModelProfile[]): ModelPool => ({ profiles });

describe("checking a profile against what this installation offers", () => {
  const catalogue = [
    { id: "anthropic", models: [{ id: "sonnet" }, { id: "haiku" }] },
    { id: "openai", models: [{ id: "gpt-x" }] },
  ];

  it("accepts a provider and model the catalogue has", () => {
    expect(validateProfileAgainstCatalogue({ alias: "fast", provider: "anthropic", modelId: "sonnet" }, catalogue)).toEqual({
      ok: true,
    });
  });

  it("refuses a provider this installation does not have", () => {
    const refused = validateProfileAgainstCatalogue({ alias: "x", provider: "gemini", modelId: "flash" }, catalogue);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain("không có provider");
    expect(refused.message).toContain("x");
  });

  it("refuses a model the provider does not offer, with a message that says which of the two was wrong", () => {
    const refused = validateProfileAgainstCatalogue({ alias: "x", provider: "anthropic", modelId: "gpt-x" }, catalogue);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain("không có model");
    expect(refused.message).toContain("gpt-x");
  });

  it("refuses everything when the catalogue is empty, rather than assuming", () => {
    // A node that cannot enumerate providers cannot promise one runs, which is the honest state after an upgrade.
    expect(validateProfileAgainstCatalogue({ alias: "a", provider: "anthropic", modelId: "sonnet" }, []).ok).toBe(false);
  });
});

describe("the order a hotkey walks", () => {
  it("walks enabled profiles by priority and skips the ones switched off", () => {
    const ordered = enabledProfilesByPriority(
      pool(
        profile({ alias: "cheap", priority: 30 }),
        profile({ alias: "fast", priority: 10 }),
        profile({ alias: "off", priority: 20, enabled: false }),
      ),
    );
    expect(ordered.map((entry) => entry.alias)).toEqual(["fast", "cheap"]);
  });

  it("wraps around, because a cycle that stops is a cycle that stops working", () => {
    const three = pool(profile({ alias: "a", priority: 1 }), profile({ alias: "b", priority: 2 }));
    expect(nextModelProfile(three, "a")?.alias).toBe("b");
    expect(nextModelProfile(three, "b")?.alias).toBe("a");
  });

  it("starts from the beginning when the current alias is not in the pool", () => {
    // A profile deleted since, or a model chosen straight from the catalogue: the hotkey's job is to change the
    // model, and there is always a first one to change to.
    const two = pool(profile({ alias: "a", priority: 1 }), profile({ alias: "b", priority: 2 }));
    expect(nextModelProfile(two, undefined)?.alias).toBe("a");
    expect(nextModelProfile(two, "gone")?.alias).toBe("a");
  });

  it("has nothing to offer when every profile is switched off", () => {
    expect(nextModelProfile(pool(profile({ enabled: false })), "fast")).toBeUndefined();
    expect(nextModelProfile(EMPTY_MODEL_POOL, "fast")).toBeUndefined();
  });

  it("breaks a priority tie by alias, so the order is stable rather than whatever the store returned", () => {
    const tied = pool(profile({ alias: "zed", priority: 5 }), profile({ alias: "alpha", priority: 5 }));
    expect(enabledProfilesByPriority(tied).map((entry) => entry.alias)).toEqual(["alpha", "zed"]);
  });
});

describe("what a stored pool does with a bad row", () => {
  it("keeps the profiles that parse and drops the one that does not", () => {
    const parsed = parseModelPool({
      profiles: [profile({ alias: "fast" }), { alias: "broken" }, profile({ alias: "smart", priority: 20 })],
    });
    expect(parsed.profiles.map((entry) => entry.alias)).toEqual(["fast", "smart"]);
  });

  it("reads a missing or malformed pool as empty rather than throwing", () => {
    expect(parseModelPool(undefined)).toEqual(EMPTY_MODEL_POOL);
    expect(parseModelPool("nope")).toEqual(EMPTY_MODEL_POOL);
    expect(parseModelPool({ profiles: "many" })).toEqual(EMPTY_MODEL_POOL);
  });

  it("finds a profile by alias, including a disabled one, because a panel shows those too", () => {
    const stored = pool(profile({ alias: "fast", enabled: false }));
    expect(profileByAlias(stored, "fast")?.enabled).toBe(false);
    expect(profileByAlias(stored, "gone")).toBeUndefined();
  });
});

describe("whether a model change needs a new generation", () => {
  it("says nothing to do when the model has not changed", () => {
    expect(modelChangeNeedsGeneration({ currentModel: "anthropic/sonnet", preferredModel: "anthropic/sonnet" })).toBe("none");
  });

  it("needs a generation when the model differs", () => {
    // Pi resolves the model when a session is created, so this is the only honest answer: the change takes effect
    // as a new generation, and the caller decides when that happens.
    expect(modelChangeNeedsGeneration({ currentModel: "anthropic/sonnet", preferredModel: "openai/gpt-x" })).toBe("handoff");
  });

  it("needs one when there is no session yet", () => {
    expect(modelChangeNeedsGeneration({ currentModel: undefined, preferredModel: "openai/gpt-x" })).toBe("handoff");
  });

  it("does nothing when nobody has expressed a preference", () => {
    expect(modelChangeNeedsGeneration({ currentModel: "anthropic/sonnet", preferredModel: undefined })).toBe("none");
  });
});
