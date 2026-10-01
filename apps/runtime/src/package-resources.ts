import { join } from "node:path";

import {
  decideResourceProfile,
  DEFAULT_RESOURCE_PROFILE,
  describeResourceProfile,
  type ResourceGrant,
  type ResourceProfile,
  type ResourceProfileName,
  type ResourceRequest,
} from "@clarkcant/contracts";
import { directoryIndexPath, readDirectoryIndex, readPackage } from "@clarkcant/core";

import { packageRootFrom, type ServiceHost } from "./service-host.ts";

/**
 * The resource profile a package is granted, as the places outside the service host read it: package details and a
 * widget frame's offscreen behaviour.
 *
 * A package with a service gets the service host's own decision, made against the engine. A package that runs nothing
 * in a container is decided here on the same rules without an engine, so a profile the policy refuses is refused for a
 * widget as it is for a service, and package details never claim a grant nobody made.
 */
export function packageResourceGrant(input: {
  packageId: string;
  request: ResourceRequest | undefined;
  serviceHost?: Pick<ServiceHost, "resourceGrant"> | undefined;
  policy?: ((input: { packageId: string; profile: ResourceProfileName }) => string | undefined) | undefined;
}): ResourceGrant {
  const decided = input.serviceHost?.resourceGrant?.(input.packageId);
  if (decided !== undefined) return decided;
  const requested = input.request?.profile ?? DEFAULT_RESOURCE_PROFILE;
  let policyRefusal: string | undefined;
  if (requested !== DEFAULT_RESOURCE_PROFILE) {
    try {
      policyRefusal = input.policy?.({ packageId: input.packageId, profile: requested });
    } catch (cause) {
      policyRefusal = `the execution policy could not be read (${cause instanceof Error ? cause.message : String(cause)})`;
    }
  }
  return decideResourceProfile({ request: input.request, needsContainer: false, capacity: undefined, policyRefusal });
}

/** What package details show about resources: the request, the decision, and the bounds or the reason in words. */
export type PackageResourcesView =
  | {
      requested: ResourceProfileName;
      status: "granted";
      profile: ResourceProfileName;
      /** The bounds as numbers, for a client to say in its own language. */
      bounds: {
        memoryMib: number;
        cpus: number;
        pids: number;
        tmpfsMib: number;
        callDeadlineMs: number;
        jobDeadlineMs: number;
        maxActiveJobs: number;
      };
      /** The same bounds in English words, for a caller with no language of its own (a CLI, a log). */
      summary: string;
      offscreen: ResourceProfile["offscreen"];
      notes: string[];
    }
  | { requested: ResourceProfileName; status: "degraded"; reason: string };

export function packageResourcesView(grant: ResourceGrant): PackageResourcesView {
  return grant.status === "granted"
    ? {
        requested: grant.requested,
        status: "granted",
        profile: grant.profile.name,
        bounds: {
          ...grant.profile.container,
          callDeadlineMs: grant.profile.callDeadlineMs,
          jobDeadlineMs: grant.profile.jobDeadlineMs,
          maxActiveJobs: grant.profile.maxActiveJobs,
        },
        summary: describeResourceProfile(grant.profile),
        offscreen: grant.profile.offscreen,
        notes: [...grant.notes],
      }
    : { requested: grant.requested, status: "degraded", reason: grant.reason };
}

/**
 * The resource request in an installed package's manifest, read from the files this node holds for it.
 *
 * `unreadable` when the node has no directory, no listing for that version and digest, or a manifest it cannot read:
 * then package details say nothing about resources rather than guess the light profile.
 */
export function installedResourceRequest(
  installed: { packageId: string; version: string; digest: string },
  dataDir: string,
): ResourceRequest | undefined | "unreadable" {
  const index = readDirectoryIndex(directoryIndexPath(process.env));
  if (index.kind !== "configured") return "unreadable";
  const root = packageRootFrom(index.entries, join(dataDir, "package-cache"))(installed);
  if (root === undefined) return "unreadable";
  try {
    const pkg = readPackage(root);
    // A manifest the reader could not read at all comes back empty, with its problems, not as an empty request.
    if (!("id" in pkg.manifest)) return "unreadable";
    return pkg.manifest.resources;
  } catch {
    return "unreadable";
  }
}
