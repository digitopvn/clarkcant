import { join } from "node:path";

import { instantSchema, nowInstant, platformForHost } from "@clarkcant/contracts";
import {
  artifactRequest,
  directoryBackedMetadata,
  lockBindingForPlan,
  materializeDependencyLock,
  resolveDependencyClosure,
  writeDependencyLock,
} from "@clarkcant/capability-host";
import {
  decideExecution,
  directoryIndexPath,
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
  grantedCapabilities?: string[];
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
      /** The frozen build input, or null when the directory published no digest to freeze. */
      lock: { ref: string; digest: string; coverage: string } | null;
    };

export function installPackage(deps: PackageInstallDeps, request: PackageInstallRequest): PackageInstallOutcome {
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
   * Resolve the dependency closure **before** anything is installed.
   *
   * This node has not downloaded the artifact, so what it can resolve here is what the directory says this
   * package is: its exact version, the digest the publisher published, and which kind of source it came from.
   * The package's own dependency tree is not readable from here, and the lock says so rather than implying it
   * was pinned (`artifact-only`). A build refuses a lock that does not cover the tree, for exactly that reason.
   *
   * A resolution that fails stops the install rather than letting a later step resolve it again: "we could not
   * say what this would install" is not a state to proceed from.
   */
  const metadata = directoryBackedMetadata(index.entries);
  const resolution =
    entry.digest.trim() === ""
      ? undefined
      : resolveDependencyClosure({ requests: [artifactRequest(entry)], metadata });
  if (resolution !== undefined && !resolution.ok) {
    return { kind: "refused", status: 400, code: "DEPENDENCY_UNRESOLVED", message: resolution.message };
  }

  /*
   * An entry that publishes no digest is refused by the installer with its own reason, and there is nothing to
   * freeze for it: a lock whose integrity is blank would name bytes nobody can check.
   */
  const lock = resolution === undefined || !resolution.ok
    ? undefined
    : materializeDependencyLock({
        packageId: entry.packageId,
        version: entry.version,
        coverage: "artifact-only",
        resolved: resolution.resolved,
        buildInputs: { platform, nodeAbi: process.versions.modules },
      });
  if (lock !== undefined) {
    /*
     * Kept next to the plans it will be consented with, under a reference that is its own digest, so a later
     * resolution can never replace the bytes a consented plan names.
     */
    const stored = writeDependencyLock({ dir: join(runtime.dataDir, "locks"), lock });
    if (!stored.ok) return { kind: "refused", status: 409, code: stored.code, message: stored.message };
  }

  const outcome = installFromEntry(coordination, {
    entry,
    directory: index.entries,
    platform,
    ownerPrincipalId: principalId,
    codeGeneration: conductor.newId("codegen"),
    expiresAt: instantSchema.parse(new Date(Date.now() + INSTALL_APPROVAL_TTL_MS).toISOString()),
    // The frozen closure, bound into the plan and the generation the install activates.
    ...(lock === undefined ? {} : { dependencyLock: lockBindingForPlan(lock) }),
    ...(request.localDigest === undefined ? {} : { localDigest: request.localDigest }),
    ...(request.requestedCapabilityRefs === undefined
      ? {}
      : { requestedCapabilityRefs: request.requestedCapabilityRefs }),
    ...(request.grantedCapabilities === undefined ? {} : { grantedCapabilities: request.grantedCapabilities }),
  });

  if (!outcome.ok) return { kind: "refused", status: 400, code: outcome.code, message: outcome.message };
  return {
    kind: "installed",
    packageId: entry.packageId,
    version: entry.version,
    generationId: outcome.generationId,
    state: outcome.state,
    lock: lock === undefined ? null : { ref: lock.lockRef, digest: lock.lockDigest, coverage: lock.coverage },
  };
}
