import { describe, expect, it } from "vitest";

import { applyEnvFile, keyVariableFor, modelFromEnv, parseEnvFile } from "../src/env-file.ts";

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
