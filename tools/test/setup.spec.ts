import { describe, expect, it } from "vitest";

import { meetsVersion, parseFlags, readEnv, upsertEnv } from "../setup.mjs";

describe("upsertEnv", () => {
  it("replaces an assignment in place and keeps comments and unrelated lines", () => {
    const content = "# which model\nCC_MODEL_PROVIDER=deepseek\nDEEPSEEK_API_KEY=\nOTHER=kept\n";
    const next = upsertEnv(content, { CC_MODEL_PROVIDER: "openai", DEEPSEEK_API_KEY: "sk-1" });
    expect(next).toBe("# which model\nCC_MODEL_PROVIDER=openai\nDEEPSEEK_API_KEY=sk-1\nOTHER=kept\n");
  });

  it("takes over a commented-out example instead of appending a duplicate", () => {
    expect(upsertEnv("# CC_MODEL_THINKING=low\n", { CC_MODEL_THINKING: "high" })).toBe("CC_MODEL_THINKING=high\n");
  });

  it("leaves a commented example alone when a live assignment follows it", () => {
    const next = upsertEnv("# PORT=1\nPORT=2\n", { PORT: "3" });
    expect(next).toBe("# PORT=1\nPORT=3\n");
  });

  it("appends a name the file never mentions and quotes values with spaces", () => {
    expect(upsertEnv("A=1\n", { CLARKCANT_LABEL: "my clark" })).toBe('A=1\nCLARKCANT_LABEL="my clark"\n');
  });

  it("ignores undefined values", () => {
    expect(upsertEnv("A=1\n", { A: undefined })).toBe("A=1\n");
  });

  it("round-trips through readEnv", () => {
    const next = upsertEnv("", { CLARKCANT_LABEL: "my clark", KEY: "abc" });
    expect(readEnv(next)).toEqual({ CLARKCANT_LABEL: "my clark", KEY: "abc" });
  });
});

describe("readEnv", () => {
  it("skips comments and empty values", () => {
    expect(readEnv("# A=1\nB=\nC=2\n")).toEqual({ C: "2" });
  });
});

describe("meetsVersion", () => {
  it("compares numerically", () => {
    expect(meetsVersion("22.19.0", [22, 19, 0])).toBe(true);
    expect(meetsVersion("v22.9.0", [22, 19, 0])).toBe(false);
    expect(meetsVersion("24.0.0", [22, 19, 0])).toBe(true);
    expect(meetsVersion("20.30.0", [22, 19, 0])).toBe(false);
  });
});

describe("parseFlags", () => {
  it("reads values and switches", () => {
    expect(parseFlags(["--yes", "--mode", "docker", "--provider", "openai", "--model", "m"])).toMatchObject({
      yes: true,
      mode: "docker",
      provider: "openai",
      model: "m",
    });
  });

  it("refuses an unknown option, mode or provider by name", () => {
    expect(() => parseFlags(["--nope"])).toThrow("--nope");
    expect(() => parseFlags(["--mode", "k8s"])).toThrow("k8s");
    expect(() => parseFlags(["--provider", "acme"])).toThrow("--provider");
    expect(() => parseFlags(["--model"])).toThrow("needs a value");
  });
});
