/**
 * Getting from the two execution policies this node used to have to the one it has now.
 *
 * Two families of preference were in force at once, and they governed different surfaces:
 *
 *   - `autonomy` (a node preference) governed the command path, whole: a four-value policy, the switches
 *     that decided which classes the judgment layer was consulted about, and what to do when it was not
 *     reachable.
 *   - `execution.mode` and `execution.rules` (registered preferences) governed widget actions and installs.
 *
 * The migration exists because the join between them is where a permission quietly widens: "take the
 * stricter of the two" is not a comparison of two modes, it is a property of the function
 * `(category × intent × boundary) → decision`, and a mode is only one input to it. So the join here is
 * pointwise and monotone by construction — mode most restrictive, refusals unioned, allowances
 * intersected, the judgment layer on only if both families left it on, and its classes unioned — which
 * makes "the result is never looser than either family" provable from the construction rather than
 * asserted about it. `packages/core/test/execution-policy-parity.spec.ts` checks it pointwise anyway.
 *
 * Two things this module deliberately does not do:
 *
 *   - It never writes the legacy keys. They stay readable, and a client that still speaks them is served by
 *     the compatibility readers in `apps/runtime/src/autonomy-settings.ts`; but the canonical policy is the
 *     only thing anything stores after this runs.
 *   - It never treats "the write did not throw" as success. `writeRegisteredPreference` validates before it
 *     stores and can refuse, so the outcome is read and a refusal is reported rather than assumed away.
 */

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type AutonomySettings,
  type EffectCategory,
  type ExecutionGuardrails,
  type ExecutionMode,
  type ExecutionPolicy,
  type ExecutionPolicyConfig,
  type ExecutionRule,
  type GuardClass,
  effectCategorySchema,
  parseAutonomySettings,
  parseExecutionPolicyConfig,
} from "@clarkcant/contracts";
import { appendAuditEvent } from "@clarkcant/storage";

import { getPreference, type PreferenceDeps, type PreferenceSource } from "./preferences.ts";
import { writeRegisteredPreference, type PreferenceWriteOutcome } from "./preference-registry.ts";

/** The one key a policy lives under from here on. */
export const EXECUTION_POLICY_PREFERENCE_KEY = "execution.policy";

/** The key a command-path node stored its whole policy under, before there was one policy. */
export const LEGACY_AUTONOMY_PREFERENCE_KEY = "autonomy";

/** The two keys the widget, install and capability paths read their policy from. */
export const LEGACY_EXECUTION_MODE_KEY = "execution.mode";
export const LEGACY_EXECUTION_RULES_KEY = "execution.rules";

/**
 * One legacy family's contribution to the join.
 *
 * `prohibition` and `guardrails` are optional because only the autonomy family ever declared them. A family
 * with no opinion about an axis must not be read as having the permissive opinion about it — that is the
 * difference between a union that is honest and a union that silently widens what the judgment layer
 * covers.
 */
export interface LegacyPolicyFamily {
  mode: ExecutionMode;
  rules: readonly ExecutionRule[];
  prohibition?: "none" | "all";
  guardrails?: ExecutionGuardrails;
}

const MODE_RANK: Record<ExecutionMode, number> = { autonomous: 0, guarded: 1, ask: 2 };

/**
 * The mode a legacy four-value policy becomes.
 *
 * `confirm` is Ask every time, exactly: a card on every effect, digest-bound, unchanged. `auto` becomes
 * Autonomous — "run what the user asked for" is the same instruction in both vocabularies. `guarded`
 * becomes Guarded, which is a declared behaviour change and not a translation of the old one: the legacy
 * mode never opened a card, and the canonical one asks wherever the effect category or a rule requires it.
 * `deny` has no mode at all; the refusal it means is carried by `prohibition` instead, and the companion
 * mode is Guarded because `ask` would be a weaker statement about the categories the refusal does not
 * name — `ask` means "you can approve this", which is precisely what the user said no to.
 */
export function legacyModeFromPolicy(executionPolicy: ExecutionPolicy): ExecutionMode {
  switch (executionPolicy) {
    case "auto":
      return "autonomous";
    case "guarded":
      return "guarded";
    case "confirm":
      return "ask";
    default:
      return "guarded";
  }
}

/** The autonomy family, as the canonical axes. */
export function autonomyFamily(settings: AutonomySettings): LegacyPolicyFamily {
  return {
    mode: legacyModeFromPolicy(settings.executionPolicy),
    /*
     * No rules. The autonomy family had no per-category table: its refusal was the whole-policy `deny`,
     * which travels as `prohibition` so that a category added by a later build is refused too.
     *
     * `auto` becomes Autonomous with the judgment layer left switched on if the user had it on. The legacy
     * `auto` skipped the layer entirely, so keeping it on is stricter, never looser — and it is what makes
     * reading the compatibility surface and writing it back a no-op instead of a silent change of mode.
     */
    rules: [],
    prohibition: settings.executionPolicy === "deny" ? "all" : "none",
    guardrails: {
      enabled: settings.jevGuardrails,
      instructions: settings.instructions.slice(0, 4_000),
      classes: [...settings.guardedClasses],
      whenUnavailable: settings.whenJevUnavailable,
    },
  };
}

/**
 * The reverse: the canonical policy written back in the legacy five fields.
 *
 * For the surfaces that still speak the old shape — the settings panel through `/autonomy`, and the two
 * preference keys a surface may still spell the mode and the rules in. Lossless for everything this build
 * can store: `deny` is the prohibition, `confirm` is Ask every time, `guarded` is Guarded, and `auto` is
 * Autonomous. What the old shape cannot say is that Guarded asks where the legacy mode did not; that is the
 * declared behaviour change of this phase, not a gap in this projection.
 */
export function autonomySettingsFromPolicy(policy: ExecutionPolicyConfig): AutonomySettings {
  return {
    executionPolicy: legacyPolicyFromPolicy(policy),
    jevGuardrails: policy.guardrails.enabled,
    instructions: policy.guardrails.instructions,
    guardedClasses: [...policy.guardrails.classes],
    whenJevUnavailable: policy.guardrails.whenUnavailable,
  };
}

/** The four-value policy a canonical one reads as, for the surfaces that still offer the four values. */
export function legacyPolicyFromPolicy(policy: ExecutionPolicyConfig): ExecutionPolicy {
  if (policy.prohibition === "all") return "deny";
  switch (policy.mode) {
    case "ask":
      return "confirm";
    case "guarded":
      return "guarded";
    default:
      return "auto";
  }
}

function readAutonomyFamily(deps: PreferenceDeps, principalId: string): LegacyPolicyFamily | undefined {
  const stored = getPreference(deps, {
    principalId,
    key: LEGACY_AUTONOMY_PREFERENCE_KEY,
    scope: "node",
  });
  if (stored === undefined) return undefined;
  // Parsed field-wise, like everything else here: a document an older build wrote must cost only the field
  // it got wrong, and a row that is not an object at all falls back to the family's own defaults.
  return autonomyFamily(parseAutonomySettings(stored.value));
}

function readExecutionFamily(deps: PreferenceDeps, principalId: string): LegacyPolicyFamily | undefined {
  const mode = getPreference(deps, { principalId, key: LEGACY_EXECUTION_MODE_KEY, scope: "global" });
  const rules = getPreference(deps, { principalId, key: LEGACY_EXECUTION_RULES_KEY, scope: "global" });
  if (mode === undefined && rules === undefined) return undefined;
  return {
    // The registry's own default for a node that stored the rules and never the mode.
    mode: parseExecutionPolicyConfig({ mode: mode?.value }).mode,
    rules: rules === undefined ? [] : parseExecutionPolicyConfig({ rules: rules.value }).rules,
  };
}

/**
 * Refusals are unioned and allowances are intersected, per category.
 *
 * First entry per category wins, because that is what the resolver reads; the result is emitted in the
 * declared category order so two runs on the same input produce the same document.
 */
function joinRules(families: readonly LegacyPolicyFamily[]): ExecutionRule[] {
  if (families.length === 0) return [];
  const [sole] = families;
  /*
   * One family keeps its own rules verbatim: there is nothing to join against, and the resolver reads the first
   * entry per category, so what the user wrote is what has to survive.
   */
  if (families.length === 1 && sole !== undefined) return sole.rules.map((rule) => ({ ...rule }));
  const joined: ExecutionRule[] = [];
  for (const category of effectCategorySchema.options as readonly EffectCategory[]) {
    const decisions = families
      .map((family) => family.rules.find((rule) => rule.effectCategory === category)?.decision)
      .filter((decision): decision is ExecutionRule["decision"] => decision !== undefined);
    if (decisions.includes("deny")) {
      joined.push({ effectCategory: category, decision: "deny" });
      continue;
    }
    if (decisions.includes("ask")) {
      joined.push({ effectCategory: category, decision: "ask" });
      continue;
    }
    /*
     * An allowance survives only when every family wrote one. Silence is not consent: a rule one family wrote and
     * the other never mentioned is dropped, and the mode decides instead — which is the stricter reading, and the
     * one the join can prove is never looser.
     */
    if (decisions.length === families.length && decisions.every((decision) => decision === "execute")) {
      joined.push({ effectCategory: category, decision: "execute" });
    }
  }
  return joined;
}

function joinGuardrails(
  families: readonly LegacyPolicyFamily[],
  defaults: ExecutionGuardrails,
): ExecutionGuardrails {
  const declared = families
    .map((family) => family.guardrails)
    .filter((guardrails): guardrails is ExecutionGuardrails => guardrails !== undefined);
  if (declared.length === 0) return { ...defaults, classes: [...defaults.classes] };
  const classes = new Set<GuardClass>();
  for (const guardrails of declared) for (const guardClass of guardrails.classes) classes.add(guardClass);
  return {
    // On only where every family that had an opinion left it on: the layer can only narrow, so leaving it
    // off is the one direction in this join that is not automatically the safer one.
    enabled: declared.every((guardrails) => guardrails.enabled),
    instructions: declared.find((guardrails) => guardrails.instructions !== "")?.instructions ?? "",
    // The union, in the declared order of the six switches, so the same input always produces the same list.
    classes: (["commands", "local-writes", "external-writes", "communication", "financial", "reads"] as const).filter(
      (guardClass) => classes.has(guardClass),
    ),
    whenUnavailable: declared.some((guardrails) => guardrails.whenUnavailable === "deny") ? "deny" : "allow",
  };
}

/**
 * Join the families into one policy, pointwise.
 *
 * One argument is the normal case for a node that only ever had one family; none is a node that had
 * neither, and it gets the canonical default — Autonomous — rather than any legacy constant.
 */
export function joinExecutionPolicies(families: readonly LegacyPolicyFamily[]): ExecutionPolicyConfig {
  if (families.length === 0) {
    return { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [], guardrails: { ...DEFAULT_EXECUTION_POLICY_CONFIG.guardrails } };
  }
  return {
    mode: families.reduce<ExecutionMode>(
      (strictest, family) => (MODE_RANK[family.mode] > MODE_RANK[strictest] ? family.mode : strictest),
      "autonomous",
    ),
    prohibition: families.some((family) => family.prohibition === "all") ? "all" : "none",
    rules: joinRules(families),
    guardrails: joinGuardrails(families, DEFAULT_EXECUTION_POLICY_CONFIG.guardrails),
  };
}

/** The policy the legacy preferences describe, without writing anything. */
export function readLegacyPolicy(deps: PreferenceDeps, principalId: string): ExecutionPolicyConfig {
  const families: LegacyPolicyFamily[] = [];
  const autonomy = readAutonomyFamily(deps, principalId);
  if (autonomy !== undefined) families.push(autonomy);
  const execution = readExecutionFamily(deps, principalId);
  if (execution !== undefined) families.push(execution);
  return joinExecutionPolicies(families);
}

/** Injected so a refused write can be exercised; production always uses the registry writer. */
export type ExecutionPolicyWrite = (
  deps: PreferenceDeps,
  input: { principalId: string; value: ExecutionPolicyConfig; source: PreferenceSource },
) => PreferenceWriteOutcome;

export interface ExecutionPolicyMigrationResult {
  /** The policy to run under, whether or not it could be stored. */
  policy: ExecutionPolicyConfig;
  /** Whether this call stored it. False means there was nothing to write, or the write was refused. */
  written: boolean;
  /** Why the registry refused the value, when it did. */
  refusal?: string;
  /** Whether either legacy family was stored at all, for the audit record and for the caller's source. */
  hadLegacy: boolean;
}

const defaultWrite: ExecutionPolicyWrite = (deps, input) =>
  writeRegisteredPreference(deps, {
    principalId: input.principalId,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
    value: input.value,
    /*
     * A policy derived from choices the user made is their choice, and one derived from nothing is the
     * default. The distinction is not cosmetic: `source` is what a later onboarding-undo reads to decide
     * whether a value it finds was its own.
     */
    source: input.source,
  });

function samePolicy(left: unknown, right: ExecutionPolicyConfig): boolean {
  return JSON.stringify(parseExecutionPolicyConfig(left)) === JSON.stringify(right);
}

/**
 * Store the canonical policy for a node that has not got one.
 *
 * Idempotent by comparison rather than by a flag: a second run computes the same join, sees the stored
 * document already says it, and writes nothing. A run that is refused writes nothing either — and still
 * answers with the joined policy, because falling back to a default would be the one outcome that widens
 * what the user chose.
 */
export function migrateExecutionPolicy(
  deps: PreferenceDeps,
  input: { principalId: string; write?: ExecutionPolicyWrite },
): ExecutionPolicyMigrationResult {
  const families: LegacyPolicyFamily[] = [];
  const autonomy = readAutonomyFamily(deps, input.principalId);
  if (autonomy !== undefined) families.push(autonomy);
  const execution = readExecutionFamily(deps, input.principalId);
  if (execution !== undefined) families.push(execution);
  const policy = joinExecutionPolicies(families);

  const stored = getPreference(deps, {
    principalId: input.principalId,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
    scope: "global",
  });
  if (stored !== undefined && samePolicy(stored.value, policy)) {
    return { policy, written: false, hadLegacy: families.length > 0 };
  }

  const outcome = (input.write ?? defaultWrite)(deps, {
    principalId: input.principalId,
    value: policy,
    source: families.length === 0 ? "default" : "user",
  });
  if (!outcome.ok) {
    /*
     * A refusal is reported, not swallowed, and not worked around. There is no smaller write that would mean
     * the same thing: the join is the policy, and dropping part of it to fit is exactly the widening this
     * module exists to prevent. The caller runs under it for this read.
     */
    return { policy, written: false, refusal: outcome.message, hadLegacy: families.length > 0 };
  }

  appendAuditEvent(deps.db, {
    // From the revision the write reported, so the record and the stored document cannot disagree about which
    // migration wrote it, and a second run cannot collide with the first.
    auditId: `audit_execution-policy-migration_${input.principalId}_r${outcome.preference.revision}`,
    principalId: input.principalId,
    kind: "policy",
    summary:
      `hợp nhất ${families.length} họ policy cũ thành policy chuẩn ` +
      `(mode ${policy.mode}, prohibition ${policy.prohibition}, ${policy.rules.length} rule)`,
    outcome: "done",
    at: deps.now(),
  });

  return { policy, written: true, hadLegacy: families.length > 0 };
}
