import { appearanceSnapshotSchema } from "@clarkcant/contracts";
import { appearanceDeclarations } from "@clarkcant/design-tokens";
import type { ReadonlyAppearanceSnapshot, WidgetAuthorApi } from "./index.ts";

/** An element supplied by the author. The core runtime never acquires a document or host window. */
export interface AppearanceElement {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
  setAttribute(name: string, value: string): void;
}

/** Apply only checked public variables to this element; never arbitrary CSS or selectors. */
export function applyAppearanceToElement(element: AppearanceElement, snapshot: ReadonlyAppearanceSnapshot): void {
  const checked = appearanceSnapshotSchema.parse(snapshot);
  for (const [name, value] of Object.entries(appearanceDeclarations(checked))) {
    if (value === undefined) element.style.removeProperty(name);
    else element.style.setProperty(name, value);
  }
  element.setAttribute("data-cc-theme", checked.scheme);
  element.setAttribute("data-cc-appearance", checked.revision);
}

/** Bind before or after init. Unsubscribe when the author's surface is removed. */
export function bindAppearance(element: AppearanceElement, appearance: WidgetAuthorApi["appearance"]): () => void {
  const current = appearance.current();
  if (current !== undefined) applyAppearanceToElement(element, current);
  return appearance.subscribe((snapshot) => applyAppearanceToElement(element, snapshot));
}
