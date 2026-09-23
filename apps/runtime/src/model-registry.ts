import {
  type ModelPool,
  type UserModelProfile,
  EMPTY_MODEL_POOL,
  nextModelProfile,
  parseModelPool,
} from "@clarkcant/contracts";
import { type Database, putPreference, readPreference } from "@clarkcant/storage";

import type { Instant } from "@clarkcant/contracts";

/**
 * The pool of models a person keeps for this node.
 *
 * Stored as a node preference rather than a table of its own: it is one person's choice about how this node behaves,
 * it is written whole and read whole, and the preferences table already keeps what it replaced — which is the first
 * question asked when a node starts behaving differently than expected.
 */

export const MODEL_POOL_PREFERENCE_KEY = "model-pool";
/**
 * Which alias a hotkey is currently on.
 *
 * Kept beside the pool rather than passed in by the caller, so a switch survives a restart: the next press has to
 * continue the walk, and a hotkey whose position lived in a browser tab would start from the beginning every time
 * the page was reloaded.
 */
export const MODEL_ALIAS_PREFERENCE_KEY = "model-alias";

/**
 * The profiles, or none.
 *
 * An unreadable pool resolves to empty rather than to an error, and empty is a working state: the node falls back to
 * the single model it always had, and the panel says the pool is empty. That is the honest failure for a setting
 * whose absence is not a fault.
 */
export function readModelPool(db: Database, principalId: string): ModelPool {
  const stored = readPreference(db, principalId, MODEL_POOL_PREFERENCE_KEY, "node");
  if (stored === undefined || stored.trim() === "") return EMPTY_MODEL_POOL;
  try {
    return parseModelPool(JSON.parse(stored));
  } catch {
    return EMPTY_MODEL_POOL;
  }
}

export function writeModelPool(db: Database, principalId: string, pool: ModelPool, at: Instant): ModelPool {
  const stored = parseModelPool(pool);
  putPreference(db, {
    principalId,
    key: MODEL_POOL_PREFERENCE_KEY,
    value: JSON.stringify(stored),
    scope: "node",
    source: "settings",
    at,
  });
  return stored;
}

/**
 * Move to the next enabled profile, and write both halves of what that means.
 *
 * Two writes, because "the model is now this" has two readers: the alias is what a person sees and what the next
 * press cycles from, and the model preference is what a session is actually created with. Writing only the first
 * would make the hotkey a label that lied about what the next turn would run.
 */
export function cycleModelPool(
  db: Database,
  principalId: string,
  at: Instant,
): { pool: ModelPool; current?: string; next?: UserModelProfile } {
  const pool = readModelPool(db, principalId);
  const current = readCurrentAlias(db, principalId);
  const next = nextModelProfile(pool, current);
  if (next === undefined) return { pool, ...(current === undefined ? {} : { current }) };

  writeCurrentAlias(db, principalId, next.alias, at);
  putPreference(db, {
    principalId,
    key: "model",
    value: `${next.provider}/${next.modelId}`,
    scope: "node",
    source: "settings",
    at,
  });
  return { pool, ...(current === undefined ? {} : { current }), next };
}

/**
 * Select a specific configured profile by alias, rather than walking to the next one.
 *
 * The alias is checked against the stored pool and must name an enabled profile: this is a choice
 * among what a person already configured, and it is what keeps `model.select` from becoming a way to
 * run an arbitrary provider/model string from a tool call or a click. Writes both halves `cycleModelPool`
 * does, for the same reason: the alias is what is shown, and the `model` preference is what the next
 * session actually runs.
 */
export function selectModelProfile(
  db: Database,
  principalId: string,
  alias: string,
  at: Instant,
): { pool: ModelPool; current?: string; next?: UserModelProfile } {
  const pool = readModelPool(db, principalId);
  const current = readCurrentAlias(db, principalId);
  const next = pool.profiles.find((profile) => profile.alias === alias && profile.enabled !== false);
  if (next === undefined) return { pool, ...(current === undefined ? {} : { current }) };

  writeCurrentAlias(db, principalId, next.alias, at);
  putPreference(db, {
    principalId,
    key: "model",
    value: `${next.provider}/${next.modelId}`,
    scope: "node",
    source: "settings",
    at,
  });
  return { pool, ...(current === undefined ? {} : { current }), next };
}

/** The alias a hotkey is on, if it has been set. */
export function readCurrentAlias(db: Database, principalId: string): string | undefined {
  const stored = readPreference(db, principalId, MODEL_ALIAS_PREFERENCE_KEY, "node");
  return stored === undefined || stored.trim() === "" ? undefined : stored.trim();
}

export function writeCurrentAlias(db: Database, principalId: string, alias: string, at: Instant): void {
  putPreference(db, {
    principalId,
    key: MODEL_ALIAS_PREFERENCE_KEY,
    value: alias,
    scope: "node",
    source: "settings",
    at,
  });
}
