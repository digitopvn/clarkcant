/**
 * Preferences, with undo.
 *
 * Every write keeps the value it replaced, so undoing is a read of what was actually there rather
 * than a guess at a default. That distinction is the whole point: a preference set during guided
 * setup and then undone must return to what the user had before setup ran, which may itself have
 * been set by an earlier session and is not recoverable from a hard-coded default.
 *
 * `previousValue` being nullable is meaningful. A preference that did not exist before has no
 * previous value, and undoing it must delete the row rather than write a plausible-looking value
 * back.
 */

import { type Instant } from "@clarkcant/contracts";
import { type Database, allRows, oneRow, toJson, parseJson, transaction } from "@clarkcant/storage";

export type PreferenceScope = "global" | "node" | "conversation";
/** Where a value came from, so an onboarding-set value can be found and undone as a group. */
export type PreferenceSource = "user" | "default" | "onboarding";

export interface PreferenceDeps {
  db: Database;
  now: () => Instant;
}

export interface PreferenceRecord {
  principalId: string;
  key: string;
  scope: PreferenceScope;
  value: unknown;
  source: PreferenceSource;
  revision: number;
  /** What this write replaced. `undefined` means there was nothing there. */
  previousValue: unknown;
  updatedAt: Instant;
}

interface PreferenceRow {
  value: string;
  scope: string;
  source: string;
  revision: number;
  previous_value: string | null;
  created_at: string;
}

function toRecord(principalId: string, key: string, row: PreferenceRow): PreferenceRecord {
  return {
    principalId,
    key,
    scope: row.scope as PreferenceScope,
    value: parseJson<unknown>(row.value, "preferences.value"),
    source: row.source as PreferenceSource,
    revision: row.revision,
    previousValue:
      row.previous_value === null
        ? undefined
        : parseJson<unknown>(row.previous_value, "preferences.previous_value"),
    updatedAt: row.created_at as Instant,
  };
}

export function getPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string; scope: PreferenceScope },
): PreferenceRecord | undefined {
  const row = oneRow<PreferenceRow>(
    deps.db,
    "SELECT value, scope, source, revision, previous_value, created_at FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?",
    input.principalId,
    input.key,
    input.scope,
  );
  return row === undefined ? undefined : toRecord(input.principalId, input.key, row);
}

/**
 * Write a preference, remembering what it replaced.
 *
 * The previous value is taken from the row being overwritten, not from the caller, so undo
 * returns to what was actually there even if several writes happened in between.
 */
export function setPreference(
  deps: PreferenceDeps,
  input: {
    principalId: string;
    key: string;
    scope: PreferenceScope;
    value: unknown;
    source: PreferenceSource;
  },
): PreferenceRecord {
  return transaction(deps.db, () => {
    const existing = getPreference(deps, input);
    const at = deps.now();
    const revision = (existing?.revision ?? 0) + 1;

    deps.db
      .prepare(
        `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (principal_id, key, scope) DO UPDATE SET
           value = excluded.value,
           source = excluded.source,
           revision = excluded.revision,
           previous_value = excluded.previous_value,
           created_at = excluded.created_at`,
      )
      .run(
        input.principalId,
        input.key,
        toJson(input.value),
        input.scope,
        input.source,
        revision,
        existing === undefined ? null : toJson(existing.value),
        at,
      );

    const written = getPreference(deps, input);
    if (!written) throw new Error(`preference ${input.key} was not written`);
    return written;
  });
}

export type UndoOutcome =
  | { undone: true; key: string; restoredTo: unknown; removed: boolean }
  | { undone: false; key: string; reason: string };

/**
 * Undo the last write to a preference.
 *
 * Restores the previous value, or removes the row when there was none. Reporting which of the two
 * happened matters: "restored to false" and "the setting no longer exists" are different states
 * for anything that reads it.
 */
export function undoPreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string; scope: PreferenceScope },
): UndoOutcome {
  return transaction(deps.db, () => {
    const existing = getPreference(deps, input);
    if (!existing) {
      return { undone: false, key: input.key, reason: "this preference has never been set" };
    }
    /*
     * No previous value means there is nothing to restore, so the row is removed rather than written back
     * with a plausible-looking value.
     *
     * The condition is `previousValue === undefined` alone, and not also `revision <= 1`. `previous_value` is
     * NULL in exactly two situations — a key that was never written before, and one whose undo already
     * restored what it had — and both mean the same thing here: the history is exhausted. Keying this on the
     * revision instead left the second undo of a preference taking the restore branch with `undefined`, which
     * reached SQLite as an unbound parameter and came back as a 500 from the preferences route. The header of
     * this file already described the intended behaviour; this is the code catching up to it.
     */
    if (existing.previousValue === undefined) {
      deps.db
        .prepare("DELETE FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
        .run(input.principalId, input.key, input.scope);
      return { undone: true, key: input.key, restoredTo: undefined, removed: true };
    }

    deps.db
      .prepare(
        `UPDATE preferences
           SET value = ?, revision = ?, source = ?, previous_value = NULL, created_at = ?
         WHERE principal_id = ? AND key = ? AND scope = ?`,
      )
      .run(
        toJson(existing.previousValue),
        existing.revision + 1,
        "user",
        deps.now(),
        input.principalId,
        input.key,
        input.scope,
      );
    return { undone: true, key: input.key, restoredTo: existing.previousValue, removed: false };
  });
}

/**
 * Delete a preference outright.
 *
 * Undo is the wrong tool for a value that exists only to be spent. A confirmation token has one
 * legitimate use and then has to be gone, and `undoPreference` would helpfully put the value it
 * replaced back. Returns whether a row was actually removed, because "the token is gone" and "there
 * was never a token" are different answers and a caller needs to tell them apart.
 */
export function deletePreference(
  deps: PreferenceDeps,
  input: { principalId: string; key: string; scope: PreferenceScope },
): boolean {
  const result = deps.db
    .prepare("DELETE FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
    .run(input.principalId, input.key, input.scope);
  return Number(result.changes) > 0;
}

/**
 * Undo everything a guided setup wrote.
 *
 * Grouped by source rather than by time, so a setup that was re-run does not leave half of its
 * earlier writes behind. Only values whose last writer was onboarding are touched: a preference
 * the user changed afterwards is theirs and is left alone.
 */
export function undoOnboardingChanges(
  deps: PreferenceDeps,
  input: { principalId: string },
): { undone: string[]; skipped: string[] } {
  const rows = allRows<{ key: string; scope: string }>(
    deps.db,
    "SELECT key, scope FROM preferences WHERE principal_id = ? AND source = ? ORDER BY key",
    input.principalId,
    "onboarding",
  );

  const undone: string[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const outcome = undoPreference(deps, {
      principalId: input.principalId,
      key: row.key,
      scope: row.scope as PreferenceScope,
    });
    if (outcome.undone) undone.push(row.key);
    else skipped.push(row.key);
  }
  return { undone, skipped };
}

export function listPreferences(
  deps: PreferenceDeps,
  principalId: string,
): PreferenceRecord[] {
  const rows = allRows<PreferenceRow & { key: string }>(
    deps.db,
    "SELECT key, value, scope, source, revision, previous_value, created_at FROM preferences WHERE principal_id = ? ORDER BY scope, key",
    principalId,
  );
  return rows.map((row) => toRecord(principalId, row.key, row));
}
