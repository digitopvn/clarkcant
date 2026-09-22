import type { FixtureDataset, PackageSource, WidgetDefinition, WidgetFixture } from "@clarkcant/contracts";

import { readPackage } from "./widget-package.ts";

/**
 * The widget definitions an installed package declares.
 *
 * The library can only show a widget whose definition it can read, and this node can only read a package whose
 * bytes it already has. That is a property of the source rather than a gap to paper over: a `git` or `npm` entry
 * names bytes nobody here holds, and nothing keeps an unpacked copy of what was installed — a generation records
 * which digest is active, not where the files are, and the artifact store is transient by design. So the answer is
 * per package and "cannot read this one" is a real answer, which the caller has to show rather than round down to
 * "nothing is installed".
 *
 * What a package contributes is **data**: definitions and fixtures. It never contributes a renderer. The library
 * resolves a definition id through the catalogue's own renderers, so a package that names an id nobody renders
 * simply does not appear — which is why the renderer gate lives on the caller's side, where the renderers are.
 */

export interface InstalledWidgetDefinition {
  packageId: string;
  version: string;
  facetId: string;
  definition: WidgetDefinition;
  /**
   * Built from the package's own `fixtures/*.json`.
   *
   * Those files hold raw props, not catalog fixtures, so the name becomes both the id and the label: inventing a
   * prettier label here would be inventing data the package never wrote.
   */
  fixtures: readonly WidgetFixture[];
}

export type InstalledWidgetsOutcome =
  | {
      ok: true;
      widgets: readonly InstalledWidgetDefinition[];
      /** Facets that did not parse, named rather than silently dropped. */
      problems: readonly string[];
    }
  | { ok: false; code: "NOT_LOCAL" | "UNREADABLE"; message: string };

export function installedWidgets(input: {
  packageId: string;
  version: string;
  source: PackageSource;
}): InstalledWidgetsOutcome {
  if (input.source.kind !== "local") {
    return {
      ok: false,
      code: "NOT_LOCAL",
      message:
        `this node has no bytes for a ${input.source.kind} package, so its widget definitions cannot be read here`,
    };
  }

  const pkg = readPackage(input.source.path);

  /*
   * Nothing parsed at all: that is a failure to read, not a package with no widgets. The two must stay apart,
   * because one is a reason to fix something and the other is a fact about the package.
   */
  if (pkg.facets.length === 0 && pkg.problems.length > 0) {
    return { ok: false, code: "UNREADABLE", message: pkg.problems.join("; ") };
  }

  return {
    ok: true,
    widgets: pkg.facets.map((facet) => ({
      packageId: input.packageId,
      version: input.version,
      facetId: facet.facetId,
      definition: facet.definition,
      fixtures: fixturesFromProps(pkg.fixtures, pkg.datasets),
    })),
    problems: pkg.problems,
  };
}

/** Sorted by name so two reads of the same package agree on the order. */
function fixturesFromProps(
  fixtures: Record<string, Record<string, unknown>>,
  datasets: Record<string, FixtureDataset>,
): WidgetFixture[] {
  return Object.entries(fixtures)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, props]) => {
      const dataset = datasets[name];
      return {
        id: name,
        label: name,
        props,
        // A fixture whose package shipped no dataset renders from none, which is a fact about the package rather
        // than something to paper over with empty rows.
        ...(dataset === undefined ? {} : { dataset }),
      };
    });
}
