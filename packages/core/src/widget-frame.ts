import type { DirectoryEntry, IsolationClass } from "@clarkcant/contracts";

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
      isolation: IsolationClass;
      /** What the package asked for. Empty means it asked for nothing, which is the common case. */
      requestedCapabilities: readonly string[];
      /** Origins the document may reach, from the package's own declaration and enforced by its policy. */
      allowedOrigins: readonly string[];
    }
  | {
      ok: false;
      code: "NO_SUCH_WIDGET" | "NOT_AN_ISOLATED_APP" | "PACKAGE_UNREADABLE";
      message: string;
    };

export function findIsolatedFrame(input: {
  directory: readonly DirectoryEntry[];
  widgetId: string;
}): IsolatedFrameLookup {
  let unreadable = 0;

  for (const entry of input.directory) {
    // Only a package this node can read. A git or npm entry names bytes nobody here has, and a frame that cannot be
    // given its code should say so rather than be given an address that will fail later.
    if (entry.source.kind !== "local") continue;

    let pkg;
    try {
      pkg = readPackage(entry.source.path);
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
      isolation: declaration.isolation,
      requestedCapabilities: pkg.manifest.requestedCapabilities,
      allowedOrigins: pkg.manifest.permissions.networkOrigins,
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
