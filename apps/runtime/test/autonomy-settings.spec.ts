import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, readExecutionPolicy } from "@clarkcant/core";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  policyFromAutonomySettings,
  projectPolicyPreference,
  readAutonomySettings,
  saveAutonomySettings,
  writePolicyPreference,
} from "../src/autonomy-settings.ts";
import { readRegisteredPreference, writeRegisteredPreference, type PreferenceDeps } from "@clarkcant/core";

/**
 * The compatibility surface around the one policy.
 *
 * Two shapes still exist in the product that predate it: the five fields the Control tab posts, and the two
 * registered preference keys a surface may still spell the mode and the rules in. Both are views here — never
 * a second copy — and the property under test is the one that matters for a view: reading it and writing it
 * back unchanged must not move anything, and writing part of it must not delete the part it cannot name.
 */

const PRINCIPAL = "prin_owner";
const AT = "2026-09-21T12:00:00.000Z" as Instant;

let db: Database;
let deps: PreferenceDeps;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  deps = { db, now: () => AT };
});

function storedPolicy(): ExecutionPolicyConfig {
  return readExecutionPolicy(deps, PRINCIPAL);
}

function writePolicy(value: ExecutionPolicyConfig): void {
  const outcome = writeRegisteredPreference(deps, {
    principalId: PRINCIPAL,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
    value,
    source: "user",
  });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("the five fields the panel posts", () => {
  it("reads the canonical policy, not a default of its own", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "guarded" });
    expect(readAutonomySettings(deps, PRINCIPAL).executionPolicy).toBe("guarded");
  });

  it("says a node-wide refusal as the refusal option, not as the mode it wraps", () => {
    // The one case AC-2 named: a node that refuses everything must not be displayed as merely "Guarded".
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all" });
    expect(readAutonomySettings(deps, PRINCIPAL).executionPolicy).toBe("deny");
  });

  it("leaves the rules alone when a write through the legacy shape cannot name them", () => {
    /*
     * The legacy shape has no rule table. A panel that edits the guardrail switches and saves must not therefore
     * delete a refusal the user wrote somewhere else — that would be a widening performed by a save button.
     */
    writePolicy({
      ...DEFAULT_EXECUTION_POLICY_CONFIG,
      rules: [
        { effectCategory: "financial", decision: "deny" },
        { effectCategory: "external-write", decision: "execute" },
      ],
    });
    const current = storedPolicy();

    const next = policyFromAutonomySettings(current, { executionPolicy: "guarded", jevGuardrails: true });

    expect(next.rules).toEqual(current.rules);
    expect(next.mode).toBe("guarded");
  });

  it("stores what it is given, and does not keep a parallel row of its own", () => {
    const stored = saveAutonomySettings(deps, PRINCIPAL, {
      executionPolicy: "confirm",
      jevGuardrails: false,
      instructions: "never delete git repositories",
      guardedClasses: ["financial"],
      whenJevUnavailable: "deny",
    });

    expect(stored.mode).toBe("ask");
    expect(stored.guardrails).toEqual({
      enabled: false,
      instructions: "never delete git repositories",
      classes: ["financial"],
      whenUnavailable: "deny",
    });
    // Read back through the reader, not through a cached value.
    expect(storedPolicy()).toEqual(stored);
  });
});

describe("the two preference keys that still name the mode and the rules", () => {
  it("answers them from the canonical policy", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask", rules: [{ effectCategory: "read", decision: "deny" }] });
    const policy = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY });
    const mode = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "execution.mode" });
    const rules = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "execution.rules" });
    if (policy === undefined || mode === undefined || rules === undefined) throw new Error("missing preference");

    expect(projectPolicyPreference(policy, mode).value).toBe("ask");
    expect(projectPolicyPreference(policy, rules).value).toEqual([{ effectCategory: "read", decision: "deny" }]);
    // The revision reported is the policy's, because that is the value the surface is being shown.
    expect(projectPolicyPreference(policy, mode).revision).toBe(policy.revision);
    expect(projectPolicyPreference(policy, mode).isDefault).toBe(policy.isDefault);
  });

  it("writes them into the policy, so the key a surface writes is the key the node obeys", () => {
    writePolicy({ ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "guarded" });

    const mode = writePolicyPreference(deps, { principalId: PRINCIPAL, key: "execution.mode", value: "ask" });
    expect(mode?.ok).toBe(true);
    expect(storedPolicy().mode).toBe("ask");

    const rules = writePolicyPreference(deps, {
      principalId: PRINCIPAL,
      key: "execution.rules",
      value: [{ effectCategory: "financial", decision: "deny" }],
    });
    expect(rules?.ok).toBe(true);
    expect(storedPolicy().rules).toEqual([{ effectCategory: "financial", decision: "deny" }]);
    // And the mode the first write set is still there: two keys, one policy.
    expect(storedPolicy().mode).toBe("ask");
  });

  it("refuses a value the canonical schema refuses, rather than storing a policy it cannot read", () => {
    const outcome = writePolicyPreference(deps, { principalId: PRINCIPAL, key: "execution.mode", value: "yolo" });
    expect(outcome?.ok).toBe(false);
    expect(storedPolicy()).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG);
  });

  it("does not touch a key that is not one of the two", () => {
    expect(writePolicyPreference(deps, { principalId: PRINCIPAL, key: "experience.theme", value: "dark" })).toBeUndefined();
  });
});
