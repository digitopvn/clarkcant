import {
  type AutonomySettings,
  type ExecutionPolicyConfig,
  type GuardrailConstraint,
  type RegisteredPreference,
  executionPolicyConfigSchema,
  executionPolicySchema,
  parseAutonomySettings,
} from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  LEGACY_EXECUTION_MODE_KEY,
  LEGACY_EXECUTION_RULES_KEY,
  autonomyFamily,
  autonomySettingsFromPolicy,
  legacyModeFromPolicy,
  readExecutionPolicy,
  readExecutionPolicyPreference,
  readRegisteredPreference,
  undoRegisteredPreference,
  writeRegisteredPreference,
  type PreferenceDeps,
  type PreferenceRefusalCode,
  type PreferenceUndoOutcome,
  type PreferenceWriteOutcome,
} from "@clarkcant/core";

/**
 * The compatibility surface for a policy this node used to store in two places.
 *
 * There is exactly one policy now — `execution.policy`, read by `readExecutionPolicy` — and nothing in this
 * file is a second copy of it. What is here is the translation a client that still speaks the old shapes
 * needs: a panel that posts the five autonomy fields, and the two registered preference keys a surface may
 * still spell the mode and the rules in. Both read the canonical policy and write through it, so there is
 * one value to keep in step and no state that can drift out of it.
 *
 * Two properties this file is careful about:
 *
 *   - **A compatibility write never deletes what it cannot speak.** The legacy settings shape has no
 *     per-category rules at all, so writing it keeps the rules the canonical policy already had. Dropping
 *     them would drop refusals, which is the one direction a projection must never take.
 *   - **A projection is marked the way the policy is marked.** `isDefault` and `revision` on a projected key
 *     are the canonical policy's, because that is what the value is: a surface must not be told a policy the
 *     user chose is a default, or the other way round.
 *
 * This module goes away when the Control tab speaks the canonical policy directly; until then it is what
 * keeps the existing panel honest rather than desynchronised.
 */

/**
 * The canonical policy, in the five fields the settings panel still posts.
 *
 * The mapping back is lossless for a policy whose mode, prohibition and guardrails are all it declares,
 * which is every policy this build can produce: `deny` is refusal of everything, `confirm` is Ask every
 * time, and `guarded` is Guarded. The one thing the old shape cannot say is that Guarded asks where the
 * legacy mode did not — that difference is real, it is the declared behaviour change of this phase, and the
 * panel's own note for that option already describes the canonical behaviour.
 */
export function readAutonomySettings(deps: PreferenceDeps, principalId: string): AutonomySettings {
  return autonomySettingsFromPolicy(readExecutionPolicy(deps, principalId));
}

/**
 * Store what the legacy settings shape describes, keeping everything it cannot describe.
 *
 * `current` is the policy in force, and it supplies every canonical axis the legacy shape cannot speak: the rules,
 * and `prohibition`. A refusal the user wrote cannot be deleted by a surface that never knew it was writing about
 * it — and this shape cannot express one either, except as the whole-policy `deny`, which is why the two are
 * handled apart: the body is read as a patch over the policy, and a field it does not name is not a field it
 * clears.
 */
export function policyFromAutonomySettings(
  current: ExecutionPolicyConfig,
  raw: unknown,
): ExecutionPolicyConfig {
  const family = autonomyFamily(parseAutonomySettings(raw));
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const named = executionPolicySchema.safeParse(body.executionPolicy);
  return {
    // The mode moves only when the body named the legacy policy. `parseAutonomySettings` fills a gap with the
    // legacy default, so a partial body would otherwise read as "the user chose guarded" and move the mode of a
    // node nobody asked to change.
    mode: named.success ? legacyModeFromPolicy(named.data) : current.mode,
    /*
     * A refusal can be added through this shape and never lifted by it.
     *
     * `deny` is the legacy spelling of "no effects on this node", so a body that names it sets `prohibition: all`.
     * A body that names anything else does not clear it, because the legacy fields have no way to say "not a
     * refusal": the four values describe who is asked, and `guarded` in that vocabulary never meant "every effect
     * is allowed". Reading a silence as consent would lift, by a guardrail edit in the settings panel, a refusal
     * the user set somewhere else — so lifting one is left to the surface that shows it (Settings → Control has
     * its own control for it), and the direction this file can move a refusal is the only safe one.
     */
    prohibition: named.success && named.data === "deny" ? "all" : current.prohibition,
    rules: [...current.rules],
    guardrails: family.guardrails ?? current.guardrails,
  };
}

/** The outcome of a compatibility write: the policy now in force, or why it was refused. */
export type SaveAutonomySettingsOutcome =
  | { ok: true; stored: ExecutionPolicyConfig }
  | { ok: false; code: PreferenceRefusalCode; message: string };

/**
 * Write the policy the legacy settings shape describes. Returns the policy now in force, or the refusal.
 *
 * The write outcome is read rather than assumed. `writeRegisteredPreference` validates before it stores and can
 * refuse — a body carrying more guard classes than the canonical list holds is the case this exists for — and a
 * refusal reported as a success would tell the settings panel it had stored a policy the node is not running
 * under.
 */
export function saveAutonomySettings(
  deps: PreferenceDeps,
  principalId: string,
  raw: unknown,
): SaveAutonomySettingsOutcome {
  const next = policyFromAutonomySettings(readExecutionPolicy(deps, principalId), raw);
  const outcome = writeRegisteredPreference(deps, {
    principalId,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
    value: next,
    source: "user",
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  return { ok: true, stored: next };
}

/**
 * Project one of the two legacy preference keys from the canonical policy.
 *
 * A key that is not one of them is returned untouched, so this can be mapped over the whole registry
 * response without a condition at the call site.
 */
export function projectPolicyPreference(
  policy: RegisteredPreference,
  preference: RegisteredPreference,
): RegisteredPreference {
  const parsed = executionPolicyConfigSchema.safeParse(policy.value);
  if (!parsed.success) return preference;
  const projected =
    preference.key === LEGACY_EXECUTION_MODE_KEY
      ? parsed.data.mode
      : preference.key === LEGACY_EXECUTION_RULES_KEY
        ? parsed.data.rules
        : undefined;
  if (projected === undefined) return preference;
  return {
    ...preference,
    value: projected,
    isDefault: policy.isDefault,
    revision: policy.revision,
    updatedAt: policy.updatedAt,
  };
}

/**
 * Translate a write to one of the two legacy preference keys into a canonical one.
 *
 * Returns nothing for every other key, which is how the route keeps one code path: it asks this first and
 * falls through to the registry when the answer is `undefined`. A write the canonical schema refuses comes
 * back as the refusal it is, so the route can report the field rather than store a policy it cannot read.
 */
export function writePolicyPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string; value: unknown },
): PreferenceWriteOutcome | undefined {
  if (input.key !== LEGACY_EXECUTION_MODE_KEY && input.key !== LEGACY_EXECUTION_RULES_KEY) return undefined;
  const current = readExecutionPolicy(deps, input.principalId);
  const next =
    input.key === LEGACY_EXECUTION_MODE_KEY
      ? { ...current, mode: input.value }
      : { ...current, rules: input.value };
  return writeRegisteredPreference(deps, {
    principalId: input.principalId,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
    value: next,
    source: "user",
  });
}

/** Whether a key is one of the two the compatibility surface translates. */
function isLegacyPolicyKey(key: string): boolean {
  return key === LEGACY_EXECUTION_MODE_KEY || key === LEGACY_EXECUTION_RULES_KEY;
}

/**
 * Undo a write that arrived through one of the two legacy keys.
 *
 * A write through `execution.mode` or `execution.rules` is translated into the canonical policy
 * (`writePolicyPreference`), so undoing one has to reach the same row. It used to undo the legacy row instead,
 * which nothing writes and nothing reads: the answer was `undone: false` for a value that had never been stored
 * there, while the policy the write actually changed stayed changed.
 *
 * Returns nothing for every other key, so the route keeps one code path: it asks this first and falls through to
 * the registry. The answer is projected under the key the caller asked about, from the canonical policy read
 * after the undo — the same one reader every other route uses.
 */
export function undoPolicyPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string },
): PreferenceUndoOutcome | undefined {
  if (!isLegacyPolicyKey(input.key)) return undefined;
  const undone = undoRegisteredPreference(deps, {
    principalId: input.principalId,
    key: EXECUTION_POLICY_PREFERENCE_KEY,
  });
  if (!undone.ok) return undone;
  const view = readRegisteredPreference(deps, { principalId: input.principalId, key: input.key });
  if (view === undefined) return undone;
  const preference = projectPolicyPreference(
    readExecutionPolicyPreference(deps, input.principalId),
    view,
  );
  return undone.undone
    ? { ok: true, undone: true, preference }
    : { ok: true, undone: false, preference, reason: undone.reason };
}

/**
 * The narrowing options this node offers the guardrail.
 *
 * Two properties matter more than the list itself. It is **host-owned**: a guardrail picks an id from
 * here and never composes a constraint, so there is no way for a model to describe a wider envelope
 * than the host already allowed. And each entry is **already a narrowing** of the preflight budget, so
 * even a mis-chosen id cannot widen anything — and if one ever did, `applyGuardrailConstraints` refuses
 * the whole answer rather than clamping it.
 */
export const DEFAULT_NARROWING: readonly { id: string; description: string; constraint: GuardrailConstraint }[] = [
  {
    id: "timeout-30s",
    description: "chạy tối đa 30 giây rồi dừng",
    constraint: { kind: "timeout-ms", value: 30_000 },
  },
  {
    id: "timeout-10s",
    description: "chạy tối đa 10 giây rồi dừng",
    constraint: { kind: "timeout-ms", value: 10_000 },
  },
  {
    id: "output-2k",
    description: "chỉ giữ 2000 byte output",
    constraint: { kind: "max-output-bytes", value: 2_000 },
  },
];
