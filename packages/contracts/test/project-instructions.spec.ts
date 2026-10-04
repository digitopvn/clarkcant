import { describe, expect, it } from "vitest";

import {
  instructionGlobProblem,
  PROJECT_INSTRUCTION_LIMITS,
  PROJECT_INSTRUCTIONS_VERSION,
  projectInstructionsFileSchema,
  projectInstructionsProblems,
  readProjectInstructions,
} from "../src/index.ts";

const RULE = { when: { path: "packages/storage/**", operation: "write" }, include: ["migrations"] };

describe("project instructions contract", () => {
  it("requires a version for a file written now", () => {
    expect(projectInstructionsFileSchema.safeParse({ version: 1, rules: [RULE] }).success).toBe(true);
    expect(projectInstructionsFileSchema.safeParse({ rules: [RULE] }).success).toBe(false);
    expect(projectInstructionsFileSchema.safeParse({ version: 2, rules: [RULE] }).success).toBe(false);
  });

  it("still reads a file with no version, as version 1", () => {
    const read = readProjectInstructions({ rules: [RULE] });
    expect(read?.version).toBe(PROJECT_INSTRUCTIONS_VERSION);
    expect(read?.rules).toEqual([{ ...RULE, when: RULE.when }]);
  });

  it("does not read a version it does not know, or a file of another shape", () => {
    expect(readProjectInstructions({ version: 2, rules: [RULE] })).toBeUndefined();
    expect(readProjectInstructions({ version: 1, rules: [RULE], extra: true })).toBeUndefined();
    expect(readProjectInstructions([RULE])).toBeUndefined();
  });

  it("leaves out a rule that does not parse and reads only the first rules", () => {
    const many = Array.from({ length: PROJECT_INSTRUCTION_LIMITS.rules + 5 }, () => RULE);
    expect(readProjectInstructions({ version: 1, rules: many })?.rules).toHaveLength(PROJECT_INSTRUCTION_LIMITS.rules);
    const read = readProjectInstructions({ version: 1, rules: [{ include: ["../secrets"] }, RULE, { include: [] }] });
    expect(read?.rules).toHaveLength(1);
  });

  it("bounds a path glob", () => {
    expect(instructionGlobProblem("src/**/*.ts")).toBeUndefined();
    expect(instructionGlobProblem("")).toMatch(/empty/);
    expect(instructionGlobProblem("/")).toMatch(/at least one/);
    expect(instructionGlobProblem("*".repeat(PROJECT_INSTRUCTION_LIMITS.globWildcards + 1))).toMatch(/wildcards/);
    expect(instructionGlobProblem(Array.from({ length: 33 }, () => "a").join("/"))).toMatch(/folders/);
    // A run of `**` counts as one folder, the way the matcher collapses it.
    expect(instructionGlobProblem([...Array.from({ length: 31 }, () => "a"), "**", "**"].join("/"))).toBeUndefined();
    const read = readProjectInstructions({ version: 1, rules: [{ when: { path: "*".repeat(17) }, include: ["a"] }, RULE] });
    expect(read?.rules).toHaveLength(1);
  });

  it("says what is wrong with a file, one line each", () => {
    expect(projectInstructionsProblems({ version: 1, rules: [RULE] })).toEqual([]);
    expect(projectInstructionsProblems({ rules: [RULE] })).toEqual([
      'version: missing; write "version": 1 (a node still reads a file without it as version 1)',
    ]);
    const problems = projectInstructionsProblems({ version: 1, rules: [RULE, { when: { operation: "delete" }, include: ["Bad Name"] }] });
    expect(problems.some((line) => line.startsWith("rules[1].when.operation: "))).toBe(true);
    expect(problems.some((line) => line.startsWith("rules[1].include[0]: must be a snippet name"))).toBe(true);
    expect(projectInstructionsProblems("text")[0]).toMatch(/^file: /);
  });
});
