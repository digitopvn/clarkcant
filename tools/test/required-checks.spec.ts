import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main as driftMain } from "../check-ruleset-drift.mjs";
import { compareWithWorkflow, diffRuleset, requiredContexts, rulesetPayload, validateConfig } from "../required-checks.mjs";
import { workflowJobsFromYaml } from "../workflow-job-contexts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function config(overrides: Record<string, unknown> = {}) {
  return validateConfig({
    repository: "owner/repo",
    ruleset: { id: 7, name: "main: required CI" },
    strict: true,
    integrationId: 15368,
    workflow: ".github/workflows/ci.yml",
    requiredJobs: ["build (linux)", "build (mac)", "lint"],
    requiredStatuses: { "review attestation": ".github/workflows/review-attestation.yml" },
    nonGatingJobs: { "nightly extra": "informational only" },
    ...overrides,
  });
}

const writers = { statusWriters: { "review attestation": ".github/workflows/review-attestation.yml" } };

const WORKFLOW = [
  "jobs:",
  "  build:",
  "    name: build (${{ matrix.os }})",
  "    strategy:",
  "      matrix:",
  "        os: [linux, mac]",
  "  lint:",
  "    name: lint",
  "  extra:",
  "    name: nightly extra",
].join("\n");

describe("compareWithWorkflow", () => {
  it("passes when every job is required or deliberately non-gating", () => {
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(WORKFLOW), writers)).toEqual([]);
  });

  it("fails on a renamed job: the old required name reports nothing and the new name gates nothing", () => {
    const renamed = WORKFLOW.replace("    name: lint", "    name: lint and format");
    const failures = compareWithWorkflow(config(), workflowJobsFromYaml(renamed), writers);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/required check "lint" is not reported by any job/u);
    expect(failures[1]).toMatch(/reports "lint and format", which .* neither requires nor lists as intentionally non-gating/u);
  });

  it("fails on an added job until it is required or listed with a reason", () => {
    const added = `${WORKFLOW}\n  container:\n    name: service container (rootless podman)`;
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(added), writers)).toEqual([
      expect.stringMatching(/"service container \(rootless podman\)", which .* neither requires/u),
    ]);
    const required = config({ requiredJobs: ["build (linux)", "build (mac)", "lint", "service container (rootless podman)"] });
    expect(compareWithWorkflow(required, workflowJobsFromYaml(added), writers)).toEqual([]);
  });

  it("fails when a new matrix entry adds a check nobody required", () => {
    const widened = WORKFLOW.replace("os: [linux, mac]", "os: [linux, mac, windows]");
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(widened), writers)).toEqual([
      expect.stringMatching(/"build \(windows\)"/u),
    ]);
  });

  it("fails when a required job could be skipped by a job-level condition", () => {
    const conditional = WORKFLOW.replace("    name: lint", "    name: lint\n    if: github.event_name == 'push'");
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(conditional), writers)).toEqual([
      expect.stringMatching(/job "lint" has a job-level `if:`/u),
    ]);
  });

  it("fails when a required job depends on a job that is not required, whose failure would skip it", () => {
    const dependent = WORKFLOW.replace("    name: lint", "    name: lint\n    needs: [extra]");
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(dependent), writers)).toEqual([
      expect.stringMatching(/required job "lint" needs "extra", which is not required/u),
    ]);
    const onRequired = WORKFLOW.replace("    name: lint", "    name: lint\n    needs: build");
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(onRequired), writers)).toEqual([]);
  });

  it("fails on a stale non-gating entry and on a required status nobody writes", () => {
    const withoutExtra = WORKFLOW.split("\n").slice(0, -2).join("\n");
    expect(compareWithWorkflow(config(), workflowJobsFromYaml(withoutExtra), {})).toEqual([
      expect.stringMatching(/"nightly extra" is listed as intentionally non-gating but no job/u),
      expect.stringMatching(/required status "review attestation" is not written by any known workflow/u),
    ]);
  });
});

describe("validateConfig", () => {
  it.each([
    ["a check both required and non-gating", { nonGatingJobs: { lint: "why" } }, /both as required and as intentionally non-gating/u],
    ["a check required twice", { requiredJobs: ["lint", "lint"] }, /required twice/u],
    ["a non-gating job without a reason", { nonGatingJobs: { extra: "" } }, /non-empty explanation/u],
    ["a non-boolean strict flag", { strict: "yes" }, /strict must be/u],
    ["no required jobs", { requiredJobs: [] }, /requiredJobs/u],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => config(overrides)).toThrow(message);
  });

  it("accepts the committed gate, which matches the committed CI workflow", () => {
    const committed = validateConfig(JSON.parse(readFileSync(`${root}.github/required-checks.json`, "utf8")));
    const jobs = workflowJobsFromYaml(readFileSync(`${root}${committed.workflow}`, "utf8"));
    expect(compareWithWorkflow(committed, jobs, writers)).toEqual([]);
    expect(requiredContexts(committed)).toEqual(expect.arrayContaining([
      "service container (rootless docker)", "service container (rootless podman)", "review attestation",
    ]));
  });
});

function ruleset(overrides: Record<string, unknown> = {}, checks = ["build (linux)", "build (mac)", "lint", "review attestation"], strict = true) {
  return {
    id: 7,
    name: "main: required CI",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: strict,
          do_not_enforce_on_create: false,
          required_status_checks: checks.map((context) => ({ context, integration_id: 15368 })),
        },
      },
    ],
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    ...overrides,
  };
}

describe("diffRuleset", () => {
  it("reports nothing when the live ruleset enforces exactly the file", () => {
    expect(diffRuleset(config(), ruleset())).toEqual([]);
  });

  it("names each missing and extra check, a loose source, and a strict mismatch", () => {
    const live = ruleset({}, ["build (linux)", "old job"], false);
    (live.rules[1] as { parameters: { required_status_checks: { context: string, integration_id?: number }[] } })
      .parameters.required_status_checks[0] = { context: "build (linux)" };
    expect(diffRuleset(config(), live)).toEqual([
      "strict_required_status_checks_policy: ruleset false, file true",
      '~ "build (linux)" must come from integration 15368, ruleset accepts any source',
      '+ "build (mac)" is required by the file but not by the ruleset',
      '+ "lint" is required by the file but not by the ruleset',
      '+ "review attestation" is required by the file but not by the ruleset',
      '- "old job" is required by the ruleset but not by the file',
    ]);
  });

  it("reports a disabled ruleset or one that no longer targets the default branch", () => {
    expect(diffRuleset(config(), ruleset({ enforcement: "evaluate", conditions: { ref_name: { include: [] } } }))).toEqual([
      'ruleset enforcement is "evaluate", expected "active"',
      "ruleset does not target the default branch (conditions.ref_name.include lacks ~DEFAULT_BRANCH)",
    ]);
  });
});

describe("rulesetPayload", () => {
  it("replaces only the required-checks rule and keeps every other rule, condition and bypass actor", () => {
    const live = ruleset({ node_id: "x", _links: {}, current_user_can_bypass: "always" }, ["lint"], false);
    const payload = rulesetPayload(config(), live);
    expect(payload).toEqual({
      name: "main: required CI",
      target: "branch",
      enforcement: "active",
      conditions: live.conditions,
      bypass_actors: live.bypass_actors,
      rules: [
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: ["build (linux)", "build (mac)", "lint", "review attestation"]
              .map((context) => ({ context, integration_id: 15368 })),
          },
        },
      ],
    });
    expect(diffRuleset(config(), { ...live, ...payload })).toEqual([]);
  });

  it("refuses a ruleset read without bypass actors, which the body could not round-trip", () => {
    const { bypass_actors: _omitted, ...withoutActors } = ruleset();
    expect(() => rulesetPayload(config(), withoutActors)).toThrow(/bypass_actors/u);
  });
});

describe("check-ruleset-drift", () => {
  function run(argv: string[], live: unknown) {
    const out: string[] = [];
    const err: string[] = [];
    const client = { request: async () => live, paginate: async () => [] };
    return driftMain(argv, { client, config: config(), out: (t: string) => out.push(t), err: (t: string) => err.push(t) })
      .then((code: number) => ({ code, out: out.join(""), err: err.join("") }));
  }

  it("exits 0 without drift and 1 with a precise diff", async () => {
    expect((await run([], ruleset())).code).toBe(0);
    const drifted = await run([], ruleset({}, ["lint"], false));
    expect(drifted.code).toBe(1);
    expect(drifted.err).toContain('+ "build (mac)" is required by the file but not by the ruleset');
    expect(drifted.err).toContain("strict_required_status_checks_policy: ruleset false, file true");
  });

  it("prints the PUT body and the command, and never writes", async () => {
    let writes = 0;
    const client = {
      request: async (method: string) => { if (method !== "GET") writes += 1; return ruleset({}, ["lint"], false); },
      paginate: async () => [],
    };
    const out: string[] = [];
    const err: string[] = [];
    const code = await driftMain(["--print-ruleset-payload"], { client, config: config(), out: (t: string) => out.push(t), err: (t: string) => err.push(t) });
    expect(code).toBe(0);
    expect(writes).toBe(0);
    expect(JSON.parse(out.join("")).rules[1].parameters.strict_required_status_checks_policy).toBe(true);
    expect(err.join("")).toContain("gh api --method PUT repos/owner/repo/rulesets/7 --input ruleset.json");
  });

  it("exits 2 when the ruleset cannot be read or an argument is unknown", async () => {
    const failing = { request: async () => { throw new Error("HTTP 404"); }, paginate: async () => [] };
    expect(await driftMain([], { client: failing, config: config(), out: () => {}, err: () => {} })).toBe(2);
    expect(await driftMain(["--apply"], { client: failing, config: config(), out: () => {}, err: () => {} })).toBe(2);
  });
});
