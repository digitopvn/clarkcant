import {
  compareReach,
  reachSnapshotOfListing,
  reachSnapshotOfManifest,
  type DirectoryEntry,
  type Notice,
  type ReachChangeView,
  type UnreadListingFields,
} from "@clarkcant/contracts";
import { unreadFieldsOf, type DirectoryIndexState } from "@clarkcant/core";
import { oneRow, type Database } from "@clarkcant/storage";

import { installedManifest } from "./package-resources.ts";

type Runtime = { db: Database; dataDir: string; identity: { nodeId: string } };

const UNKNOWN: ReachChangeView = { verdict: "unknown" };

/**
 * The listing of the version a package update notice names, when the directory lists it.
 *
 * Matched by package and version, not digest: the notice records no digest, and its `update` action is
 * `POST /packages/install` with the package and version, which installs the first listing of them (`installPackage`).
 * This is that same listing, so what the notice shows is about the artifact Update would fetch.
 */
function noticeEntry(notice: Notice, index: DirectoryIndexState): DirectoryEntry | undefined {
  const subject = notice.subject;
  if (notice.category !== "update" || subject?.kind !== "package" || subject.version === undefined) return undefined;
  if (index.kind !== "configured") return undefined;
  return index.entries.find((candidate) => candidate.packageId === subject.packageId && candidate.version === subject.version);
}

/**
 * On a package update notice, what the listing of the version it offers says that this node does not read, so the
 * notice does not show the change as all of it. Undefined for any other notice and when the version is not listed.
 */
export function noticeUnreadFields(notice: Notice, index: DirectoryIndexState): UnreadListingFields | undefined {
  const entry = noticeEntry(notice, index);
  return entry === undefined ? undefined : unreadFieldsOf(index, entry);
}

function installedVersion(runtime: Runtime, packageId: string): { package_id: string; version: string; digest: string } | undefined {
  return oneRow<{ package_id: string; version: string; digest: string }>(
    runtime.db,
    "SELECT package_id, version, digest FROM package_generations WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL",
    packageId,
    runtime.identity.nodeId,
  );
}

/**
 * What a version of a package reaches against the version this node runs now, for the two places an update is shown
 * before it is applied: the update notice, and the install question the policy may raise for it.
 *
 * The installed side is the installed manifest (what the host enforces now); the new side is the listing, whose reach
 * and resource request are binding, so what is shown is what the install will accept. Undefined when the package is not
 * installed or is already at that version. `unknown` when it is installed at another version and the two cannot be
 * compared: the installed manifest cannot be read, or the new version is not listed. That is said rather than left
 * silent, so a person does not read silence as "no change", and nothing is guessed.
 *
 * Read when shown rather than stored with the notice, so it always compares against what runs now.
 */
export function reachChangeAgainstInstalled(
  runtime: Runtime,
  entry: Pick<DirectoryEntry, "packageId" | "version" | "declaredReach" | "resources">,
  index: DirectoryIndexState,
): ReachChangeView | undefined {
  const installed = installedVersion(runtime, entry.packageId);
  if (installed === undefined || installed.version === entry.version) return undefined;
  const manifest = installedManifest(
    { packageId: installed.package_id, version: installed.version, digest: installed.digest },
    runtime.dataDir,
    index,
  );
  if (manifest === "unreadable") return UNKNOWN;
  return compareReach(reachSnapshotOfManifest(manifest), reachSnapshotOfListing(entry));
}

/**
 * The same for a package update notice: the listing of the version it names, against what is installed. Undefined for
 * any other notice, and when the package is not installed or already runs that version; `unknown` when the directory no
 * longer lists the version the notice names.
 */
export function noticeReachChange(runtime: Runtime, notice: Notice, index: DirectoryIndexState): ReachChangeView | undefined {
  const subject = notice.subject;
  if (notice.category !== "update" || subject?.kind !== "package" || subject.version === undefined) return undefined;
  const entry = noticeEntry(notice, index);
  if (entry !== undefined) return reachChangeAgainstInstalled(runtime, entry, index);
  const installed = installedVersion(runtime, subject.packageId);
  return installed === undefined || installed.version === subject.version ? undefined : UNKNOWN;
}
