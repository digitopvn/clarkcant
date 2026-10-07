import {
  DEFAULT_RESOURCE_PROFILE,
  declaredReachIsEmpty,
  declaredReachOf,
  riskLaneFor,
  type DirectoryEntry,
  type PackageManifest,
} from "@clarkcant/contracts";

/**
 * The directory entry a package's manifest describes.
 *
 * One construction for every listing the author's tools write: `clark widget publish` prepares it for a directory, and
 * a live authoring session lists the package being developed to its own node the same way, so the two can never
 * disagree about what a manifest declares.
 */

export function requestedSummary(permissions: PackageManifest["permissions"]): string[] {
  const out = permissions.networkOrigins.map((origin) => "network: " + origin);
  for (const { path, access } of permissions.filesystem) out.push(`filesystem (${access}): ${path}`);
  if (permissions.microphone) out.push("microphone");
  if (permissions.camera) out.push("camera");
  return out;
}

/** Whether a resource request says anything an absent one does not: another profile, or a GPU. */
export function requestsMoreThanDefault(
  resources: PackageManifest["resources"],
): resources is NonNullable<PackageManifest["resources"]> {
  return resources !== undefined && (resources.profile !== DEFAULT_RESOURCE_PROFILE || resources.gpu === true);
}

export function directoryEntryOf(
  manifest: PackageManifest,
  listing: {
    source: DirectoryEntry["source"];
    publisher: DirectoryEntry["publisher"];
    sizeBytes: number;
    digest: string;
  },
): DirectoryEntry {
  const reach = declaredReachOf(manifest);
  return {
    packageId: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    source: listing.source,
    // The signature is verified against the artifact, never listed as though the listing vouched for it.
    publisher: listing.publisher,
    // Empty rather than absent: a package without preview media is listed, not hidden.
    preview: {},
    // The manifest and the directory share one facet vocabulary, so what a listing advertises is what the package holds.
    facets: [...new Set(manifest.facets.map((facet) => facet.kind))],
    // From the manifest, one entry per facet: the install supervisor plans isolation per facet, and this is the
    // only place that knows the answer without guessing it back out of the strongest lane.
    isolations: manifest.facets.map((facet) => ({ facetKind: facet.kind, isolation: facet.isolation })),
    platforms: manifest.platforms,
    hostApi: manifest.hostApi,
    permissionsSummary: requestedSummary(manifest.permissions),
    // What it reaches beyond its sandbox, shown before install. Binding: an install refuses an artifact that differs.
    ...(declaredReachIsEmpty(reach) ? {} : { declaredReach: reach }),
    // The resource profile it requests, so an update can say what changes before it is fetched. Binding in the same way.
    // Only when it is not the default, which an absent field already means: a node from before this field refuses an
    // index holding an entry field it does not know, so a default request stays readable by it.
    ...(requestsMoreThanDefault(manifest.resources) ? { resources: manifest.resources } : {}),
    // From the isolation the facets declare, never from what the publisher says about their own package.
    riskTier: riskLaneFor(manifest.facets.map((facet) => facet.isolation)),
    sizeBytes: listing.sizeBytes,
    digest: listing.digest,
  };
}
