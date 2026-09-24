import type { PackageGeneration } from "@clarkcant/contracts";
import { allRows, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

import type { InstallDeps } from "./install-lifecycle.ts";

/**
 * Uninstalling, restoring and rolling back a package, as the person asks for them.
 *
 * All three move which generation is active and nothing else. Generations are never deleted — that is what lets an
 * uninstall be undone without fetching anything, and a rollback land on bytes this node already verified — and a
 * widget's stored state and its snapshots are never touched: an uninstalled widget's instances go offline, their
 * history keeps showing its text alternative, and restoring the package brings the same instances back with the
 * same state. Deleting a widget's data is a different action with its own consequences, and none of these is it.
 *
 * The widget ids are the caller's to supply: an instance names its definition, not the package that shipped it, and
 * which definitions a package declares is read from the package on disk, which is the runtime's to read.
 */

export type PackageLifecycleRefusal =
  | "NOT_INSTALLED"
  | "ALREADY_INSTALLED"
  | "NOTHING_TO_RESTORE"
  | "NO_PREVIOUS_VERSION"
  | "VERSION_UNAVAILABLE";

export type PackageLifecycleOutcome =
  | {
      ok: true;
      packageId: string;
      /** The version now active, or undefined after an uninstall. */
      activeVersion: string | undefined;
      /** The version that was active before, or undefined after a restore. */
      previousVersion: string | undefined;
      instancesOffline: number;
      instancesRestored: number;
      /** Widget instances whose stored state was kept, which after these actions is every one that had state. */
      statesKept: number;
    }
  | { ok: false; code: PackageLifecycleRefusal; message: string };

interface GenerationRow {
  generation_id: string;
  version: string;
  digest: string;
  superseded_at: string | null;
  document: string;
}

/** Whether a generation's bytes can still be served: the runtime checks the directory still lists them unchanged. */
export type GenerationAvailable = (generation: Pick<PackageGeneration, "packageId" | "version" | "digest">) => boolean;

function active(deps: InstallDeps, packageId: string): GenerationRow | undefined {
  return oneRow<GenerationRow>(
    deps.db,
    `SELECT generation_id, version, digest, superseded_at, document FROM package_generations
      WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL`,
    packageId,
    deps.nodeId,
  );
}

function newestSuperseded(deps: InstallDeps, packageId: string, exceptVersion?: string): GenerationRow | undefined {
  return oneRow<GenerationRow>(
    deps.db,
    `SELECT generation_id, version, digest, superseded_at, document FROM package_generations
      WHERE package_id = ? AND node_id = ? AND superseded_at IS NOT NULL AND version <> ?
      ORDER BY superseded_at DESC, activated_at DESC LIMIT 1`,
    packageId,
    deps.nodeId,
    exceptVersion ?? "",
  );
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Move every instance of these definitions from one lifecycle to another, keeping the document in step. */
function moveInstances(
  deps: InstallDeps,
  widgetIds: readonly string[],
  from: (lifecycle: string) => boolean,
  to: "offline" | "ready",
): number {
  if (widgetIds.length === 0) return 0;
  const rows = allRows<{ instance_id: string; lifecycle: string; document: string }>(
    deps.db,
    `SELECT instance_id, lifecycle, document FROM widget_instances
      WHERE owner_node_id = ? AND definition_id IN (${placeholders(widgetIds.length)})`,
    deps.nodeId,
    ...widgetIds,
  );
  let moved = 0;
  for (const row of rows) {
    if (!from(row.lifecycle)) continue;
    const document = parseJson<Record<string, unknown>>(row.document, "widget_instances.document");
    deps.db
      .prepare("UPDATE widget_instances SET lifecycle = ?, document = ?, updated_at = ? WHERE instance_id = ?")
      .run(to, toJson({ ...document, lifecycle: to }), deps.now(), row.instance_id);
    moved += 1;
  }
  return moved;
}

function statesKept(deps: InstallDeps, widgetIds: readonly string[]): number {
  if (widgetIds.length === 0) return 0;
  return (
    oneRow<{ n: number }>(
      deps.db,
      `SELECT COUNT(*) AS n FROM widget_state s JOIN widget_instances i ON i.instance_id = s.instance_id
        WHERE i.owner_node_id = ? AND i.definition_id IN (${placeholders(widgetIds.length)})`,
      deps.nodeId,
      ...widgetIds,
    )?.n ?? 0
  );
}

/**
 * Uninstall: retire the active generation and take the package's widgets offline.
 *
 * The generation row stays, superseded, so **Restore** can bring back exactly these bytes.
 */
export function uninstallPackage(
  deps: InstallDeps,
  input: { packageId: string; widgetIds: readonly string[] },
): PackageLifecycleOutcome {
  return transaction(deps.db, () => {
    const current = active(deps, input.packageId);
    if (current === undefined) {
      return { ok: false as const, code: "NOT_INSTALLED" as const, message: `${input.packageId} is not installed on this node` };
    }
    deps.db
      .prepare("UPDATE package_generations SET superseded_at = ? WHERE generation_id = ?")
      .run(deps.now(), current.generation_id);
    const offline = moveInstances(deps, input.widgetIds, (lifecycle) => lifecycle !== "offline", "offline");
    return {
      ok: true as const,
      packageId: input.packageId,
      activeVersion: undefined,
      previousVersion: current.version,
      instancesOffline: offline,
      instancesRestored: 0,
      statesKept: statesKept(deps, input.widgetIds),
    };
  });
}

/**
 * Restore: reactivate the generation that was uninstalled most recently, and bring its widgets back.
 *
 * Refused when something is already active — restoring over an installed package would be a rollback in disguise —
 * and when the bytes are no longer available, since reactivating a generation nothing can serve would say "installed"
 * about a package that cannot run.
 */
export function restorePackage(
  deps: InstallDeps,
  input: { packageId: string; widgetIds: readonly string[]; available: GenerationAvailable },
): PackageLifecycleOutcome {
  return transaction(deps.db, () => {
    const current = active(deps, input.packageId);
    if (current !== undefined) {
      return {
        ok: false as const,
        code: "ALREADY_INSTALLED" as const,
        message: `${input.packageId}@${current.version} is installed; there is nothing to restore`,
      };
    }
    const target = newestSuperseded(deps, input.packageId);
    if (target === undefined) {
      return {
        ok: false as const,
        code: "NOTHING_TO_RESTORE" as const,
        message: `${input.packageId} was never installed on this node`,
      };
    }
    if (!input.available({ packageId: input.packageId, version: target.version, digest: target.digest })) {
      return {
        ok: false as const,
        code: "VERSION_UNAVAILABLE" as const,
        message: `${input.packageId}@${target.version} is no longer listed with the digest this node installed, so it cannot be restored from here; install it again from the marketplace`,
      };
    }
    deps.db.prepare("UPDATE package_generations SET superseded_at = NULL WHERE generation_id = ?").run(target.generation_id);
    const restored = moveInstances(deps, input.widgetIds, (lifecycle) => lifecycle === "offline", "ready");
    return {
      ok: true as const,
      packageId: input.packageId,
      activeVersion: target.version,
      previousVersion: undefined,
      instancesOffline: 0,
      instancesRestored: restored,
      statesKept: statesKept(deps, input.widgetIds),
    };
  });
}

/**
 * Roll back: make the most recently replaced *other* version active again.
 *
 * Only code moves. A widget's stored state stays at whatever version it was migrated to; if that is newer than the
 * restored definition understands, the widget opens read-only and says so, because there is no migration down.
 */
export function rollbackPackage(
  deps: InstallDeps,
  input: { packageId: string; available: GenerationAvailable },
): PackageLifecycleOutcome {
  return transaction(deps.db, () => {
    const current = active(deps, input.packageId);
    if (current === undefined) {
      return { ok: false as const, code: "NOT_INSTALLED" as const, message: `${input.packageId} is not installed on this node` };
    }
    const target = newestSuperseded(deps, input.packageId, current.version);
    if (target === undefined) {
      return {
        ok: false as const,
        code: "NO_PREVIOUS_VERSION" as const,
        message: `no other version of ${input.packageId} was ever active on this node`,
      };
    }
    if (!input.available({ packageId: input.packageId, version: target.version, digest: target.digest })) {
      return {
        ok: false as const,
        code: "VERSION_UNAVAILABLE" as const,
        message: `${input.packageId}@${target.version} is no longer listed with the digest this node installed, so it cannot be rolled back to`,
      };
    }
    // The partial unique index allows one active generation per package and node: retire first, then revive.
    deps.db
      .prepare("UPDATE package_generations SET superseded_at = ? WHERE generation_id = ?")
      .run(deps.now(), current.generation_id);
    deps.db.prepare("UPDATE package_generations SET superseded_at = NULL WHERE generation_id = ?").run(target.generation_id);
    return {
      ok: true as const,
      packageId: input.packageId,
      activeVersion: target.version,
      previousVersion: current.version,
      instancesOffline: 0,
      instancesRestored: 0,
      statesKept: 0,
    };
  });
}

/** The version a rollback would make active, if there is one. */
export function previousPackageVersion(deps: InstallDeps, packageId: string): string | undefined {
  const current = active(deps, packageId);
  if (current === undefined) return undefined;
  return newestSuperseded(deps, packageId, current.version)?.version;
}

export interface RestorablePackageView {
  packageId: string;
  version: string;
  digest: string;
  uninstalledAt: string;
}

/** Packages that were installed here, are not now, and could be restored without fetching anything. */
export function listRestorablePackages(deps: InstallDeps): RestorablePackageView[] {
  const rows = allRows<{ package_id: string; version: string; digest: string; superseded_at: string }>(
    deps.db,
    `SELECT g.package_id, g.version, g.digest, g.superseded_at FROM package_generations g
      WHERE g.node_id = ? AND g.superseded_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM package_generations a
                         WHERE a.package_id = g.package_id AND a.node_id = g.node_id AND a.superseded_at IS NULL)
        AND g.superseded_at = (SELECT MAX(b.superseded_at) FROM package_generations b
                                WHERE b.package_id = g.package_id AND b.node_id = g.node_id)
      ORDER BY g.package_id`,
    deps.nodeId,
  );
  return rows.map((row) => ({
    packageId: row.package_id,
    version: row.version,
    digest: row.digest,
    uninstalledAt: row.superseded_at,
  }));
}

/** The `packageId@version` of every generation active on this node, for preferring the running code over a listing. */
export function activePackageVersions(deps: Pick<InstallDeps, "db" | "nodeId">): ReadonlySet<string> {
  const rows = allRows<{ package_id: string; version: string }>(
    deps.db,
    "SELECT package_id, version FROM package_generations WHERE node_id = ? AND superseded_at IS NULL",
    deps.nodeId,
  );
  return new Set(rows.map((row) => `${row.package_id}@${row.version}`));
}
