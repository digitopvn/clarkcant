import { useCallback, useSyncExternalStore, type RefObject } from "react";
import { readAppearanceSnapshot, subscribeToAppearanceSnapshot } from "./appearance.ts";

/** Appearance belongs to the surface being drawn, including scoped Widget Lab previews. */
export function useWidgetAppearance(scope?: RefObject<Element | null>) {
  const read = useCallback(() => readAppearanceSnapshot(scope?.current), [scope]);
  const subscribe = subscribeToAppearanceSnapshot;
  return useSyncExternalStore(subscribe, read, read);
}
