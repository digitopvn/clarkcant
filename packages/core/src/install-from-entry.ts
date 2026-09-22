import type { DependencyLockBinding, DirectoryEntry, Instant, Platform } from "@clarkcant/contracts";

import { installFromSource, type InstallOutcome } from "./install-from-source.ts";
import type { InstallDeps } from "./install-lifecycle.ts";

/**
 * Installing a package a directory listed.
 *
 * This is the seam between the marketplace and the install path, and its whole job is to be **thin**: it turns an
 * entry plus a host into the input `installFromSource` already takes, and it invents nothing on the way. Every
 * refusal the caller sees — the wrong platform, a missing digest, a host API the package does not support, a source
 * that is not exact — comes from the resolver that already checked it, with the code it already uses. A second
 * layer deciding the same questions is how a marketplace quietly becomes a second install path.
 */

/**
 * The host API this node implements.
 *
 * One number, in one place. A package declares a range (`hostApi: {min, max}`) and the resolver refuses one that
 * does not contain this; the value was previously only ever a literal inside test fixtures, which meant the node
 * itself had no answer to "which host API are you" — the question every entry is checked against.
 */
export const HOST_API_VERSION = 1;

export interface InstallFromEntryRequest {
  entry: DirectoryEntry;
  /** The index the entry came from, so the resolver can refuse an entry that is not in it. */
  directory: readonly DirectoryEntry[];
  /** From `platformForHost(process.platform, process.arch)`; the caller decides what an unnamed host means. */
  platform: Platform;
  hostApi?: number;
  ownerPrincipalId: string;
  /** Distinguishes one code generation from the next; the caller owns what it means. */
  codeGeneration: string;
  expiresAt: Instant;
  /** Required when the entry's source is local: the digest the caller computed from those bytes. */
  localDigest?: string;
  requestedCapabilityRefs?: readonly string[];
  grantedCapabilities?: readonly string[];
  /** The frozen dependency closure resolved before this call, if one was. */
  dependencyLock?: DependencyLockBinding;
}

/**
 * The healthcheck this node can honestly run.
 *
 * The supervisor calls it after activation is staged and before a generation becomes active. What this node can
 * check without fetching and running the artifact is that the plan is bound to a digest the directory published —
 * and the resolver has already refused any candidate that did not match one. It **cannot** check that the package
 * works, so the outcome says `verified: "digest-only"` rather than letting "active" read as "known good".
 */
function digestOnlyHealthcheck(entry: DirectoryEntry): () => boolean {
  return () => entry.digest.trim() !== "";
}

export function installFromEntry(deps: InstallDeps, request: InstallFromEntryRequest): InstallOutcome {
  return installFromSource(deps, {
    source: request.entry.source,
    directory: request.directory,
    hostApi: request.hostApi ?? HOST_API_VERSION,
    platform: request.platform,
    ...(request.localDigest === undefined ? {} : { localDigest: request.localDigest }),
    ownerPrincipalId: request.ownerPrincipalId,
    ...(request.dependencyLock === undefined ? {} : { dependencyLock: request.dependencyLock }),
    // One plan per package version, so two turns that ask for the same package share it rather than installing it
    // twice — which is what the requirement key exists for.
    requirementKey: `pkg:${request.entry.packageId}@${request.entry.version}`,
    requestedCapabilityRefs: request.requestedCapabilityRefs ?? [],
    grantedCapabilities: request.grantedCapabilities ?? [],
    // Straight from the entry. The publisher knew each facet's lane from its own manifest, and the entry carries it
    // so nobody has to derive a per-facet plan from a strongest lane.
    isolationPlan: request.entry.isolations,
    codeGeneration: request.codeGeneration,
    healthcheck: digestOnlyHealthcheck(request.entry),
    expiresAt: request.expiresAt,
  });
}

/** What a successful install verified, said in the response rather than left to be assumed. */
export const INSTALL_VERIFICATION = "digest-only";
