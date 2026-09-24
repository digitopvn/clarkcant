import {
  WIDGET_STATE_MAX_BYTES,
  applyStateMigrationOps,
  durableState,
  validateStateAgainstSchema,
  type WidgetDefinition,
} from "@clarkcant/contracts";
import { toJson, transaction } from "@clarkcant/storage";

import { type StateMigration, migrateInstanceStateReported } from "./widget-lifecycle.ts";
import { type WidgetDeps, getInstance, readWidgetStateRow } from "./widget-service.ts";

/**
 * Durable state for a widget that runs in its own frame.
 *
 * A built-in surface changes its state through a bound view action, which the node validates operation by operation.
 * A third-party widget has no such operations: it writes its own state, shaped by the schema its definition
 * declares. What this file adds is the node's half of that write — the part the frame cannot be trusted to do:
 *
 * - **View state is not stored.** Keys the definition declares ephemeral are dropped before anything else happens.
 * - **The schema is enforced here**, on the merged document, so a widget cannot store a shape its own definition
 *   says is impossible and then fail to read it back.
 * - **A stale write is refused with the committed state**, so the widget can show its user what was saved instead
 *   of losing the edit silently in either direction.
 * - **State that does not match this definition's version is read-only.** Either a migration failed, or the package
 *   was rolled back past the version the state was written at; in both cases writing would overwrite data the
 *   current code does not understand.
 */

/** Why a frame's state can or cannot be written right now. */
export type WidgetStateStatus =
  | { kind: "writable" }
  | { kind: "offline"; reason: string }
  | { kind: "migration-failed"; fromVersion: number; toVersion: number; reason: string }
  | { kind: "newer-than-definition"; storedVersion: number; definitionVersion: number };

export interface FrameStateView {
  stateRevision: number;
  stateVersion: number;
  state: Record<string, unknown>;
  status: WidgetStateStatus;
}

/**
 * Turn a definition's declarative steps into the migrations `migrateInstanceState` runs.
 *
 * The step that reaches the definition's current version also checks its output against the state schema, and
 * throws when it does not match — inside the migration's transaction, so a migration that produces state the current
 * code cannot read is rolled back exactly like one that failed outright.
 */
export function compileStateMigrations(
  definition: Pick<WidgetDefinition, "stateMigrations" | "stateSchema" | "stateVersion">,
): StateMigration[] {
  const target = definition.stateVersion ?? 0;
  return (definition.stateMigrations ?? []).map((step) => ({
    from: step.from,
    to: step.to,
    apply: (body) => {
      const next = applyStateMigrationOps(body, step.ops);
      if (step.to === target) {
        const validation = validateStateAgainstSchema(definition.stateSchema, next);
        if (!validation.ok) {
          throw new Error(`the migrated state does not match stateSchema: ${validation.problems.join("; ")}`);
        }
      }
      return next;
    },
  }));
}

/**
 * The state a frame is mounted with, migrated first when the definition is newer than what is stored.
 *
 * Run where the frame is resolved, so a migration happens once, on the node, before any code of the new version
 * sees the state — never in the frame, and never lazily on a write that would have to guess what it was writing
 * over.
 */
export function prepareFrameState(
  deps: WidgetDeps,
  input: { instanceId: string; definition: WidgetDefinition },
): FrameStateView {
  const target = input.definition.stateVersion ?? 0;
  const instance = getInstance(deps, input.instanceId);
  const offline: WidgetStateStatus | undefined =
    instance?.lifecycle === "offline"
      ? { kind: "offline", reason: "the package that runs this widget is not installed on this node" }
      : undefined;

  let row = readWidgetStateRow(deps.db, input.instanceId);
  if (row === undefined) {
    return { stateRevision: 0, stateVersion: target, state: {}, status: offline ?? { kind: "writable" } };
  }

  let status: WidgetStateStatus = offline ?? { kind: "writable" };
  if (row.stateVersion > target) {
    status = { kind: "newer-than-definition", storedVersion: row.stateVersion, definitionVersion: target };
  } else if (row.stateVersion < target && offline === undefined) {
    const outcome = migrateInstanceStateReported(
      { db: deps.db, nodeId: deps.nodeId, now: deps.now },
      { instanceId: input.instanceId, toVersion: target, migrations: compileStateMigrations(input.definition) },
    );
    if (outcome.ok) {
      row = readWidgetStateRow(deps.db, input.instanceId) ?? row;
    } else {
      status = {
        kind: "migration-failed",
        fromVersion: outcome.recoveredAtVersion,
        toVersion: target,
        reason: outcome.reason,
      };
    }
  }

  return {
    stateRevision: row.revision,
    stateVersion: row.stateVersion,
    state: durableState(input.definition, row.body),
    status,
  };
}

export type StatePatchOutcome =
  | { ok: true; stateRevision: number; state: Record<string, unknown> }
  | {
      ok: false;
      code:
        | "INSTANCE_UNKNOWN"
        | "NOT_AUTHORIZED"
        | "INSTANCE_OFFLINE"
        | "STATE_READ_ONLY"
        | "STATE_REVISION_STALE"
        | "STATE_SCHEMA_INVALID"
        | "STATE_TOO_LARGE";
      message: string;
      stateRevision?: number;
      state?: Record<string, unknown>;
    };

/**
 * Commit one state write from a frame.
 *
 * The revision check and the write are in one transaction, so two surfaces writing at once cannot both be told they
 * won: the second is refused with what the first committed.
 */
export function applyWidgetStatePatch(
  deps: WidgetDeps,
  input: {
    instanceId: string;
    principalId: string;
    definition: WidgetDefinition;
    expectedRevision: number;
    patch: Record<string, unknown>;
  },
): StatePatchOutcome {
  const instance = getInstance(deps, input.instanceId);
  if (instance === undefined) {
    return { ok: false, code: "INSTANCE_UNKNOWN", message: `widget instance ${input.instanceId} does not exist` };
  }
  if (instance.ownerPrincipalId !== input.principalId) {
    return { ok: false, code: "NOT_AUTHORIZED", message: "this instance belongs to another principal" };
  }
  if (instance.lifecycle === "offline") {
    return {
      ok: false,
      code: "INSTANCE_OFFLINE",
      message: "the package that runs this widget is not installed, so its state is kept but cannot be changed",
    };
  }
  const target = input.definition.stateVersion ?? 0;

  return transaction(deps.db, () => {
    const current = readWidgetStateRow(deps.db, input.instanceId);
    const committed = current === undefined ? {} : durableState(input.definition, current.body);
    const currentRevision = current?.revision ?? 0;

    if (current !== undefined && current.stateVersion !== target) {
      return {
        ok: false as const,
        code: "STATE_READ_ONLY" as const,
        message:
          current.stateVersion > target
            ? `the saved state is stateVersion ${String(current.stateVersion)}, newer than this version of the widget understands (${String(target)}); it is kept unchanged`
            : `the saved state is stateVersion ${String(current.stateVersion)} and could not be migrated to ${String(target)}; it is kept unchanged`,
        stateRevision: currentRevision,
        state: committed,
      };
    }
    if (input.expectedRevision !== currentRevision) {
      return {
        ok: false as const,
        code: "STATE_REVISION_STALE" as const,
        message: `the write was planned at revision ${String(input.expectedRevision)}; the saved state is at ${String(currentRevision)}`,
        stateRevision: currentRevision,
        state: committed,
      };
    }

    const next = durableState(input.definition, { ...committed, ...input.patch });
    const validation = validateStateAgainstSchema(input.definition.stateSchema, next);
    if (!validation.ok) {
      return {
        ok: false as const,
        code: "STATE_SCHEMA_INVALID" as const,
        message: `the state does not match the widget's stateSchema: ${validation.problems.join("; ")}`,
        stateRevision: currentRevision,
        state: committed,
      };
    }
    const document = toJson(next);
    const bytes = new TextEncoder().encode(document).length;
    if (bytes > WIDGET_STATE_MAX_BYTES) {
      return {
        ok: false as const,
        code: "STATE_TOO_LARGE" as const,
        message: `the state is ${String(bytes)} bytes; a widget may store at most ${String(WIDGET_STATE_MAX_BYTES)}`,
        stateRevision: currentRevision,
        state: committed,
      };
    }

    const at = deps.now();
    const stateRevision = currentRevision + 1;
    if (current === undefined) {
      deps.db
        .prepare(
          `INSERT INTO widget_state
             (instance_id, state_version, state_revision, document, draft, draft_revision, draft_saved_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(input.instanceId, target, stateRevision, document, at);
    } else {
      deps.db
        .prepare("UPDATE widget_state SET state_revision = ?, document = ?, updated_at = ? WHERE instance_id = ?")
        .run(stateRevision, document, at, input.instanceId);
    }
    return { ok: true as const, stateRevision, state: next };
  });
}
