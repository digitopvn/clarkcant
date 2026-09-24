import { join } from "node:path";

import { nowInstant, type DirectoryEntry } from "@clarkcant/contracts";
import {
  decideExecution,
  directoryIndexPath,
  installedWidgets,
  listInstalledPackages,
  readDirectoryIndex,
  readExecutionPolicy,
  recordEffectExecution,
  resolveLocalSource,
  restorePackage,
  rollbackPackage,
  uninstallPackage,
  type GenerationAvailable,
  type InstallDeps,
  type PackageLifecycleRefusal,
} from "@clarkcant/core";

import type { PackageInstallDeps } from "./package-install.ts";

/**
 * Uninstalling, restoring and rolling back a package, whoever asked.
 *
 * Settings, the route and the model's `manage_package` tool all end here, so a spoken "gỡ widget bảng việc" and a click
 * on **Gỡ** are one action with one answer. What the node decides is in `@clarkcant/core`'s `package-lifecycle.ts`;
 * this layer supplies the two things only the runtime can know — which widget definitions a package declares, read
 * from its bytes on disk, and whether the bytes a generation recorded are still the ones the directory lists.
 */

export type PackageChange = "uninstall" | "restore" | "rollback";

/**
 * Who asked. A click is the person acting on the host's own control for this exact package; `agent` and `voice` are
 * the model acting on something the person said, which is what a mode that asks every time exists to check.
 */
export type PackageChangeSource = "click" | "agent" | "voice";

export type PackageChangeRefusal = PackageLifecycleRefusal | "POLICY_REFUSED" | "CONFIRMATION_REQUIRED";

export type PackageChangeOutcome =
  | {
      kind: "changed";
      action: PackageChange;
      packageId: string;
      activeVersion: string | undefined;
      previousVersion: string | undefined;
      instancesOffline: number;
      instancesRestored: number;
      statesKept: number;
      /**
       * True when the package carries trusted native code, which Pi loaded at start: the change reaches that code
       * only when Pi restarts, and saying "done" without that would be claiming more than happened.
       */
      restartNeeded: boolean;
    }
  | { kind: "refused"; status: number; code: PackageChangeRefusal; message: string };

const REFUSAL_STATUS: Record<PackageLifecycleRefusal, number> = {
  NOT_INSTALLED: 404,
  NOTHING_TO_RESTORE: 404,
  ALREADY_INSTALLED: 409,
  NO_PREVIOUS_VERSION: 409,
  VERSION_UNAVAILABLE: 409,
};

function installDeps(deps: PackageInstallDeps): InstallDeps {
  return { db: deps.runtime.db, nodeId: deps.runtime.identity.nodeId, now: nowInstant, newId: deps.conductor.newId };
}

/**
 * The directory entries that are this package, at any version.
 *
 * A local install records the path as its id, so an entry whose local path is the recorded id is the same package —
 * the same narrow fallback the widget listing uses.
 */
function entriesOf(entries: readonly DirectoryEntry[], packageId: string): DirectoryEntry[] {
  return entries.filter(
    (entry) => entry.packageId === packageId || (entry.source.kind === "local" && entry.source.path === packageId),
  );
}

/**
 * Every widget definition id any listed version of the package declares.
 *
 * Every version rather than the active one: an instance created under 1.0 names the definition 1.0 declared, and
 * uninstalling 2.0 must take that instance offline too.
 */
function widgetIdsOf(entries: readonly DirectoryEntry[], cacheRoot: string): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const read = installedWidgets({
      packageId: entry.packageId,
      version: entry.version,
      source: resolveLocalSource(entry, cacheRoot),
    });
    if (read.ok) for (const widget of read.widgets) ids.add(widget.definition.id);
  }
  return [...ids];
}

/** Whether the directory still lists exactly the bytes a generation recorded. A changed digest is different code. */
function availableIn(entries: readonly DirectoryEntry[]): GenerationAvailable {
  return (generation) =>
    entries.some((entry) => entry.version === generation.version && entry.digest === generation.digest);
}

function isNative(deps: PackageInstallDeps, packageId: string): boolean {
  return listInstalledPackages(installDeps(deps)).some(
    (entry) => entry.packageId === packageId && entry.lane === "trusted-native",
  );
}

export function changePackage(
  deps: PackageInstallDeps,
  input: { action: PackageChange; packageId: string; source: PackageChangeSource; conversationId?: string },
): PackageChangeOutcome {
  const principalId = deps.runtime.identity.ownerPrincipalId;
  const operationDigest = `package.${input.action}:${input.packageId}`;
  // Read at the request, so a mode the person just changed applies to this change.
  const policy = readExecutionPolicy({ db: deps.runtime.db, now: nowInstant }, principalId);
  const decided = decideExecution({
    policy,
    action: { kind: "effect", category: "local-write", operationDigest },
    // The person named this package and this action; the policy still decides whether that is enough.
    explicitUserIntent: true,
  });
  if (decided.kind === "deny") {
    return { kind: "refused", status: 403, code: "POLICY_REFUSED", message: decided.reason };
  }
  /*
   * When the policy asks, a click on this package's own button in Settings is the answer: it is host-owned UI naming
   * exactly this action, which is what the question would have shown. A sentence the model acted on is not, so that
   * path stops and sends the person to the button instead of opening a second, parallel approval flow.
   */
  if (decided.kind === "ask" && input.source !== "click") {
    return {
      kind: "refused",
      status: 409,
      code: "CONFIRMATION_REQUIRED",
      message: `${decided.reason}; nothing was changed. Confirm it in Settings → Extensions & Widgets, on ${input.packageId}.`,
    };
  }

  const index = readDirectoryIndex(directoryIndexPath(process.env));
  const entries = index.kind === "configured" ? entriesOf(index.entries, input.packageId) : [];
  const widgetIds = widgetIdsOf(entries, join(deps.runtime.dataDir, "package-cache"));
  const available = availableIn(entries);
  const core = installDeps(deps);

  // Native code is judged on the generation that was running before an uninstall and on the one running after a
  // restore or rollback: either way, it is the code Pi has to load or unload.
  const nativeBefore = input.action === "uninstall" ? isNative(deps, input.packageId) : false;
  const outcome =
    input.action === "uninstall"
      ? uninstallPackage(core, { packageId: input.packageId, widgetIds })
      : input.action === "restore"
        ? restorePackage(core, { packageId: input.packageId, widgetIds, available })
        : rollbackPackage(core, { packageId: input.packageId, available });

  if (!outcome.ok) {
    return { kind: "refused", status: REFUSAL_STATUS[outcome.code], code: outcome.code, message: outcome.message };
  }
  recordEffectExecution(
    { db: deps.runtime.db, nodeId: deps.runtime.identity.nodeId, now: nowInstant, newId: deps.conductor.newId },
    {
      principalId,
      mode: policy.mode,
      decision:
        decided.kind === "execute"
          ? decided
          : { kind: "execute", reason: "confirmed by the person on the package's own control in Settings", audit: true },
      category: "local-write",
      operationDigest,
      description: `${input.action} ${input.packageId}${outcome.activeVersion === undefined ? "" : ` → ${outcome.activeVersion}`} (${input.source})`,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    },
  );
  return {
    kind: "changed",
    action: input.action,
    packageId: outcome.packageId,
    activeVersion: outcome.activeVersion,
    previousVersion: outcome.previousVersion,
    instancesOffline: outcome.instancesOffline,
    instancesRestored: outcome.instancesRestored,
    statesKept: outcome.statesKept,
    restartNeeded: input.action === "uninstall" ? nativeBefore : isNative(deps, input.packageId),
  };
}
