import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseYamlSubset, YamlSubsetError } from "../yaml-subset-parser.mjs";

const workflowsDir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

describe("parseYamlSubset", () => {
  it("reads mappings, sequences of mappings, flow sequences and comments", () => {
    const text = [
      "# leading comment",
      "name: CI",
      "on:",
      "  push:",
      '    branches: ["**", main] # trailing',
      "  pull_request:",
      "jobs:",
      "  build:",
      "    name: build (${{ matrix.os }})",
      "    strategy:",
      "      matrix:",
      "        os: [ubuntu-latest, 'mac''os']",
      "        include:",
      "          - os: windows-latest",
      '            node: "24"',
      "          -   os: other",
      "    steps:",
      "    - run: echo hi",
      "    - uses: actions/checkout@abc # v4",
    ].join("\n");
    expect(parseYamlSubset(text)).toEqual({
      name: "CI",
      on: { push: { branches: ["**", "main"] }, pull_request: null },
      jobs: {
        build: {
          name: "build (${{ matrix.os }})",
          strategy: { matrix: { os: ["ubuntu-latest", "mac'os"], include: [{ os: "windows-latest", node: "24" }, { os: "other" }] } },
          steps: [{ run: "echo hi" }, { uses: "actions/checkout@abc" }],
        },
      },
    });
  });

  it("types plain scalars the way GitHub does and keeps quoted ones as text", () => {
    expect(parseYamlSubset('a: 22.10\nb: "22.10"\nc: true\nd: ~\ne: 24\nf: a#b\ng: "x\\"y"')).toEqual({
      a: 22.1, b: "22.10", c: true, d: null, e: 24, f: "a#b", g: 'x"y',
    });
  });

  it("reads literal and folded block scalars, including lines that look like comments or keys", () => {
    const text = ["run: |", "  echo one", "  # not a comment", "  key: not a key", "", "if: >-", "  a ==", "  b", "next: 1"].join("\n");
    expect(parseYamlSubset(text)).toEqual({ run: "echo one\n# not a comment\nkey: not a key\n", if: "a == b", next: 1 });
  });

  it.each([
    ["an anchor", "a: &anchor 1"],
    ["an alias", "a: *anchor"],
    ["a tag", "a: !!str 1"],
    ["a flow mapping", "a: {b: 1}"],
    ["a multi-line plain scalar", "a: one\n  two"],
    ["an unterminated quoted scalar", 'a: "one'],
    ["a duplicate key", "a: 1\na: 2"],
    ["tab indentation", "a:\n\tb: 1"],
    ["a nested flow sequence", "a: [[1]]"],
    ["an indented document", "  a: 1"],
    ["unexpected indentation", "a: 1\n    b: 2"],
  ])("refuses %s instead of guessing", (_label, text) => {
    expect(() => parseYamlSubset(text)).toThrow(YamlSubsetError);
  });

  it("reads every workflow in the repository", () => {
    for (const file of ["ci.yml", "release-widget-tooling.yml", "review-attestation.yml", "merge-gate-drift.yml"]) {
      const parsed = parseYamlSubset(readFileSync(`${workflowsDir}${file}`, "utf8")) as { jobs?: unknown };
      expect(parsed.jobs, file).toBeTypeOf("object");
    }
  });
});
