import path from "node:path";

import { describe, expect, it } from "vitest";

import { relative, repoRelativePath, repoRoot } from "../invariants/context.mjs";

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
