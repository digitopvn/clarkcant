import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import { searchCatalog } from "@clarkcant/widget-catalog";

/**
 * The library surface as a state machine.
 *
 * Kept as plain functions rather than component state so the parts that are easy to get wrong -
 * filtering, selection, and what "close" restores - are testable in Node without a DOM. The
 * components only render what this returns.
 *
 * `close` returns the closed state exactly, rather than remembering the last query: the library is a
 * look-up surface, and reopening it on a stale filter hides the catalog the person came back to see.
 */

export type LibraryMode = "browse" | "develop";

export interface WidgetLibraryTarget {
  definitionId?: string;
  family?: string;
}

export interface WidgetLibraryState {
  open: boolean;
  mode: LibraryMode;
  query: string;
  /** `"all"` rather than `undefined` so the facet strip always has a selected member. */
  family: string;
  selectedId: string | undefined;
}

export const CLOSED_LIBRARY: WidgetLibraryState = {
  open: false,
  mode: "browse",
  query: "",
  family: "all",
  selectedId: undefined,
};

export type WidgetLibraryAction =
  | { kind: "open"; mode?: LibraryMode; target?: WidgetLibraryTarget }
  | { kind: "close" }
  | { kind: "query"; value: string }
  | { kind: "family"; value: string }
  | { kind: "select"; cardId: string }
  | { kind: "back" };

export function applyLibraryAction(
  state: WidgetLibraryState,
  action: WidgetLibraryAction,
): WidgetLibraryState {
  switch (action.kind) {
    case "open": {
      const target = action.target;
      // A spoken "show me the calendar widget" lands on the widget rather than on the grid, because
      // landing on the grid would make the person repeat themselves.
      const selectedId = target?.definitionId;
      const family = selectedId === undefined && target?.family !== undefined ? target.family : "all";
      return {
        open: true,
        mode: action.mode ?? "browse",
        query: "",
        family,
        selectedId,
      };
    }
    case "close":
      return CLOSED_LIBRARY;
    case "query":
      return { ...state, query: action.value, selectedId: undefined };
    case "family":
      return { ...state, family: action.value, selectedId: undefined };
    case "select":
      return { ...state, selectedId: action.cardId };
    case "back":
      // Back leaves the filter and the query alone: the person is going back one step, not resetting.
      return { ...state, selectedId: undefined };
    default:
      return state;
  }
}

export function familyFacets(entries: readonly WidgetCatalogEntry[]): readonly string[] {
  return ["all", ...[...new Set(entries.map((entry) => entry.family))].sort((a, b) => a.localeCompare(b))];
}

/** Entries the current filter shows, best match first. */
export function visibleEntries(
  entries: readonly WidgetCatalogEntry[],
  state: WidgetLibraryState,
): readonly WidgetCatalogEntry[] {
  const byFamily =
    state.family === "all" ? entries : entries.filter((entry) => entry.family === state.family);
  return searchCatalog(byFamily, state.query);
}

/** The entry the detail view is showing, when the id still resolves. */
export function selectedEntry(
  entries: readonly WidgetCatalogEntry[],
  state: WidgetLibraryState,
): WidgetCatalogEntry | undefined {
  if (state.selectedId === undefined) return undefined;
  return entries.find((entry) => entry.cardId === state.selectedId);
}
