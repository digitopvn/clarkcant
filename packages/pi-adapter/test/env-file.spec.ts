import { describe, expect, it } from "vitest";

import {
  applyEnvFile,
  DEFAULT_MODEL_BUDGET,
  keyVariableFor,
  modelBudgetFromEnv,
  modelFromEnv,
  parseEnvFile,
} from "../src/env-file.ts";

/**
 * Loading credentials from a local file.
 *
 * The precedence rule is the part that matters: a deployment that sets a real secret in its
 * own environment must not have it replaced by a file in the checkout. That is a security
 * property, not a convenience, so it is asserted rather than assumed.
 */

describe("parsing an env file", () => {
  it("reads plain assignments", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("accepts a quoted value, with or without export", () => {
    expect(parseEnvFile(`export A="one"\nB='two'`)).toEqual({ A: "one", B: "two" });
  });

  it("ignores comments, blanks and empty values", () => {
    expect(parseEnvFile("# note\n\nA=1\nEMPTY=\n#B=2")).toEqual({ A: "1" });
  });

  it("keeps an equals sign that is part of the value", () => {
    // A base64 secret ends in one often enough that splitting on the first equals and keeping
    // the rest is the only correct reading.
    expect(parseEnvFile("KEY=abc=def==")).toEqual({ KEY: "abc=def==" });
  });
});

describe("applying an env file", () => {
  it("never overwrites a variable the environment already set", () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "from-environment" };
    const result = applyEnvFile(".env", env, () => "DEEPSEEK_API_KEY=from-file\nOTHER=1");

    expect(env.DEEPSEEK_API_KEY).toBe("from-environment");
    expect(env.OTHER).toBe("1");
    expect(result.overridden).toEqual(["DEEPSEEK_API_KEY"]);
    expect(result.loaded).toEqual(["OTHER"]);
  });

  it("reports a missing file without throwing", () => {
    expect(applyEnvFile(".env", {}, () => {
      throw new Error("ENOENT");
    })).toEqual({ loaded: [], overridden: [], missing: true });
  });

  it("reports names only, so a caller cannot log a secret by accident", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyEnvFile(".env", env, () => "TOKEN=supersecretvalue");
    expect(JSON.stringify(result)).not.toContain("supersecretvalue");
  });
});

describe("choosing a model from the environment", () => {
  it("requires a provider and a model together", () => {
    expect(modelFromEnv({ CC_MODEL_PROVIDER: "deepseek" })).toBeUndefined();
    expect(modelFromEnv({ CC_MODEL_ID: "deepseek-v4-flash" })).toBeUndefined();
    expect(modelFromEnv({})).toBeUndefined();
    expect(modelFromEnv({ CC_MODEL_PROVIDER: " ", CC_MODEL_ID: "x" })).toBeUndefined();
  });

  it("returns the pair when both are present", () => {
    expect(modelFromEnv({ CC_MODEL_PROVIDER: "deepseek", CC_MODEL_ID: "deepseek-v4-flash" })).toEqual({
      provider: "deepseek",
      id: "deepseek-v4-flash",
    });
  });

  it("only accepts a reasoning level the SDK knows", () => {
    const base = { CC_MODEL_PROVIDER: "deepseek", CC_MODEL_ID: "m" };
    expect(modelFromEnv({ ...base, CC_MODEL_THINKING: "high" })).toMatchObject({ thinkingLevel: "high" });
    expect(modelFromEnv({ ...base, CC_MODEL_THINKING: "enormous" })).toEqual({ provider: "deepseek", id: "m" });
  });

  it("names the variable a provider's key belongs in", () => {
    expect(keyVariableFor("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(keyVariableFor("google")).toBe("GEMINI_API_KEY");
    expect(keyVariableFor("not-a-provider")).toBeUndefined();
  });
});

describe("the ceiling on one conversation turn", () => {
  it("uses a generous default when nothing is configured", () => {
    // Generous on purpose: a limit that fires on ordinary use teaches the user to raise it
    // rather than to trust it.
    expect(modelBudgetFromEnv({})).toEqual(DEFAULT_MODEL_BUDGET);
    expect(DEFAULT_MODEL_BUDGET.maxWallClockMs).toBeGreaterThanOrEqual(60_000);
  });

  it("takes a configured limit", () => {
    expect(modelBudgetFromEnv({ CC_MODEL_MAX_WALL_CLOCK_MS: "5000", CC_MODEL_MAX_TOKENS: "900" })).toEqual({
      maxWallClockMs: 5000,
      maxTokens: 900,
    });
  });

  it("ignores a limit that is not a positive number, rather than clamping it", () => {
    // Clamping would leave an operator believing a restriction is in force when a different
    // one is. Falling back to the default is the honest reading of a mistyped limit.
    const base = DEFAULT_MODEL_BUDGET;
    expect(modelBudgetFromEnv({ CC_MODEL_MAX_WALL_CLOCK_MS: "soon" })).toEqual(base);
    expect(modelBudgetFromEnv({ CC_MODEL_MAX_WALL_CLOCK_MS: "0" })).toEqual(base);
    expect(modelBudgetFromEnv({ CC_MODEL_MAX_WALL_CLOCK_MS: "-5" })).toEqual(base);
    expect(modelBudgetFromEnv({ CC_MODEL_MAX_TOKENS: "" })).toEqual(base);
  });

  it("keeps the two limits independent", () => {
    const budget = modelBudgetFromEnv({ CC_MODEL_MAX_TOKENS: "1234" });
    expect(budget.maxTokens).toBe(1234);
    expect(budget.maxWallClockMs).toBe(DEFAULT_MODEL_BUDGET.maxWallClockMs);
  });
});
