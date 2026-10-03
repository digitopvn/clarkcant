import {
  compareReach,
  reachSnapshotOfListing,
  reachSnapshotOfManifest,
  type DirectoryEntry,
  type Notice,
  type ReachChange,
} from "@clarkcant/contracts";
import type { DirectoryIndexState } from "@clarkcant/core";
import { oneRow, type Database } from "@clarkcant/storage";

import { installedManifest } from "./package-resources.ts";

/**
 * What a version of a package reaches against the version this node runs now, for the two places an update is shown
 * before it is applied: the update notice, and the install question the policy may raise for it.
 *
 * The installed side is the installed manifest (what the host enforces now); the new side is the listing, whose reach
 * and resource request are binding, so what is shown is what the install will accept. Undefined when the package is not
 * installed, is already at that version, or its manifest cannot be read: nothing is said rather than a guess.
 *
 * Read when shown rather than stored with the notice, so it always compares against what runs now.
 */
export function reachChangeAgainstInstalled(
  runtime: { db: Database; dataDir: string; identity: { nodeId: string } },
  entry: Pick<DirectoryEntry, "packageId" | "version" | "declaredReach" | "resources">,
  index: DirectoryIndexState,
): ReachChange | undefined {
  const installed = oneRow<{ package_id: string; version: string; digest: string }>(
    runtime.db,
    "SELECT package_id, version, digest FROM package_generations WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL",
    entry.packageId,
    runtime.identity.nodeId,
  );
  if (installed === undefined || installed.version === entry.version) return undefined;
  const manifest = installedManifest(
    { packageId: installed.package_id, version: installed.version, digest: installed.digest },
    runtime.dataDir,
    index,
  );
  if (manifest === "unreadable") return undefined;
  return compareReach(reachSnapshotOfManifest(manifest), reachSnapshotOfListing(entry));
}

/**
 * The same for a package update notice: the listing of the version it names, against what is installed. Undefined for
 * any other notice, and for a version the directory no longer lists.
 */
export function noticeReachChange(
  runtime: { db: Database; dataDir: string; identity: { nodeId: string } },
  notice: Notice,
  index: DirectoryIndexState,
): ReachChange | undefined {
  const subject = notice.subject;
  if (notice.category !== "update" || subject?.kind !== "package" || subject.version === undefined) return undefined;
  if (index.kind !== "configured") return undefined;
  const entry = index.entries.find((candidate) => candidate.packageId === subject.packageId && candidate.version === subject.version);
  if (entry === undefined) return undefined;
  return reachChangeAgainstInstalled(runtime, entry, index);
}
