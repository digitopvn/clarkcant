import { join } from "node:path";

import {
  capabilityRefSchema,
  entryFitsHost,
  instantSchema,
  nowInstant,
  platformForHost,
  riskLaneFor,
  type CapabilityRef,
  type DirectoryEntry,
  type EffectCategory,
  type PackageGeneration,
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
  activeGeneration,
  artifactMatchesPlan,
  decideApprovalWithinTransaction,
  decideExecution,
  deriveGrantedCapabilities,
  directoryIndexPath,
  effectCategoryForLane,
  fetchGitArtifact,
  fetchNpmArtifact,
  installFromEntry,
  readDirectoryIndex,
  readExecutionPolicy,
  readPackage,
  recordEffectExecution,
  requestApproval,
  resolveLocalSource,
  type CoordinationDeps,
} from "@clarkcant/core";
import { type Database, allRows, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

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
   */
  const cacheRoot = join(runtime.dataDir, "package-cache");
  const fetched = await fetchRemoteArtifact(entry, cacheRoot);
  if (!fetched.ok) return { kind: "refused", status: fetched.status, code: fetched.code, message: fetched.message };
  const { entry: resolvedEntry, localDigest: fetchedLocalDigest } = fetched;
  const directoryForInstall = index.entries.map((candidate) => (candidate === entry ? resolvedEntry : candidate));

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
    description: `install ${entry.packageId}@${entry.version}`,
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
  const manifestRequestedCapabilities: readonly CapabilityRef[] =
    resolvedEntry.source.kind === "local"
      ? (readPackage(resolvedEntry.source.path).manifest.requestedCapabilities ?? [])
          .map((ref) => capabilityRefSchema.safeParse(ref))
          .filter((parsed): parsed is { success: true; data: CapabilityRef } => parsed.success)
          .map((parsed) => parsed.data)
      : [];

  /*
   * The risk tier the granted-set decision is made in, computed from the package's own facet isolations rather
   * than trusted from the directory's `riskTier` claim alone (H3). `riskLaneFor` takes the strongest of a list, so
   * folding the directory's claim into that same list means the claim can only ever raise the computed tier, never
   * lower it — a directory that under-claimed a native facet as `declarative` cannot use that claim to grant
   * capabilities at a weaker risk category than the facets it actually isolates.
   */
  const computedRiskTier = riskLaneFor([...entry.isolations.map((facet) => facet.isolation), entry.riskTier]);

  /*
   * The granted set, derived from the manifest's request rather than trusted from the request body (issue #93,
   * P1). `deriveGrantedCapabilities` asks the same execution policy this install itself was just decided against,
   * per requested capability, in the risk category the package's own strongest facet lane implies — so a
   * `declarative`/`isolated-ui` package's requests are granted by the same explicit "install X" intent that
   * authorized the install, and a `service`/`trusted-native` package's requests are only granted when the policy
   * would execute that riskier category outright. A capability the policy would ask about (M1) is surfaced back to
   * the caller as pending rather than silently dropped, and one the policy denies is surfaced as denied.
   */
  const grant = deriveGrantedCapabilities({
    requested: manifestRequestedCapabilities,
    riskTier: computedRiskTier,
    policy,
    explicitUserIntent: true,
    artifactDigest: entry.digest,
  });

  /*
   * A capability the policy would ask about goes through the same approval path an install itself takes when the
   * policy is `ask` (M1): a real `requestApproval` record, not a value quietly folded out of the response. The
   * install still proceeds without it — the package activates with the narrower granted set — and the caller can
   * see, and later approve, exactly what is still pending.
   */
  const pendingCapabilities = grant.needsApproval.map((ref) => {
    const operationDigest = `${entry.digest}:${ref}`;
    /*
     * A reinstall of the same digest asks the same question every time unless this reuses what is already
     * pending: without this, calling install twice while a capability approval sits unanswered would pile up a
     * second `approvals` row nobody asked for, and the caller would not know which one still matters. Reusing the
     * row for the same `operationDigest` (this package's digest plus this capability ref) means "install this
     * again" and "still waiting on the same grant" read as the one thing they are.
     */
    const existing = runtime.db
      .prepare("SELECT approval_id FROM approvals WHERE operation_digest = ? AND decision = 'pending'")
      .get(operationDigest) as { approval_id: string } | undefined;
    return {
      ref,
      approvalId:
        existing?.approval_id ??
        requestApproval(coordination, {
          operationDigest,
          operationDescription: `cấp quyền ${ref} cho ${entry.displayName} ${entry.version}`,
          effectCategory: effectCategoryForLane(computedRiskTier),
          ttlMs: INSTALL_APPROVAL_TTL_MS,
        }).approvalId,
    };
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
    pendingCapabilities,
    deniedCapabilities: grant.denied,
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
  const firstColon = operationDigest.indexOf(":");
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
          const generation = findGenerationByDigest(runtime.db, runtime.identity.nodeId, parsed.digest);
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

    const generation = findGenerationByDigest(runtime.db, runtime.identity.nodeId, parsed.digest);
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
    const generation = findGenerationByDigest(runtime.db, runtime.identity.nodeId, parsed.digest);
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
  const index = readDirectoryIndex(directoryIndexPath(process.env));
  const entry =
    index.kind === "configured"
      ? index.entries.find(
          (candidate) => candidate.packageId === generation.packageId && candidate.version === generation.version,
        )
      : undefined;
  if (entry === undefined) return [];

  const cacheRoot = join(runtime.dataDir, "package-cache");
  const resolvedSource = resolveLocalSource(entry, cacheRoot);
  if (resolvedSource.kind !== "local") return []; // Not fetched onto this node (yet); nothing to read a manifest from.

  const requested = readPackage(resolvedSource.path)
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
