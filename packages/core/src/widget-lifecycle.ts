/**
 * Widget lifecycle: drafts, state migration, pin restore and package disablement.
 *
 * These four live together because they share one storage row. A widget's committed state and
 * its unsaved draft sit in the same record on purpose: a save that loses a revision race must
 * leave the draft in place, and a conflict that cleared the draft would be worse than the
 * conflict it reported. Splitting drafts into their own table makes that guarantee something a
 * later refactor can quietly break.
 *
 * The refusal messages are part of the contract, not decoration. "Refreshed" and "your unsaved
 * work was discarded" are different outcomes, and a caller that cannot tell them apart will
 * eventually tell the user the wrong one.
 */

import { type Instant, type WidgetSnapshot, widgetSnapshotSchema } from "@clarkcant/contracts";
import { type Database, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

export interface LifecycleDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
}

/** Widget-owned state. Opaque here: this module moves it, it does not interpret it. */
export type WidgetStateBody = Record<string, unknown>;

interface StateRow {
  state_version: number;
  state_revision: number;
  document: string;
  draft: string | null;
  draft_revision: number | null;
  draft_editor: string | null;
  draft_saved_at: string | null;
}

export interface WidgetStateView {
  instanceId: string;
  stateVersion: number;
  revision: number;
  body: WidgetStateBody;
  /** Present only while there is unsaved work. */
  draft: WidgetStateBody | undefined;
  draftRevision: number | undefined;
  /** Which editing surface wrote the draft, so a second one can be told rather than clobbering it. */
  draftEditor: string | undefined;
  draftSavedAt: Instant | undefined;
}

function requireState(deps: LifecycleDeps, instanceId: string): StateRow {
  const row = oneRow<StateRow>(
    deps.db,
    "SELECT state_version, state_revision, document, draft, draft_revision, draft_editor, draft_saved_at FROM widget_state WHERE instance_id = ?",
    instanceId,
  );
  if (!row) {
    throw new Error(`widget instance ${instanceId} has no state row; initialise it before editing`);
  }
  return row;
}

function view(instanceId: string, row: StateRow): WidgetStateView {
  return {
    instanceId,
    stateVersion: row.state_version,
    revision: row.state_revision,
    body: parseJson<WidgetStateBody>(row.document, "widget_state.document"),
    draft: row.draft === null ? undefined : parseJson<WidgetStateBody>(row.draft, "widget_state.draft"),
    draftRevision: row.draft_revision ?? undefined,
    draftEditor: row.draft_editor ?? undefined,
    draftSavedAt: (row.draft_saved_at ?? undefined) as Instant | undefined,
  };
}

/** Create the state row for a freshly created instance. */
export function initialiseState(
  deps: LifecycleDeps,
  input: { instanceId: string; body?: WidgetStateBody; stateVersion?: number },
): WidgetStateView {
  const at = deps.now();
  const body = input.body ?? {};
  deps.db
    .prepare(
      `INSERT INTO widget_state
         (instance_id, state_version, state_revision, document, draft, draft_revision, draft_saved_at, updated_at)
       VALUES (?, ?, 1, ?, NULL, NULL, NULL, ?)`,
    )
    .run(input.instanceId, input.stateVersion ?? 1, toJson(body), at);
  return view(input.instanceId, requireState(deps, input.instanceId));
}

export function readInstanceState(
  deps: LifecycleDeps,
  instanceId: string,
): WidgetStateView | undefined {
  const row = oneRow<StateRow>(
    deps.db,
    "SELECT state_version, state_revision, document, draft, draft_revision, draft_editor, draft_saved_at FROM widget_state WHERE instance_id = ?",
    instanceId,
  );
  return row === undefined ? undefined : view(instanceId, row);
}

/* ------------------------------------------------------------------ *
 * Drafts, autosave and conflicts (T46)
 * ------------------------------------------------------------------ */

export type SaveOutcome =
  | { ok: true; revision: number }
  | {
      ok: false;
      code: "CONFLICT";
      /** What the committed state is now, so the editor can show both. */
      currentRevision: number;
      currentBody: WidgetStateBody;
      /** Always true. Stated explicitly because the alternative is losing the draft. */
      draftPreserved: true;
    }
  | {
      ok: false;
      code: "DRAFT_HELD";
      /** The surface that currently holds the draft. */
      heldBy: string;
      /** What it wrote, so the second editor sees it instead of replacing it. */
      heldDraft: WidgetStateBody;
      message: string;
    };

/** Write the draft without touching the committed state. */
function writeDraft(
  deps: LifecycleDeps,
  input: { instanceId: string; body: WidgetStateBody; expectedRevision: number; editorToken: string },
): void {
  const at = deps.now();
  deps.db
    .prepare(
      "UPDATE widget_state SET draft = ?, draft_revision = ?, draft_editor = ?, draft_saved_at = ?, updated_at = ? WHERE instance_id = ?",
    )
    .run(toJson(input.body), input.expectedRevision, input.editorToken, at, at, input.instanceId);
}

/**
 * Save a draft, refusing if the editor was working from superseded content.
 *
 * A refusal writes the draft and leaves the committed state untouched. Both halves matter: the
 * user keeps their text, and the newer content they had not seen is not overwritten by an
 * autosave composed before it existed.
 *
 * One draft exists per widget, and the surface that opened it keeps it. Without that rule two
 * editors of the same widget silently replace each other's text, and both commits would publish
 * whichever document happened to be written last. The second editor is told who holds the draft
 * and is shown what that surface wrote, which is a recoverable outcome; a clobbered draft is not.
 */
export function saveDraft(
  deps: LifecycleDeps,
  input: { instanceId: string; body: WidgetStateBody; expectedRevision: number; editorToken: string },
): SaveOutcome {
  return transaction(deps.db, () => {
    const row = requireState(deps, input.instanceId);

    if (row.draft !== null && row.draft_editor !== null && row.draft_editor !== input.editorToken) {
      return {
        ok: false,
        code: "DRAFT_HELD",
        heldBy: row.draft_editor,
        heldDraft: parseJson<WidgetStateBody>(row.draft, "widget_state.draft"),
        message: `${row.draft_editor} already has an unsaved draft for this widget; your text was not saved here`,
      };
    }

    if (row.state_revision !== input.expectedRevision) {
      writeDraft(deps, input);
      return {
        ok: false,
        code: "CONFLICT",
        currentRevision: row.state_revision,
        currentBody: parseJson<WidgetStateBody>(row.document, "widget_state.document"),
        draftPreserved: true,
      };
    }

    writeDraft(deps, input);
    return { ok: true, revision: input.expectedRevision };
  });
}

/**
 * Promote the draft to committed state.
 *
 * Refuses while the draft was composed against a superseded revision, for the same reason the
 * save does: committing it would silently discard whatever arrived in between. It also refuses to
 * commit a draft written by another surface, which would otherwise publish someone else's text
 * under this editor's name.
 */
export function commitDraft(
  deps: LifecycleDeps,
  input: { instanceId: string; expectedRevision: number; editorToken: string },
): SaveOutcome {
  return transaction(deps.db, () => {
    const row = requireState(deps, input.instanceId);
    if (row.draft === null) {
      throw new Error(`widget instance ${input.instanceId} has no draft to commit`);
    }
    if (row.draft_editor !== null && row.draft_editor !== input.editorToken) {
      return {
        ok: false,
        code: "DRAFT_HELD",
        heldBy: row.draft_editor,
        heldDraft: parseJson<WidgetStateBody>(row.draft, "widget_state.draft"),
        message: `the open draft belongs to ${row.draft_editor}; this editor cannot commit it`,
      };
    }
    if (row.state_revision !== input.expectedRevision) {
      return {
        ok: false,
        code: "CONFLICT",
        currentRevision: row.state_revision,
        currentBody: parseJson<WidgetStateBody>(row.document, "widget_state.document"),
        draftPreserved: true,
      };
    }

    const nextRevision = row.state_revision + 1;
    deps.db
      .prepare(
        "UPDATE widget_state SET document = ?, state_revision = ?, draft = NULL, draft_revision = NULL, draft_editor = NULL, draft_saved_at = NULL, updated_at = ? WHERE instance_id = ?",
      )
      .run(row.draft, nextRevision, deps.now(), input.instanceId);
    return { ok: true, revision: nextRevision };
  });
}

/**
 * Drop the draft.
 *
 * Separate from committing because discarding unsaved work is a decision, and a decision needs
 * a call site someone had to write. Only the surface holding the draft may discard it, for the
 * same reason it is the only one that may overwrite or commit it.
 */
export function discardDraft(
  deps: LifecycleDeps,
  input: { instanceId: string; editorToken: string },
): { discarded: boolean; refused?: string } {
  const row = requireState(deps, input.instanceId);
  if (row.draft === null) return { discarded: false };
  if (row.draft_editor !== null && row.draft_editor !== input.editorToken) {
    return {
      discarded: false,
      refused: `the open draft belongs to ${row.draft_editor}; this editor cannot discard it`,
    };
  }
  deps.db
    .prepare(
      "UPDATE widget_state SET draft = NULL, draft_revision = NULL, draft_editor = NULL, draft_saved_at = NULL, updated_at = ? WHERE instance_id = ?",
    )
    .run(deps.now(), input.instanceId);
  return { discarded: true };
}

/* ------------------------------------------------------------------ *
 * State migration (T51)
 * ------------------------------------------------------------------ */

export interface StateMigration {
  from: number;
  to: number;
  /** Throwing aborts the step. The old state survives because the whole run is one transaction. */
  apply: (body: WidgetStateBody) => WidgetStateBody;
}

export type MigrationOutcome =
  | { ok: true; fromVersion: number; toVersion: number; steps: number }
  | {
      ok: false;
      code: "MIGRATION_FAILED";
      failedStep: { from: number; to: number };
      reason: string;
      /** The version the state is still at, after rollback. */
      recoveredAtVersion: number;
      recoveredBody: WidgetStateBody;
    };

/**
 * Migrate stored state to a newer version, all or nothing.
 *
 * The entire run is one transaction, so a step that throws at version 3 of 5 leaves the state at
 * its original version rather than half-converted. A partially migrated document is worse than
 * an unmigrated one: the unmigrated state is still readable by the code that wrote it, and a
 * half-migrated one is readable by neither.
 */
export function migrateInstanceState(
  deps: LifecycleDeps,
  input: { instanceId: string; toVersion: number; migrations: readonly StateMigration[] },
): MigrationOutcome {
  return transaction(deps.db, () => {
    const row = requireState(deps, input.instanceId);
    const fromVersion = row.state_version;
    const body = parseJson<WidgetStateBody>(row.document, "widget_state.document");

    if (fromVersion >= input.toVersion) {
      return { ok: true, fromVersion, toVersion: fromVersion, steps: 0 };
    }

    let current = body;
    let version = fromVersion;
    let steps = 0;

    while (version < input.toVersion) {
      const step = input.migrations.find((candidate) => candidate.from === version);
      if (!step) {
        return {
          ok: false,
          code: "MIGRATION_FAILED",
          failedStep: { from: version, to: input.toVersion },
          reason: `no migration is registered from version ${version} to ${input.toVersion}`,
          recoveredAtVersion: fromVersion,
          recoveredBody: body,
        };
      }
      try {
        current = step.apply(current);
      } catch (cause) {
        // The enclosing transaction is rolled back by the throw, which is the recovery: the
        // state row is never written, so the old document and version are still there.
        throw new MigrationStepFailed(step.from, step.to, cause);
      }
      version = step.to;
      steps += 1;
    }

    // The revision moves with the shape: a frame that read the old shape planned its write against the old
    // revision, so it is refused as stale instead of writing old keys over the migrated document.
    deps.db
      .prepare(
        "UPDATE widget_state SET document = ?, state_version = ?, state_revision = state_revision + 1, updated_at = ? WHERE instance_id = ?",
      )
      .run(toJson(current), version, deps.now(), input.instanceId);
    return { ok: true, fromVersion, toVersion: version, steps };
  });
}

/**
 * Thrown to carry a failed step out of the transaction.
 *
 * Exported so a caller can recognise it; the transaction boundary is what performs the rollback,
 * so the throw is the mechanism rather than an error to swallow.
 */
export class MigrationStepFailed extends Error {
  readonly from: number;
  readonly to: number;

  constructor(from: number, to: number, cause: unknown) {
    super(
      `state migration ${from} -> ${to} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "MigrationStepFailed";
    this.from = from;
    this.to = to;
  }
}

/** Run `migrateInstanceState` and convert a thrown step failure into its reported outcome. */
export function migrateInstanceStateReported(
  deps: LifecycleDeps,
  input: { instanceId: string; toVersion: number; migrations: readonly StateMigration[] },
): MigrationOutcome {
  try {
    return migrateInstanceState(deps, input);
  } catch (cause) {
    if (!(cause instanceof MigrationStepFailed)) throw cause;
    // Re-read rather than trusting the in-memory copy: the claim being made is that storage
    // still holds the original, and reading it back is the only way to establish that.
    const after = requireState(deps, input.instanceId);
    return {
      ok: false,
      code: "MIGRATION_FAILED",
      failedStep: { from: cause.from, to: cause.to },
      reason: cause.message,
      recoveredAtVersion: after.state_version,
      recoveredBody: parseJson<WidgetStateBody>(after.document, "widget_state.document"),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Pins and media ownership (T48)
 * ------------------------------------------------------------------ */

export interface PinRestore {
  pinId: string;
  instanceId: string;
  /** Preserved across the restore so a re-opened player resumes rather than restarts. */
  positionSeconds: number;
  /** Always false. Stated in the type so a caller cannot forget to check. */
  playing: false;
  /** Why playback was not started, shown to the user rather than left implicit. */
  autoplayRefused: string;
}

/**
 * Restore a pinned instance without starting playback.
 *
 * A pin restores a surface, not a session. Starting audio or video because a panel re-entered
 * the viewport is the behaviour users describe as "it just started playing by itself", so the
 * restore returns the position and leaves `playing` false. The widget starts playback when the
 * user asks it to, and the reason is carried back so the UI can say why nothing is playing.
 */
export function restorePinnedInstance(deps: LifecycleDeps, pinId: string): PinRestore {
  const pin = oneRow<{ instance_id: string; conversation_id: string }>(
    deps.db,
    "SELECT instance_id, conversation_id FROM pins WHERE pin_id = ?",
    pinId,
  );
  if (!pin) throw new Error(`pin ${pinId} does not exist`);

  const state = readInstanceState(deps, pin.instance_id);
  const position = state?.body.positionSeconds;
  return {
    pinId,
    instanceId: pin.instance_id,
    positionSeconds: typeof position === "number" && Number.isFinite(position) ? position : 0,
    playing: false,
    autoplayRefused:
      "Restoring a pin reopens the surface. Playback starts when you ask for it, not when the panel appears.",
  };
}

/* ------------------------------------------------------------------ *
 * Disabling a package (T50)
 * ------------------------------------------------------------------ */

export interface DisableOutcome {
  packageDigest: string;
  /** Instances whose renderer is gone, so they cannot be mounted. */
  instancesOffline: number;
  /** Snapshots that remain readable. History is not part of the disable. */
  snapshotsStillReadable: number;
  reason: string;
}

/**
 * Take a package out of service while its history stays readable.
 *
 * Uninstalling must not erase what a widget already produced. The instance moves to `offline`,
 * which is a lifecycle the contract already defines, so the timeline keeps a rendering of the
 * past and the actions that would need the missing code are reported as unavailable rather than
 * appearing to work.
 */
export function disablePackage(
  deps: LifecycleDeps,
  input: { packageDigest: string; reason: string },
): DisableOutcome {
  return transaction(deps.db, () => {
    const affected = deps.db
      .prepare("SELECT instance_id, document FROM widget_instances WHERE package_digest = ?")
      .all(input.packageDigest) as { instance_id: string; document: string }[];

    for (const row of affected) {
      const instance = parseJson<Record<string, unknown>>(row.document, "widget_instances.document");
      const updated = { ...instance, lifecycle: "offline" };
      deps.db
        .prepare("UPDATE widget_instances SET lifecycle = ?, document = ?, updated_at = ? WHERE instance_id = ?")
        .run("offline", toJson(updated), deps.now(), row.instance_id);
    }

    let readable = 0;
    for (const row of affected) {
      const count = oneRow<{ n: number }>(
        deps.db,
        "SELECT COUNT(*) AS n FROM widget_snapshots WHERE instance_id = ?",
        row.instance_id,
      );
      readable += count?.n ?? 0;
    }

    return {
      packageDigest: input.packageDigest,
      instancesOffline: affected.length,
      snapshotsStillReadable: readable,
      reason: input.reason,
    };
  });
}

export interface SnapshotDisplay {
  snapshot: WidgetSnapshot;
  text: string;
  /** Always false after the owning package is gone, and reported rather than implied. */
  actionsAvailable: false;
  unavailableBecause: string;
}

/**
 * Render a stored snapshot for display.
 *
 * This is the path the timeline uses for a message whose widget can no longer be mounted, so it
 * reads only stored text and never needs the package.
 */
export function readSnapshotForDisplay(
  deps: LifecycleDeps,
  snapshotId: string,
): SnapshotDisplay | undefined {
  const row = oneRow<{ document: string }>(
    deps.db,
    "SELECT document FROM widget_snapshots WHERE snapshot_id = ?",
    snapshotId,
  );
  if (!row) return undefined;
  const snapshot = widgetSnapshotSchema.parse(parseJson<Record<string, unknown>>(row.document, "widget_snapshots.document"));
  return {
    snapshot,
    text: snapshot.textAlternative,
    actionsAvailable: false,
    unavailableBecause:
      "The package that produced this view is no longer installed, so it is shown as a saved record.",
  };
}
