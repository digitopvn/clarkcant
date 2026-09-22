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

import { WidgetPreview } from "@clarkcant/conversation-client";

import { catalogTarget, type CatalogRuntimeInput } from "./catalog-target.ts";

/**
 * Draws the target into `host`. Returns `false` when there was nothing this build could draw.
 *
 * The decision about what to draw is `catalogTarget` in `catalog-target.ts`; this only mounts it.
 */
export function mountCatalogPreview(input: CatalogRuntimeInput, host: HTMLElement): boolean {
  const target = catalogTarget(input);
  if (target === undefined) return false;
  createRoot(host).render(<WidgetPreview entry={target.entry} fixture={target.fixture} />);
  return true;
}

/*
 * The bootstrap. Absent in a test, where this module is imported for the function above: a test that mounted
 * anything would be a test that needs a browser, which is what the browser suite is for.
 *
 * The global is read through a cast rather than declared with `declare global`: that is a namespace, and this
 * workspace runs TypeScript by stripping types, which cannot execute one.
 */
const host = typeof document === "undefined" ? null : document.getElementById("cc-catalog-root");
const input =
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { __CC_CATALOG__?: CatalogRuntimeInput }).__CC_CATALOG__;
if (host !== null && input !== undefined) mountCatalogPreview(input, host);
