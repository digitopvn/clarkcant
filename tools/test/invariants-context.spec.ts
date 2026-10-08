import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatReport, relative, repoRelativePath, repoRoot } from "../invariants/context.mjs";

describe("repoRelativePath", () => {
  it("turns a Windows path into a forward-slash repo path", () => {
    expect(
      repoRelativePath("D:\\repo", "D:\\repo\\packages\\core\\src\\execution-policy.ts", path.win32),
    ).toBe("packages/core/src/execution-policy.ts");
  });

  it("leaves a POSIX path as it is", () => {
    expect(repoRelativePath("/repo", "/repo/packages/core/src/execution-policy.ts", path.posix)).toBe(
      "packages/core/src/execution-policy.ts",
    );
  });
});

describe("relative", () => {
  it("gives a forward-slash path on the host OS", () => {
    expect(relative(path.join(repoRoot, "packages", "core", "src", "execution-policy.ts"))).toBe(
      "packages/core/src/execution-policy.ts",
    );
  });
});

describe("formatReport", () => {
  const entry = (name: string, extra: Partial<{ failures: string[]; notes: string[]; skipped: boolean }> = {}) => ({
    name,
    failures: [],
    notes: [],
    skipped: false,
    ...extra,
  });

  it("reports a skipped check as skipped, never as passed", () => {
    const { text, failed } = formatReport([entry("a"), entry("b", { skipped: true, notes: ["dependencies are not installed"] })]);
    expect(failed).toBe(0);
    expect(text).toBe("PASS  a\nSKIP  b\n      · dependencies are not installed\n\n1 invariant check(s) passed, 1 skipped\n");
    expect(text).not.toMatch(/all \d+ invariant checks passed/);
  });

  it("fails a check with failures even if it also said it skipped, and counts the skips beside the failures", () => {
    const { text, failed } = formatReport([entry("a", { skipped: true, failures: ["broken"] }), entry("b", { skipped: true })]);
    expect(failed).toBe(1);
    expect(text).toBe("FAIL  a\n      ✗ broken\nSKIP  b\n\n1 invariant check(s) failed, 1 skipped\n");
  });

  it("says all passed only when every check ran and passed", () => {
    expect(formatReport([entry("a"), entry("b")]).text).toBe("PASS  a\nPASS  b\n\nall 2 invariant checks passed\n");
  });
});
