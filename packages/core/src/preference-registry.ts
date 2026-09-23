/**
 * The preference registry, applied.
 *
 * `preferences.ts` is the store: it remembers what a write replaced so undo returns to what was
 * actually there. This module is the policy on top of it — which keys exist, what shape each one
 * accepts, which scope it lives in, and when a change takes effect.
 *
 * Three rules it exists to enforce:
 *
 * 1. **An unregistered key is refused, not stored.** A preference nothing reads is a setting that
 *    silently does nothing, so the refusal names the key instead of accepting it.
 * 2. **The scope comes from the key.** A caller never chooses between global and node: a device
 *    preference cannot be widened into an account-wide default by a request that says so.
 * 3. **A read answers for every registered key.** A preference nobody has set is reported with its
 *    declared default and `isDefault: true`, so the settings surface can render a real current
 *    state without inventing one, and cannot mistake a default for a choice the user made.
 *
 * Nothing here returns the stored value of an unregistered key. That is what keeps credentials —
 * which have their own store and their own routes — out of the settings API by construction rather
 * than by remembering to filter them.
 */

import {
  PREFERENCE_KEYS,
  PREFERENCE_REGISTRY,
  preferenceDefinition,
  type PreferenceDefinition,
  type RegisteredPreference,
} from "@clarkcant/contracts";
import { asJsonValue } from "@clarkcant/storage";

import {
  getPreference,
  setPreference,
  undoPreference,
  type PreferenceDeps,
  type PreferenceRecord,
  type PreferenceSource,
} from "./preferences.ts";

export type { RegisteredPreference };

export type PreferenceRefusalCode = "PREFERENCE_UNKNOWN" | "PREFERENCE_INVALID";

export type PreferenceWriteOutcome =
  | { ok: true; preference: RegisteredPreference }
  | { ok: false; code: PreferenceRefusalCode; message: string };

export type PreferenceUndoOutcome =
  | { ok: true; undone: true; preference: RegisteredPreference }
  | { ok: true; undone: false; preference: RegisteredPreference; reason: string }
  | { ok: false; code: "PREFERENCE_UNKNOWN"; message: string };

/**
 * The part of a validation issue this needs.
 *
 * Structural rather than the schema library's own type, so this package keeps depending on
 * contracts and storage alone, and so a test can hand it an issue list without building one.
 */
export interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Describe why a value was refused, naming the field and never the value.
 *
 * A refusal is shown to whoever typed it, and the settings surface renders secrets nowhere — so
 * the report is a path and a rule ("exposure: too big"), not a rendering of what arrived.
 */
export function describeValidationIssues(error: {
  readonly issues: readonly ValidationIssue[];
}): string {
  const described = error.issues.slice(0, 4).map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  return described.length === 0 ? "this preference does not accept that value" : described.join("; ");
}

function envelope(
  definition: PreferenceDefinition,
  record: PreferenceRecord | undefined,
): RegisteredPreference {
  const shared = {
    key: definition.key,
    scope: definition.scope,
    applies: definition.applies,
  };
  if (record === undefined) {
    /*
     * A default is module-level state — `DEFAULT_EXECUTION_POLICY_CONFIG` holds arrays this process shares with
     * every read — so it is copied rather than handed out by reference: a caller that mutated what it read would
     * otherwise edit the default for every later read, and a widget holding one would hold the declaration.
     */
    return {
      ...shared,
      value: asJsonValue(definition.default, `preferences.${definition.key}.default`),
      isDefault: true,
      revision: 0,
      updatedAt: null,
    };
  }
  return {
    ...shared,
    value: record.value,
    isDefault: false,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

function refusalFor(key: string): { ok: false; code: "PREFERENCE_UNKNOWN"; message: string } {
  return { ok: false, code: "PREFERENCE_UNKNOWN", message: `"${key}" is not a preference this node has` };
}

/**
 * Every registered preference, in registry order.
 *
 * One read per registered key rather than one read of the whole table. Two reasons, and the second
 * is the important one: a key with no row still has to be answered, and the preferences table holds
 * rows this module has no business decoding. Reading by key means the response can only ever contain
 * what the registry declares — not because a filter remembered to drop the rest, but because nothing
 * else is ever read.
 */
export function listRegisteredPreferences(
  deps: PreferenceDeps,
  principalId: string,
): RegisteredPreference[] {
  const preferences: RegisteredPreference[] = [];
  for (const key of PREFERENCE_KEYS) {
    // Indexed through the registry rather than looked up by string: the key came from the registry,
    // so a missing definition would be a compile error rather than a preference silently dropped.
    const definition: PreferenceDefinition = PREFERENCE_REGISTRY[key];
    preferences.push(
      envelope(
        definition,
        getPreference(deps, { principalId, key: definition.key, scope: definition.scope }),
      ),
    );
  }
  return preferences;
}

/** One registered preference, or nothing when the key is not one this node has. */
export function readRegisteredPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string },
): RegisteredPreference | undefined {
  const definition = preferenceDefinition(input.key);
  if (definition === undefined) return undefined;
  return envelope(
    definition,
    getPreference(deps, {
      principalId: input.principalId,
      key: definition.key,
      scope: definition.scope,
    }),
  );
}

/**
 * Write a registered preference.
 *
 * The value is validated before the store is touched, so a refused write leaves the previous
 * value exactly where it was. The revision travels back with the value because the surface that
 * wrote it is what has to show that the write landed.
 */
export function writeRegisteredPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string; value: unknown; source?: PreferenceSource },
): PreferenceWriteOutcome {
  const definition = preferenceDefinition(input.key);
  if (definition === undefined) return refusalFor(input.key);

  const normalized = definition.normalize?.(input.value);
  const parsed = definition.schema.safeParse(normalized === undefined ? input.value : normalized);
  if (!parsed.success) {
    return { ok: false, code: "PREFERENCE_INVALID", message: describeValidationIssues(parsed.error) };
  }

  const record = setPreference(deps, {
    principalId: input.principalId,
    key: definition.key,
    scope: definition.scope,
    value: parsed.data,
    source: input.source ?? "user",
  });
  return { ok: true, preference: envelope(definition, record) };
}

/**
 * Undo the last write to a registered preference.
 *
 * `undone: false` is a real answer, not a failure: a key nobody has written has nothing to undo,
 * and the surface should say that rather than report a change that did not happen.
 */
export function undoRegisteredPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string },
): PreferenceUndoOutcome {
  const definition = preferenceDefinition(input.key);
  if (definition === undefined) return refusalFor(input.key);

  const outcome = undoPreference(deps, {
    principalId: input.principalId,
    key: definition.key,
    scope: definition.scope,
  });
  // Read again rather than reuse the undo's own report: undo may have restored a value or removed
  // the row, and both are states of the store worth reporting exactly as they now are.
  const preference = envelope(
    definition,
    getPreference(deps, {
      principalId: input.principalId,
      key: definition.key,
      scope: definition.scope,
    }),
  );

  if (!outcome.undone) {
    return { ok: true, undone: false, preference, reason: outcome.reason };
  }
  return { ok: true, undone: true, preference };
}

/**
 * The user's instructions as prompt text, or nothing.
 *
 * `undefined` for every state that means "say nothing": the toggle is off, the text is blank, or the stored
 * value is not the shape this expects. That is deliberate rather than a refusal — the caller appends this to
 * a system prompt, and a heading with nothing under it is something the model will try to interpret, while a
 * malformed preference must not be the reason a turn fails to start.
 *
 * Lives here rather than in the composition root so it is testable without a running node: it is the step
 * between "what the user stored" and "what the model is told", which is exactly where a mistake would be
 * invisible.
 */
export function readPersonalInstructions(
  deps: PreferenceDeps,
  principalId: string,
): string | undefined {
  const stored = readRegisteredPreference(deps, { principalId, key: "ai.personalInstructions" });
  const value = stored?.value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { enabled?: unknown; text?: unknown };
  if (record.enabled !== true || typeof record.text !== "string") return undefined;
  const text = record.text.trim();
  return text === "" ? undefined : text;
}
