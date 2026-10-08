import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DETACHED_PERFORM_LIMITS } from "../src/detached-window.mjs";

/**
 * The preload's named subscriptions, loaded against a stand-in `electron`.
 *
 * What only this proves: that a renderer surface which subscribes and later unmounts leaves no listener behind.
 * A listener the preload never removes keeps firing its stale closure on every future event, one more per remount.
 */

type Listener = (...args: unknown[]) => void;

interface Bridge {
  onWidgetReattached(callback: (payload: unknown) => void): () => void;
  onNotificationClicked(callback: (payload: { target?: unknown }) => void): () => void;
}

function loadPreload<T = Bridge>(file = "preload.cjs"): { bridge: T; listeners: Map<string, Set<Listener>> } {
  const listeners = new Map<string, Set<Listener>>();
  let exposed: T | undefined;
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name: string, value: T) {
        exposed = value;
      },
    },
    ipcRenderer: {
      on(channel: string, listener: Listener) {
        const set = listeners.get(channel) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(channel, set);
      },
      removeListener(channel: string, listener: Listener) {
        listeners.get(channel)?.delete(listener);
      },
      invoke() {
        return Promise.resolve(undefined);
      },
    },
  };
  const require = createRequire(import.meta.url);
  const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
  const electronPath = require.resolve("electron");
  delete require.cache[path];
  const previous = require.cache[electronPath];
  // SAFETY: a minimal module record; the preload only reads `exports` from it.
  require.cache[electronPath] = { exports: electron } as unknown as NodeJS.Module;
  try {
    require(path);
  } finally {
    if (previous === undefined) delete require.cache[electronPath];
    else require.cache[electronPath] = previous;
  }
  if (exposed === undefined) throw new Error("the preload exposed no bridge");
  return { bridge: exposed, listeners };
}

describe("preload subscriptions", () => {
  it("removes the reattach listener when the surface unsubscribes", () => {
    const { bridge, listeners } = loadPreload();
    const seen: unknown[] = [];
    const unsubscribe = bridge.onWidgetReattached((payload) => seen.push(payload));
    const channel = listeners.get("desktop:widgetReattached");
    expect(channel?.size).toBe(1);
    for (const listener of channel ?? []) listener({}, { instanceRef: "w1" });
    expect(seen).toEqual([{ instanceRef: "w1" }]);

    unsubscribe();
    expect(listeners.get("desktop:widgetReattached")?.size).toBe(0);
  });

  it("does not pile up listeners across remounts", () => {
    const { bridge, listeners } = loadPreload();
    for (let mount = 0; mount < 3; mount += 1) {
      const off = bridge.onWidgetReattached(() => undefined);
      off();
    }
    const keep = bridge.onNotificationClicked(() => undefined);
    expect(listeners.get("desktop:widgetReattached")?.size).toBe(0);
    expect(listeners.get("desktop:notificationClicked")?.size).toBe(1);
    keep();
    expect(listeners.get("desktop:notificationClicked")?.size).toBe(0);
  });

  it("passes a clicked notification's target on as a copied string, and nothing else from the IPC payload", () => {
    const { bridge, listeners } = loadPreload();
    const seen: unknown[] = [];
    const off = bridge.onNotificationClicked((payload) => seen.push(payload));
    const fire = (payload: unknown) => {
      for (const listener of listeners.get("desktop:notificationClicked") ?? []) listener({ sender: "ipc" }, payload);
    };
    fire({ target: "notice:ntf_1", extra: "dropped" });
    fire({ target: { toString: () => "notice:ntf_1" } });
    fire(undefined);
    expect(seen).toEqual([{ target: "notice:ntf_1" }, {}, {}]);
    off();
  });
});

describe("the detached preload's performs", () => {
  interface DetachedBridge {
    onPerform(callback: (push: unknown) => void): () => void;
  }
  const push = (listeners: Map<string, Set<Listener>>, performId: string) => {
    for (const listener of listeners.get("detached:perform") ?? []) listener({ sender: "ipc" }, { performId, action: "format", input: {} });
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a perform pushed before the page listened to the page when it subscribes, once", () => {
    const { bridge, listeners } = loadPreload<DetachedBridge>("detached-preload.cjs");
    push(listeners, "perform_early");
    const seen: unknown[] = [];
    const off = bridge.onPerform((value) => seen.push(value));
    expect(seen).toEqual([{ performId: "perform_early", action: "format", input: {} }]);
    push(listeners, "perform_next");
    expect(seen).toHaveLength(2);
    off();

    // Held for the next subscriber, while unsubscribed, and handed over only once.
    push(listeners, "perform_between");
    const again: unknown[] = [];
    const offAgain = bridge.onPerform((value) => again.push(value));
    expect(again).toEqual([{ performId: "perform_between", action: "format", input: {} }]);
    offAgain();
    const third: unknown[] = [];
    bridge.onPerform((value) => third.push(value))();
    expect(third).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it("drops a held perform once the host has stopped waiting on it", () => {
    vi.useFakeTimers();
    const { bridge, listeners } = loadPreload<DetachedBridge>("detached-preload.cjs");
    push(listeners, "perform_in_time");
    vi.advanceTimersByTime(DETACHED_PERFORM_LIMITS.answerWithinMs - 1);
    const seen: { performId?: string }[] = [];
    bridge.onPerform((value) => seen.push(value as { performId?: string }))();
    expect(seen.map((value) => value.performId)).toEqual(["perform_in_time"]);

    push(listeners, "perform_too_late");
    vi.advanceTimersByTime(DETACHED_PERFORM_LIMITS.answerWithinMs);
    const late: unknown[] = [];
    bridge.onPerform((value) => late.push(value))();
    expect(late).toEqual([]);
  });
});
