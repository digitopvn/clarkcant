import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type AutonomySettings,
  type EffectCategory,
  type ExecutionMode,
  type ExecutionPolicy,
  type ExecutionPolicyConfig,
  type ExecutionRule,
} from "@clarkcant/contracts";

import { decideExecution, guardrailCovers } from "../src/execution-policy.ts";
import {
  autonomyFamily,
  joinExecutionPolicies,
  legacyPolicyFromPolicy,
  type LegacyPolicyFamily,
} from "../src/execution-policy-migration.ts";

/**
 * Parity across the surfaces, and — the half that actually catches a regression — parity between what this
 * build decides and what the two legacy policies decided before it.
 *
 * Cross-surface parity alone is the weaker claim: four seams reading one function agree with each other by
 * construction, and the failure this phase exists to prevent is not those four disagreeing but the one
 * policy being *looser* than what it replaced. So the table below carries a frozen model of the legacy
 * decisions — the command path's four-value policy and class switches, and the widget/install path's
 * mode-plus-rules — and asserts, for every tuple, that the canonical decision is never more permissive
 * than the legacy one it stands in for.
 *
 * The legacy model is written out here on purpose rather than imported: `policyForEffect` is gone from the
 * production tree, and a regression oracle that shares code with the thing under test proves nothing.
 */

const RISKY: ReadonlySet<EffectCategory> = new Set<EffectCategory>([
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
]);
const CATEGORIES: readonly EffectCategory[] = [
  "read",
  "local-write",
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
];
const SURFACES = ["command", "widget-action", "install", "capability"] as const;
const MODES: readonly ExecutionMode[] = ["autonomous", "guarded", "ask"];

/** Permissiveness, so "never looser" is a comparison and not a description. */
const PERMISSIVENESS: Record<"deny" | "ask" | "execute", number> = { deny: 0, ask: 1, execute: 2 };

function policy(overrides: Partial<ExecutionPolicyConfig> = {}): ExecutionPolicyConfig {
  return { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...overrides };
}

function decisionKind(
  inForce: ExecutionPolicyConfig,
  category: EffectCategory,
  options: { explicitUserIntent: boolean; hardBoundary?: boolean },
): "deny" | "ask" | "execute" {
  return decideExecution({
    policy: inForce,
    action: { kind: "effect", category, operationDigest: "sha256:parity" },
    explicitUserIntent: options.explicitUserIntent,
    ...(options.hardBoundary !== true
      ? {}
      : { hardBoundary: { kind: "os-permission" as const, because: "the operating system asks" } }),
  }).kind;
}

/**
 * The command path as it was: `policyForEffect` plus the branch it drove in `run_command`.
 *
 * Two properties of it matter to this table. `deny` and `confirm` were answered by the policy alone;
 * `auto` and `guarded` both ran the command without a card, and differed only in whether the judgment
 * layer was consulted — so no legacy mode except `confirm` could ever ask a person. Which class the
 * judgment layer judged is a separate gate, and it is preserved rather than compared: it can only narrow.
 */
function legacyCommandDecision(executionPolicy: ExecutionPolicy): "deny" | "ask" | "execute" {
  if (executionPolicy === "deny") return "deny";
  if (executionPolicy === "confirm") return "ask";
  return "execute";
}

/** The widget, install and capability path as it was: `decideExecution({mode, rules, explicitUserIntent: true})`. */
function legacySurfaceDecision(
  family: { mode: ExecutionMode; rules: readonly ExecutionRule[] },
  category: EffectCategory,
): "deny" | "ask" | "execute" {
  const rule = family.rules.find((entry) => entry.effectCategory === category);
  if (rule?.decision === "deny") return "deny";
  if (family.mode === "ask") return "ask";
  if (family.mode === "guarded") {
    if (rule?.decision === "execute") return "execute";
    if (rule?.decision === "ask" || RISKY.has(category)) return "ask";
    return "execute";
  }
  return rule?.decision === "ask" ? "ask" : "execute";
}

const AUTONOMY_DEFAULT: AutonomySettings = {
  executionPolicy: "guarded",
  jevGuardrails: true,
  instructions: "",
  guardedClasses: ["commands", "local-writes", "external-writes", "communication", "financial"],
  whenJevUnavailable: "allow",
};

function autonomy(overrides: Partial<AutonomySettings> = {}): AutonomySettings {
  return { ...AUTONOMY_DEFAULT, ...overrides };
}

/**
 * Every legacy configuration the ledger enumerates: one family alone, the other alone, and the two together.
 *
 * Written in the legacy vocabulary rather than in canonical terms, because the canonical side is the thing that has
 * to be derived — a table that started from the answer could not show that the answer is no looser than the question.
 */
const LEGACY_CONFIGS: readonly {
  id: string;
  autonomy?: AutonomySettings;
  execution?: { mode: ExecutionMode; rules: readonly ExecutionRule[] };
}[] = [
  { id: "autonomy=guarded (default)", autonomy: autonomy() },
  { id: "autonomy=auto", autonomy: autonomy({ executionPolicy: "auto" }) },
  { id: "autonomy=confirm", autonomy: autonomy({ executionPolicy: "confirm" }) },
  { id: "autonomy=deny", autonomy: autonomy({ executionPolicy: "deny" }) },
  { id: "execution.mode=autonomous (default)", execution: { mode: "autonomous", rules: [] } },
  { id: "execution.mode=guarded", execution: { mode: "guarded", rules: [] } },
  { id: "execution.mode=ask", execution: { mode: "ask", rules: [] } },
  {
    id: "both: autonomy=guarded + mode=autonomous",
    autonomy: autonomy(),
    execution: { mode: "autonomous", rules: [] },
  },
  {
    id: "both: autonomy=deny + mode=autonomous",
    autonomy: autonomy({ executionPolicy: "deny" }),
    execution: { mode: "autonomous", rules: [] },
  },
  {
    id: "both: autonomy=auto + mode=ask",
    autonomy: autonomy({ executionPolicy: "auto" }),
    execution: { mode: "ask", rules: [] },
  },
];

describe("one policy, four surfaces", () => {
  it("answers one thing for one question, whichever seam asks it", () => {
    /*
     * The four seams supply their own guard class and their own reading of intent, and neither is an input to the
     * decision: the guard class decides whether the judgment layer looks, and `mode` decides who is asked. So the
     * assertion is that one (mode, category, intent, boundary) produces one kind on all four — the shape that makes
     * "a command and a widget action with the same reach behave the same" a fact rather than a hope.
     */
    let cases = 0;
    for (const mode of MODES) {
      for (const category of CATEGORIES) {
        for (const explicitUserIntent of [true, false]) {
          for (const hardBoundary of [true, false]) {
            const kinds = SURFACES.map((surface) => {
              cases += 1;
              return `${surface}=${decisionKind(policy({ mode }), category, { explicitUserIntent, hardBoundary })}`;
            });
            expect(
              new Set(kinds.map((entry) => entry.split("=")[1])).size,
              `${mode}/${category}/intent=${explicitUserIntent}/boundary=${hardBoundary}: ${kinds.join(", ")}`,
            ).toBe(1);
          }
        }
      }
    }
    console.info(`cross-surface tuples evaluated: ${cases}`);
  });

  it("keeps the judgment layer's gate on the guard class, never on the outcome", () => {
    const base = policy();
    // A read is a read on either surface; a command that changes something is judged under `commands`.
    expect(guardrailCovers(base, { surface: "command", effectCategory: "read" })).toBe(false);
    expect(guardrailCovers(base, { surface: "capability", effectCategory: "read" })).toBe(false);
    expect(guardrailCovers(base, { surface: "command", effectCategory: "local-write" })).toBe(true);
    expect(guardrailCovers(base, { surface: "capability", effectCategory: "media-capture" })).toBe(true);
  });

  it("still asks at a hard boundary in every mode, Autonomous included", () => {
    for (const mode of MODES) {
      expect(decisionKind(policy({ mode }), "media-capture", { explicitUserIntent: true, hardBoundary: true })).toBe(
        "ask",
      );
    }
  });

  it("runs what the user asked for under Autonomous, and guards what the agent chose on its own", () => {
    for (const category of RISKY) {
      expect(decisionKind(policy({ mode: "autonomous" }), category, { explicitUserIntent: true }), category).toBe(
        "execute",
      );
      expect(decisionKind(policy({ mode: "autonomous" }), category, { explicitUserIntent: false }), category).toBe(
        "ask",
      );
    }
    for (const category of ["read", "local-write"] as const) {
      expect(decisionKind(policy({ mode: "autonomous" }), category, { explicitUserIntent: false }), category).toBe(
        "execute",
      );
    }
  });
});

describe("no tuple is looser than the legacy policy it replaced", () => {
  it("holds for every surface, category, intent and boundary", () => {
    /*
     * The regression this table exists to catch cannot be seen in the canonical policy alone: `guarded` asking
     * a person where the legacy command path asked nobody is a tightening, and a mode that quietly stopped
     * refusing what a rule refused would be a widening. Both are visible here as a comparison, per tuple.
     */
    let cases = 0;
    const loosening: string[] = [];

    for (const config of LEGACY_CONFIGS) {
      const families: LegacyPolicyFamily[] = [];
      if (config.autonomy !== undefined) families.push(autonomyFamily(config.autonomy));
      if (config.execution !== undefined) families.push(config.execution);
      const inForce = joinExecutionPolicies(families);
      for (const surface of SURFACES) {
        for (const category of CATEGORIES) {
          // The command path answered to the `autonomy` family only; the other three answered to mode+rules, and
          // where a family did not govern a surface there was no legacy decision to compare against.
          const legacy =
            surface === "command"
              ? config.autonomy === undefined
                ? undefined
                : legacyCommandDecision(config.autonomy.executionPolicy)
              : config.execution === undefined
                ? undefined
                : legacySurfaceDecision(config.execution, category);
          for (const explicitUserIntent of [true, false]) {
            for (const hardBoundary of [true, false]) {
              const canonical = decisionKind(inForce, category, { explicitUserIntent, hardBoundary });
              cases += 1;
              if (legacy === undefined) continue;
              if (PERMISSIVENESS[canonical] > PERMISSIVENESS[legacy]) {
                loosening.push(
                  `${config.id}/${surface}/${category}/intent=${explicitUserIntent}/boundary=${hardBoundary}: ` +
                    `${legacy} -> ${canonical}`,
                );
              }
            }
          }
        }
      }
    }

    // Reported rather than implied: a matrix that silently ran nothing would pass.
    console.info(`legacy-vs-canonical tuples evaluated: ${cases} over ${LEGACY_CONFIGS.length} legacy configurations`);
    expect(cases).toBe(LEGACY_CONFIGS.length * SURFACES.length * CATEGORIES.length * 2 * 2);
    expect(loosening).toEqual([]);
  });

  it("keeps the legacy refusal of everything a refusal of everything, boundary included", () => {
    const denied = joinExecutionPolicies([autonomyFamily({ ...AUTONOMY_DEFAULT, executionPolicy: "deny" })]);
    expect(denied.prohibition).toBe("all");
    expect(denied.mode).toBe("guarded");
    for (const category of CATEGORIES) {
      expect(decisionKind(denied, category, { explicitUserIntent: true }), category).toBe("deny");
      expect(decisionKind(denied, category, { explicitUserIntent: true, hardBoundary: true }), category).toBe("deny");
    }
    // The one thing that must never happen to a node that said "never".
    expect(legacyPolicyFromPolicy(denied)).toBe("deny");
  });

  it("keeps a single family's own rules exactly, and intersects allowances only when two families disagree", () => {
    const rules: ExecutionRule[] = [
      { effectCategory: "external-write", decision: "execute" },
      { effectCategory: "destructive", decision: "deny" },
    ];
    // One family: the user's own rules survive whole — an allowance dropped here would be a silent restriction.
    const alone = joinExecutionPolicies([
      { mode: "autonomous", rules, guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails } },
    ]);
    expect(alone.rules).toEqual(rules);
    // Two: the refusal is unioned and the allowance is dropped, because silence is not consent.
    const joined = joinExecutionPolicies([
      { mode: "autonomous", rules: [{ effectCategory: "destructive", decision: "deny" }] },
      { mode: "autonomous", rules, guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails } },
    ]);
    expect(joined.rules).toEqual([{ effectCategory: "destructive", decision: "deny" }]);
    expect(decisionKind(joined, "external-write", { explicitUserIntent: true })).toBe("execute");
  });
});
