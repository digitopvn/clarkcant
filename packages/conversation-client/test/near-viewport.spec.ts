import { describe, expect, it } from "vitest";

import { NEAR_VIEWPORT_MARGIN, type NearObserverConstructor, observeNearViewport, scrollRootOf } from "../src/near-viewport.ts";

/**
 * When a player counts as near the screen, so that its bytes are read before it is seen and not before.
 *
 * The observer is a stand-in here: what is checked is which scroll area it is rooted at, the margin it is given, that
 * the player is told once, and that an engine without an observer leaves the player waiting for a press of Play.
 */

interface FakeElement {
  name: string;
  parentElement: FakeElement | null;
}

function chain(...names: string[]): FakeElement {
  let parent: FakeElement | null = null;
  for (const name of names) parent = { name, parentElement: parent };
  if (parent === null) throw new Error("no elements");
  return parent;
}

const asElement = (element: FakeElement): Element => element as unknown as Element;

function fakeObserver() {
  const made: { root: Element | null; rootMargin: string; observed: Element[]; disconnected: boolean; fire: (near: boolean) => void }[] = [];
  const Observer = class {
    record: (typeof made)[number];
    constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void, options: { root: Element | null; rootMargin: string }) {
      this.record = {
        root: options.root,
        rootMargin: options.rootMargin,
        observed: [],
        disconnected: false,
        fire: (near) => callback([{ isIntersecting: near }]),
      };
      made.push(this.record);
    }
    observe(target: Element): void {
      this.record.observed.push(target);
    }
    disconnect(): void {
      this.record.disconnected = true;
    }
  } as unknown as NearObserverConstructor;
  return { Observer, made };
}

describe("near the screen", () => {
  it("roots the observer at the nearest ancestor that scrolls, not at the page", () => {
    const player = chain("page", "transcript", "message", "player");
    const overflow = (element: Element) => ((element as unknown as FakeElement).name === "transcript" ? "auto" : "visible");
    expect((scrollRootOf(asElement(player), overflow) as unknown as FakeElement | null)?.name).toBe("transcript");
    expect(scrollRootOf(asElement(player), () => "visible")).toBeNull();
    expect((scrollRootOf(asElement(player), (element) => ((element as unknown as FakeElement).name === "page" ? "scroll" : "hidden")) as unknown as FakeElement | null)?.name).toBe("page");
  });

  it("tells the player once, the first time it comes near, and stops observing", () => {
    const { Observer, made } = fakeObserver();
    const player = chain("transcript", "player");
    let told = 0;
    observeNearViewport({ element: asElement(player), onNear: () => (told += 1), Observer, overflowOf: () => "auto" });
    const observer = made[0];
    expect(observer?.rootMargin).toBe(NEAR_VIEWPORT_MARGIN);
    expect((observer?.root as unknown as FakeElement | null)?.name).toBe("transcript");
    expect(observer?.observed).toEqual([asElement(player)]);

    observer?.fire(false);
    expect(told).toBe(0);
    observer?.fire(true);
    observer?.fire(true);
    expect(told).toBe(1);
    expect(observer?.disconnected).toBe(true);
  });

  it("never tells a player that went away before it came near", () => {
    const { Observer, made } = fakeObserver();
    let told = 0;
    const stop = observeNearViewport({ element: asElement(chain("player")), onNear: () => (told += 1), Observer, overflowOf: () => "visible" });
    stop();
    made[0]?.fire(true);
    expect(told).toBe(0);
    expect(made[0]?.disconnected).toBe(true);
  });

  it("leaves the player waiting for a press of Play when there is no observer, or the observer refuses", () => {
    let told = 0;
    const none = observeNearViewport({ element: asElement(chain("player")), onNear: () => (told += 1), Observer: undefined, overflowOf: () => "auto" });
    none();
    const Refusing = class {
      constructor() {
        throw new Error("rootMargin not supported");
      }
    } as unknown as NearObserverConstructor;
    const refused = observeNearViewport({ element: asElement(chain("player")), onNear: () => (told += 1), Observer: Refusing, overflowOf: () => "auto" });
    refused();
    expect(told).toBe(0);
  });
});
