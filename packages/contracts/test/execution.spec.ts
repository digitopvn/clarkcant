import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTONOMY_SETTINGS,
  EXECUTION_POLICIES,
  GUARD_CLASSES,
  executionPolicyOr,
  guardClassFor,
  parseAutonomySettings,
  parseGuardrailConstraint,
} from "../src/execution.ts";

/**
 * The autonomy contract.
 *
 * These are the values a settings panel writes and a command path reads, so the cases that matter are
 * the ones where something is missing or wrong: an upgrade that predates a field, a hand-edited row, a
 * settings object a person half-filled. Every one of them has to resolve to a policy that still
 * consults the guardrail rather than to a crash or to `auto`.
 */
describe("the execution policy a node runs under", () => {
  it("defaults to guarded when nothing is stored", () => {
    expect(executionPolicyOr(undefined)).toBe("guarded");
  });

  it("keeps a policy a person chose", () => {
    for (const policy of EXECUTION_POLICIES) {
      expect(executionPolicyOr(policy)).toBe(policy);
    }
  });

  it("resolves an unreadable value to the default rather than to autonomy", () => {
    // A stored "true" is the shape the boolean this replaced would have written. It must not be read
    // as `auto`, and it must not throw at the moment a command is proposed.
    expect(executionPolicyOr(true)).toBe("guarded");
    expect(executionPolicyOr("yes")).toBe("guarded");
    expect(executionPolicyOr({ policy: "deny" })).toBe("guarded");
  });
});

describe("which switch governs an effect", () => {
  it("governs every command with the commands switch", () => {
    // Whatever the command turns out to do, "commands" is the row a person looks for afterwards.
    expect(guardClassFor({ surface: "command", effectCategory: "read" })).toBe("commands");
    expect(guardClassFor({ surface: "command", effectCategory: "destructive" })).toBe("commands");
    expect(guardClassFor({ surface: "command", effectCategory: "external-write" })).toBe("commands");
  });

  it("governs a capability by how far its effect reaches", () => {
    expect(guardClassFor({ surface: "capability", effectCategory: "read" })).toBe("reads");
    expect(guardClassFor({ surface: "capability", effectCategory: "external-write" })).toBe("external-writes");
    expect(guardClassFor({ surface: "capability", effectCategory: "communication" })).toBe("communication");
    expect(guardClassFor({ surface: "capability", effectCategory: "financial" })).toBe("financial");
  });

  it("treats a local or destructive effect as a local write", () => {
    expect(guardClassFor({ surface: "capability", effectCategory: "local-write" })).toBe("local-writes");
    expect(guardClassFor({ surface: "capability", effectCategory: "destructive" })).toBe("local-writes");
    expect(guardClassFor({ surface: "capability", effectCategory: "media-capture" })).toBe("local-writes");
  });
});

describe("the autonomy settings a node stores", () => {
  it("starts autonomous, guarded, and with reads unguarded", () => {
    expect(DEFAULT_AUTONOMY_SETTINGS.executionPolicy).toBe("guarded");
    expect(DEFAULT_AUTONOMY_SETTINGS.jevGuardrails).toBe(true);
    expect(DEFAULT_AUTONOMY_SETTINGS.whenJevUnavailable).toBe("allow");
    expect(DEFAULT_AUTONOMY_SETTINGS.guardedClasses).not.toContain("reads");
    expect(DEFAULT_AUTONOMY_SETTINGS.guardedClasses).toContain("commands");
  });

  it("fills missing fields from the defaults instead of resetting the object", () => {
    // What an upgrade looks like: a row written before `whenJevUnavailable` existed.
    const parsed = parseAutonomySettings({ executionPolicy: "confirm", jevGuardrails: false });
    expect(parsed.executionPolicy).toBe("confirm");
    expect(parsed.jevGuardrails).toBe(false);
    expect(parsed.whenJevUnavailable).toBe(DEFAULT_AUTONOMY_SETTINGS.whenJevUnavailable);
    expect(parsed.guardedClasses).toEqual(DEFAULT_AUTONOMY_SETTINGS.guardedClasses);
  });

  it("costs only the field that is wrong", () => {
    const parsed = parseAutonomySettings({
      executionPolicy: "sometimes",
      instructions: "Never delete git repositories.",
      whenJevUnavailable: "deny",
    });
    expect(parsed.executionPolicy).toBe("guarded");
    expect(parsed.whenJevUnavailable).toBe("deny");
    expect(parsed.instructions).toBe("Never delete git repositories.");
  });

  it("drops a guard class that is not one of the six", () => {
    const parsed = parseAutonomySettings({ guardedClasses: ["commands", "teleportation"] });
    expect(parsed.guardedClasses).toEqual(["commands"]);
  });

  it("falls back whole when the stored value is not an object", () => {
    expect(parseAutonomySettings("autonomous")).toEqual(DEFAULT_AUTONOMY_SETTINGS);
    expect(parseAutonomySettings(undefined)).toEqual(DEFAULT_AUTONOMY_SETTINGS);
  });

  it("names all six switches", () => {
    expect(GUARD_CLASSES).toEqual([
      "commands",
      "local-writes",
      "external-writes",
      "communication",
      "financial",
      "reads",
    ]);
  });
});

describe("a guardrail's constraint", () => {
  it("accepts the three ways an operation may be narrowed", () => {
    expect(parseGuardrailConstraint({ kind: "timeout-ms", value: 30_000 })).toEqual({
      kind: "timeout-ms",
      value: 30_000,
    });
    expect(parseGuardrailConstraint({ kind: "max-output-bytes", value: 2_000 })?.value).toBe(2_000);
    expect(parseGuardrailConstraint({ kind: "cwd", value: "packages/core" })?.value).toBe("packages/core");
  });

  it("refuses anything else, including a negative or unbounded value", () => {
    expect(parseGuardrailConstraint({ kind: "timeout-ms", value: 0 })).toBeUndefined();
    expect(parseGuardrailConstraint({ kind: "timeout-ms", value: -1 })).toBeUndefined();
    expect(parseGuardrailConstraint({ kind: "timeout-ms", value: 10_000_000 })).toBeUndefined();
    expect(parseGuardrailConstraint({ kind: "allow-everything", value: 1 })).toBeUndefined();
    expect(parseGuardrailConstraint("allow")).toBeUndefined();
  });
});
