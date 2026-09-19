import { describe, expect, it } from "vitest";

import type { ModelPool, UserModelProfile } from "@clarkcant/contracts";

import {
  type CandidateFilterInput,
  filterBackgroundCandidates,
  routeBackgroundModel,
} from "../src/model-router.ts";

/**
 * Routing background work.
 *
 * Two properties matter and both are about not failing: the policy layer is only ever shown models that can actually
 * run, and a worker starts even when it says nothing. The filters are deterministic on purpose — every one of them is
 * a fact the node can check, so nothing here depends on a model's opinion about itself.
 */
function profile(overrides: Partial<UserModelProfile> = {}): UserModelProfile {
  return {
    modelProfileId: `profile_${overrides.alias ?? "fast"}`,
    alias: "fast",
    provider: "anthropic",
    modelId: "sonnet",
    enabled: true,
    roles: ["background"],
    priority: 10,
    ...overrides,
  };
}

const pool = (...profiles: UserModelProfile[]): ModelPool => ({ profiles });

function filterInput(overrides: Partial<CandidateFilterInput> = {}): CandidateFilterInput {
  return {
    pool: pool(profile()),
    hasCredential: () => true,
    isHealthy: () => true,
    contextWindowFor: () => 200_000,
    supportsTools: () => true,
    needsTools: false,
    ...overrides,
  };
}

describe("the profiles a background job could run on", () => {
  it("keeps the ones that are on and asked for this role", () => {
    const outcome = filterBackgroundCandidates(
      filterInput({
        pool: pool(
          profile({ alias: "on", priority: 20 }),
          profile({ alias: "off", priority: 10, enabled: false }),
          profile({ alias: "foreground-only", roles: ["foreground"], priority: 5 }),
        ),
      }),
    );
    expect(outcome.eligible.map((entry) => entry.alias)).toEqual(["on"]);
    expect(outcome.rejected.map((entry) => entry.alias)).toEqual(["off", "foreground-only"]);
  });

  it("orders the survivors by priority, not by the order the store returned", () => {
    const outcome = filterBackgroundCandidates(
      filterInput({ pool: pool(profile({ alias: "slow", priority: 30 }), profile({ alias: "quick", priority: 1 })) }),
    );
    expect(outcome.eligible.map((entry) => entry.alias)).toEqual(["quick", "slow"]);
  });

  it("leaves out a provider with no credential, and says which one", () => {
    const outcome = filterBackgroundCandidates(
      filterInput({
        pool: pool(profile({ alias: "openai", provider: "openai" }), profile({ alias: "anthropic" })),
        hasCredential: (provider) => provider === "anthropic",
      }),
    );
    expect(outcome.eligible.map((entry) => entry.alias)).toEqual(["anthropic"]);
    expect(outcome.rejected[0]?.reason).toContain("credential");
  });

  it("leaves out a provider that is not healthy", () => {
    const outcome = filterBackgroundCandidates(filterInput({ isHealthy: () => false }));
    expect(outcome.eligible).toEqual([]);
    expect(outcome.rejected[0]?.reason).toContain("không khoẻ");
  });

  it("leaves out a model that cannot call tools, but only when tools are needed", () => {
    const noTools = { supportsTools: () => false };
    expect(filterBackgroundCandidates(filterInput({ ...noTools, needsTools: true })).eligible).toEqual([]);
    // The same model is fine for work that does not call tools: the filter is about the job, not the model.
    expect(filterBackgroundCandidates(filterInput({ ...noTools, needsTools: false })).eligible).toHaveLength(1);
  });

  it("lets an unknown tool capability through, because filtering it would empty a thin catalogue", () => {
    const outcome = filterBackgroundCandidates(
      filterInput({ supportsTools: () => undefined, needsTools: true }),
    );
    expect(outcome.eligible).toHaveLength(1);
  });

  it("leaves out a context window too small for the work, and keeps an unknown one", () => {
    const small = filterBackgroundCandidates(filterInput({ contextWindowFor: () => 8_000, neededContextWindow: 100_000 }));
    expect(small.eligible).toEqual([]);
    expect(small.rejected[0]?.reason).toContain("context");

    const unknown = filterBackgroundCandidates(filterInput({ contextWindowFor: () => undefined, neededContextWindow: 100_000 }));
    expect(unknown.eligible).toHaveLength(1);
  });

  it("leaves out a profile whose token ceiling is below what the work may spend", () => {
    const outcome = filterBackgroundCandidates(
      filterInput({ pool: pool(profile({ maxTokens: 1_000 })), neededTokens: 5_000 }),
    );
    expect(outcome.eligible).toEqual([]);
    expect(outcome.rejected[0]?.reason).toContain("token");
  });
});

describe("choosing among the survivors", () => {
  const eligible = [
    { alias: "fast", provider: "anthropic", modelId: "haiku", priority: 10 },
    { alias: "smart", provider: "anthropic", modelId: "sonnet", priority: 20 },
  ];
  const verify = () => true;

  it("takes the policy layer's choice when it is one of the candidates", async () => {
    const routed = await routeBackgroundModel({
      eligible,
      decide: async () => ({ status: "chosen", alias: "smart" }),
      verify,
    });
    expect(routed).toMatchObject({ via: "jev", alias: "smart", provider: "anthropic", modelId: "sonnet" });
  });

  it("refuses a choice outside the set it offered, and falls back", async () => {
    // The filters are authoritative: a selector that names something it was not offered has not made a decision.
    const routed = await routeBackgroundModel({
      eligible,
      decide: async () => ({ status: "chosen", alias: "not-offered" }),
      verify,
    });
    expect(routed?.via).toBe("first-eligible");
    expect(routed?.alias).toBe("fast");
  });

  it("re-checks the chosen profile, because a pool can change while a selector is thinking", async () => {
    const routed = await routeBackgroundModel({
      eligible,
      decide: async () => ({ status: "chosen", alias: "smart" }),
      verify: (alias) => alias !== "smart",
    });
    expect(routed?.via).toBe("first-eligible");
  });

  it("does not fail the job when the policy layer is unavailable", async () => {
    const routed = await routeBackgroundModel({
      eligible,
      decide: async () => ({ status: "unavailable", reason: "429 from the provider" }),
      verify,
    });
    // A worker still starts, and the reason travels with the choice rather than disappearing.
    expect(routed?.alias).toBe("fast");
    expect(routed?.reason).toContain("429");
  });

  it("does not ask a selector to choose between fewer than two candidates", async () => {
    let asked = 0;
    const routed = await routeBackgroundModel({
      eligible: [eligible[0]!],
      decide: async () => {
        asked += 1;
        return { status: "chosen", alias: "fast" };
      },
      verify,
    });
    expect(asked).toBe(0);
    expect(routed?.via).toBe("first-eligible");
  });

  it("falls back in the stated order: background default, then foreground, then the first eligible", async () => {
    const unavailable = async (): Promise<{ status: "unavailable"; reason: string }> => ({
      status: "unavailable",
      reason: "nope",
    });

    const byDefault = await routeBackgroundModel({
      eligible,
      decide: unavailable,
      backgroundDefaultAlias: "smart",
      foregroundAlias: "fast",
      verify,
    });
    expect(byDefault?.via).toBe("background-default");

    const byForeground = await routeBackgroundModel({
      eligible,
      decide: unavailable,
      foregroundAlias: "smart",
      verify,
    });
    expect(byForeground?.via).toBe("foreground");

    const firstEligible = await routeBackgroundModel({ eligible, decide: unavailable, verify });
    expect(firstEligible?.via).toBe("first-eligible");
  });

  it("ignores a fallback that names a profile which is no longer usable", async () => {
    const routed = await routeBackgroundModel({
      eligible,
      backgroundDefaultAlias: "gone",
      verify: (alias) => alias !== "gone",
    });
    expect(routed?.via).toBe("first-eligible");
  });

  it("returns nothing when no profile survived the filters, so the caller can report why", async () => {
    expect(await routeBackgroundModel({ eligible: [], verify })).toBeUndefined();
  });
});
