import { describe, expect, it } from "vitest";

import {
  instructionGlobProblem,
  PROJECT_INSTRUCTION_LIMITS,
  PROJECT_INSTRUCTIONS_VERSION,
  type ProjectInstructionRule,
  projectInstructionsFileSchema,
  projectInstructionsProblems,
  readProjectInstructions,
} from "../src/index.ts";

const RULE = { when: { path: "packages/storage/**", operation: "write" }, include: ["migrations"] };

/** The rules a reader uses, failing the test when it could not use the file at all. */
function rulesRead(value: unknown): ProjectInstructionRule[] {
  const read = readProjectInstructions(value);
  if (!read.ok) throw new Error(`not read: ${read.reason}`);
  expect(read.version).toBe(PROJECT_INSTRUCTIONS_VERSION);
  return read.rules;
}

describe("project instructions contract", () => {
  it("requires a version for a file written now", () => {
    expect(projectInstructionsFileSchema.safeParse({ version: 1, rules: [RULE] }).success).toBe(true);
    expect(projectInstructionsFileSchema.safeParse({ rules: [RULE] }).success).toBe(false);
    expect(projectInstructionsFileSchema.safeParse({ version: 2, rules: [RULE] }).success).toBe(false);
  });

  it("still reads a file with no version, as version 1", () => {
    expect(rulesRead({ rules: [RULE] })).toEqual([{ ...RULE, when: RULE.when }]);
  });

  it("says why it does not read a version it does not know, or a file of another shape", () => {
    expect(readProjectInstructions({ version: 2, rules: [RULE] })).toEqual({ ok: false, reason: "unknown-version", version: 2 });
    // A version 2 file may have keys version 1 does not know; the version is what it is refused for.
    expect(readProjectInstructions({ version: 2, rules: [RULE], future: {} })).toEqual({
      ok: false,
      reason: "unknown-version",
      version: 2,
    });
    expect(readProjectInstructions({ version: "1", rules: [RULE] })).toEqual({ ok: false, reason: "shape" });
    expect(readProjectInstructions({ version: 1, rules: [RULE], extra: true })).toEqual({ ok: false, reason: "shape" });
    expect(readProjectInstructions([RULE])).toEqual({ ok: false, reason: "shape" });
  });

  it("tolerates an editor's $schema at the top, and nothing else unknown there", () => {
    const schema = "https://example.invalid/instructions.schema.json";
    expect(rulesRead({ $schema: schema, version: 1, rules: [RULE] })).toHaveLength(1);
    expect(projectInstructionsProblems({ $schema: schema, version: 1, rules: [RULE] })).toEqual([]);
    expect(projectInstructionsProblems({ version: 1, rules: [RULE], extra: true })).toEqual(['file: Unrecognized key: "extra"']);
    // An unknown key inside a rule, or inside its `when`, leaves out that rule only.
    expect(rulesRead({ version: 1, rules: [{ ...RULE, extra: true }, RULE, { ...RULE, when: { ...RULE.when, extra: 1 } }] })).toHaveLength(1);
  });

  it("leaves out a rule that does not parse and reads only the first rules", () => {
    const many = Array.from({ length: PROJECT_INSTRUCTION_LIMITS.rules + 5 }, () => RULE);
    expect(rulesRead({ version: 1, rules: many })).toHaveLength(PROJECT_INSTRUCTION_LIMITS.rules);
    expect(rulesRead({ version: 1, rules: [{ include: ["../secrets"] }, RULE, { include: [] }] })).toHaveLength(1);
  });

  it("bounds a path glob", () => {
    expect(instructionGlobProblem("src/**/*.ts")).toBeUndefined();
    expect(instructionGlobProblem("")).toMatch(/empty/);
    expect(instructionGlobProblem("/")).toMatch(/at least one/);
    expect(instructionGlobProblem("*".repeat(PROJECT_INSTRUCTION_LIMITS.globWildcards + 1))).toMatch(/wildcards/);
    expect(instructionGlobProblem(Array.from({ length: 33 }, () => "a").join("/"))).toMatch(/folders/);
    // A run of `**` counts as one folder, the way the matcher collapses it.
    expect(instructionGlobProblem([...Array.from({ length: 31 }, () => "a"), "**", "**"].join("/"))).toBeUndefined();
    expect(rulesRead({ version: 1, rules: [{ when: { path: "*".repeat(17) }, include: ["a"] }, RULE] })).toHaveLength(1);
  });

  it("bounds the path glob characters of a whole file, leaving out the rule that would go over, in file order", () => {
    // Ten globs of 195 characters: two such rules fit in the file's 4,000, a third does not, a short one still does.
    const long = (letter: string): string => `src/${letter.repeat(191)}`;
    const wide = { when: { path: Array.from({ length: 10 }, (_, index) => long(String.fromCharCode(97 + index))) }, include: ["a"] };
    expect(PROJECT_INSTRUCTION_LIMITS.globCharsPerFile).toBe(4_000);
    const file = { version: 1, rules: [wide, wide, wide, RULE] };
    // The third wide rule would take the file over; the small rule after it still fits.
    expect(rulesRead(file)).toEqual([wide, wide, RULE]);
    expect(projectInstructionsProblems(file)).toEqual([
      `rules[2].when.path: takes the file's path globs over ${String(PROJECT_INSTRUCTION_LIMITS.globCharsPerFile)} characters in all; a node leaves this rule out`,
    ]);
    expect(projectInstructionsFileSchema.safeParse({ version: 1, rules: [wide, wide, RULE] }).success).toBe(true);
  });

  it("says what is wrong with a file, one line each", () => {
    expect(projectInstructionsProblems({ version: 1, rules: [RULE] })).toEqual([]);
    expect(projectInstructionsProblems({ rules: [RULE] })).toEqual([
      'version: missing; write "version": 1 (a node still reads a file without it as version 1)',
    ]);
    const problems = projectInstructionsProblems({ version: 1, rules: [RULE, { when: { operation: "delete" }, include: ["Bad Name"] }] });
    expect(problems).toEqual([
      "rules[1].when.operation: must be one of read, write, command, test, deploy or a list of 1 to 16 of them",
      "rules[1].include[0]: must be a snippet name of lowercase letters, digits and -",
    ]);
    expect(projectInstructionsProblems("text")[0]).toMatch(/^file: /);
    expect(projectInstructionsProblems({ version: "1", rules: [] })).toEqual(["version: must be the number 1"]);
  });

  it("names the field and the value that is wrong in a condition that takes one value or a list", () => {
    const problemsOf = (when: Record<string, unknown>): string[] =>
      projectInstructionsProblems({ version: 1, rules: [{ when, include: ["a"] }] });
    expect(problemsOf({ role: ["task", 3] })).toEqual(["rules[0].when.role: item [1] must be one of foreground, background, task"]);
    expect(problemsOf({ project: 5 })).toEqual(["rules[0].when.project: must be a folder name or a list of 1 to 16 of them"]);
    expect(problemsOf({ skill: [] })).toEqual(["rules[0].when.skill: must be a skill name or a list of 1 to 16 of them"]);
    expect(problemsOf({ path: "" })).toEqual(["rules[0].when.path: must not be empty"]);
    expect(problemsOf({ path: ["src/**", "/"] })).toEqual(["rules[0].when.path[1]: must name at least one folder or file"]);
    expect(problemsOf({ capability: "x".repeat(201) })[0]).toMatch(/^rules\[0\]\.when\.capability: Too big/);
  });

  it("stops at a version it does not know with one line that says what to do", () => {
    expect(projectInstructionsProblems({ version: 2, rules: [{ ...RULE, future: true }] })).toEqual([
      "version 2 is newer than this build reads (1); update ClarkCant",
    ]);
    expect(projectInstructionsProblems({ version: 0, rules: [] })).toEqual(['version 0 is not one ClarkCant reads; write "version": 1']);
  });
});
