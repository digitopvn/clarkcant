import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";

import { runCli } from "../src/cli.ts";
import { publishedDefinitions, versionRuleViolations } from "../src/version-rules.ts";

/**
 * What a new version may change without breaking state and bindings that already exist on people's machines.
 *
 * The rules are asserted one at a time against a single base definition, so each test names the one change it makes
 * and the refusal it expects; the last block runs `clark widget publish` twice on a real scaffold, because a rule the
 * command never consults protects nobody.
 */

const base: WidgetDefinition = {
  id: "com.example.notes.main@1",
  version: "1.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object" },
  eventSchemas: {},
  stateSchema: { type: "object", properties: { text: { type: "string" } } },
  stateVersion: 1,
  ephemeralStateKeys: ["scroll"],
  stateMigrations: [{ from: 0, to: 1, ops: [{ op: "rename", from: "body", to: "text" }] }],
  semanticDescription: "Notes.",
  requestedCapabilities: [],
  sizing: { compact: true, expanded: true },
  textFallback: "Notes.",
  effectCategories: [],
  datasetRefs: [],
};

function check(next: Partial<WidgetDefinition>, packageVersion = "1.1.0"): string[] {
  return versionRuleViolations(
    publishedDefinitions("1.0.0", [base]),
    publishedDefinitions(packageVersion, [{ ...base, version: "1.1.0", ...next }]),
  );
}

describe("version rules", () => {
  it("allows a version that changes nothing stored state or bindings depend on", () => {
    expect(check({ semanticDescription: "Notes, better described." })).toEqual([]);
  });

  it("does not treat key order as a schema change", () => {
    expect(check({ stateSchema: { properties: { text: { type: "string" } }, type: "object" } })).toEqual([]);
  });

  it("refuses a changed stateSchema without a higher stateVersion", () => {
    const problems = check({ stateSchema: { type: "object", properties: { text: { type: "number" } } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stateSchema changed but stateVersion is still 1");
  });

  it("refuses a higher stateVersion that has no step from the published one", () => {
    const problems = check({ stateSchema: { type: "object" }, stateVersion: 2 });
    expect(problems.some((problem) => problem.includes("no migration step from stateVersion 1"))).toBe(true);
  });

  it("refuses a raised stateVersion whose chain skips the published one, even with the schema unchanged", () => {
    const problems = check({
      stateVersion: 3,
      stateMigrations: [...(base.stateMigrations ?? []), { from: 2, to: 3, ops: [{ op: "remove", key: "old" }] }],
    });
    expect(problems).toEqual([expect.stringContaining("no migration step from stateVersion 1")]);
  });

  it("allows a changed stateSchema carried forward by a new migration step", () => {
    expect(
      check({
        stateSchema: { type: "object", properties: { text: { type: "string" }, pinned: { type: "boolean" } } },
        stateVersion: 2,
        stateMigrations: [...(base.stateMigrations ?? []), { from: 1, to: 2, ops: [{ op: "default", key: "pinned", value: false }] }],
      }),
    ).toEqual([]);
  });

  it("refuses a published migration step that was edited", () => {
    const problems = check({ stateMigrations: [{ from: 0, to: 1, ops: [{ op: "rename", from: "content", to: "text" }] }] });
    expect(problems).toEqual([expect.stringContaining("published migration step from stateVersion 0 was changed or removed")]);
  });

  it("refuses a lower stateVersion", () => {
    const problems = check({ stateVersion: 0, stateMigrations: [] });
    expect(problems.some((problem) => problem.includes("went from 1 down to 0"))).toBe(true);
  });

  it("refuses a new capability, a changed effect category or changed view-only keys without a major definition version", () => {
    expect(check({ requestedCapabilities: ["calendar.read@1"] })).toEqual([expect.stringContaining("requestedCapabilities (+calendar.read@1)")]);
    expect(check({ effectCategories: ["local-write"] })).toEqual([expect.stringContaining("effectCategories")]);
    expect(check({ ephemeralStateKeys: [] })).toEqual([expect.stringContaining("ephemeralStateKeys")]);
    expect(check({ version: "2.0.0", requestedCapabilities: ["calendar.read@1"] })).toEqual([]);
  });

  it("allows dropping a requested capability", () => {
    const previous = publishedDefinitions("1.0.0", [{ ...base, requestedCapabilities: ["calendar.read@1"] }]);
    const next = publishedDefinitions("1.1.0", [{ ...base, version: "1.1.0" }]);
    expect(versionRuleViolations(previous, next)).toEqual([]);
  });

  it("refuses removing a definition without a major package version", () => {
    const previous = publishedDefinitions("1.0.0", [base]);
    expect(versionRuleViolations(previous, publishedDefinitions("1.1.0", []))).toEqual([
      expect.stringContaining("needs a new major package version"),
    ]);
    expect(versionRuleViolations(previous, publishedDefinitions("2.0.0", []))).toEqual([]);
  });
});

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function editJson(path: string, edit: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("clark widget publish holds a new version to the one it prepared before", () => {
  it("refuses a changed stateSchema without a migration, then accepts it with one", async () => {
    const root = mkdtempSync(join(tmpdir(), "clark-widget-"));
    created.push(root);
    expect(await runCli(["widget", "init", root])).toBe(0);
    expect(await runCli(["widget", "publish", root])).toBe(0);

    const manifest = join(root, "clarkcant.json");
    const definition = join(root, "widgets", "main", "widget.json");
    editJson(manifest, (value) => {
      value["version"] = "0.2.0";
    });
    editJson(definition, (value) => {
      value["stateSchema"] = { type: "object", properties: { done: { type: "boolean" } }, additionalProperties: true };
    });
    const entryBefore = readFileSync(join(root, "dist", "directory-entry.json"), "utf8");
    expect(await runCli(["widget", "publish", root])).toBe(1);
    // Nothing was prepared for the refused version.
    expect(readFileSync(join(root, "dist", "directory-entry.json"), "utf8")).toBe(entryBefore);

    editJson(manifest, (value) => {
      value["version"] = "0.3.0";
    });
    editJson(definition, (value) => {
      value["stateVersion"] = 1;
      value["stateMigrations"] = [{ from: 0, to: 1, ops: [{ op: "default", key: "done", value: false }] }];
    });
    // Conformance runs the migration against the previous version's state, so the package carries one.
    writeFileSync(join(root, "fixtures", "state-v0.json"), `${JSON.stringify({}, null, 2)}\n`);
    expect(await runCli(["widget", "publish", root])).toBe(0);
    const recorded = JSON.parse(readFileSync(join(root, "dist", "published-definitions.json"), "utf8")) as {
      packageVersion: string;
    };
    expect(recorded.packageVersion).toBe("0.3.0");
  });
});
