import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";

import type { InstalledPackageRead } from "../api.ts";

/**
 * Installed packages as catalog entries, gated on what this client can actually draw.
 *
 * Four rules, and each one is a way this could lie:
 *
 * **Only what can be rendered.** A definition whose id resolves to no renderer is left out, because a card that
 * opened onto nothing would be worse than an absent card. The gate lives here rather than on the node because the
 * renderers live here, and a second opinion about what can be drawn would drift from this one.
 *
 * **A card of its own, because the id space is taken.** Every definition id a shipping renderer can draw is already a
 * catalog entry, so an installed widget keyed by its definition id could never appear: the catalog's entry would win
 * the id every time. The card identity is therefore namespaced by the package (`<packageId>/<definitionId>`), which is
 * a fact about where the widget came from rather than a prettier name. Rendering still resolves from the definition
 * id, so there is still exactly one renderer per id, and the catalog's own card stays visible beside it.
 *
 * **A package this node cannot read is named, not omitted.** "This package declares no widgets" and "this node
 * cannot read that package" are different facts, and a shorter list would state the first when it meant the second.
 *
 * **Nothing is invented.** The card is named by the definition id and described by the definition's own
 * `semanticDescription`. A prettier name would be data the package never wrote.
 */

export interface InstalledEntriesRead {
  entries: readonly WidgetCatalogEntry[];
  /** What was left out and why, so the surface can say it instead of showing a quietly shorter list. */
  notes: readonly { packageId: string; message: string }[];
}

export function installedCatalogEntries(input: {
  packages: readonly InstalledPackageRead[];
  /** The catalog's own entries, so a widget that re-declares one inherits that definition's family. */
  known: readonly WidgetCatalogEntry[];
  canRender: (definitionId: string) => boolean;
}): InstalledEntriesRead {
  const entries: WidgetCatalogEntry[] = [];
  const notes: { packageId: string; message: string }[] = [];

  for (const read of input.packages) {
    if (!read.ok) {
      notes.push({ packageId: read.packageId, message: read.message });
      continue;
    }

    for (const widget of read.widgets) {
      const definitionId = widget.definition.id;

      if (!input.canRender(definitionId)) {
        notes.push({
          packageId: read.packageId,
          message: `${definitionId} has no renderer in this build, so it is not listed rather than listed empty`,
        });
        continue;
      }

      entries.push({
        // Namespaced by the package, because every renderable definition id is already a catalog entry - so this is
        // what lets a package's own widget be a card rather than a duplicate of the catalog's.
        cardId: `${read.packageId}/${definitionId}`,
        definition: widget.definition,
        family: familyFor(definitionId, input.known),
        displayName: definitionId,
        description: widget.definition.semanticDescription,
        tags: [],
        aliases: [],
        // Only a package whose bytes are on this machine can be read at all, so every entry here is a local one.
        // The gallery words that as "Local development package", which is what it is.
        source: "local",
        // Not a maturity claim: the catalog's own entries are the curated ones, and this says "not from that set".
        status: "experimental",
        fixtures: widget.fixtures,
      });
    }

    for (const problem of read.problems) {
      notes.push({ packageId: read.packageId, message: problem });
    }
  }

  return { entries, notes };
}

/**
 * The family an installed widget belongs to.
 *
 * A package that re-declares a catalog definition keeps that definition's family; anything else takes its own id
 * namespace, which is a fact about the id rather than an invented grouping.
 */
function familyFor(definitionId: string, known: readonly WidgetCatalogEntry[]): string {
  const match = known.find((entry) => entry.definition.id === definitionId);
  if (match !== undefined) return match.family;
  const [namespace] = definitionId.split(".");
  return namespace === undefined || namespace === "" ? "other" : namespace;
}