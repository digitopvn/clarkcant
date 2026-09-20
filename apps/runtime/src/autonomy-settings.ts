import {
  type AutonomySettings,
  DEFAULT_AUTONOMY_SETTINGS,
  type GuardrailConstraint,
  type Instant,
  parseAutonomySettings,
} from "@clarkcant/contracts";
import { type Database, putPreference, readPreference } from "@clarkcant/storage";

/**
 * The autonomy settings, stored like every other node preference.
 *
 * A node preference rather than a row of its own, because that is what it is: one person's choice about
 * how this node behaves, in the same table as the model they picked. Storing it as JSON in a text
 * preference also means a build that does not know a field yet reads around it instead of failing, which
 * is why `parseAutonomySettings` is field-wise.
 */
export const AUTONOMY_PREFERENCE_KEY = "autonomy";

/**
 * Read the policy this node runs under.
 *
 * Unreadable storage resolves to the defaults rather than to an error, and the defaults are `guarded`:
 * the failure mode has to be a node that still consults the guardrail, not one that has silently stopped
 * consulting anything. A JSON row that cannot be parsed is treated as absent for the same reason.
 */
export function readAutonomySettings(db: Database, principalId: string): AutonomySettings {
  const stored = readPreference(db, principalId, AUTONOMY_PREFERENCE_KEY, "node");
  if (stored === undefined || stored.trim() === "") return DEFAULT_AUTONOMY_SETTINGS;
  try {
    return parseAutonomySettings(JSON.parse(stored));
  } catch {
    return DEFAULT_AUTONOMY_SETTINGS;
  }
}

export function writeAutonomySettings(
  db: Database,
  principalId: string,
  settings: AutonomySettings,
  at: Instant,
): void {
  putPreference(db, {
    principalId,
    key: AUTONOMY_PREFERENCE_KEY,
    value: JSON.stringify(settings),
    scope: "node",
    source: "settings",
    at,
  });
}

/**
 * Store whatever a client sent, after parsing it.
 *
 * The parse is here rather than in the route so there is exactly one place that decides what a partial or
 * wrong body means — and it means "fill the gaps from the defaults", never "store the raw object". A route
 * that wrote what it was given would let a client store a policy the node then has to guess at on every
 * command.
 */
export function saveAutonomySettings(
  db: Database,
  principalId: string,
  raw: unknown,
  at: Instant,
): AutonomySettings {
  const settings = parseAutonomySettings(raw);
  writeAutonomySettings(db, principalId, settings, at);
  return settings;
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
