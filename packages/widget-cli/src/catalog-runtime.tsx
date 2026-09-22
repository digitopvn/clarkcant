/**
 * The catalog runtime, bundled for the dev host's frame.
 *
 * `clark widget dev --builtin <id>` shows a catalog widget in the same sandboxed shell a package's widget gets, so
 * an author can compare the two without opening a second window. It draws with the production renderer: this entry
 * mounts `WidgetPreview`, which calls the same `resolveRenderer` the conversation and the library call, so a builtin
 * preview cannot drift from what a person would see.
 *
 * This file exists for one reason: a browser cannot run the workspace's TypeScript, so the dev host needs a module it
 * can load. What to draw is plain data and is decided below, in functions a test can call without a browser.
 */
import { createRoot } from "react-dom/client";

import type { WidgetFixture } from "@clarkcant/contracts";
import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import { catalogEntry } from "@clarkcant/widget-catalog";
import { WidgetPreview } from "@clarkcant/conversation-client";

/** What the frame is told to draw: a catalog entry, and one of its fixtures. */
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
 * A missing fixture falls back to the entry's first one rather than failing, because the shell's fixture control
 * lists what the entry has: a name that no longer exists means the page is one reload behind, not that the request
 * was wrong. A missing entry is a real refusal, and it is reported by returning `undefined` rather than throwing —
 * the frame has to leave the shell usable, since the shell is where the author reads what went wrong.
 */
export function catalogTarget(input: CatalogRuntimeInput): CatalogRuntimeTarget | undefined {
  const entry = catalogEntry(input.definitionId);
  if (entry === undefined) return undefined;
  const fixture = entry.fixtures.find((candidate) => candidate.id === input.fixtureId) ?? entry.fixtures[0];
  if (fixture === undefined) return undefined;
  return { entry, fixture };
}

/** Draws the target into `host`. Returns `false` when there was nothing this build could draw. */
export function mountCatalogPreview(input: CatalogRuntimeInput, host: HTMLElement): boolean {
  const target = catalogTarget(input);
  if (target === undefined) return false;
  createRoot(host).render(<WidgetPreview entry={target.entry} fixture={target.fixture} />);
  return true;
}

declare global {
  interface Window {
    /** Set by the frame HTML, so the shell has exactly one way to say what to draw. */
    __CC_CATALOG__?: CatalogRuntimeInput;
  }
}

/*
 * The bootstrap. Absent in a test, where this module is imported for the functions above: a test that mounted
 * anything would be a test that needs a browser, which is what `apps/web/e2e` is for.
 */
const host = typeof document === "undefined" ? null : document.getElementById("cc-catalog-root");
const input = typeof window === "undefined" ? undefined : window.__CC_CATALOG__;
if (host !== null && input !== undefined) mountCatalogPreview(input, host);
