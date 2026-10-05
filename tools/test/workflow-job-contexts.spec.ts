import { describe, expect, it } from "vitest";

import { expandMatrix, workflowJobsFromYaml } from "../workflow-job-contexts.mjs";

describe("expandMatrix", () => {
  it("adds an include entry to every combination it does not overwrite, else as a new combination", () => {
    // The example from GitHub's documentation for `include`.
    const matrix = {
      fruit: ["apple", "pear"],
      animal: ["cat", "dog"],
      include: [
        { color: "green" },
        { color: "pink", animal: "cat" },
        { fruit: "apple", shape: "circle" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" },
      ],
    };
    expect(expandMatrix(matrix, "job")).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ]);
  });

  it("removes excluded combinations before includes apply", () => {
    expect(expandMatrix({ os: ["a", "b"], node: [1, 2], exclude: [{ os: "b", node: 2 }] }, "job")).toEqual([
      { os: "a", node: 1 }, { os: "a", node: 2 }, { os: "b", node: 1 },
    ]);
  });

  it("treats an include-only matrix as exactly its entries", () => {
    expect(expandMatrix({ include: [{ os: "a" }, { os: "b" }] }, "job")).toEqual([{ os: "a" }, { os: "b" }]);
  });

  it("refuses a matrix built from an expression", () => {
    expect(() => expandMatrix("${{ fromJSON(needs.a.outputs.m) }}", "job")).toThrow(/cannot be expanded offline/u);
  });
});

describe("workflowJobsFromYaml", () => {
  it("expands the repository's verify matrix exactly as GitHub names its checks", () => {
    const yaml = [
      "jobs:",
      "  verify:",
      "    name: verify (${{ matrix.os }}, node ${{ matrix.node }})",
      "    strategy:",
      "      matrix:",
      '        node: ["22.19", "24"]',
      "        os: [ubuntu-latest]",
      "        include:",
      "          - os: macos-latest",
      '            node: "24"',
      "  secret-scan:",
      "    name: secret scan",
      "  unnamed:",
      "    if: github.event_name == 'push'",
      "  unnamed-matrix:",
      "    strategy:",
      "      matrix:",
      "        os: [a]",
      "        node: [22.10]",
    ].join("\n");
    expect(workflowJobsFromYaml(yaml)).toEqual([
      {
        id: "verify",
        contexts: ["verify (ubuntu-latest, node 22.19)", "verify (ubuntu-latest, node 24)", "verify (macos-latest, node 24)"],
        hasJobCondition: false,
        needs: [],
      },
      { id: "secret-scan", contexts: ["secret scan"], hasJobCondition: false, needs: [] },
      { id: "unnamed", contexts: ["unnamed"], hasJobCondition: true, needs: [] },
      { id: "unnamed-matrix", contexts: ["unnamed-matrix (a, 22.1)"], hasJobCondition: false, needs: [] },
    ]);
  });

  it.each([
    ["an expression other than matrix.<key>", "jobs:\n  a:\n    name: a ${{ inputs.x }}"],
    ["a matrix key no combination defines", "jobs:\n  a:\n    name: a ${{ matrix.missing }}\n    strategy:\n      matrix:\n        os: [x]"],
    ["a reusable workflow call", "jobs:\n  a:\n    uses: ./.github/workflows/other.yml"],
    ["a workflow without jobs", "name: x"],
  ])("refuses %s", (_label, yaml) => {
    expect(() => workflowJobsFromYaml(yaml)).toThrow();
  });
});
