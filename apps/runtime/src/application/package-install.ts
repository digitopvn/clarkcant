import { join } from "node:path";

import {
  entryFitsHost,
  instantSchema,
  nowInstant,
  platformForHost,
  type CapabilityRef,
  type DirectoryEntry,
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
  artifactMatchesPlan,
  decideExecution,
  deriveGrantedCapabilities,
  directoryIndexPath,
  fetchGitArtifact,
  fetchNpmArtifact,
  installFromEntry,
  readDirectoryIndex,
  readExecutionPolicy,
  recordEffectExecution,
  requestApproval,
} from "@clarkcant/core";
import { type Database } from "@clarkcant/storage";

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

export interface PackageInstallDeps {
  runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
  conductor: { newId: (prefix: string) => string };
}

/** The install request, already parsed: the route owns reading the body. */
export interface PackageInstallRequest {
  packageId: string;
  version: string;
  /** A digest the caller computed for a local source, when it sent one. */
  localDigest?: string;
  requestedCapabilityRefs?: string[];
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
      ? fetchGitArtifact({ url: entry.source.url, ref: entry.source.ref, cacheRoot })
      : await fetchNpmArtifact({ name: entry.source.name, version: entry.source.version, cacheRoot });

  if (!fetched.ok) {
    return { ok: false, status: 400, code: fetched.code, message: fetched.message };
  }
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

export async function installPackage(
  deps: PackageInstallDeps,
  request: PackageInstallRequest,
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

  const index = readDirectoryIndex(directoryIndexPath(process.env));
  if (index.kind === "not-configured") return { kind: "refused", status: 409, code: "NO_DIRECTORY", message: index.reason };
  if (index.kind === "unreadable") {
    return { kind: "refused", status: 409, code: "DIRECTORY_UNREADABLE", message: index.reason };
  }
  const entry = index.entries.find(
    (candidate) => candidate.packageId === packageId && candidate.version === version,
  );
  if (entry === undefined) {
    return { kind: "refused", status: 404, code: "NOT_IN_DIRECTORY", message: `${packageId}@${version} is not in the directory` };
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

  const principalId = runtime.identity.ownerPrincipalId;
  // Read at the request rather than captured at boot, so a mode the user just changed applies to this install.
  const policy = readExecutionPolicy({ db: runtime.db, now: () => nowInstant() }, principalId);
  const decision = decideExecution({
    policy,
    action: { kind: "effect", category: "local-write", operationDigest: entry.digest },
    /*
     * True, unlike a command the model proposed: installing *this named package* is what the person asked for,
     * which is exactly the case Autonomous exists to run without a second question. Guarded and Ask still apply,
     * because the decision is the policy's to make, not this route's.
     */
    explicitUserIntent: true,
  });

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
    const approval = requestApproval(coordination, {
      operationDigest: entry.digest,
      operationDescription: `cài ${entry.displayName} ${entry.version} (${entry.riskTier})`,
      effectCategory: "local-write",
      ttlMs: INSTALL_APPROVAL_TTL_MS,
    });
    // 202 rather than an error: nothing failed, and the approval is the next step rather than a refusal.
    return { kind: "approval-required", message: decision.reason, approvalId: approval.approvalId };
  }

  /*
   * Autonomy without a record is the one combination this node refuses, the same way `run_command` does: an effect
   * nobody approved and nobody can find afterwards is worse than a question. Recorded before the install starts,
   * so one that hangs or dies still shows that it began.
   */
  recordEffectExecution(coordination, {
    principalId,
    mode: policy.mode,
    decision,
    category: "local-write",
    operationDigest: entry.digest,
    description: `install ${entry.packageId}@${entry.version}`,
  });

  /*
   * A git or npm source is fetched here, to a node-owned cache directory, before anything else touches it.
   *
   * `resolvePackageSource` (inside `installFromEntry`) only ever compares against the digest the *directory*
   * published — a claim the publisher made, not bytes this node looked at. Fetching now and re-pointing the
   * entry at the cache directory means the digest that reaches the install plan is computed over the bytes this
   * node actually holds, and a mismatch is refused here, before a plan is even proposed, rather than discovered
   * after consent.
   */
  const cacheRoot = join(runtime.dataDir, "package-cache");
  const fetched = await fetchRemoteArtifact(entry, cacheRoot);
  if (!fetched.ok) return { kind: "refused", status: fetched.status, code: fetched.code, message: fetched.message };
  const { entry: resolvedEntry, localDigest: fetchedLocalDigest } = fetched;
  const directoryForInstall = index.entries.map((candidate) => (candidate === entry ? resolvedEntry : candidate));

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
   * The granted set, derived from what was requested rather than trusted from the request body (issue #93, P1):
   * a client declaring its own grants would let a forged request body become authority. `deriveGrantedCapabilities`
   * asks the same execution policy this install itself was just decided against, per requested capability, in the
   * risk category the package's own strongest facet lane implies — so a `declarative`/`isolated-ui` package's
   * requests are granted by the same explicit "install X" intent that authorized the install, and a
   * `service`/`trusted-native` package's requests are only granted when the policy would execute that riskier
   * category outright. Anything the policy would ask about, or refuse, is left out of the granted set rather than
   * answered here.
   */
  const grant = deriveGrantedCapabilities({
    requested: (request.requestedCapabilityRefs ?? []) as readonly CapabilityRef[],
    riskTier: entry.riskTier,
    policy,
    explicitUserIntent: true,
    artifactDigest: entry.digest,
  });

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
      : request.localDigest === undefined
        ? {}
        : { localDigest: request.localDigest }),
    ...(request.requestedCapabilityRefs === undefined
      ? {}
      : { requestedCapabilityRefs: request.requestedCapabilityRefs }),
    grantedCapabilities: grant.granted,
  });

  if (!outcome.ok) return { kind: "refused", status: 400, code: outcome.code, message: outcome.message };
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
  };
}
