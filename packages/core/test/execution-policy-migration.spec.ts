import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type AutonomySettings,
  type EffectCategory,
  type ExecutionPolicyConfig,
} from "@clarkcant/contracts";
import { allRows, migrate, openDatabase, type Database } from "@clarkcant/storage";

import { decideExecution, readExecutionPolicy } from "../src/execution-policy.ts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  LEGACY_AUTONOMY_PREFERENCE_KEY,
  LEGACY_EXECUTION_MODE_KEY,
  LEGACY_EXECUTION_RULES_KEY,
  autonomyFamily,
  autonomySettingsFromPolicy,
  joinExecutionPolicies,
  migrateExecutionPolicy,
  readLegacyPolicy,
} from "../src/execution-policy-migration.ts";
import { setPreference, undoPreference, type PreferenceDeps } from "../src/preferences.ts";
import { readRegisteredPreference } from "../src/preference-registry.ts";

/**
 * The migration that replaces two execution policies with one.
 *
 * The property under test is not "it runs" but "it does not widen": a node that stored the strictest thing the
 * old vocabulary could express must not end up with the loosest thing the new one can. The cases are ordered
 * from the narrowest legacy configuration to the widest, because that is the order in which a mistake here
 * would be noticed by the person it happened to.
 */

const PRINCIPAL = "prin_owner";
const AT = "2026-09-21T12:00:00.000Z" as never;

let db: Database;
let deps: PreferenceDeps;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  deps = { db, now: () => AT };
});

function autonomy(overrides: Partial<AutonomySettings> = {}): AutonomySettings {
  return {
    executionPolicy: "guarded",
    jevGuardrails: true,
    instructions: "",
    guardedClasses: ["commands", "local-writes", "external-writes", "communication", "financial"],
    whenJevUnavailable: "allow",
    ...overrides,
  };
}

function storeLegacy(deps: PreferenceDeps, input: { autonomy?: unknown; mode?: unknown; rules?: unknown }): void {
  if (input.autonomy !== undefined) {
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: LEGACY_AUTONOMY_PREFERENCE_KEY,
      scope: "node",
      value: input.autonomy,
      source: "user",
    });
  }
  if (input.mode !== undefined) {
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: LEGACY_EXECUTION_MODE_KEY,
      scope: "global",
      value: input.mode,
      source: "user",
    });
  }
  if (input.rules !== undefined) {
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: LEGACY_EXECUTION_RULES_KEY,
      scope: "global",
      value: input.rules,
      source: "user",
    });
  }
}

function kind(policy: ExecutionPolicyConfig, category: EffectCategory): string {
  return decideExecution({
    policy,
    action: { kind: "effect", category, operationDigest: "sha256:migration" },
    explicitUserIntent: true,
  }).kind;
}

function auditPolicyRows(): { kind: string; summary: string }[] {
  return allRows<{ kind: string; summary: string }>(db, "SELECT kind, summary FROM audit_log ORDER BY audit_id");
}

describe("the legacy refusal of everything", () => {
  it("stays a refusal of everything, and never becomes autonomous", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "deny" }) });

    const result = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });

    expect(result.policy.prohibition).toBe("all");
    expect(result.policy.mode).toBe("guarded");
    expect(result.policy.mode).not.toBe("autonomous");
    for (const category of ["read", "local-write", "external-write", "financial"] as const) {
      expect(kind(result.policy, category), category).toBe("deny");
    }
    // Stored, so the refusal outlives this read — and it is the canonical key, not the legacy row.
    expect(
      readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY })?.value,
    ).toMatchObject({ prohibition: "all" });
  });

  it("keeps the refusal above a hard boundary", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "deny" }) });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });

    const decision = decideExecution({
      policy,
      action: { kind: "effect", category: "media-capture", operationDigest: "sha256:migration" },
      explicitUserIntent: true,
      hardBoundary: { kind: "oauth", because: "the account holder has to grant this" },
    });
    expect(decision.kind).toBe("deny");
  });

  it("is not undone by a later write through the legacy settings shape", () => {
    // The panel keeps sending the value it displayed, so a guardrail edit there cannot silently lift the refusal.
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "deny" }) });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    const rewritten = joinExecutionPolicies([
      autonomyFamily(autonomySettingsFromPolicy({ ...policy, guardrails: { ...policy.guardrails, enabled: false } })),
    ]);
    expect(rewritten.prohibition).toBe("all");
  });
});

describe("the other three legacy policies", () => {
  it("turns confirm into Ask every time, whole", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "confirm" }) });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(policy.mode).toBe("ask");
    for (const category of ["read", "local-write", "financial"] as const) {
      expect(kind(policy, category), category).toBe("ask");
    }
  });

  it("turns auto into Autonomous, with the judgment layer exactly as the user left it", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "auto", jevGuardrails: false }) });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(policy.mode).toBe("autonomous");
    expect(policy.guardrails.enabled).toBe(false);
    expect(policy.prohibition).toBe("none");
  });

  it("turns guarded into Guarded, which changes what a command does", () => {
    /*
     * The declared behaviour change, asserted rather than described. The legacy `guarded` ran a command a user
     * asked for without a card and only consulted the judgment layer; the canonical `guarded` asks a person
     * wherever the effect category reaches past this machine. Both are stricter than the other family's default,
     * which is why the migration is allowed to make the change — and why PR 1 is not a refactor.
     */
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "guarded" }) });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(policy.mode).toBe("guarded");
    expect(kind(policy, "local-write")).toBe("execute");
    expect(kind(policy, "external-write")).toBe("ask");
    expect(kind(policy, "destructive")).toBe("ask");
  });
});

describe("the family the widget, install and capability paths read", () => {
  it("keeps the stored mode, and adds the canonical default judgment layer", () => {
    storeLegacy(deps, { mode: "ask" });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(policy.mode).toBe("ask");
    expect(policy.prohibition).toBe("none");
    expect(policy.guardrails).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG.guardrails);
  });

  it("keeps a single family's own rules exactly", () => {
    /*
     * One family, so there is nothing to intersect against. Dropping an allowance here would be a silent
     * restriction on the still-legacy surfaces; dropping a refusal would be worse. Both must survive whole.
     */
    storeLegacy(deps, {
      mode: "autonomous",
      rules: [
        { effectCategory: "external-write", decision: "execute" },
        { effectCategory: "financial", decision: "deny" },
      ],
    });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(policy.rules).toEqual([
      { effectCategory: "external-write", decision: "execute" },
      { effectCategory: "financial", decision: "deny" },
    ]);
    expect(kind(policy, "financial")).toBe("deny");
  });

  it("migrates a node already at the rule cap, keeping what each category was told", () => {
    /*
     * Twenty-four entries is the cap the registry enforces, and it validates before it stores — so a migration
     * that added rules of its own would be refused outright on a node already at the cap. This is the case that
     * makes the write outcome worth reading, and the refusals already in the list are what must survive it.
     */
    const categories = [
      "read",
      "local-write",
      "external-write",
      "destructive",
      "financial",
      "communication",
      "media-capture",
    ] as const;
    const firstSeven = categories.map((category, index) => ({
      effectCategory: category as EffectCategory,
      decision: index % 2 === 0 ? ("deny" as const) : ("execute" as const),
    }));
    const padding = Array.from({ length: 17 }, (_entry, index) => ({
      effectCategory: categories[index % 7] as EffectCategory,
      decision: "ask" as const,
    }));
    storeLegacy(deps, { mode: "autonomous", rules: [...firstSeven, ...padding] });

    const result = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });

    expect(result.written).toBe(true);
    expect(result.refusal).toBeUndefined();
    // Kept verbatim, duplicates and all: the resolver reads the first entry per category, and rewriting the list
    // is not this migration's job.
    expect(result.policy.rules).toHaveLength(24);
    expect(kind(result.policy, "read")).toBe("deny");
    expect(kind(result.policy, "local-write")).toBe("execute");
    expect(kind(result.policy, "external-write")).toBe("deny");
    expect(kind(result.policy, "destructive")).toBe("execute");
    expect(kind(result.policy, "financial")).toBe("deny");
  });
});

describe("both families at once", () => {
  it("joins pointwise: the stricter mode, the union of refusals, the intersection of allowances", () => {
    storeLegacy(deps, {
      autonomy: autonomy({ executionPolicy: "guarded", guardedClasses: ["financial"] }),
      mode: "autonomous",
      rules: [
        { effectCategory: "destructive", decision: "deny" },
        { effectCategory: "external-write", decision: "execute" },
      ],
    });

    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });

    // Most restrictive mode of {guarded, autonomous}.
    expect(policy.mode).toBe("guarded");
    // The refusal survives; the allowance does not, because the other family never wrote one.
    expect(policy.rules).toEqual([{ effectCategory: "destructive", decision: "deny" }]);
    expect(kind(policy, "destructive")).toBe("deny");
    expect(kind(policy, "external-write")).toBe("ask");
    // The judgment layer's switches belong to the family that declared them, so nothing is widened or narrowed
    // by the other family's silence.
    expect(policy.guardrails.classes).toEqual(["financial"]);
    expect(policy.guardrails.enabled).toBe(true);
    // One family refuses when the layer is unreachable, so the join does.
    expect(policy.guardrails.whenUnavailable).toBe("allow");
  });

  it("keeps the refusal of everything even against the other family's autonomy", () => {
    storeLegacy(deps, {
      autonomy: autonomy({ executionPolicy: "deny" }),
      mode: "autonomous",
    });
    const { policy } = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(policy.prohibition).toBe("all");
    expect(kind(policy, "external-write")).toBe("deny");
  });
});

describe("a node that stored neither family", () => {
  it("gets the canonical default, which is Autonomous, and stores it as a default", () => {
    const result = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    expect(result.hadLegacy).toBe(false);
    expect(result.policy.mode).toBe("autonomous");
    expect(result.policy).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG);
    const stored = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY });
    expect(stored?.value).toEqual(DEFAULT_EXECUTION_POLICY_CONFIG);
  });
});

describe("the migration is idempotent and auditable", () => {
  it("writes once, and a second run changes nothing", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "confirm" }) });

    const first = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    const second = migrateExecutionPolicy(deps, { principalId: PRINCIPAL });

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.policy).toEqual(first.policy);
    expect(
      readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY })?.revision,
    ).toBe(1);
  });

  it("leaves one audit record naming what it merged", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "guarded" }) });
    migrateExecutionPolicy(deps, { principalId: PRINCIPAL });
    migrateExecutionPolicy(deps, { principalId: PRINCIPAL });

    const rows = auditPolicyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("policy");
    expect(rows[0]?.summary).toContain("policy chuẩn");
  });

  it("audits a second migration after the row was undone, instead of throwing over a taken id", () => {
    /*
     * The record's id used to come from the revision the write reported, and a revision is resettable: undoing a
     * first write deletes the row, so the next read migrated again at revision 1 and derived the same id.
     * `audit_log.audit_id` is a primary key, so that insert threw — after the policy had been stored, which left the
     * change the record exists for un-audited and failed the request that triggered it.
     */
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "deny" }) });
    expect(migrateExecutionPolicy(deps, { principalId: PRINCIPAL }).written).toBe(true);
    expect(auditPolicyRows()).toHaveLength(1);

    const undone = undoPreference(deps, {
      principalId: PRINCIPAL,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      scope: "global",
    });
    expect(undone).toMatchObject({ undone: true, removed: true });
    expect(
      readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY })?.isDefault,
    ).toBe(true);

    // No throw, the join again rather than a default, and a second record of its own.
    expect(readExecutionPolicy(deps, PRINCIPAL).prohibition).toBe("all");
    expect(auditPolicyRows()).toHaveLength(2);
  });

  it("does not treat a refused write as a success", () => {
    /*
     * `writeRegisteredPreference` validates before it stores and can refuse. Swallowing that would report a
     * migration that never happened, which is exactly the failure the outcome check exists for — so the seam is
     * exercised with a writer that refuses.
     */
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "deny" }) });

    const result = migrateExecutionPolicy(deps, {
      principalId: PRINCIPAL,
      write: () => ({ ok: false, code: "PREFERENCE_INVALID", message: "rules: too many entries" }),
    });

    expect(result.written).toBe(false);
    expect(result.refusal).toContain("too many entries");
    // Nothing was stored, and the joined policy — not a default — is what the caller runs under.
    expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY })?.isDefault).toBe(
      true,
    );
    expect(result.policy.prohibition).toBe("all");
    expect(auditPolicyRows()).toEqual([]);
  });
});

describe("the canonical policy is the authority from then on", () => {
  it("reads the stored canonical policy, and ignores the legacy rows once it exists", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "confirm" }) });
    const migrated = readExecutionPolicy(deps, PRINCIPAL);
    expect(migrated.mode).toBe("ask");

    // A later legacy write — a client that has not been updated — must not be a second authority.
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "auto", jevGuardrails: false }) });
    expect(readExecutionPolicy(deps, PRINCIPAL).mode).toBe("ask");
  });

  it("falls back to the joined policy rather than to a default when the stored value no longer parses", () => {
    storeLegacy(deps, { autonomy: autonomy({ executionPolicy: "deny" }) });
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      scope: "global",
      value: { mode: "sometimes" },
      source: "user",
    });

    // A document this build cannot read is replaced by the join of what the node actually stored, so a corrupt
    // row cannot be the reason a refusal is forgotten.
    const policy = readExecutionPolicy(deps, PRINCIPAL);
    expect(policy.prohibition).toBe("all");
  });

  it("reports what the legacy preferences describe without writing anything", () => {
    storeLegacy(deps, { mode: "guarded" });
    const legacy = readLegacyPolicy(deps, PRINCIPAL);
    expect(legacy.mode).toBe("guarded");
    expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: EXECUTION_POLICY_PREFERENCE_KEY })?.isDefault).toBe(
      true,
    );
  });
});

describe("a read of the legacy settings shape does not change the policy when it is written back", () => {
  it("round-trips the canonical policy through the five legacy fields", () => {
    /*
     * The compatibility surface's whole safety property. A panel that reads the policy, changes one guardrail
     * switch and saves must not have moved the mode — and reading it must be exact, or the panel would be
     * displaying something the node does not obey.
     */
    const policies: ExecutionPolicyConfig[] = [
      DEFAULT_EXECUTION_POLICY_CONFIG,
      { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "guarded" },
      { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode: "ask" },
      { ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all", mode: "guarded" },
      {
        ...DEFAULT_EXECUTION_POLICY_CONFIG,
        guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails, enabled: false, classes: ["financial"] },
      },
    ];
    for (const policy of policies) {
      const back = joinExecutionPolicies([autonomyFamily(autonomySettingsFromPolicy(policy))]);
      expect(back.mode, policy.mode).toBe(policy.mode);
      expect(back.prohibition, policy.mode).toBe(policy.prohibition);
      expect(back.guardrails, policy.mode).toEqual(policy.guardrails);
    }
  });
});
