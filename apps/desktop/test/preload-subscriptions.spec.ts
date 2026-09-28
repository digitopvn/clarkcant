import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The preload's named subscriptions, loaded against a stand-in `electron`.
 *
 * What only this proves: that a renderer surface which subscribes and later unmounts leaves no listener behind.
 * A listener the preload never removes keeps firing its stale closure on every future event, one more per remount.
 */

type Listener = (...args: unknown[]) => void;

interface Bridge {
  onWidgetReattached(callback: (payload: unknown) => void): () => void;
  onNotificationClicked(callback: () => void): () => void;
}

function loadPreload(): { bridge: Bridge; listeners: Map<string, Set<Listener>> } {
  const listeners = new Map<string, Set<Listener>>();
  let exposed: Bridge | undefined;
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name: string, value: Bridge) {
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
  const path = fileURLToPath(new URL("../src/preload.cjs", import.meta.url));
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
});
