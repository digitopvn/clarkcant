import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type AutonomySettings,
  type EffectCategory,
  type ExecutionMode,
  type ExecutionPolicy,
  type ExecutionPolicyConfig,
  type ExecutionRule,
  type Instant,
  type WidgetDefinition,
  compileActionBinding,
} from "@clarkcant/contracts";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import { decideExecution, guardrailCovers } from "../src/execution-policy.ts";
import {
  autonomyFamily,
  joinExecutionPolicies,
  legacyPolicyFromPolicy,
  type LegacyPolicyFamily,
} from "../src/execution-policy-migration.ts";
import {
  createInstance,
  invokeMiniAppAction,
  saveActionBinding,
  type WidgetDeps,
} from "../src/widget-service.ts";

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

describe("one policy, whichever seam asks it", () => {
  /*
   * The seams live in different packages: a command goes through `run_command` in `apps/runtime/src/node-tools.ts`,
   * an install through the route in `apps/runtime/src/gateway.ts`, and both are driven under all three modes by
   * `apps/runtime/test/node-tools.spec.ts`, `command-policy.spec.ts` and `package-install-route.spec.ts`. The one
   * seam this package owns is the widget action, and it is driven here through its real entry point rather than
   * through the decision it calls: a table that calls `decideExecution` four times with the same arguments and a
   * different label in a string measures nothing about a seam.
   */
  const ACTION_WIDGET: WidgetDefinition = {
    id: "canvas.probe@1",
    version: "1.0.0",
    renderer: "catalog",
    propsSchema: { type: "object", additionalProperties: true },
    eventSchemas: {},
    stateSchema: { type: "object" },
    stateVersion: 1,
    semanticDescription: "A widget whose bound action is not a view operation",
    requestedCapabilities: [],
    sizing: { compact: true, expanded: true },
    textFallback: "A probe widget.",
    effectCategories: ["local-write"],
    datasetRefs: [],
  };

  let db: Database;
  let deps: WidgetDeps;
  let instanceId: string;
  let bindingId: string;
  let bindingDigest: string;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    migrate(db);
    let counter = 0;
    deps = {
      db,
      nodeId: "node_local",
      now: () => "2026-09-21T12:00:00.000Z" as Instant,
      newId: (prefix) => `${prefix}_${(counter += 1)}`,
    };
    const instance = createInstance(deps, {
      definition: ACTION_WIDGET,
      packageDigest: "sha256:probe",
      ownerPrincipalId: "prin_owner" as never,
      props: {},
    });
    const compiled = compileActionBinding({
      bindingId: "act_probe",
      instance: {
        instanceId: instance.instanceId,
        ownerNodeId: deps.nodeId,
        definitionRef: { id: ACTION_WIDGET.id, version: ACTION_WIDGET.version, packageDigest: "sha256:probe" },
        actionBindingRevision: instance.actionBindingRevision,
      },
      packageGeneration: "sha256:probe",
      label: "do something",
      // Not a view operation, so the seam has to ask the policy whether the effect may happen at all.
      proposal: { kind: "agent", intent: "do something", contextRefs: [] },
      inputSchema: { type: "object" },
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "local-write",
      requiresApproval: true,
      limits: {},
      bindingDigest: "sha256:probe-action",
      at: deps.now(),
      knownCapabilities: new Set<string>(),
    });
    if (!compiled.ok) throw new Error(`fixture binding did not compile: ${compiled.message}`);
    saveActionBinding(deps, compiled.binding);
    instanceId = instance.instanceId;
    bindingId = compiled.binding.actionBindingId;
    bindingDigest = compiled.binding.bindingDigest;
  });

  function invoke(inForce: ExecutionPolicyConfig) {
    return invokeMiniAppAction(deps, {
      conversationId: "conv_parity",
      principalId: "prin_owner" as never,
      instanceId,
      actionBindingId: bindingId,
      expectedRevision: 1,
      expectedBindingDigest: bindingDigest,
      input: {},
      invocationId: "inv_parity",
      policy: inForce,
    });
  }

  it("refuses through the widget seam exactly what the policy refuses", () => {
    const decision = decideExecution({
      policy: policy({ prohibition: "all" }),
      action: { kind: "effect", category: "local-write", operationDigest: bindingDigest },
      explicitUserIntent: true,
    });
    if (decision.kind !== "deny") throw new Error("expected the prohibition to refuse");

    const outcome = invoke(policy({ prohibition: "all" }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("POLICY_REFUSED");
    // The seam reports the policy's own reason rather than a second vocabulary for it.
    expect(outcome.message).toBe(decision.reason);
  });

  it("tells a policy that asks apart from one that allows, because the two need different fixes", () => {
    for (const mode of ["ask", "autonomous"] as const) {
      const inForce = policy({ mode });
      const decision = decideExecution({
        policy: inForce,
        action: { kind: "effect", category: "local-write", operationDigest: bindingDigest },
        explicitUserIntent: true,
      });

      const outcome = invoke(inForce);
      expect(outcome.ok, mode).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      // An action this node has no executor for is not a permission problem, and a policy that asks is not a
      // policy that allowed: the seam says which of the two it is.
      expect(outcome.code, mode).toBe("UNSUPPORTED_ACTION");
      if (decision.kind === "ask") expect(outcome.message, mode).toContain("approval path");
      else expect(outcome.message, mode).toContain("no executor");
    }
  });

  it("answers one thing for one policy whatever a seam is free to vary", () => {
    /*
     * What the cross-surface claim rests on, stated as the property that makes it true: the only inputs to the
     * decision are the policy and the question, and the fields a seam supplies — the digest an approval is bound to,
     * the sentence a card carries, whether it read a click or a proposal — are not among them. The question has no
     * `surface` field at all, which is the structural half of the same fact.
     *
     * The seams themselves are driven through their own entry points: the widget action just below, and the command
     * and install seams in `apps/runtime/test/node-tools.spec.ts`, `command-policy.spec.ts` and
     * `package-install-route.spec.ts`.
     */
    const seams = [
      { seam: "command", operationDigest: "sha256:command" },
      { seam: "install", operationDigest: "sha256:install" },
      { seam: "widget-action", operationDigest: "sha256:binding" },
    ] as const;

    for (const mode of MODES) {
      for (const category of CATEGORIES) {
        for (const explicitUserIntent of [true, false]) {
          for (const hardBoundary of [true, false]) {
            const kinds = seams.map(({ seam, operationDigest }) =>
              decideExecution({
                policy: policy({ mode }),
                action: { kind: "effect", category, operationDigest },
                explicitUserIntent,
                ...(hardBoundary
                  ? {
                      hardBoundary: {
                        kind: "os-permission" as const,
                        because: `${seam} was handed to the operating system`,
                      },
                    }
                  : {}),
              }).kind,
            );
            expect(
              new Set(kinds).size,
              `${mode}/${category}/intent=${explicitUserIntent}/boundary=${hardBoundary}`,
            ).toBe(1);
          }
        }
      }
    }
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
