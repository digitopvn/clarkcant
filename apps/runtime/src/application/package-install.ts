import { join } from "node:path";

import {
  capabilityRefSchema,
  declaredReachMismatch,
  declaredReachOf,
  declaredResourcesMismatch,
  directorySourceRefSchema,
  entryFitsHost,
  instantSchema,
  nowInstant,
  platformForHost,
  recordSkippedFacets,
  riskLaneFor,
  skippedFacetLane,
  type CapabilityRef,
  type DirectoryEntry,
  type DirectorySourceRef,
  type EffectCategory,
  type PackageGeneration,
  type PackageManifest,
  type Principal,
} from "@clarkcant/contracts";
import {
  artifactRequest,
  directoryBackedMetadata,
  incompleteCoverageRefusal,
  lockBindingForPlan,
  materializeDependencyLock,
  readDependencyLock,
  resolveDependencyClosure,
  writeDependencyLock,
  type BuildInputs,
  type DependencyLock,
  type DependencyMetadataSource,
} from "@clarkcant/capability-host";
import {
  HOST_API_VERSION,
  LOCAL_DIRECTORY_SOURCE_ID,
  PRE_SOURCES_DIRECTORY_SOURCE,
  activeGeneration,
  artifactMatchesPlan,
  decideApprovalWithinTransaction,
  decideExecution,
  declaredWidgetIds,
  deriveGrantedCapabilities,
  devConsentScopeOf,
  digestOfDirectory,
  isDevConsentScope,
  directoryProblems,
  originOf,
  sourcesUnreadBefore,
  effectCategoryForLane,
  fetchGitArtifact,
  fetchNpmArtifact,
  installFromEntry,
  refreshDirectory,
  readExecutionPolicy,
  readPackage,
  recordEffectExecution,
  requestApproval,
  resolveLocalSource,
  snapshotLocalPackage,
  type CoordinationDeps,
  type ExecutionIntent,
  type DirectoryIndexState,
  type DirectoryOrigin,
  type DirectorySourceStatus,
} from "@clarkcant/core";
import { type Database, allRows, appendEvent, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

import { hostText, ownerLocale } from "../host-text.ts";
import { forgetPackageInstructionsQuietly } from "./package-instructions.ts";
import { readNodeDirectory } from "./widget-dev-store.ts";

/**
 * Installing a package a directory listed.
 *
 * The seam between the marketplace and the install path, and the only one: it finds the entry in the
 * configured index, decides with the execution policy that already governs every other effect, and
 * calls the install supervisor that already exists. It does not fetch, unpack, verify or activate
 * anything itself, and there is no second install path behind it.
 *
 * It answers with a result rather than a response. Which status a refusal deserves is HTTP, and HTTP
 * belongs to the route; this decides what happened. The dependencies are parameters, so the flow
 * cannot read a module-level value that was wired after boot.
 *
 * The order is the order that matters and it is unchanged: the host's own preflight (platform, then
 * the directory the package must be listed in) runs first, and only then does the policy decide.
 */

/** How long a pending install approval stays good for, and how long the plan it produces may live. */
const INSTALL_APPROVAL_TTL_MS = 10 * 60 * 1000;

/** The longest source name a generation records (`directorySourceRefSchema`). */
const DIRECTORY_SOURCE_LABEL_MAX = 300;

/** How old this node's copy of a remote directory may be before an install of a listing missing from it fetches again. */
const MISSING_LISTING_REFRESH_AGE_MS = 60_000;

export interface PackageInstallDeps {
  runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
  conductor: { newId: (prefix: string) => string };
  /**
   * Told once a different generation is active, so the package services that run follow what is installed.
   *
   * Not awaited: a service's image can take minutes to fetch, and an install is done when its generation is recorded.
   */
  packagesChanged?: () => void;
  /**
   * Told when a package's running code goes away — uninstalled, or rolled back to other code — so what was handed to
   * its widget frames under that code (browser tokens) is withdrawn. Not awaited: the change is done when recorded.
   */
  packageCodeEnded?: (packageId: string) => void;
}

/** The node's own install deps, with its service host told whenever what is installed changes. */
export function packageInstallDepsOf(services: {
  runtime: PackageInstallDeps["runtime"];
  conductor: PackageInstallDeps["conductor"];
  serviceHost?: { reconcile(): Promise<void> } | undefined;
  browserTokens?: { endPackage(packageId: string): Promise<number> } | undefined;
}): PackageInstallDeps {
  return {
    runtime: services.runtime,
    conductor: services.conductor,
    packagesChanged: () => {
      void services.serviceHost?.reconcile().catch((cause: unknown) => {
        process.stderr.write(`services: could not follow the package change: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      });
    },
    packageCodeEnded: (packageId) => {
      void services.browserTokens?.endPackage(packageId).catch((cause: unknown) => {
        process.stderr.write(`browser tokens: could not withdraw ${packageId}'s tokens: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      });
    },
  };
}

/** The install request, already parsed: the route owns reading the body. */
export interface PackageInstallRequest {
  packageId: string;
  version: string;
  /**
   * The identity a caller chose for a local source's plan, when it sent one. Kept for API clients that send it: the plan
   * and the generation carry it as given. Left out, the node uses the listing's digest, as an approved install does.
   */
  localDigest?: string;
  /**
   * For a listing by a path on this machine: the content digest of its files the listing showed (the
   * `marketplace-results` card's `contentDigest`). The install is refused when the files no longer hash to it.
   */
  contentDigest?: string;
  requestedCapabilityRefs?: string[];
  /**
   * The id of the directory source the listing the person pressed Install on was listed by (the `marketplace-results`
   * card's `sourceId`). Naming it is choosing that source: the install is refused when another source owns the listing
   * by now, and it is what allows installing from a later source while an earlier one cannot be read, or over a package
   * installed from a different source. Left out, the install takes only what precedence and the installed package's own
   * source allow; see `sourceRefusal`.
   */
  sourceId?: string;
}

export type PackageInstallOutcome =
  | { kind: "refused"; status: number; code: string; message: string }
  | { kind: "approval-required"; message: string; approvalId: string }
  | {
      kind: "installed";
      packageId: string;
      version: string;
      generationId: string;
      state: string;
      /**
       * The frozen build input, or null when the directory published no digest to freeze.
       *
       * `buildable` is what the locked-build path would do with this closure: a lock that covers the artifact but
       * not the package's tree is refused by name (`LOCK_INCOMPLETE`) rather than read as one a build would run,
       * and saying so here keeps the frozen input from being mistaken for a complete one.
       */
      lock: {
        ref: string;
        digest: string;
        coverage: string;
        buildable: boolean;
        /** Why the locked-build path would refuse this closure, when it would. */
        buildRefusal?: string;
      } | null;
      /**
       * Capabilities the manifest requested that were not granted (M1): each is reported here rather than
       * silently dropped, split by why. `pendingCapabilities` went through the same approval path
       * (`requestApproval`) an install itself would take when the policy is `ask` — an approval record now exists
       * for each one, under its own operation digest, for a caller to act on. `deniedCapabilities` were refused
       * outright by policy and have no approval to grant.
       */
      pendingCapabilities: readonly { ref: string; approvalId: string }[];
      deniedCapabilities: readonly string[];
    };

/**
 * The frozen build input, resolved and then read back the way a build reads it.
 *
 * Two properties this holds apart. What comes back is not the object this function just built but the artifact
 * read out of the node's lock directory under the reference a consented plan will name: a build never sees the
 * in-memory copy, so a plan bound to one that was never written would name bytes nobody can read. And the
 * locked-build path's own admission travels with it, so a closure a build would refuse is refused here rather
 * than being passed on as if it were a build input.
 */
export interface FrozenInstallClosure {
  /** The closure as a build reads it. Absent when the directory published no digest to freeze. */
  lock: DependencyLock | undefined;
  /**
   * The locked-build path's refusal, when it would refuse this closure.
   *
   * `undefined` means the closure covers what a build consumes. `LOCK_INCOMPLETE` is the honest answer for a
   * closure that covers the artifact but not the package's tree, and it is kept rather than thrown away: the
   * install proceeds (the package is activated), and a build refuses this input instead of resolving anything
   * itself.
   */
  buildRefusal: { code: "LOCK_INCOMPLETE"; message: string } | undefined;
}

export type FreezeInstallClosureOutcome =
  | { ok: true; frozen: FrozenInstallClosure }
  | { ok: false; status: number; code: string; message: string };

/**
 * Resolve the dependency closure **before** anything is installed, then consume it the way a build does.
 *
 * This node has not downloaded the artifact, so what it can resolve here is what the directory says this package
 * is: its exact version, the digest the publisher published, and which kind of source it came from. The package's
 * own dependency tree is not readable from here — a manifest's dependencies live inside the artifact, and nothing
 * in this repository turns a declared range into an exact version — so the lock says `artifact-only` rather than
 * implying it pinned a tree. Widening that claim is the one direction this must never take: a lock that says it
 * covers a tree nobody read is worse than one that says what it covers.
 *
 * A resolution that fails stops the install rather than letting a later step resolve it again: "we could not say
 * what this would install" is not a state to proceed from.
 */
export function freezeInstallClosure(input: {
  /** The node's lock directory. The reference is resolved inside it and nowhere else. */
  lockDir: string;
  entry: DirectoryEntry;
  metadata: DependencyMetadataSource;
  buildInputs: BuildInputs;
}): FreezeInstallClosureOutcome {
  const { entry } = input;

  /*
   * An entry that publishes no digest is refused by the installer with its own reason, and there is nothing to
   * freeze for it: a lock whose integrity is blank would name bytes nobody can check.
   */
  if (entry.digest.trim() === "") return { ok: true, frozen: { lock: undefined, buildRefusal: undefined } };

  const resolution = resolveDependencyClosure({ requests: [artifactRequest(entry)], metadata: input.metadata });
  if (!resolution.ok) {
    return { ok: false, status: 400, code: "DEPENDENCY_UNRESOLVED", message: resolution.message };
  }

  const materialized = materializeDependencyLock({
    packageId: entry.packageId,
    version: entry.version,
    coverage: "artifact-only",
    resolved: resolution.resolved,
    buildInputs: input.buildInputs,
  });

  /*
   * Kept next to the plans it will be consented with, under a reference that is its own digest, so a later
   * resolution can never replace the bytes a consented plan names.
   */
  const stored = writeDependencyLock({ dir: input.lockDir, lock: materialized });
  if (!stored.ok) return { ok: false, status: 409, code: stored.code, message: stored.message };

  /*
   * Read back through the same reader the locked-build runner uses, under the reference the plan is about to
   * carry. A missing or edited artifact stops the install here instead of becoming a plan that names bytes no
   * build can read.
   */
  const readBack = readDependencyLock({
    dir: input.lockDir,
    lockRef: materialized.lockRef,
    lockDigest: materialized.lockDigest,
  });
  if (!readBack.ok) return { ok: false, status: 409, code: readBack.code, message: readBack.message };

  return { ok: true, frozen: { lock: readBack.lock, buildRefusal: incompleteCoverageRefusal(readBack.lock) } };
}

export type RemoteFetchOutcome =
  | { ok: true; entry: DirectoryEntry; localDigest?: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * Fetch a git or npm entry's bytes into the node's package cache, and re-point the entry at them.
 *
 * A `local` entry is returned unchanged: this node already holds its bytes, and there is nothing to fetch. A git
 * or npm entry is fetched, its digest checked against the one the directory published
 * (`artifactMatchesPlan`), and the returned entry's `source` is rewritten to `local` at the cache path — so
 * everything downstream of this function (the dependency lock, the install plan, the consent digest) sees one
 * shape of source and treats a remote package exactly like a package already on disk.
 */
export async function fetchRemoteArtifact(entry: DirectoryEntry, cacheRoot: string): Promise<RemoteFetchOutcome> {
  if (entry.source.kind === "local") return { ok: true, entry };

  const fetched =
    entry.source.kind === "git"
      ? await fetchGitArtifact({
          url: entry.source.url,
          ref: entry.source.ref,
          cacheRoot,
          // Off by default (C1): a production directory listing is untrusted input, and a bare local path or
          // `file://` url in it must never be fetched. The one caller allowed to opt in is a test harness that
          // sets this explicitly, or a future "install from a path on this machine" flow that is not this one.
          allowLocalPaths: process.env["CC_ALLOW_LOCAL_GIT_SOURCES"] === "1",
          // N2: checked inside the fetch, before the staged bytes are ever renamed into the servable cache path,
          // rather than only here after the rename already happened.
          expectedDigest: entry.digest,
        })
      : await fetchNpmArtifact({
          name: entry.source.name,
          version: entry.source.version,
          cacheRoot,
          expectedDigest: entry.digest,
          // Overridable so the e2e suite (and a future self-hosted registry deployment) can point npm fetches
          // at a registry other than the public one. Omitted in production, where the default inside
          // `fetchNpmArtifact` (the real npmjs.org registry) is exactly what should run. `exactOptionalPropertyTypes`
          // rejects an explicit `undefined` for an optional property, so the key itself is left out rather than
          // set to `process.env[...]` directly.
          ...(process.env["CC_NPM_REGISTRY_URL"] === undefined ? {} : { registryUrl: process.env["CC_NPM_REGISTRY_URL"] }),
        });

  if (!fetched.ok) {
    // `ARTIFACT_DIGEST_MISMATCH` from the fetch itself (N2) reports the same fact `artifactMatchesPlan` below
    // would have, under the code this route's callers already handle.
    const status = fetched.code === "ARTIFACT_DIGEST_MISMATCH" ? 409 : 400;
    const code = fetched.code === "ARTIFACT_DIGEST_MISMATCH" ? "DIGEST_MISMATCH" : fetched.code;
    return { ok: false, status, code, message: fetched.message };
  }
  // Defense in depth: `fetchGitArtifact`/`fetchNpmArtifact` already checked this before anything was cached
  // (N2), so this should never fire for a fresh fetch. Kept as a second, independent check against whatever
  // `fetched.artifact.digest` actually says — the seam that catches a future fetch implementation forgetting to
  // pass `expectedDigest` through, rather than trusting the inner check silently.
  if (!artifactMatchesPlan(fetched.artifact.digest, entry.digest)) {
    return {
      ok: false,
      status: 409,
      code: "DIGEST_MISMATCH",
      message: `the fetched artifact for ${entry.packageId}@${entry.version} does not match the digest the directory published`,
    };
  }

  return {
    ok: true,
    entry: { ...entry, source: { kind: "local", path: fetched.artifact.path } },
    localDigest: fetched.artifact.digest,
  };
}

/**
 * An install the person already approved, from the inbox: the approval it was decided on and the artifact digest that
 * approval was bound to. Only `decideInstallApproval` passes it, after it has claimed that approval as granted.
 */
export interface ApprovedInstall {
  approvalId: string;
  digest: string;
  /** For a listing by a path on this machine: the content digest of its files when the person was asked. */
  localDigest?: string;
  /** The id of the directory source that owned the listing when the person was asked; see `approvalSourceRefusal`. */
  sourceId?: string;
}

/**
 * The most regular files a path on this machine may hold for the node to digest it (`localContentDigest`) or copy it
 * into a snapshot to install (`snapshotLocalPackage`).
 */
export const LOCAL_DIGEST_MAX_FILES = 5_000;
/** The most bytes, in total, the files at a path on this machine may hold for the node to digest or copy them. */
export const LOCAL_DIGEST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The content digest of a package listed by a path on this machine, computed the way a git or npm fetch digests the
 * bytes it holds (`digestOfDirectory`, with `.git` left out). Undefined for a git or npm listing, whose bytes the fetch
 * itself checks against the listing.
 *
 * A local listing's own `digest` is what its publisher packed, not a hash of the files at the path now. This is what a
 * search shows for such a listing (`contentDigest`) and what the inbox checks an install question against. An install
 * does not use it: it copies the files into a snapshot and digests the copy (`snapshotLocalPackage`), which equals
 * this digest for the same files, so a listing's `contentDigest` and an approval's pin compare with it directly.
 *
 * Bounded, because it runs on every local row a search lists (ten by default) and every install question the inbox
 * shows: a path past `LOCAL_DIGEST_MAX_FILES` files or `LOCAL_DIGEST_MAX_BYTES` bytes is not digested at
 * all (`tooLarge`). Nothing is skipped to fit: the digest covers every file the listing's own digest covers, so it can
 * be compared with what a publisher packed.
 */
export function localContentDigest(
  entry: DirectoryEntry,
): { ok: true; digest: string } | { ok: false; tooLarge: boolean; message: string } | undefined {
  if (entry.source.kind !== "local") return undefined;
  try {
    const digest = digestOfDirectory(entry.source.path, {
      exclude: [".git"],
      // As the snapshot leaves it out: `.GIT` is the same folder as `.git` on Windows and macOS.
      excludeAnyCase: true,
      limits: { maxFiles: LOCAL_DIGEST_MAX_FILES, maxBytes: LOCAL_DIGEST_MAX_BYTES },
    });
    return digest.ok
      ? { ok: true, digest: digest.digest }
      : { ok: false, tooLarge: digest.code === "ARTIFACT_TOO_LARGE", message: digest.message };
  } catch (cause) {
    // A path that is gone or unreadable has no digest, and so cannot be the files anybody approved.
    return { ok: false, tooLarge: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Whether a local listing's files are still the ones an approval pinned. Always true for a git or npm listing. */
export function localFilesUnchanged(entry: DirectoryEntry, pinned: string | undefined): boolean {
  const current = localContentDigest(entry);
  return current === undefined || (current.ok && pinned !== undefined && current.digest === pinned);
}

/** Why an approved local install was refused: its files are not the ones the person was asked about. */
export function localFilesChangedMessage(packageId: string, version: string): string {
  return `${packageId}@${version}'s files on this machine changed after you were asked, so nothing was installed; install it again to be asked about what they are now`;
}

/**
 * Why a direct install from a listing was refused: the files changed after the list that showed them was made. Pressing
 * Install on that list again sends the same digest and is refused again, so the way forward is a new search.
 */
export function localFilesChangedSinceListingMessage(packageId: string, version: string): string {
  return `${packageId}@${version}'s files on this machine changed after this list was made, so nothing was installed. Search again to list them as they are now, then install.`;
}

/** Why a local install was refused before anything was decided: its files could not be digested. */
function localSourceUnreadable(
  packageId: string,
  version: string,
  failure: { tooLarge: boolean; message: string },
): PackageInstallOutcome {
  return {
    kind: "refused",
    status: 400,
    code: "LOCAL_SOURCE_UNREADABLE",
    message: failure.tooLarge
      ? `${packageId}@${version}'s files on this machine are too large to verify: ${failure.message}`
      : `${packageId}@${version}'s files on this machine could not be read: ${failure.message}`,
  };
}

/**
 * The directory source the active generation of `packageId` was installed from. A generation installed before sources
 * were recorded came from the index file, the only source there was (`PRE_SOURCES_DIRECTORY_SOURCE`). Undefined when
 * the package is not installed.
 */
function installedDirectorySource(deps: PackageInstallDeps, packageId: string): DirectorySourceRef | undefined {
  const { runtime } = deps;
  const generation = activeGeneration(
    { db: runtime.db, nodeId: runtime.identity.nodeId, now: nowInstant, newId: deps.conductor.newId },
    packageId,
    runtime.identity.nodeId,
  );
  if (generation === undefined) return undefined;
  const recorded = directorySourceRefSchema.safeParse(generation.directorySource);
  return recorded.success ? recorded.data : PRE_SOURCES_DIRECTORY_SOURCE;
}

/**
 * Whether an approved install is refused because another source owns the listing than the one that owned it when the
 * person was asked. The bytes are pinned by digest either way, but the source decides where the package's updates come
 * from, so the generation records only the source the person was shown. A question asked before sources were recorded
 * was about the index file's listing, the only source there was.
 */
export function approvalSourceRefusal(input: {
  packageId: string;
  version: string;
  origin: DirectoryOrigin | undefined;
  askedSourceId: string | undefined;
}): { status: 409; code: "DIRECTORY_SOURCE_CHANGED"; message: string } | undefined {
  const { packageId, version, origin, askedSourceId } = input;
  if ((origin?.id ?? LOCAL_DIRECTORY_SOURCE_ID) === (askedSourceId ?? LOCAL_DIRECTORY_SOURCE_ID)) return undefined;
  return {
    status: 409,
    code: "DIRECTORY_SOURCE_CHANGED",
    message: `${packageId}@${version} is now listed by ${origin?.label ?? "another source"}, not by the source you were asked about, so nothing was installed; install it again to be asked about where it comes from now`,
  };
}

/**
 * Whether a direct install of a listing is refused for the source it comes from, and why.
 *
 * - The person pressed Install on a row that named a source, and another source owns the listing by now: refused, so
 *   what is installed is never from a source the person was not shown.
 * - Without a named source, a listing is installed only from the source the installed package came from, and for a
 *   package not installed from a recorded source, only when every source earlier than the listing's was read. Otherwise an earlier source that could not be read
 *   (a catalog behind a VPN, a feed never fetched) or a different publisher of the same id would be filled in silently.
 *   The refusal names both sources and the way forward: pressing Install on the row, which names its source.
 */
export function sourceRefusal(input: {
  packageId: string;
  version: string;
  origin: DirectorySourceRef | undefined;
  unreadBefore: readonly DirectorySourceStatus[];
  installedFrom: DirectorySourceRef | undefined;
  chosenSourceId: string | undefined;
}): PackageInstallOutcome | undefined {
  const { packageId, version, origin, unreadBefore, installedFrom, chosenSourceId } = input;
  const listing = `${packageId}@${version}`;
  if (chosenSourceId !== undefined) {
    if (origin === undefined || origin.id === chosenSourceId) return undefined;
    return {
      kind: "refused",
      status: 409,
      code: "DIRECTORY_SOURCE_CHANGED",
      message: `${listing} is now listed by ${origin.label}, not by the source this list showed, so nothing was installed. Search again to see where it is listed now.`,
    };
  }
  if (origin === undefined) return undefined;
  if (installedFrom !== undefined) {
    // The person chose this package's source when they installed it; that choice holds, and nothing else stands in for it.
    if (installedFrom.id === origin.id) return undefined;
    return {
      kind: "refused",
      status: 409,
      code: "DIRECTORY_SOURCE_CHANGED",
      message: `${packageId} was installed from ${installedFrom.label}, and ${listing} is listed by ${origin.label}, a different source, so nothing was installed. Search and install it from the ${origin.label} listing to switch where it comes from.`,
    };
  }
  const unread = unreadBefore[0];
  if (unread !== undefined) {
    return {
      kind: "refused",
      status: 409,
      code: "DIRECTORY_SOURCE_UNREAD",
      message: `${listing} is listed by ${origin.label}, but ${unread.origin.label} comes first and could not be read (${unread.reason ?? unread.state}), and it may list ${packageId} itself. Nothing was installed. Try again once ${unread.origin.label} answers, or search and install it from the ${origin.label} listing to take it from there.`,
    };
  }
  return undefined;
}

/** Options of `installPackage`. */
interface InstallOptions {
  approved?: ApprovedInstall;
  /**
   * A widget dev session's consent scope (`devConsentScopeOf`), when the listing is one of its generations. The policy
   * decides, asks about and approves the scope rather than this one artifact: the package and everything it may reach.
   * A generation that reaches exactly what an approved one did is the same question, already answered; any change to
   * that reach is a new question. Each install still records the exact files it ran. Refused unless it is the scope of
   * the listing being installed, so a caller cannot name a scope it was not given.
   */
  consentScope?: string;
  /**
   * Whose intent the install carries out. Absent is the person asking for this named package on their own surface.
   * A widget dev session Clark started passes `proposed` (with the turn's origin): Clark chose to install, so the
   * policy decides it as Clark's own proposal rather than as the person's request.
   */
  intent?: ExecutionIntent;
}

/**
 * Install a package from the directory. A local package's snapshot is held for the whole install (`SnapshotOutcome`),
 * so nothing removes it between the moment it is placed or reused and the moment a generation names it, or the install
 * ends without one.
 */
export async function installPackage(
  deps: PackageInstallDeps,
  request: PackageInstallRequest,
  options: InstallOptions = {},
): Promise<PackageInstallOutcome> {
  const holds: (() => void)[] = [];
  try {
    return await installHolding(deps, request, options, holds);
  } finally {
    for (const release of holds) release();
  }
}

async function installHolding(
  deps: PackageInstallDeps,
  request: PackageInstallRequest,
  options: InstallOptions,
  holds: (() => void)[],
): Promise<PackageInstallOutcome> {
  const { runtime, conductor } = deps;
  const { packageId, version } = request;

  /*
   * This host's own platform, from Node's pair. A host the vocabulary cannot name has no answer to "can this
   * package run here", and guessing `web` would offer a native package to something that cannot run it - so it is
   * refused by name rather than attempted.
   */
  const platform = platformForHost(process.platform, process.arch);
  if (platform === undefined) {
    return {
      kind: "refused",
      status: 400,
      code: "PLATFORM_UNKNOWN",
      message: `${process.platform}-${process.arch} is not a platform this host vocabulary names`,
    };
  }

  /*
   * The directory every configured source composes (`readDirectory`). A listing a remote source added since this node's
   * copy was fetched is looked for once more after a refresh, so an install pressed on a fresh marketplace card is not
   * refused for a copy that was a minute old. The listing is still only a pointer: everything below re-checks it.
   */
  const directory = { env: process.env, dataDir: runtime.dataDir };
  const listedIn = (state: DirectoryIndexState) =>
    state.kind === "configured"
      ? state.entries.find((candidate) => candidate.packageId === packageId && candidate.version === version)
      : undefined;
  let index = readNodeDirectory(runtime.dataDir);
  // Also fetched again when an earlier source has nothing to list: one never fetched may list this package itself.
  const found = listedIn(index);
  const foundOrigin = found === undefined ? undefined : originOf(index, found);
  const behindUnread = foundOrigin !== undefined && sourcesUnreadBefore(index, foundOrigin).length > 0;
  if (found === undefined || behindUnread) {
    await refreshDirectory(directory, { maxAgeMs: MISSING_LISTING_REFRESH_AGE_MS });
    index = readNodeDirectory(runtime.dataDir);
  }
  if (index.kind === "not-configured") return { kind: "refused", status: 409, code: "NO_DIRECTORY", message: index.reason };
  if (index.kind === "unreadable") {
    return { kind: "refused", status: 409, code: "DIRECTORY_UNREADABLE", message: index.reason };
  }
  const entry = listedIn(index);
  if (entry === undefined) {
    // A package missing because its marketplace is down is not reported as a package that does not exist.
    const problems = directoryProblems(index.sources);
    return {
      kind: "refused",
      status: 404,
      code: "NOT_IN_DIRECTORY",
      message: `${packageId}@${version} is not in the directory${problems === undefined ? "" : ` (${problems})`}`,
    };
  }
  const origin = originOf(index, entry);
  /*
   * Which source a listing comes from is part of what is installed: the same package id in another source is another
   * publisher's claim. An approved install already pins the artifact the person was asked about by its digest, which
   * no other source's listing can satisfy with different bytes, so the check is for the direct path.
   */
  if (options.approved === undefined) {
    const refusal = sourceRefusal({
      packageId,
      version,
      origin,
      unreadBefore: origin === undefined ? [] : sourcesUnreadBefore(index, origin),
      installedFrom: installedDirectorySource(deps, packageId),
      chosenSourceId: request.sourceId,
    });
    if (refusal !== undefined) return refusal;
  } else {
    // The source the person was asked about is the one recorded, never one that took the listing over since.
    const refusal = approvalSourceRefusal({ packageId, version, origin, askedSourceId: options.approved.sourceId });
    if (refusal !== undefined) return { kind: "refused", ...refusal };
  }

  /*
   * The host's own compatibility preflight, before anything else — including before the policy decides and
   * before a byte is fetched. The wrong platform, a host API this node does not implement, or an entry that
   * publishes no digest are all facts this node already knows from the listing alone, and a listing that cannot
   * run here must not be shown as one that can, let alone fetched.
   *
   * The two checks are asked separately, with `resolvePackageSource`'s own codes, rather than through
   * `resolvePackageSource` itself — whose git/npm branches look an entry up in the directory *by source*
   * (`findEntry`), a second search this route does not need for an entry it was already handed.
   * `resolvePackageSource` still runs its full check once more inside `installFromEntry`, against the (by then
   * local) resolved entry, so nothing here widens what it would refuse.
   */
  if (entry.hostApi.min > HOST_API_VERSION || entry.hostApi.max < HOST_API_VERSION) {
    return {
      kind: "refused",
      status: 400,
      code: "HOST_API_MISMATCH",
      message: `needs host API ${String(entry.hostApi.min)}–${String(entry.hostApi.max)}, this host is ${String(HOST_API_VERSION)}`,
    };
  }
  const fit = entryFitsHost({ entry, hostApi: HOST_API_VERSION, platform });
  if (!fit.ok) {
    return { kind: "refused", status: 400, code: "PLATFORM_MISMATCH", message: fit.reason };
  }
  if (entry.digest.trim() === "") {
    return {
      kind: "refused",
      status: 400,
      code: "DIGEST_MISMATCH",
      message: "the directory entry publishes no digest",
    };
  }
  if (options.consentScope !== undefined && options.consentScope !== devConsentScopeOf(entry)) {
    return {
      kind: "refused",
      status: 409,
      code: "DIGEST_MISMATCH",
      message: `${packageId}@${version} is no longer listed with the reach this install was asked under, so nothing was installed`,
    };
  }
  /** What the policy decides and an approval names: the artifact, or a dev session's consent scope. */
  const operationDigest = options.consentScope ?? entry.digest;

  /*
   * An approved install installs the artifact that was approved and nothing else. The same package and version can
   * name a different artifact by now (the listing was republished), and an approval given for the old bytes is not
   * an approval for the new ones: refused before anything is fetched, and the person is asked again on the next try.
   */
  const approved = options.approved;
  if (approved !== undefined && operationDigest !== approved.digest) {
    return {
      kind: "refused",
      status: 409,
      code: "DIGEST_MISMATCH",
      message: `${packageId}@${version} is no longer the artifact that was approved, so nothing was installed`,
    };
  }
  /*
   * The same rule for a listing by a path on this machine, whose listed digest says nothing about the files there now:
   * the approval pinned their content when the person was asked, and an approval that pinned none installs nothing.
   */
  if (approved !== undefined && entry.source.kind === "local" && approved.localDigest === undefined) {
    return { kind: "refused", status: 409, code: "DIGEST_MISMATCH", message: localFilesChangedMessage(packageId, version) };
  }

  const cacheRoot = join(runtime.dataDir, "package-cache");
  /*
   * A listing by a path on this machine is installed from a snapshot, not from the path: the node copies the files into
   * its content-addressed package cache, digests the copy, and everything the install reads (the manifest, its reach,
   * its widgets) and everything that later serves the package reads that copy. Edits to the path after this change
   * nothing that runs until the package is installed again, which makes a new snapshot checked like this one.
   *
   * The snapshot's digest is the one every check compares: the content an approval pinned when the person was asked
   * (other files install nothing), and the `contentDigest` a listing showed for a direct install (files that changed
   * since the list was made are refused). A copy that does not match is discarded rather than cached. With neither, a
   * path whose files changed while they were copied is refused too (409), since the copy would be a mix of two versions.
   * A path that cannot be copied (unreadable, holding a link, or too large to verify) is refused (400), and a copy the
   * node could not write into its own cache (a full disk, a locked or unwritable cache folder) is refused as the cache's
   * failure (503), not the files'.
   *
   * Deliberately before the policy decides: these are facts about the files, not decisions, so a person whose mode
   * would deny the install still learns that the files changed (409) or cannot be read (400) rather than only that the
   * policy refused (403), and a question the policy asks pins this same digest. A snapshot made for an install the
   * policy then refuses or asks about stays in the cache, where an install of the same bytes reuses it.
   */
  let snapshot: { path: string; digest: string } | undefined;
  if (entry.source.kind === "local") {
    const expectedDigest = approved?.localDigest ?? request.contentDigest;
    const taken = await snapshotLocalPackage({
      path: entry.source.path,
      cacheRoot,
      limits: { maxFiles: LOCAL_DIGEST_MAX_FILES, maxBytes: LOCAL_DIGEST_MAX_BYTES },
      ...(expectedDigest === undefined ? {} : { expectedDigest }),
    });
    if (!taken.ok && taken.code === "ARTIFACT_DIGEST_MISMATCH") {
      return {
        kind: "refused",
        status: 409,
        code: "DIGEST_MISMATCH",
        message: approved === undefined ? localFilesChangedSinceListingMessage(packageId, version) : localFilesChangedMessage(packageId, version),
      };
    }
    if (!taken.ok && taken.code === "LOCAL_SOURCE_CHANGED") {
      return {
        kind: "refused",
        status: 409,
        code: "DIGEST_MISMATCH",
        message: `${packageId}@${version}'s files on this machine changed while they were being copied, so nothing was installed and the files were left as they are. Install it again once they have stopped changing.`,
      };
    }
    if (!taken.ok && (taken.code === "PACKAGE_CACHE_UNAVAILABLE" || taken.code === "CACHE_ESCAPE")) {
      return {
        kind: "refused",
        status: 503,
        code: "PACKAGE_CACHE_UNAVAILABLE",
        message: `${packageId}@${version} was not installed: this node could not write its copy of the files into its package cache (${taken.message}). The files on this machine were not changed, and whatever was installed before keeps running. Try again; if it keeps failing, check the free space and permissions of ${cacheRoot}.`,
      };
    }
    if (!taken.ok) {
      return localSourceUnreadable(packageId, version, { tooLarge: taken.code === "ARTIFACT_TOO_LARGE", message: taken.message });
    }
    holds.push(taken.release);
    snapshot = taken.artifact;
  }

  const principalId = runtime.identity.ownerPrincipalId;
  // Read at the request rather than captured at boot, so a mode the user just changed applies to this install.
  const policy = readExecutionPolicy({ db: runtime.db, now: () => nowInstant() }, principalId);
  const asked = decideExecution({
    policy,
    action: { kind: "effect", category: "local-write", operationDigest },
    /*
     * By default the person's: installing *this named package* is what the person asked for, which is exactly the case
     * Autonomous exists to run without a second question. Guarded and Ask still apply, because the decision is the
     * policy's to make, not this route's. A caller acting on Clark's own proposal says so (`options.intent`).
     */
    intent: options.intent ?? { kind: "interactive" },
  });
  /*
   * The question the policy asked has been answered by the person, so it is not asked again: `ask` becomes the
   * decision they gave, audited. `deny` stays a refusal: a rule that forbids installing is not something an earlier
   * approval can outvote, and neither can a policy the person tightened after they approved.
   */
  const decision =
    approved !== undefined && asked.kind === "ask"
      ? { kind: "execute" as const, reason: "the person approved this install", audit: true }
      : asked;

  if (decision.kind === "deny") {
    return { kind: "refused", status: 403, code: "POLICY_REFUSED", message: decision.reason };
  }

  const coordination = {
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    now: () => nowInstant(),
    newId: conductor.newId,
  };

  if (decision.kind === "ask") {
    /*
     * A listing by a path on this machine is asked about together with the digest of the snapshot taken above, so
     * approving it later installs those files and not whatever the path holds by then.
     */
    const localDigest = snapshot?.digest;
    /*
     * Asking to install the same artifact again while its approval still waits is the same question, not a new one:
     * reuse the pending row for this digest, as the capability approvals below do, so a second press or a repeated
     * request does not pile up approvals nobody can tell apart. Only a live one — an expired row is not a question
     * anybody can still answer — and, for a local listing, only one asked about the files as they are now.
     */
    const pending = allRows<{ approval_id: string }>(
      runtime.db,
      "SELECT approval_id FROM approvals WHERE operation_digest = ? AND decision = 'pending' AND task_id IS NULL AND expires_at > ? ORDER BY requested_at, approval_id",
      operationDigest,
      nowInstant(),
    ).find((row) => {
      // A question asked about another source's listing of the same bytes is another question.
      const asked = findInstallApprovalRequest(runtime.db, runtime.identity.nodeId, row.approval_id);
      return (
        approvalSourceRefusal({ packageId, version, origin, askedSourceId: asked?.sourceId }) === undefined &&
        (localDigest === undefined || asked?.localDigest === localDigest)
      );
    });
    /*
     * A new question is recorded together with what it asks about - the package, the version and the artifact - in
     * one transaction, so an approval the inbox cannot name never exists. That record is what makes it an install
     * approval: the inbox lists it and the decision route installs it from there (`install-approval.ts`).
     */
    const approvalId =
      pending?.approval_id ??
      transaction(runtime.db, () => {
        const created = requestApproval(coordination, {
          operationDigest,
          operationDescription:
            options.consentScope === undefined
              ? hostText(ownerLocale(runtime)).approvals.installCard(entry.displayName, entry.version, entry.riskTier)
              : hostText(ownerLocale(runtime)).approvals.devSessionCard(entry.displayName, entry.version, entry.riskTier),
          effectCategory: "local-write",
          ttlMs: INSTALL_APPROVAL_TTL_MS,
        });
        recordInstallApprovalEvent(deps, {
          approvalId: created.approvalId,
          packageId: entry.packageId,
          version: entry.version,
          digest: entry.digest,
          ...(localDigest === undefined ? {} : { localDigest }),
          ...(options.consentScope === undefined ? {} : { consentScope: options.consentScope }),
          ...(origin === undefined ? {} : { sourceId: origin.id }),
          result: "asked",
        });
        return created.approvalId;
      });
    // 202 rather than an error: nothing failed, and the approval is the next step rather than a refusal.
    return { kind: "approval-required", message: decision.reason, approvalId };
  }

  /*
   * A git or npm source is fetched here, to a node-owned cache directory, before anything else touches it — and,
   * per M4, before the effect is recorded as executed. Fetching can fail (a dead remote, a digest mismatch, a
   * refused url) for reasons that have nothing to do with this node's own decision to install, and an audit trail
   * that already says "executed" for a fetch that never produced bytes would be false. What "autonomy without a
   * record" (below) actually guards is the effect this node *performed*, not merely attempted.
   *
   * `resolvePackageSource` (inside `installFromEntry`) only ever compares against the digest the *directory*
   * published — a claim the publisher made, not bytes this node looked at. Fetching now and re-pointing the
   * entry at the cache directory means the digest that reaches the install plan is computed over the bytes this
   * node actually holds, and a mismatch is refused here, before a plan is even proposed, rather than discovered
   * after consent.
   *
   * A local listing was already copied above, and is re-pointed at its snapshot the same way.
   */
  const fetched: RemoteFetchOutcome =
    snapshot === undefined
      ? await fetchRemoteArtifact(entry, cacheRoot)
      : { ok: true, entry: { ...entry, source: { kind: "local", path: snapshot.path } } };
  if (!fetched.ok) return { kind: "refused", status: fetched.status, code: fetched.code, message: fetched.message };
  const { entry: resolvedEntry, localDigest: fetchedLocalDigest } = fetched;
  const directoryForInstall = index.entries.map((candidate) => (candidate === entry ? resolvedEntry : candidate));

  /*
   * The manifest inside the artifact this node just fetched or copied and digested. A resolved entry is always `local`
   * by this point (git and npm sources are re-pointed at their cache path, local ones at their snapshot), so this is
   * the package's own word, read from the bytes that will run.
   */
  const fetchedPackage = resolvedEntry.source.kind === "local" ? readPackage(resolvedEntry.source.path) : undefined;
  const fetchedManifest = fetchedPackage?.manifest;
  const skippedFacets = fetchedPackage?.skippedFacets ?? [];

  /*
   * The listing's host API range was checked above; the package's own manifest says it too, and a listing written by
   * hand can say less. A package whose manifest needs a newer host than this one is refused here, before anything is
   * recorded, the same way a listing that says so is.
   */
  const manifestHostApi = (fetchedManifest as Partial<PackageManifest> | undefined)?.hostApi;
  if (manifestHostApi !== undefined && (manifestHostApi.min > HOST_API_VERSION || manifestHostApi.max < HOST_API_VERSION)) {
    return {
      kind: "refused",
      status: 400,
      code: "HOST_API_MISMATCH",
      message: `${entry.packageId}@${entry.version} was not installed: its manifest needs host API ${String(manifestHostApi.min)}–${String(manifestHostApi.max)}, this host is ${String(HOST_API_VERSION)}`,
    };
  }

  /*
   * What the person was shown is what they agree to. The listing and the install question show the entry's declared
   * reach (the origins, secrets and browser-token providers), so an artifact that declares a different one is refused
   * before anything is recorded or installed, rather than installed on a consent given for something else. A listing
   * that says nothing claims the package reaches nothing.
   *
   * The reach compared is what this node can read: a skipped facet's reach is never read, so it is never in the
   * package's side. A listing is one list for the whole package and cannot say which facet reaches what, so its side
   * cannot be narrowed the same way; a listing that counts a skipped facet's reach is refused, and the message says
   * that may be why, so the fix (update ClarkCant) is named rather than the publisher blamed.
   */
  const reachRefusal = declaredReachMismatch(entry.declaredReach, declaredReachOf({ facets: fetchedManifest?.facets ?? [] }));
  const reachMismatch =
    (reachRefusal === undefined || skippedFacets.length === 0
      ? reachRefusal
      : `${reachRefusal}. The package also declares facets of a kind this version of ClarkCant does not understand (${[...new Set(skippedFacets.map((facet) => facet.kind))].join(", ")}), whose reach this node cannot read or check; if the listing counts their reach, update ClarkCant to install this package`) ??
    // The resource profile is shown the same way (an update notice compares it before anything is fetched), so it binds too.
    declaredResourcesMismatch(entry.resources, fetchedManifest?.resources);
  if (reachMismatch !== undefined) {
    return {
      kind: "refused",
      status: 409,
      code: "DECLARED_REACH_MISMATCH",
      message: `${entry.packageId}@${entry.version} was not installed: ${reachMismatch}`,
    };
  }

  /*
   * For a listing by a path on this machine, the digest of the snapshot this install runs from. The record keeps it next
   * to the listing's digest, so what was installed can be told apart from what was published under that name, and it
   * names the bytes that run rather than what the path held at one moment.
   */
  const checkedFiles = snapshot?.digest;

  /*
   * Autonomy without a record is the one combination this node refuses, the same way `run_command` does: an effect
   * nobody approved and nobody can find afterwards is worse than a question. Recorded only once the artifact this
   * node is about to install is actually in hand (M4) — a fetch failure above returns before this line runs, and
   * is never recorded as an executed effect.
   */
  recordEffectExecution(coordination, {
    principalId,
    mode: policy.mode,
    decision,
    category: "local-write",
    operationDigest: entry.digest,
    description: `install ${entry.packageId}@${entry.version}${checkedFiles === undefined ? "" : ` files ${checkedFiles}`}`,
  });

  /*
   * Freeze the closure before anything is installed, and take the locked-build path's admission of it.
   *
   * `buildable: false` is the honest answer for the lock this route can produce, and it is stated rather than
   * left out: the route pins the artifact, its provenance and the build inputs, and a build refuses that input
   * (`LOCK_INCOMPLETE`) instead of resolving a closure itself. That refusal is the guarantee, not a gap in it.
   */
  const frozen = freezeInstallClosure({
    lockDir: join(runtime.dataDir, "locks"),
    entry,
    metadata: directoryBackedMetadata(index.entries),
    buildInputs: { platform, nodeAbi: process.versions.modules },
  });
  if (!frozen.ok) return { kind: "refused", status: frozen.status, code: frozen.code, message: frozen.message };
  const { lock, buildRefusal } = frozen.frozen;

  /*
   * What was actually requested: the fetched package's own manifest, never the HTTP request body (H2).
   *
   * `request.requestedCapabilityRefs` is a value the *caller* sent — a client asking to install a package can put
   * anything in its own request body, so treating it as "what the package requested" would let a forged request
   * body become the very set of capabilities this step grants. The manifest inside the artifact this node just
   * fetched and digest-verified (`resolvedEntry.source.path`) is the one thing here that cannot be a forgery: it
   * either produced the bytes the directory's published digest names, or the install already refused above. Only a
   * `local` entry has a manifest this node can read; a resolved entry is always `local` by this point (the fetch
   * step re-points git/npm sources at the cache path), so this is not a narrowing beyond what already had to
   * succeed. Values that do not parse as a `CapabilityRef` are dropped rather than trusted — the manifest is
   * package-authored content, not a schema-checked boundary.
   */
  const manifestRequestedCapabilities: readonly CapabilityRef[] = (fetchedManifest?.requestedCapabilities ?? [])
    .map((ref) => capabilityRefSchema.safeParse(ref))
    .filter((parsed): parsed is { success: true; data: CapabilityRef } => parsed.success)
    .map((parsed) => parsed.data);

  /*
   * The risk tier the granted-set decision is made in, computed from the package's own facet isolations rather
   * than trusted from the directory's `riskTier` claim alone (H3). `riskLaneFor` takes the strongest of a list, so
   * folding the directory's claim into that same list means the claim can only ever raise the computed tier, never
   * lower it — a directory that under-claimed a native facet as `declarative` cannot use that claim to grant
   * capabilities at a weaker risk category than the facets it actually isolates.
   */
  const computedRiskTier = riskLaneFor([
    ...entry.isolations.map((facet) => facet.isolation),
    entry.riskTier,
    // The facets the digest-verified artifact itself declares, so a listing that left a service facet out cannot
    // lower the lane its capabilities are granted in.
    ...(fetchedManifest?.facets ?? []).map((facet) => facet.isolation),
    // A facet of a kind this node does not know is never run here, but its lane still counts, so a skipped facet can
    // only raise the lane; one that names no lane this node knows counts as the strongest.
    ...skippedFacets.map(skippedFacetLane),
  ]);

  /*
   * The granted set, derived from the manifest's request rather than trusted from the request body (issue #93,
   * P1). `deriveGrantedCapabilities` asks the same execution policy this install itself was just decided against,
   * per requested capability, in the risk category the package's own strongest facet lane implies — so a
   * `declarative`/`isolated-ui` package's requests are granted by the same explicit "install X" intent that
   * authorized the install, and a `service`/`trusted-native` package's requests are only granted when the policy
   * would execute that riskier category outright. A capability the policy would ask about (M1) is surfaced back to
   * the caller as pending rather than silently dropped, and one the policy denies is surfaced as denied.
   */
  const derived = deriveGrantedCapabilities({
    requested: manifestRequestedCapabilities,
    riskTier: computedRiskTier,
    policy,
    /*
     * The install's own intent, except where the person approved this install: the question they answered named the
     * package and (for a dev session's scope) the capabilities it requests, so their answer is their request.
     */
    intent: approved === undefined ? (options.intent ?? { kind: "interactive" }) : { kind: "interactive" },
    artifactDigest: operationDigest,
  });

  /*
   * A capability the policy would ask about goes through the same approval path an install itself takes when the
   * policy is `ask` (M1): a real `requestApproval` record, not a value quietly folded out of the response. The
   * install still proceeds without it — the package activates with the narrower granted set — and the caller can
   * see, and later approve, exactly what is still pending.
   */
  /*
   * A dev session's generations share one consent scope, so a capability the person granted for that scope is granted
   * to every generation of it rather than asked again on each save. Only an approval that was granted: one still
   * pending is reused below, and one denied stays a question for the next generation, as it is for any install.
   */
  const scope = options.consentScope;
  const grantedForScope =
    scope === undefined || derived.needsApproval.length === 0
      ? new Set<string>()
      : new Set(
          allRows<{ operation_digest: string }>(
            runtime.db,
            "SELECT operation_digest FROM approvals WHERE task_id IS NULL AND decision = 'granted' AND substr(operation_digest, 1, ?) = ?",
            scope.length + 1,
            `${scope}:`,
          ).map((row) => row.operation_digest.slice(scope.length + 1)),
        );
  const grant = {
    granted: [...derived.granted, ...derived.needsApproval.filter((ref) => grantedForScope.has(ref))],
    needsApproval: derived.needsApproval.filter((ref) => !grantedForScope.has(ref)),
    denied: derived.denied,
  };
  const pendingCapabilities = grant.needsApproval.map((ref) => {
    const capabilityDigest = `${operationDigest}:${ref}`;
    /*
     * A reinstall of the same digest asks the same question every time unless this reuses what is already
     * pending: without this, calling install twice while a capability approval sits unanswered would pile up a
     * second `approvals` row nobody asked for, and the caller would not know which one still matters. Reusing the
     * row for the same digest (this package's digest, or its dev consent scope, plus this capability ref) means "install this
     * again" and "still waiting on the same grant" read as the one thing they are.
     */
    const existing = runtime.db
      .prepare("SELECT approval_id FROM approvals WHERE operation_digest = ? AND decision = 'pending'")
      .get(capabilityDigest) as { approval_id: string } | undefined;
    return {
      ref,
      approvalId:
        existing?.approval_id ??
        requestApproval(coordination, {
          operationDigest: capabilityDigest,
          operationDescription: hostText(ownerLocale(runtime)).approvals.grantCard(ref, entry.displayName, entry.version),
          effectCategory: effectCategoryForLane(computedRiskTier),
          ttlMs: INSTALL_APPROVAL_TTL_MS,
        }).approvalId,
    };
  });

  // A package installed while none was: whatever pairs an earlier one left are not a decision about this one.
  const fresh = activeGeneration(coordination, entry.packageId, runtime.identity.nodeId) === undefined;
  const outcome = installFromEntry(coordination, {
    entry: resolvedEntry,
    directory: directoryForInstall,
    platform,
    ownerPrincipalId: principalId,
    codeGeneration: conductor.newId("codegen"),
    expiresAt: instantSchema.parse(new Date(Date.now() + INSTALL_APPROVAL_TTL_MS).toISOString()),
    // The frozen closure, bound into the plan and the generation the install activates — the one read back from
    // the lock directory, so what the plan names is what a build would read.
    ...(lock === undefined ? {} : { dependencyLock: lockBindingForPlan(lock) }),
    ...(fetchedLocalDigest !== undefined
      ? { localDigest: fetchedLocalDigest }
      : request.localDigest !== undefined
        ? { localDigest: request.localDigest }
        : /*
           * A local listing whose files were checked above: against the content an approval pinned, or digested by the
           * node itself for a direct install. The plan and the generation carry the listing's digest - the one the person
           * was shown - as a local install that sends it does, so everything that finds a package by its listing finds
           * this one.
           */
          entry.source.kind === "local"
          ? { localDigest: entry.digest }
          : {}),
    ...(request.requestedCapabilityRefs === undefined
      ? {}
      : { requestedCapabilityRefs: request.requestedCapabilityRefs }),
    grantedCapabilities: grant.granted,
    // Kept on the generation, so uninstalling can still reach these widgets' instances once the files are gone.
    ...(resolvedEntry.source.kind === "local" ? { widgetIds: declaredWidgetIds(resolvedEntry.source.path) } : {}),
    // Recorded on the generation, so every later read of this package finds the snapshot rather than the path.
    ...(snapshot === undefined ? {} : { snapshotDigest: snapshot.digest }),
    // What it left out, so those facets stay inert for this generation even on a host that understands them later.
    ...(skippedFacets.length === 0 ? {} : { skippedFacets: recordSkippedFacets(skippedFacets) }),
    // Where it came from, so its updates are taken from that source only. A long index path keeps its end, the file name.
    ...(origin === undefined
      ? {}
      : { directorySource: { id: origin.id, kind: origin.kind, label: origin.label.slice(-DIRECTORY_SOURCE_LABEL_MAX) } }),
  });

  if (!outcome.ok) return { kind: "refused", status: 400, code: outcome.code, message: outcome.message };
  deps.packagesChanged?.();
  // New code is running: tokens its frames were given under the code it replaced, and the declaration that allowed
  // them, end with it. A first install has none, and joining an install already made changes no code.
  if (!outcome.joinedExisting) deps.packageCodeEnded?.(entry.packageId);
  // Last, and never failing the install: a fresh package's instructions start off, whatever an earlier one left.
  if (fresh) forgetPackageInstructionsQuietly({ db: runtime.db, now: nowInstant }, { principalId, packageId: entry.packageId, source: "agent" });
  return {
    kind: "installed",
    packageId: entry.packageId,
    version: entry.version,
    generationId: outcome.generationId,
    state: outcome.state,
    lock: lock === undefined
      ? null
      : {
          ref: lock.lockRef,
          digest: lock.lockDigest,
          coverage: lock.coverage,
          buildable: buildRefusal === undefined,
          ...(buildRefusal === undefined ? {} : { buildRefusal: buildRefusal.message }),
        },
    pendingCapabilities,
    deniedCapabilities: grant.denied,
  };
}

/* ------------------------------------------------------------------ *
 * The record of an install the policy asked about
 * ------------------------------------------------------------------ */

/** The event stream an install approval's question and every outcome of it are written to. */
export const INSTALL_APPROVAL_STREAM = "package.install-approval";

/**
 * What happened to one install approval: the question itself (`asked`), the person's answer (`installed` once the
 * approved install ran, `denied`), a deadline nobody met (`expired`), an approval that could not be carried out
 * (`refused`: the listing changed, the policy now forbids it, the approval was already decided) or an install that
 * was approved and then failed (`failed`).
 */
export type InstallApprovalResult = "asked" | "installed" | "denied" | "expired" | "refused" | "failed";

export interface InstallApprovalEvent {
  approvalId: string;
  packageId: string;
  version: string;
  /** The directory entry's artifact digest the question was asked about. */
  digest: string;
  /** For a listing by a path on this machine: the content digest of its files when the question was asked. */
  localDigest?: string;
  /**
   * For a widget dev session's generation: the consent scope the question was asked about (`devConsentScopeOf`), which
   * is then what the approval names instead of the artifact digest.
   */
  consentScope?: string;
  /** The id of the directory source that owned the listing when the question was asked. */
  sourceId?: string;
  result: InstallApprovalResult;
  code?: string;
  generationId?: string;
}

/**
 * Append one install-approval record to the node's event log. Throws when the write fails: the `asked` record is
 * written inside the transaction that creates the approval, and must fail that transaction rather than leave a
 * question nobody can name. An outcome's audit goes through `auditInstallApproval`, which does not throw.
 */
export function recordInstallApprovalEvent(
  deps: Pick<PackageInstallDeps, "runtime" | "conductor">,
  event: InstallApprovalEvent,
): void {
  appendEvent(deps.runtime.db, {
    eventId: deps.conductor.newId("evt"),
    kind: INSTALL_APPROVAL_STREAM,
    stream: INSTALL_APPROVAL_STREAM,
    nodeId: deps.runtime.identity.nodeId,
    document: event,
    occurredAt: nowInstant(),
  });
}

/** An outcome's audit record. A failed write is reported and does not undo the outcome it describes. */
export function auditInstallApproval(
  deps: Pick<PackageInstallDeps, "runtime" | "conductor">,
  event: InstallApprovalEvent,
): void {
  try {
    recordInstallApprovalEvent(deps, event);
  } catch (cause) {
    process.stderr.write(
      `packages: could not record the ${event.result} install approval ${event.approvalId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

/**
 * The package, version and artifact an install approval asked about, from its `asked` record on this node. Undefined
 * for any other approval: a command's, a task's or a capability's has no such record, so this is also how an install
 * approval is told apart from the rest of the `approvals` table.
 */
export function findInstallApprovalRequest(
  db: Database,
  nodeId: string,
  approvalId: string,
): {
  packageId: string;
  version: string;
  digest: string;
  localDigest?: string;
  consentScope?: string;
  sourceId?: string;
} | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM events
      WHERE source_node_id = ? AND stream = ? AND json_extract(document, '$.approvalId') = ?
        AND json_extract(document, '$.result') = 'asked'
      LIMIT 1`,
    nodeId,
    INSTALL_APPROVAL_STREAM,
    approvalId,
  );
  if (row === undefined) return undefined;
  const event = parseJson<InstallApprovalEvent>(row.document, "events.document");
  return {
    packageId: event.packageId,
    version: event.version,
    digest: event.digest,
    ...(event.localDigest === undefined ? {} : { localDigest: event.localDigest }),
    ...(event.consentScope === undefined ? {} : { consentScope: event.consentScope }),
    ...(typeof event.sourceId === "string" ? { sourceId: event.sourceId } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Resolving a pending capability approval (N1)
 * ------------------------------------------------------------------ */

/**
 * The install seam's own `operationDigest` for a pending capability, built and consumed only here:
 * `${entry.digest}:${ref}`. `entry.digest` is always `sha256:<hex>` (`digestOfDirectory`,
 * `package-fetch.ts`), which never itself contains a third `:`, and `capabilityRefSchema` refuses a
 * `:` in a ref — so splitting on the first two `:` is unambiguous rather than a guess.
 */
function parseCapabilityOperationDigest(operationDigest: string): { digest: string; ref: CapabilityRef } | undefined {
  // A dev session's consent scope carries one more segment in front (`widget-dev-scope:sha256:<hex>`).
  const start = isDevConsentScope(operationDigest) ? operationDigest.indexOf(":") + 1 : 0;
  const firstColon = operationDigest.indexOf(":", start);
  const secondColon = operationDigest.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) return undefined;
  const digest = operationDigest.slice(0, secondColon);
  const ref = capabilityRefSchema.safeParse(operationDigest.slice(secondColon + 1));
  return ref.success ? { digest, ref: ref.data } : undefined;
}

export type CapabilityApprovalDecisionOutcome =
  | {
      ok: true;
      decision: "granted" | "denied";
      ref: CapabilityRef;
      /** The generation the capability was granted to, when one was found for this digest on this node. */
      generationId?: string;
      /** True when this decision was already recorded — the same decision replayed rather than applied twice. */
      alreadyDecided: boolean;
    }
  | {
      ok: false;
      status: number;
      code:
        | "APPROVAL_EXPIRED"
        | "APPROVAL_FORGED"
        | "APPROVAL_ALREADY_DECIDED"
        | "NOT_HOME_AUTHORITY"
        | "NOT_A_CAPABILITY_APPROVAL"
        | "NO_GENERATION_FOR_APPROVAL";
      message: string;
    };

/**
 * Resolve a pending install-capability approval: `POST /packages/approvals/:id/decision`.
 *
 * Node-scoped, not conversation-scoped — this approval has no `taskId`, because it was never a step in a
 * dispatched task; it is the install route's own record of a capability the policy asked about (M1/N1). It
 * reuses `decideApproval` (the same decide/expected-revision semantics `/conversations/:id/approvals/:id/decide`
 * uses) rather than a second decision routine, and adds only what a capability approval needs beyond a plain
 * one: on grant, the capability is added to the generation that requested it, persisted, and audited; on deny,
 * the approval record itself (already `denied`) is the whole answer, since nothing runs for a capability nobody
 * granted.
 *
 * Idempotent on a repeated submission of the *same* decision: `decideApproval` refuses a second decide with
 * `APPROVAL_ALREADY_DECIDED`, and a caller retrying the exact call it already made (a network retry, a double
 * click) is not the "someone is trying to flip an already-decided approval" case that refusal exists for. This
 * checks the stored decision first and returns the same success rather than an error when it already matches.
 */
export function decideInstallCapabilityApproval(
  deps: PackageInstallDeps,
  input: {
    approvalId: string;
    decision: "granted" | "denied";
    decidingPrincipal: Principal;
    /** The digest the approver actually saw, so an approved capability cannot be swapped (same rule as any approval). */
    seenOperationDigest: string;
  },
): CapabilityApprovalDecisionOutcome {
  const { runtime, conductor } = deps;
  const coordination = { db: runtime.db, nodeId: runtime.identity.nodeId, now: () => nowInstant(), newId: conductor.newId };

  /*
   * R1: the approval's own kind is checked *before* `decideApproval` ever runs, not after. This route reuses
   * `decideApproval` for its decide/expected-revision/dedup semantics, but it is not the only thing that creates
   * a row in the `approvals` table — a dispatched task's own effect approval (`task_id` set) and this install
   * seam's own capability approval (`operation_digest` shaped `${digest}:${ref}`, `task_id` null) share the same
   * table and the same decide path. Deciding first and inspecting the shape *afterward* (the previous ordering)
   * meant a caller who supplied any other approval's id — a `run_command` approval from an unrelated
   * conversation, say — still flipped it to granted/denied for real, and only then got told the digest "did not
   * name a package capability": the state change had already happened, and the conversation route that owns that
   * approval never runs to act on it, so the underlying request it belonged to is now silently stuck. Nothing
   * below this point may commit a decision for an approval that does not pass this check.
   */
  const preflightRow = oneRow<{ task_id: string | null; operation_digest: string }>(
    runtime.db,
    "SELECT task_id, operation_digest FROM approvals WHERE approval_id = ?",
    input.approvalId,
  );
  if (preflightRow === undefined) {
    return { ok: false as const, status: 404, code: "APPROVAL_FORGED" as const, message: "approval does not exist" };
  }
  if (preflightRow.task_id !== null && preflightRow.task_id !== undefined) {
    return {
      ok: false as const,
      status: 409,
      code: "NOT_A_CAPABILITY_APPROVAL" as const,
      message: "this approval belongs to a dispatched task, not an install-capability grant; decide it through the conversation's own approval route",
    };
  }
  if (parseCapabilityOperationDigest(preflightRow.operation_digest) === undefined) {
    return {
      ok: false as const,
      status: 409,
      code: "NOT_A_CAPABILITY_APPROVAL" as const,
      message: "this approval does not name a package capability",
    };
  }

  /*
   * Read (and, on a first-ever read, lazily migrate) the execution policy *before* opening the outer transaction
   * below. `readExecutionPolicy` can itself write and open its own `transaction()` the first time it runs
   * (`migrateExecutionPolicy`) — nested transactions are refused outright (SQLite would implicitly commit the
   * outer one), so this has to happen outside the boundary R2 introduces, not inside it. It is read-mostly and
   * has nothing to do with the decision/grant atomicity this function is otherwise responsible for.
   */
  const policy = readExecutionPolicy({ db: runtime.db, now: () => nowInstant() }, runtime.identity.ownerPrincipalId);

  /*
   * R2: the decision and the grant it authorizes land in one transaction. `decideApprovalWithinTransaction` is
   * `decideApproval`'s own body without its own `BEGIN`/`COMMIT` (see coordination.ts), composed here inside a
   * single outer `transaction()` alongside the grant write and its audit record — so a crash between "decided"
   * and "granted" cannot happen: either both commit, or neither does, and a caller retrying after such a crash
   * finds the approval still `pending` rather than a `granted` approval with a missing capability.
   */
  return transaction(runtime.db, () => {
    const decided = decideApprovalWithinTransaction(coordination, {
      approvalId: input.approvalId,
      decision: input.decision,
      decidingPrincipal: input.decidingPrincipal,
      seenOperationDigest: input.seenOperationDigest,
    });

    if (!decided.ok) {
      if (decided.code === "APPROVAL_ALREADY_DECIDED") {
        const row = oneRow<{ decision: string; operation_digest: string; effect_category: string }>(
          runtime.db,
          "SELECT decision, operation_digest, effect_category FROM approvals WHERE approval_id = ?",
          input.approvalId,
        );
        if (row !== undefined && row.decision === input.decision && row.operation_digest === input.seenOperationDigest) {
          const parsed = parseCapabilityOperationDigest(row.operation_digest);
          if (parsed === undefined) {
            return {
              ok: false as const,
              status: 409,
              code: "NOT_A_CAPABILITY_APPROVAL" as const,
              message: "this approval does not name a package capability",
            };
          }
          // R2 replay: a client retrying the same already-decided submission (a network retry, a double click,
          // or a genuine retry after the process crashed between the decision and the grant last time) must not
          // get a silent no-op. If the grant is missing from the generation it belongs to, apply it now — this
          // branch is what makes a partial-failure retry actually converge rather than reporting false success.
          const generation = generationForApprovalDigest(runtime, parsed.digest);
          if (row.decision === "granted" && generation !== undefined) {
            applyCapabilityGrant(
              deps,
              coordination,
              input,
              generation,
              parsed.ref,
              row.operation_digest,
              row.effect_category as EffectCategory,
              policy.mode,
            );
          }
          return {
            ok: true as const,
            decision: input.decision,
            ref: parsed.ref,
            ...(generation === undefined ? {} : { generationId: generation.generationId }),
            alreadyDecided: true,
          };
        }
      }
      return { ok: false as const, status: 409, code: decided.code, message: decided.message };
    }

    const parsed = parseCapabilityOperationDigest(decided.approval.operationDigest);
    if (parsed === undefined) {
      return {
        ok: false as const,
        status: 409,
        code: "NOT_A_CAPABILITY_APPROVAL" as const,
        message: "this approval does not name a package capability",
      };
    }

    const generation = generationForApprovalDigest(runtime, parsed.digest);
    if (input.decision === "granted" && generation === undefined) {
      // R2: no active, unsuperseded generation carries this digest (it was superseded by a newer install before
      // the approval was decided, or never activated). There is nowhere to persist the grant, so this is a named
      // refusal, not the false `ok: true` the previous code returned with no `generationId` to show for it.
      return {
        ok: false as const,
        status: 409,
        code: "NO_GENERATION_FOR_APPROVAL" as const,
        message: `no active generation on this node carries digest ${parsed.digest}; the capability could not be granted anywhere`,
      };
    }
    if (input.decision === "granted" && generation !== undefined) {
      applyCapabilityGrant(
        deps,
        coordination,
        input,
        generation,
        parsed.ref,
        decided.approval.operationDigest,
        decided.approval.effectCategory as EffectCategory,
        policy.mode,
      );
    }

    return {
      ok: true as const,
      decision: input.decision,
      ref: parsed.ref,
      ...(generation === undefined ? {} : { generationId: generation.generationId }),
      alreadyDecided: false,
    };
  });
}

/**
 * Add `ref` to `generation`'s granted capabilities and audit the grant, idempotently.
 *
 * R5(a): a `null` `grantedCapabilities` (migration 22's pre-N4 marker) is resolved via
 * `resolveGenerationGrantedCapabilities` *first* — pulling the generation's full manifest-requested set — rather
 * than treated as `[]`. Approving a single capability before a generation's grant has ever been lazily resolved
 * must not discard the rest of that generation's manifest-requested capabilities: once this write lands,
 * `grantedCapabilities` is no longer `null`, so the lazy-resolve path never runs again for this generation.
 */
function applyCapabilityGrant(
  deps: PackageInstallDeps,
  coordination: CoordinationDeps,
  input: { decidingPrincipal: Principal },
  generation: PackageGeneration,
  ref: CapabilityRef,
  operationDigest: string,
  effectCategory: EffectCategory,
  policyMode: Parameters<typeof recordEffectExecution>[1]["mode"],
): void {
  const { runtime } = deps;
  const currentGrants = resolveGenerationGrantedCapabilities(deps, generation);
  if (currentGrants.includes(ref)) return;

  const updated: PackageGeneration = {
    ...generation,
    grantedCapabilities: [...currentGrants, ref].sort(),
  };
  runtime.db
    .prepare("UPDATE package_generations SET document = ? WHERE generation_id = ?")
    .run(toJson(updated), updated.generationId);
  recordEffectExecution(coordination, {
    principalId: input.decidingPrincipal.principalId,
    mode: policyMode,
    decision: { kind: "execute", reason: "the user approved this capability", audit: true },
    category: effectCategory,
    operationDigest,
    description: `grant ${ref} to ${updated.packageId}@${updated.version}`,
  });
}

/** A capability a package asked for at install that the policy put to the person, still waiting for an answer. */
export interface PendingCapabilityApproval {
  approvalId: string;
  ref: CapabilityRef;
  packageId: string;
  version: string;
  /** What the decision must be sent back with: the exact operation the person is shown. */
  operationDigest: string;
  description: string;
  requestedAt: string;
  expiresAt: string;
}

/**
 * `GET /packages/approvals`: every unanswered install-capability approval that can still be answered.
 *
 * Only approvals whose package is active here: granting one for a package that was since uninstalled has nowhere
 * to land (`NO_GENERATION_FOR_APPROVAL`), and a button that can only fail is not a control. Expired ones are left
 * out for the same reason; the next install of the package asks again.
 */
export function listPendingCapabilityApprovals(
  deps: PackageInstallDeps,
  now: string = nowInstant(),
): PendingCapabilityApproval[] {
  const { runtime } = deps;
  const rows = allRows<{
    approval_id: string;
    operation_digest: string;
    operation_description: string;
    requested_at: string;
    expires_at: string;
  }>(
    runtime.db,
    `SELECT approval_id, operation_digest, operation_description, requested_at, expires_at FROM approvals
      WHERE task_id IS NULL AND decision = 'pending' AND expires_at > ?
      ORDER BY requested_at, approval_id`,
    now,
  );
  return rows.flatMap((row) => {
    const parsed = parseCapabilityOperationDigest(row.operation_digest);
    if (parsed === undefined) return [];
    const generation = generationForApprovalDigest(runtime, parsed.digest);
    if (generation === undefined) return [];
    return [
      {
        approvalId: row.approval_id,
        ref: parsed.ref,
        packageId: generation.packageId,
        version: generation.version,
        operationDigest: row.operation_digest,
        description: row.operation_description,
        requestedAt: row.requested_at,
        expiresAt: row.expires_at,
      },
    ];
  });
}

/** The active generation on this node whose digest is the one a capability approval named. Node-scoped by construction. */
/**
 * The active generation an install-capability approval's digest names: the one carrying that artifact digest, or, for a
 * dev session's consent scope, the active generation of a listing with that scope.
 */
function generationForApprovalDigest(runtime: PackageInstallDeps["runtime"], digest: string): PackageGeneration | undefined {
  if (!isDevConsentScope(digest)) return findGenerationByDigest(runtime.db, runtime.identity.nodeId, digest);
  const index = readNodeDirectory(runtime.dataDir);
  if (index.kind !== "configured") return undefined;
  for (const entry of index.entries) {
    if (devConsentScopeOf(entry) !== digest) continue;
    const generation = findGenerationByDigest(runtime.db, runtime.identity.nodeId, entry.digest);
    if (generation !== undefined) return generation;
  }
  return undefined;
}

function findGenerationByDigest(db: Database, nodeId: string, digest: string): PackageGeneration | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM package_generations WHERE node_id = ? AND digest = ? AND superseded_at IS NULL",
    nodeId,
    digest,
  );
  return row === undefined ? undefined : parseJson<PackageGeneration>(row.document, "package_generations.document");
}

/* ------------------------------------------------------------------ *
 * Lazily resolving a legacy generation's grantedCapabilities (N4)
 * ------------------------------------------------------------------ */

/**
 * A `package_generations` row's `grantedCapabilities`, allowing the `null` marker migration 22 writes for a
 * generation that predates the field — everywhere else in this codebase that reads a generation off the raw
 * `document` column has to allow for it too, rather than trusting `PackageGeneration`'s schema type (which,
 * correctly, only describes a generation this code itself just activated).
 */
export type LegacyPackageGeneration = Omit<PackageGeneration, "grantedCapabilities"> & {
  grantedCapabilities: readonly CapabilityRef[] | null;
};

/**
 * Resolve a generation's `grantedCapabilities`, lazily backfilling the pre-N4-field case rather than trusting it
 * was already migrated to a real array.
 *
 * `null` (migration 22's marker, see its comment in `packages/storage/src/migrate.ts`) means this generation
 * activated before this field existed, back when an install granted whatever the manifest requested outright.
 * The honest resolution for that generation, read now rather than guessed at migration time, is exactly that:
 * the package's own manifest `requestedCapabilities`, filtered through `capabilityRefSchema` the same way the
 * current install path treats a manifest's own request (never trusted as authority beyond what parses). This
 * only reads a manifest this node can already reach — a local install directly, or a git/npm source already
 * fetched into this node's own cache (`resolveLocalSource`) — and resolves to `[]` without persisting when it
 * cannot, so a package this node cannot currently read is under-served rather than granted a guess.
 *
 * Resolved once: the result is written back onto the generation's own row, so a second call for the same
 * generation reads the array directly and never re-reads the manifest.
 */
export function resolveGenerationGrantedCapabilities(
  deps: PackageInstallDeps,
  generation: LegacyPackageGeneration,
): readonly CapabilityRef[] {
  if (generation.grantedCapabilities !== null) return generation.grantedCapabilities;

  const { runtime } = deps;
  const index = readNodeDirectory(runtime.dataDir);
  const entry =
    index.kind === "configured"
      ? index.entries.find(
          (candidate) => candidate.packageId === generation.packageId && candidate.version === generation.version,
        )
      : undefined;
  if (entry === undefined) return [];

  const cacheRoot = join(runtime.dataDir, "package-cache");
  const resolvedSource = resolveLocalSource(entry, cacheRoot, generation);
  if (resolvedSource.kind !== "local") return []; // Not fetched onto this node (yet); nothing to read a manifest from.

  const requested = readPackage(resolvedSource.path, { skippedAtInstall: generation.skippedFacets })
    .manifest.requestedCapabilities?.map((ref) => capabilityRefSchema.safeParse(ref))
    .filter((parsed): parsed is { success: true; data: CapabilityRef } => parsed?.success === true)
    .map((parsed) => parsed.data);
  const resolved: readonly CapabilityRef[] = requested ?? [];

  const updated: PackageGeneration = { ...generation, grantedCapabilities: [...resolved] };
  // R5(b): the `IS NULL` guard makes this write a compare-and-swap rather than a blind overwrite. Two processes
  // reading the same DB concurrently (this runtime and a CLI tool, say) can both observe the legacy `null`
  // marker and both race to resolve it; without the guard, whichever writes second clobbers any grant the other
  // applied in between (e.g. a capability approval decided between this function's read and its own write).
  runtime.db
    .prepare(
      "UPDATE package_generations SET document = ? WHERE generation_id = ? AND node_id = ? AND json_extract(document, '$.grantedCapabilities') IS NULL",
    )
    .run(toJson(updated), generation.generationId, runtime.identity.nodeId);

  return resolved;
}

/** `activeGeneration`, then resolved through `resolveGenerationGrantedCapabilities` — the one call site every
 * reader of "what is this node's active generation for this package granted" should use instead of reading
 * `.grantedCapabilities` off `activeGeneration`'s own result directly, which does not allow for the legacy
 * `null` marker. */
export function activeGenerationWithResolvedGrants(
  deps: PackageInstallDeps,
  packageId: string,
): PackageGeneration | undefined {
  const generation = activeGeneration(
    { db: deps.runtime.db, nodeId: deps.runtime.identity.nodeId, now: nowInstant, newId: deps.conductor.newId },
    packageId,
    deps.runtime.identity.nodeId,
  ) as LegacyPackageGeneration | undefined;
  if (generation === undefined) return undefined;
  return { ...generation, grantedCapabilities: [...resolveGenerationGrantedCapabilities(deps, generation)] };
}
