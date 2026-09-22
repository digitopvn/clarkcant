import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { includeRegExp, uncoveredFiles } from "../tsconfig-coverage.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The two configs the `typecheck` script runs, read the way the invariant reads them. */
const realConfigs = ["tsconfig.json", "tsconfig.web.json"].map((name) => ({
  name,
  ...JSON.parse(readFileSync(join(repoRoot, name), "utf8")),
}));

describe("includeRegExp", () => {
  it("matches a file directly under the pattern root", () => {
    expect(includeRegExp("apps/web/src/**/*.tsx")?.test("apps/web/src/App.tsx")).toBe(true);
  });

  it("matches a file nested several directories deep", () => {
    const pattern = includeRegExp("packages/conversation-client/src/**/*.tsx");
    expect(pattern?.test("packages/conversation-client/src/settings/controls/SettingsRow.tsx")).toBe(true);
  });

  it("does not match a .tsx file against a .ts pattern", () => {
    const pattern = includeRegExp("packages/*/src/**/*.ts");
    expect(pattern?.test("packages/widget-cli/src/catalog-runtime.tsx")).toBe(false);
  });

  it("does not match a path outside the pattern root", () => {
    const pattern = includeRegExp("packages/widget-cli/src/**/*.tsx");
    expect(pattern?.test("packages/core/src/thing.tsx")).toBe(false);
  });

  it("returns undefined for glob syntax it does not implement, rather than matching nothing", () => {
    expect(includeRegExp("packages/{a,b}/src/*.tsx")).toBeUndefined();
    expect(includeRegExp("packages/?/src/*.tsx")).toBeUndefined();
    expect(includeRegExp("")).toBeUndefined();
    expect(includeRegExp(undefined)).toBeUndefined();
  });
});

describe("uncoveredFiles", () => {
  it("finds a .tsx file that no real config includes", () => {
    const { uncovered } = uncoveredFiles(["packages/voice-adapters/src/panel.tsx"], realConfigs);
    expect(uncovered).toEqual(["packages/voice-adapters/src/panel.tsx"]);
  });

  it("accepts the widget CLI browser entry that the web config names", () => {
    const { uncovered } = uncoveredFiles(["packages/widget-cli/src/catalog-runtime.tsx"], realConfigs);
    expect(uncovered).toEqual([]);
  });

  it("accepts a .tsx spec under the web root's test include", () => {
    const { uncovered } = uncoveredFiles(["packages/conversation-client/test/markdown.spec.tsx"], realConfigs);
    expect(uncovered).toEqual([]);
  });

  it("applies the config's own exclude, as TypeScript does", () => {
    const config = [{ name: "synthetic", include: ["packages/*/src/**/*.tsx"], exclude: ["packages/legacy/**"] }];
    const { uncovered } = uncoveredFiles(["packages/a/src/ok.tsx", "packages/legacy/src/gone.tsx"], config);
    expect(uncovered).toEqual(["packages/legacy/src/gone.tsx"]);
  });

  it("reports a pattern it cannot read instead of silently matching nothing", () => {
    const config = [{ name: "synthetic", include: ["packages/{a,b}/src/*.tsx"] }];
    const { problems } = uncoveredFiles(["packages/a/src/x.tsx"], config);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("synthetic");
  });

  it("treats a config without an include as covering nothing", () => {
    const { uncovered } = uncoveredFiles(["packages/a/src/x.tsx"], [{ name: "synthetic" }]);
    expect(uncovered).toEqual(["packages/a/src/x.tsx"]);
  });
});
