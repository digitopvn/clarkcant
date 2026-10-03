import { useEffect, useState } from "react";

/**
 * Whether an element is near enough to the screen that its bytes are worth reading.
 *
 * Used by the players, which read their source only when they are about to be seen or the person presses play. "Near"
 * is half a screen above or below what is visible, so a player that is scrolled to is usually ready by the time it
 * arrives, while a conversation's older recordings are never read just because the conversation was opened.
 */

/** How far beyond the visible part of the scroll area an element counts as near: half its height, above and below. */
export const NEAR_VIEWPORT_MARGIN = "50% 0px";

/** The part of `IntersectionObserver` used here, so a test can stand in for it. */
export type NearObserverConstructor = new (
  callback: (entries: readonly { isIntersecting: boolean }[]) => void,
  options: { root: Element | null; rootMargin: string },
) => { observe: (target: Element) => void; disconnect: () => void };

/**
 * The scroll area an element is seen through: its nearest ancestor that scrolls vertically, or `null` for the page.
 *
 * The transcript scrolls inside its own element rather than the page. An observer rooted at the page clips the element
 * by that scroll area first, so its margin would never reach past the area's edge and "near" would mean "visible";
 * rooted at the area itself, the margin is measured where the scrolling happens.
 */
export function scrollRootOf(element: Element, overflowOf: (element: Element) => string): Element | null {
  for (let current = element.parentElement; current !== null; current = current.parentElement) {
    const overflow = overflowOf(current);
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return current;
  }
  return null;
}

/**
 * Calls `onNear` once, the first time `element` comes near its scroll area's visible part, and returns how to stop.
 *
 * Without an observer (an old engine, or one that refuses the options) nothing is ever called near: the player then
 * waits for the person to press play, which reads the same bytes on request. That is the honest fallback - reading
 * every recording at once is what this exists to stop, and guessing at scroll positions would be a second, worse
 * observer.
 */
export function observeNearViewport(input: {
  element: Element;
  onNear: () => void;
  Observer: NearObserverConstructor | undefined;
  overflowOf: (element: Element) => string;
}): () => void {
  if (input.Observer === undefined) return () => undefined;
  let done = false;
  let observer: InstanceType<NearObserverConstructor>;
  try {
    observer = new input.Observer(
      (entries) => {
        if (done || !entries.some((entry) => entry.isIntersecting)) return;
        done = true;
        observer.disconnect();
        input.onNear();
      },
      { root: scrollRootOf(input.element, input.overflowOf), rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    observer.observe(input.element);
  } catch {
    return () => undefined;
  }
  return () => {
    done = true;
    observer.disconnect();
  };
}

/**
 * Whether `element` has come near the screen; once it has, it stays so.
 *
 * The element is passed as a value (from a callback ref) rather than a ref object, so a placeholder that is drawn
 * after the first render is still observed. `watching` is false when there is nothing left to wait for (the bytes are
 * already read), so no observer is kept.
 */
export function useNearViewport(element: Element | null, watching: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!watching || near || element === null) return undefined;
    const Observer = (globalThis as { IntersectionObserver?: NearObserverConstructor }).IntersectionObserver;
    return observeNearViewport({
      element,
      onNear: () => setNear(true),
      Observer,
      overflowOf: (candidate) => getComputedStyle(candidate).overflowY,
    });
  }, [element, near, watching]);
  return near;
}
