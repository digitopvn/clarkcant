import type { DirectoryEntry, IsolationClass, WidgetDefinition } from "@clarkcant/contracts";

import { resolveLocalSource } from "./package-fetch.ts";
import { readPackage } from "./widget-package.ts";

/**
 * Finding the frame document for a widget that runs in one.
 *
 * The conversation knows a widget by its definition id; the frame needs a URL, and the two are joined by the package
 * on disk. This is that join, and it is deliberately the only place it happens: a second implementation would be a
 * second answer to "where does this widget's code live", and the two would disagree the first time a package moved.
 *
 * A definition is matched by reading each local package's own definition files rather than by splitting the id into
 * a package name and a facet. The id *looks* like `<package>.<facet>@<version>`, and a package is free not to follow
 * that — the authoring format says the definition is whatever the package's `widget.json` says it is.
 */

export type IsolatedFrameLookup =
  | {
      ok: true;
      packageId: string;
      version: string;
      widgetId: string;
      /** The URL the frame document is served from, relative to the node that will serve it. */
      url: string;
      /**
       * The entry file's path inside the package.
       *
       * Separate from `url` because a frame grant replaces the prefix with a path segment that carries it — so
       * whoever mints the grant needs the path, not the ready-made token-less URL.
       */
      entryPath: string;
      isolation: IsolationClass;
      /** What the package asked for. Empty means it asked for nothing, which is the common case. */
      requestedCapabilities: readonly string[];
      /** Origins the document may reach, from the package's own declaration and enforced by its policy. */
      allowedOrigins: readonly string[];
      /**
       * The definition as this package version declares it — what the node holds the widget's state to: its schema,
       * its `stateVersion`, the keys it says are view state and the migrations that carry older state forward.
       */
      definition: WidgetDefinition;
    }
  | {
      ok: false;
      code: "NO_SUCH_WIDGET" | "NOT_AN_ISOLATED_APP" | "PACKAGE_UNREADABLE";
      message: string;
    };

/**
 * What a frame is actually brokered: the requested set, narrowed to what was granted.
 *
 * A manifest's `requestedCapabilities` is metadata the package wrote about itself, never an authority — the
 * generation's `grantedCapabilities` (carried from a real consent decision, `install-consent.ts`) is the one
 * that is. This is deliberately the intersection rather than the granted set alone: a capability the node granted
 * for some other reason but this widget never asked for still has no business being handed to it.
 */
export function brokeredCapabilities(
  requested: readonly string[],
  granted: readonly string[] | undefined,
): readonly string[] {
  const grantedSet = new Set(granted ?? []);
  return requested.filter((ref) => grantedSet.has(ref));
}

/** A brokered capability the frame is not given yet, and why — so the widget and the person can be told which. */
export interface UnavailableCapability {
  ref: string;
  code: string;
  message: string;
}

/** Whether a capability can run now; the runtime answers it from the capability registry. */
export type CapabilityPreflight = (ref: string) => { ready: true } | { ready: false; code: string; message: string };

/**
 * Narrow what a frame is brokered to what can actually run now.
 *
 * A grant is permission, not readiness: a capability the person approved can still be missing a connection or a
 * loaded extension. Handing the frame such a capability tells it something works that will fail on first use, so
 * it is held back and reported with the reason instead — and it is brokered again, with no new approval, on the
 * next mount after the prerequisite is met.
 */
export function readyCapabilities(
  brokered: readonly string[],
  preflight: CapabilityPreflight,
): { ready: readonly string[]; unavailable: readonly UnavailableCapability[] } {
  const ready: string[] = [];
  const unavailable: UnavailableCapability[] = [];
  for (const ref of brokered) {
    const checked = preflight(ref);
    if (checked.ready) ready.push(ref);
    else unavailable.push({ ref, code: checked.code, message: checked.message });
  }
  return { ready, unavailable };
}

export function findIsolatedFrame(input: {
  directory: readonly DirectoryEntry[];
  widgetId: string;
  /**
   * Where fetched git/npm artifacts are cached. When given, a git/npm entry whose bytes this node has already
   * fetched (H1) is served from that cache path the same way a `local` entry is — the fetch step already verified
   * the bytes against the directory's published digest, so there is nothing more to check here.
   */
  cacheRoot?: string;
}): IsolatedFrameLookup {
  let unreadable = 0;

  for (const entry of input.directory) {
    const source = entry.source.kind === "local" ? entry.source : input.cacheRoot === undefined ? entry.source : resolveLocalSource(entry, input.cacheRoot);
    // Only a package this node can read. A git or npm entry this node has not fetched (or has no cache root
    // configured to check) names bytes nobody here has, and a frame that cannot be given its code should say so
    // rather than be given an address that will fail later.
    if (source.kind !== "local") continue;

    let pkg;
    try {
      pkg = readPackage(source.path);
    } catch {
      unreadable += 1;
      continue;
    }

    /*
     * A package the reader could not make sense of reports problems and no facets rather than throwing, so this is
     * where "broken" is separated from "unknown": an author whose manifest is malformed should be told that, not told
     * that no package declares their widget.
     */
    if (pkg.facets.length === 0 && pkg.problems.length > 0) {
      unreadable += 1;
      continue;
    }

    const facet = pkg.facets.find((candidate) => candidate.definition.id === input.widgetId);
    if (facet === undefined) continue;

    if (facet.definition.renderer !== "isolated-app") {
      return {
        ok: false,
        code: "NOT_AN_ISOLATED_APP",
        message: `${input.widgetId} declares the ${facet.definition.renderer} renderer, so it is drawn in the conversation rather than in a frame`,
      };
    }

    const declaration = facet.manifest.facets.find((candidate) => candidate.id === facet.facetId);
    if (declaration === undefined) {
      // The reader validated the manifest, so a facet it returned without a declaration is a reader inconsistency
      // rather than a bad package — said as such instead of guessed at.
      unreadable += 1;
      continue;
    }

    return {
      ok: true,
      packageId: entry.packageId,
      version: entry.version,
      widgetId: input.widgetId,
      url: `/packages/${entry.packageId}/${entry.version}/files/${facet.entryPath}`,
      entryPath: facet.entryPath,
      isolation: declaration.isolation,
      requestedCapabilities: pkg.manifest.requestedCapabilities,
      allowedOrigins: pkg.manifest.permissions.networkOrigins,
      definition: facet.definition,
    };
  }

  if (unreadable > 0) {
    return {
      ok: false,
      code: "PACKAGE_UNREADABLE",
      message: `${String(unreadable)} local ${unreadable === 1 ? "package" : "packages"} could not be read, so this widget's code cannot be located`,
    };
  }
  return {
    ok: false,
    code: "NO_SUCH_WIDGET",
    message: `no package this node can read declares the widget ${input.widgetId}`,
  };
}
