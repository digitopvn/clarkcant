import { directoryIndexPath, listInstalledPackages, readDirectoryIndex } from "@clarkcant/core";
import { nowInstant, type ServiceConnectionRequirement } from "@clarkcant/contracts";

import type { PackageConnectionBroker } from "../package-connections.ts";
import { installedConnection, installedManifest } from "../package-resources.ts";
import type { PackageInstallDeps } from "./package-install.ts";
import type { TurnOrigin } from "@clarkcant/contracts";

import { changePackage, type PackageChange, type PackageChangeOutcome, type PackageChangeSource } from "./package-lifecycle.ts";

/**
 * A package change, and what it means for the account the package was connected to.
 *
 * The Settings route and the model's `manage_package` tool both call this, so an uninstall said, typed or clicked
 * leaves no account behind: the connection is read from the manifest before the change (once uninstalled, that
 * manifest is no longer the active one), and after a successful uninstall its tokens are revoked at the provider and
 * deleted on this node. Restore and rollback keep the connection, so the restored package works on the same account.
 */
export async function changePackageAndConnection(
  deps: PackageInstallDeps,
  connections: Pick<PackageConnectionBroker, "forget"> | undefined,
  input: { action: PackageChange; packageId: string; source: PackageChangeSource; conversationId?: string; origin?: TurnOrigin },
): Promise<PackageChangeOutcome> {
  const connection = input.action === "uninstall" ? declaredConnection(deps, input.packageId) : undefined;
  const outcome = changePackage(deps, input);
  if (outcome.kind === "changed" && input.action === "uninstall") {
    await connections?.forget(input.packageId, connection);
  }
  return outcome;
}

/** The connection an installed package declares, read from its manifest, or undefined. */
function declaredConnection(deps: PackageInstallDeps, packageId: string): ServiceConnectionRequirement | undefined {
  const { runtime } = deps;
  const installed = listInstalledPackages({
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    now: nowInstant,
    newId: deps.conductor.newId,
  }).find((entry) => entry.packageId === packageId);
  if (installed === undefined) return undefined;
  const manifest = installedManifest(installed, runtime.dataDir, readDirectoryIndex(directoryIndexPath(process.env)));
  return manifest === "unreadable" ? undefined : installedConnection(manifest);
}
