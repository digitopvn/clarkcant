import type { WidgetFixture } from "@clarkcant/contracts";
import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import { catalogEntry } from "@clarkcant/widget-catalog";

/**
 * What the dev host's builtin frame draws, and the page that draws it.
 *
 * Kept out of `catalog-runtime.tsx` for the same reason the shell's behaviour is kept out of its script: a decision
 * written inside a page cannot be tested without a browser, and `catalog-runtime.tsx` is a `.tsx` file the Node
 * config does not type-check. Here the decisions are plain data, and only the mount needs a browser.
 */

export interface CatalogRuntimeInput {
  definitionId: string;
  fixtureId: string;
}

export interface CatalogRuntimeTarget {
  entry: WidgetCatalogEntry;
  fixture: WidgetFixture;
}

/**
 * The entry and fixture to draw, or `undefined` when the frame was told something this build cannot draw.
 *
 * A fixture id that no longer exists falls back to the entry's first one rather than failing, because the shell's
 * fixture control lists what the entry has: a name that has gone means the page is one reload behind, not that the
 * request was wrong. A definition the catalog does not have is a real refusal, reported by returning `undefined`
 * rather than thrown, because the frame still has to leave the shell usable — the shell is where a person reads what
 * went wrong.
 */
export function catalogTarget(input: CatalogRuntimeInput): CatalogRuntimeTarget | undefined {
  const entry = catalogEntry(input.definitionId);
  if (entry === undefined) return undefined;
  const fixture = entry.fixtures.find((candidate) => candidate.id === input.fixtureId) ?? entry.fixtures[0];
  if (fixture === undefined) return undefined;
  return { entry, fixture };
}

/** JSON for a `<script>` body, with `<` escaped so no value can close the tag it sits in. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * The frame's page: a root element, what to draw, and the module that draws it.
 *
 * The definition id is safe in the title because it is a catalog id by the time it reaches here — `catalogTarget`
 * is what decides whether an id is one, and this page is only served for an id that resolved.
 */
export function catalogFrameHtml(input: CatalogRuntimeInput): string {
  return [
    "<!doctype html>",
    '<html lang="vi">',
    "  <head>",
    '    <meta charset="utf-8" />',
    `    <title>${input.definitionId}</title>`,
    "  </head>",
    "  <body>",
    '    <div id="cc-catalog-root"></div>',
    `    <script>window.__CC_CATALOG__ = ${scriptJson(input)};</script>`,
    '    <script type="module" src="/src/catalog-runtime.tsx"></script>',
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}
