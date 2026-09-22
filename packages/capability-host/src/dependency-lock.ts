import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  dependencyDrift,
  dependencyLockCoverageSchema,
  pinnedArtifactSchema,
  type DependencyLockBinding,
  type DependencyLockCoverage,
  type DependencyProvenance,
  type DirectoryEntry,
  type PackageSource,
  type PinnedArtifact,
} from "@clarkcant/contracts";
import { asJsonValue, payloadDigest, type JsonValue } from "@clarkcant/storage";
import { z } from "zod";

/**
 * The dependency lock: what a build is allowed to see.
 *
 * A package manager resolves a range to whatever is current when it looks, which means two builds of the same
 * package one day apart can run different code while the plan, the consent and the digest all still name the same
 * artifact. This module removes that gap:
 *
 * 1. **Resolve metadata first.** `resolveDependencyClosure` turns what a package declared — `^1.2.0`, `latest`, a
 *    git ref, a path — into exact versions and integrities, before any executable step runs. A resolution that
 *    cannot be pinned fails the install; it does not fall back to "whatever the package manager finds".
 * 2. **Materialise one immutable artifact.** The pins, the declared load-time scripts and the build inputs are
 *    hashed with the same canonical digest the rest of the repository uses, so the same inputs always produce the
 *    same digest and any changed pin produces a different one.
 * 3. **Refuse drift rather than re-resolve.** A build handed a closure that no longer matches the consented digest
 *    stops and names the dependency that moved. Quietly continuing with the new resolution is the behaviour this
 *    exists to prevent.
 *
 * Two limits are deliberate and stated where they matter. A lock proves **reproducibility, not safety**: an exact
 * version with a matching integrity is still third-party code, and nothing here inspects what that code does. And a
 * lock only covers what was resolved: `coverage` says whether the package's own dependency tree was readable where
 * the lock was written, and a build refuses a lock that does not cover the tree it is about to build.
 *
 * The resolved provenance is kept because the three sources are not the same claim: `npm:<name>@<version>` names a
 * registry artifact, `git:<url>#<ref>` names a revision in somebody's repository, and `local:<path>` names bytes on
 * this machine. Flattening them into a version number would make a checkout and a tarball look alike.
 */

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export interface DependencyRequest {
  name: string;
  /** What the package wrote: a range, a dist-tag, a git ref or a path. A range here is expected — that is the point. */
  spec: string;
  /** Where to look. The resolved pin records where it actually came from, which may differ (a workspace override). */
  provenance: DependencyProvenance;
}

export interface DependencyMetadata {
  version: string;
  integrity: string;
  /** `npm:<name>@<version>` | `git:<url>#<ref>` | `local:<path>`. */
  resolvedFrom: string;
}

/**
 * What this node can learn about a request without holding the artifact.
 *
 * Injected rather than fetched here, so the resolver has one behaviour (pin what the metadata says) and no test
 * needs a registry to exercise it. An implementation that has no answer returns `undefined`, which fails closed.
 */
export interface DependencyMetadataSource {
  resolve(request: DependencyRequest): DependencyMetadata | undefined;
}

export type DependencyResolutionRefusal =
  | "NO_METADATA"
  | "VERSION_NOT_EXACT"
  | "INCOMPLETE_PIN"
  | "CONFLICTING_RESOLUTION";

export type DependencyResolution =
  | { ok: true; resolved: PinnedArtifact[] }
  | { ok: false; code: DependencyResolutionRefusal; message: string };

/**
 * Resolve every request to an exact artifact, or refuse the whole closure.
 *
 * All-or-nothing on purpose: a closure with one unresolved entry is not a partial lock, it is an unknown build
 * input, and letting the rest through would mean the build runs against a tree nobody pinned.
 */
export function resolveDependencyClosure(input: {
  requests: readonly DependencyRequest[];
  metadata: DependencyMetadataSource;
}): DependencyResolution {
  const byName = new Map<string, PinnedArtifact>();

  for (const request of input.requests) {
    const metadata = input.metadata.resolve(request);
    if (metadata === undefined) {
      return {
        ok: false,
        code: "NO_METADATA",
        message: `no ${request.provenance} metadata for "${request.name}" (${request.spec}), so the closure cannot be pinned`,
      };
    }

    const pin = pinnedArtifactSchema.safeParse({
      name: request.name,
      version: metadata.version,
      integrity: metadata.integrity,
      resolvedFrom: metadata.resolvedFrom,
    });
    if (!pin.success) {
      const versionLooksFloating = !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version);
      return {
        ok: false,
        code: versionLooksFloating ? "VERSION_NOT_EXACT" : "INCOMPLETE_PIN",
        message: versionLooksFloating
          ? `"${request.name}" resolved to "${metadata.version}", which is not one version; a lock has to name the exact artifact`
          : `"${request.name}" resolved without the version, integrity and provenance a pin needs`,
      };
    }

    const existing = byName.get(request.name);
    if (
      existing !== undefined &&
      (existing.version !== pin.data.version || existing.integrity !== pin.data.integrity)
    ) {
      // One version per name, or the lock does not say which artifact a build gets.
      return {
        ok: false,
        code: "CONFLICTING_RESOLUTION",
        message: `"${request.name}" resolved twice, to ${existing.version} (${existing.integrity}) and ${pin.data.version} (${pin.data.integrity})`,
      };
    }
    byName.set(request.name, pin.data);
  }

  return { ok: true, resolved: [...byName.values()].sort(comparePins) };
}

/** Where the resolved bytes of one source come from, in the vocabulary of that source. */
export function provenanceRef(source: PackageSource, version: string): string {
  if (source.kind === "npm") return `npm:${source.name}@${version}`;
  if (source.kind === "git") return `git:${source.url}#${source.ref}`;
  return `local:${source.path}`;
}

/** The package itself, as the request a closure resolves first. */
export function artifactRequest(entry: DirectoryEntry): DependencyRequest {
  const source = entry.source;
  const spec =
    source.kind === "npm"
      ? `${source.name}@${source.version}`
      : source.kind === "git"
        ? `${source.url}#${source.ref}`
        : source.path;
  return { name: entry.packageId, spec, provenance: source.kind };
}

/**
 * Metadata from a directory listing.
 *
 * The only catalog this node has for a package it has not downloaded, which is exactly what makes it the honest
 * answer here: a dependency resolves to the version and digest the directory publishes, and a name the directory
 * does not list has no metadata at all rather than a plausible-looking guess.
 */
export function directoryBackedMetadata(entries: readonly DirectoryEntry[]): DependencyMetadataSource {
  return {
    resolve: (request) => {
      const entry = entries.find((candidate) => candidate.packageId === request.name);
      if (entry === undefined) return undefined;
      return {
        version: entry.version,
        integrity: entry.digest,
        resolvedFrom: provenanceRef(entry.source, entry.version),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The lock artifact
 * ------------------------------------------------------------------ */

export interface BuildInputs {
  /** Target platform the artifact is built for. */
  platform: string;
  /** Node ABI the artifact is built against; a different one can produce a different binary from the same pins. */
  nodeAbi: string;
}

export interface DependencyLock {
  /** Where this artifact lives under the node's lock directory. */
  lockRef: string;
  /** Canonical digest over everything below. */
  lockDigest: string;
  packageId: string;
  version: string;
  coverage: DependencyLockCoverage;
  /** The pinned artifacts, sorted by name. */
  dependencies: PinnedArtifact[];
  /** Load-time scripts the artifact declares, sorted. Part of the digest: adding one changes the build input. */
  lifecycleScripts: string[];
  buildInputs: BuildInputs;
}

const LOCK_FILE_SUFFIX = ".lock.json";

/**
 * The name a lock artifact is kept under.
 *
 * Closed to `[A-Za-z0-9_-]` on purpose: a package id travels in from a publisher, and a reference built from it must
 * not be able to name a path outside the lock directory. Two ids that sanitise to the same name are not a silent
 * collision either — the digest inside the artifact is what a reader checks.
 */
export function dependencyLockRef(
  packageId: string,
  version: string,
  coverage: DependencyLockCoverage,
): string {
  const segment = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-");
  return `locks/${segment(packageId)}@${segment(version)}.${coverage}${LOCK_FILE_SUFFIX}`;
}

function comparePins(a: PinnedArtifact, b: PinnedArtifact): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return a.resolvedFrom < b.resolvedFrom ? -1 : a.resolvedFrom > b.resolvedFrom ? 1 : 0;
}

/** The part of the lock the digest covers, with keys and array order fixed so the same input hashes the same. */
function lockBody(input: Omit<DependencyLock, "lockRef" | "lockDigest">): JsonValue {
  return asJsonValue({
    packageId: input.packageId,
    version: input.version,
    coverage: input.coverage,
    dependencies: input.dependencies.map((pin) => ({ ...pin })),
    lifecycleScripts: [...input.lifecycleScripts],
    buildInputs: { nodeAbi: input.buildInputs.nodeAbi, platform: input.buildInputs.platform },
  });
}

/**
 * Turn a resolved closure into the artifact a build reads.
 *
 * Digested with `payloadDigest`, the repository's canonical sorted-key digest, rather than a scheme invented here:
 * the point of a digest is that every writer agrees on it, and a second canonicalisation would be a second answer.
 */
export function materializeDependencyLock(input: {
  packageId: string;
  version: string;
  coverage: DependencyLockCoverage;
  resolved: readonly PinnedArtifact[];
  lifecycleScripts?: readonly string[];
  buildInputs: BuildInputs;
}): DependencyLock {
  const dependencies = [...input.resolved].sort(comparePins).map((pin) => pinnedArtifactSchema.parse(pin));
  const body = {
    packageId: input.packageId,
    version: input.version,
    coverage: dependencyLockCoverageSchema.parse(input.coverage),
    dependencies,
    lifecycleScripts: [...new Set(input.lifecycleScripts ?? [])].sort(),
    buildInputs: { platform: input.buildInputs.platform, nodeAbi: input.buildInputs.nodeAbi },
  };
  return {
    lockRef: dependencyLockRef(body.packageId, body.version, body.coverage),
    lockDigest: payloadDigest(lockBody(body)),
    ...body,
  };
}

const storedLockSchema = z.strictObject({
  lockRef: z.string().min(1).max(300),
  lockDigest: z.string().min(1).max(120),
  packageId: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  coverage: dependencyLockCoverageSchema,
  dependencies: z.array(pinnedArtifactSchema).max(256),
  lifecycleScripts: z.array(z.string().min(1).max(300)).max(64),
  buildInputs: z.strictObject({ platform: z.string().min(1).max(120), nodeAbi: z.string().min(1).max(40) }),
});

export type LockStoreRefusal = "LOCK_MISSING" | "LOCK_MUTATED" | "LOCK_IMMUTABLE";

function withinDirectory(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function readStoredLock(path: string): { ok: true; lock: DependencyLock } | { ok: false; message: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: "there is no lock artifact at this reference on this node" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: "the lock artifact is not readable JSON" };
  }
  const lock = storedLockSchema.safeParse(parsed);
  if (!lock.success) {
    return { ok: false, message: "the lock artifact is not a lock this node wrote" };
  }
  const recorded = lock.data.lockDigest;
  const computed = payloadDigest(lockBody(lock.data));
  if (computed !== recorded) {
    // Checked rather than trusted: the digest is in the file it describes, so it only means something if the
    // contents are re-hashed on the way in.
    return { ok: false, message: `the lock artifact's contents no longer hash to ${recorded}` };
  }
  return { ok: true, lock: lock.data };
}

/**
 * Write the artifact, and never replace a frozen one.
 *
 * A reference that is already taken by a different digest is a refusal, not an overwrite: the node would otherwise
 * be able to change what a consented plan builds by resolving again, which is the failure this whole module exists
 * to prevent. The completed case is unaffected because a lock that covers more — the package's tree as well as the
 * artifact — has its own reference.
 */
export function writeDependencyLock(input: {
  dir: string;
  lock: DependencyLock;
}): { ok: true; path: string } | { ok: false; code: LockStoreRefusal; message: string } {
  const path = resolve(input.dir, input.lock.lockRef);
  if (!withinDirectory(input.dir, path)) {
    return {
      ok: false,
      code: "LOCK_MUTATED",
      message: `the lock reference ${input.lock.lockRef} does not name an artifact inside this node's lock directory`,
    };
  }
  if (existsSync(path)) {
    const existing = readStoredLock(path);
    if (!existing.ok) {
      return { ok: false, code: "LOCK_MUTATED", message: `the lock artifact at ${input.lock.lockRef} is unusable: ${existing.message}` };
    }
    if (existing.lock.lockDigest !== input.lock.lockDigest) {
      return {
        ok: false,
        code: "LOCK_IMMUTABLE",
        message: `${input.lock.packageId}@${input.lock.version} is already frozen at ${existing.lock.lockDigest}, and this resolution produced ${input.lock.lockDigest}; a build input that moved has to be reviewed again rather than replaced`,
      };
    }
    return { ok: true, path };
  }

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(input.lock, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, path };
}

/**
 * Read the frozen artifact a plan consented to, or fail.
 *
 * Missing and mutated are the same answer — the install does not proceed — but they are named separately, because
 * "this node never wrote it" and "somebody changed it after it was written" are different incidents. Nothing here
 * falls back to resolving the closure again: a fallback would mean the build ran on a closure no consent covered.
 */
export function readDependencyLock(input: {
  dir: string;
  lockRef: string;
  lockDigest: string;
}): { ok: true; lock: DependencyLock } | { ok: false; code: LockStoreRefusal; message: string } {
  const path = resolve(input.dir, input.lockRef);
  if (!withinDirectory(input.dir, path)) {
    return {
      ok: false,
      code: "LOCK_MUTATED",
      message: `the lock reference ${input.lockRef} does not name an artifact inside this node's lock directory`,
    };
  }
  const stored = readStoredLock(path);
  if (!stored.ok) {
    const missing = stored.message.startsWith("there is no lock artifact");
    return {
      ok: false,
      code: missing ? "LOCK_MISSING" : "LOCK_MUTATED",
      message: missing
        ? `no frozen build input at ${input.lockRef}, and a build is not allowed to resolve one itself`
        : `${input.lockRef}: ${stored.message}`,
    };
  }
  if (stored.lock.lockDigest !== input.lockDigest) {
    return {
      ok: false,
      code: "LOCK_MUTATED",
      message: `${input.lockRef} records ${stored.lock.lockDigest}, not the consented ${input.lockDigest}`,
    };
  }
  return { ok: true, lock: stored.lock };
}

/** What the install plan and the generation carry from a lock. */
export function lockBindingForPlan(lock: DependencyLock): DependencyLockBinding {
  return {
    lockRef: lock.lockRef,
    lockDigest: lock.lockDigest,
    coverage: lock.coverage,
    dependencies: lock.dependencies,
  };
}

/* ------------------------------------------------------------------ *
 * Drift
 * ------------------------------------------------------------------ */

/**
 * Whether the closure in front of a build is the one consent was bound to.
 *
 * Compared pin by pin as well as by digest, because the digest alone says "different" and a person needs to know
 * which dependency moved. Build inputs and declared scripts are compared too: a platform change or a newly
 * declared `postinstall` changes what the build will do, and neither is a dependency.
 */
export function assertLockUnchanged(
  consented: DependencyLock,
  current: DependencyLock,
): { ok: true } | { ok: false; code: "LOCK_DRIFT"; message: string } {
  const differences: string[] = [];
  if (consented.coverage !== current.coverage) {
    differences.push(`the lock now covers ${current.coverage}, not ${consented.coverage}`);
  }
  differences.push(...dependencyDrift(consented.dependencies, current.dependencies));
  const scripts = new Set(consented.lifecycleScripts);
  for (const script of current.lifecycleScripts) {
    if (!scripts.has(script)) differences.push(`the artifact now declares a load-time script "${script}"`);
  }
  for (const script of consented.lifecycleScripts) {
    if (!current.lifecycleScripts.includes(script)) {
      differences.push(`the artifact no longer declares the load-time script "${script}"`);
    }
  }
  for (const key of ["platform", "nodeAbi"] as const) {
    if (consented.buildInputs[key] !== current.buildInputs[key]) {
      differences.push(`the build input ${key} is now ${current.buildInputs[key]}, not ${consented.buildInputs[key]}`);
    }
  }
  if (differences.length === 0) return { ok: true };
  return {
    ok: false,
    code: "LOCK_DRIFT",
    message: `${differences.join("; ")} — the closure resolved now is not the one that was consented to, so this build stops instead of running on either one`,
  };
}

/* ------------------------------------------------------------------ *
 * Lifecycle scripts
 * ------------------------------------------------------------------ */

/**
 * Which of an artifact's load-time scripts may run.
 *
 * Nothing is approved by default. An install script is the usual vector in a package supply-chain attack, and
 * `postinstall` is not a build step a reader can see in a manifest — it is code, and it runs before anything this
 * node could inspect it with. Approval therefore has to name the script.
 */
export function lifecycleScriptGate(input: {
  declared: readonly string[];
  approved: readonly string[];
}): { permitted: string[]; refused: string[] } {
  const approved = new Set(input.approved);
  const declared = [...new Set(input.declared)].sort();
  return {
    permitted: declared.filter((script) => approved.has(script)),
    refused: declared.filter((script) => !approved.has(script)),
  };
}

/* ------------------------------------------------------------------ *
 * The ordered pipeline: resolve, then build
 * ------------------------------------------------------------------ */

export interface PreparedLockedBuild {
  /** The consented lock, which is what the build reads. Never the closure resolved just now. */
  lock: DependencyLock;
}

export type PrepareLockedBuildResult =
  | { ok: true; prepared: PreparedLockedBuild }
  | {
      ok: false;
      code: DependencyResolutionRefusal | LockStoreRefusal | "LOCK_DRIFT" | "LOCK_INCOMPLETE";
      message: string;
    };

/**
 * Resolve the closure, then check it against what consent covered — before anything is executed.
 *
 * The order is the point. Metadata is read here, in the parent process, and compared with the consented digest, so
 * there is no moment at which a build could run against a range that resolved differently. What comes back is the
 * **stored** lock: the freshly resolved closure is used to detect drift and is then thrown away, because a
 * resolution that matches the consent adds nothing and one that does not match stops the install.
 */
export function prepareLockedBuild(input: {
  lockDir: string;
  /** The lock the install plan consented to. */
  consented: { lockRef: string; lockDigest: string; coverage: DependencyLockCoverage };
  packageId: string;
  version: string;
  /** The artifact itself, already resolved by the install resolver. */
  artifact: DependencyRequest;
  /** The package's declared dependencies, as its manifest wrote them. */
  declared: readonly DependencyRequest[];
  metadata: DependencyMetadataSource;
  buildInputs: BuildInputs;
  /** Load-time scripts the artifact declares, which are part of the build input. */
  lifecycleScripts: readonly string[];
}): PrepareLockedBuildResult {
  const stored = readDependencyLock({
    dir: input.lockDir,
    lockRef: input.consented.lockRef,
    lockDigest: input.consented.lockDigest,
  });
  if (!stored.ok) return { ok: false, code: stored.code, message: stored.message };

  if (stored.lock.coverage !== "artifact-and-dependencies") {
    /*
     * A lock that covers the artifact alone was written where the package's tree could not be read. Building on it
     * would mean running a build whose dependencies nobody pinned, which is the state this phase exists to end.
     */
    return {
      ok: false,
      code: "LOCK_INCOMPLETE",
      message: `${stored.lock.lockRef} covers ${stored.lock.coverage}, so it does not pin the dependency tree this build would consume`,
    };
  }

  const resolution = resolveDependencyClosure({
    requests: [input.artifact, ...input.declared],
    metadata: input.metadata,
  });
  if (!resolution.ok) return { ok: false, code: resolution.code, message: resolution.message };

  const current = materializeDependencyLock({
    packageId: input.packageId,
    version: input.version,
    coverage: "artifact-and-dependencies",
    resolved: resolution.resolved,
    lifecycleScripts: input.lifecycleScripts,
    buildInputs: input.buildInputs,
  });

  const unchanged = assertLockUnchanged(stored.lock, current);
  if (!unchanged.ok) return { ok: false, code: unchanged.code, message: unchanged.message };

  return { ok: true, prepared: { lock: stored.lock } };
}

/**
 * The frozen pins, for a build to read instead of resolving anything itself.
 *
 * Canonical JSON through the same digest helper, so what a build sees is byte-identical for byte-identical input.
 */
export function frozenBuildEnvironment(lock: DependencyLock): Record<string, string> {
  return {
    CC_LOCKED_DEPENDENCIES: JSON.stringify({
      lockDigest: lock.lockDigest,
      dependencies: lock.dependencies.map((pin) => ({ ...pin })),
    }),
    CC_LOCKED_LIFECYCLE_SCRIPTS: JSON.stringify(lock.lifecycleScripts),
  };
}
