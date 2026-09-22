import { directoryEntrySchema, riskLaneFor, type DirectoryEntry, type PackageSource, type Platform, type RiskLane } from "@clarkcant/contracts";

/**
 * Resolving where a package comes from.
 *
 * The rule this file exists to enforce is that a source resolves to an **exact artifact** or it does not resolve.
 * A git branch and an npm range are both "whatever is there when you look", and installing one means installing
 * something nobody reviewed — while the plan, the consent and the digest all say a specific thing was approved.
 *
 * It is a resolver, not an installer. What it produces is the candidate that the existing install lifecycle already
 * knows how to carry: `joinOrCreatePlan`, `advanceInstall`, `activateGeneration`, `rollbackGeneration`. There is no
 * second install path here, which is the point of the phase — a marketplace that installed by itself would be a
 * second place for the digest, staging and rollback rules to be re-implemented and to drift.
 *
 * It also assigns the risk lane, and takes the strongest facet rather than the first: a package is as trusted as
 * its least isolated part, and a listing that called a package "declarative" while it shipped a native tool would
 * make the label worthless.
 */

export type SourceRefusal =
  | "GIT_REF_NOT_EXACT"
  | "NPM_VERSION_NOT_EXACT"
  | "NOT_IN_DIRECTORY"
  | "DIGEST_MISMATCH"
  | "HOST_API_MISMATCH"
  | "PLATFORM_MISMATCH"
  | "LOCAL_DIGEST_REQUIRED";

export interface ResolvedPackage {
  packageId: string;
  version: string;
  /** Where the artifact is fetched from, resolved to an exact location. */
  artifactUrl: string;
  digest: string;
  rationale: string;
  sourceTier: "built-in-workspace" | "first-party-recipe" | "curated-registry" | "public-research";
  lane: RiskLane;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedPackage }
  | { ok: false; code: SourceRefusal; message: string };

/** A commit id, or a version tag. Anything else names a moving target. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;
const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** Exact semver, with no range operators and no wildcards. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface ResolveInput {
  source: PackageSource;
  /** The directory listing, when the source is a registry rather than a path. */
  directory?: readonly DirectoryEntry[];
  hostApi: number;
  platform: Platform;
  /**
   * The digest computed from a local package by the caller.
   *
   * Passed in rather than computed here so this module does not need to read a filesystem, and so the one place
   * that hashes a package directory is the one place that packs one.
   */
  localDigest?: string;
}

export function resolvePackageSource(input: ResolveInput): ResolveResult {
  const { source } = input;

  if (source.kind === "git") {
    if (!COMMIT_ID.test(source.ref) && !VERSION_TAG.test(source.ref)) {
      /*
       * Refused rather than resolved. A branch name resolves to whatever it points at today, so the plan the user
       * approved and the artifact that arrives would be two different things that share a name.
       */
      return {
        ok: false,
        code: "GIT_REF_NOT_EXACT",
        message: `git ref "${source.ref}" is not a commit id or a version tag, so it does not name one revision`,
      };
    }
    const entry = findEntry(input, source.url);
    if (entry === undefined) {
      return { ok: false, code: "NOT_IN_DIRECTORY", message: `${source.url} is not in the directory` };
    }
    return finish(input, entry, `git ${source.url}@${source.ref}`, "curated-registry", `${source.url}#${source.ref}`);
  }

  if (source.kind === "npm") {
    if (!EXACT_VERSION.test(source.version)) {
      return {
        ok: false,
        code: "NPM_VERSION_NOT_EXACT",
        message: `npm version "${source.version}" is a range, so it does not name one artifact`,
      };
    }
    const entry = findEntry(input, source.name);
    if (entry === undefined) {
      return { ok: false, code: "NOT_IN_DIRECTORY", message: `${source.name} is not in the directory` };
    }
    if (entry.version !== source.version) {
      return {
        ok: false,
        code: "NOT_IN_DIRECTORY",
        message: `directory has ${source.name}@${entry.version}, not @${source.version}`,
      };
    }
    return finish(input, entry, `npm ${source.name}@${source.version}`, "curated-registry", `npm:${source.name}@${source.version}`);
  }

  // Local: the caller has already hashed the directory, and there is no published digest to compare it against —
  // so the digest is the identity rather than something to check.
  if (input.localDigest === undefined) {
    return {
      ok: false,
      code: "LOCAL_DIGEST_REQUIRED",
      message: "a local package must be hashed before it can be planned, so the plan names the bytes it approved",
    };
  }

  /*
   * A local path has a name when the directory lists it.
   *
   * The path is where the bytes are, not what the package is called, so recording the path as the package id gives
   * one package two names: the listing says `com.example.chart-widget` while the installed row said
   * `apps/web/e2e/fixtures/chart-widget`, and both were shown to the same person. The listing is this node's own
   * record of what that path is, so its name is the better answer. A path the directory does not list keeps the
   * path: installing an unlisted local path works today, and it has nothing better to be called.
   *
   * The digest stays the caller's hash of the local bytes rather than the listed digest. Those two describe
   * different things - the bytes on disk right now against whatever was published - and this is a local install.
   */
  const listed = input.directory?.find((entry) => entry.source.kind === "local" && entry.source.path === source.path);
  return {
    ok: true,
    resolved: {
      packageId: listed?.packageId ?? source.path,
      version: listed?.version ?? "0.0.0-local",
      artifactUrl: `file:${source.path}`,
      digest: input.localDigest,
      rationale: `local path ${source.path}`,
      sourceTier: "built-in-workspace",
      // A local package is one the user has on disk and is developing; its lane comes from the manifest at install
      // time, so it is not guessed here.
      lane: "isolated-ui",
    },
  };
}

function findEntry(input: ResolveInput, key: string): DirectoryEntry | undefined {
  return input.directory?.find((entry) => entry.packageId === key);
}

function finish(
  input: ResolveInput,
  entry: DirectoryEntry,
  rationale: string,
  sourceTier: ResolvedPackage["sourceTier"],
  artifactUrl: string,
): ResolveResult {
  const parsed = directoryEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return { ok: false, code: "NOT_IN_DIRECTORY", message: "the directory entry does not match the schema" };
  }
  if (input.hostApi < entry.hostApi.min || input.hostApi > entry.hostApi.max) {
    // Refused before download, so a listing that cannot run here is never offered as one that can.
    return {
      ok: false,
      code: "HOST_API_MISMATCH",
      message: `needs host API ${String(entry.hostApi.min)}–${String(entry.hostApi.max)}, this host is ${String(input.hostApi)}`,
    };
  }
  if (!entry.platforms.includes(input.platform)) {
    // Names both sides. "Does not list linux-x64" tells a reader what this host is and nothing about what the
    // package is for, so it reads as a malformed package rather than as one built for another machine.
    return {
      ok: false,
      code: "PLATFORM_MISMATCH",
      message: `is built for ${entry.platforms.join(", ")}; this host is ${input.platform}`,
    };
  }
  if (entry.digest.trim() === "") {
    // A directory entry with no digest is refused rather than trusted: there would be nothing to check the artifact
    // against, and "no digest" must never behave like "digest matched".
    return { ok: false, code: "DIGEST_MISMATCH", message: "the directory entry publishes no digest" };
  }
  return {
    ok: true,
    resolved: {
      packageId: entry.packageId,
      version: entry.version,
      artifactUrl,
      digest: entry.digest,
      rationale,
      sourceTier,
      lane: entry.riskTier,
    },
  };
}

/**
 * Whether a fetched artifact is the one that was planned.
 *
 * Separate from resolving, because these are two different moments: the digest is checked again after the bytes
 * arrive, and an artifact that does not match is refused rather than installed. `riskLaneFor` is re-exported here so
 * a caller that has a manifest in hand assigns the lane by the same rule the directory listing used.
 */
export function artifactMatchesPlan(fetchedDigest: string, plannedDigest: string): boolean {
  return fetchedDigest === plannedDigest && plannedDigest.trim() !== "";
}

export { riskLaneFor };
