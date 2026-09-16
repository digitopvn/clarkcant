import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME_CHOICE,
  PREPAINT_SCRIPT_PATH,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  isThemeChoice,
  readDocumentTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  subscribeToDocumentTheme,
  systemPrefersLight,
  watchSystemTheme,
} from "../src/theme.ts";

/**
 * The theme choice.
 *
 * The distinctions under test are the ones that break quietly: a choice stored as its resolved
 * value, a `system` preference that stops following the system, and a parse helper that throws on
 * the one case it exists to survive.
 */

function fakeStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  read: () => Record<string, string>;
} {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    read: () => data,
  };
}

describe("a theme choice", () => {
  it("accepts exactly the three choices and nothing else", () => {
    for (const value of ["dark", "light", "system"]) expect(isThemeChoice(value), value).toBe(true);
    for (const value of ["Dark", "auto", "", null, undefined, 0, {}, ["dark"]]) {
      expect(isThemeChoice(value), String(value)).toBe(false);
    }
  });

  it("defaults to following the system rather than to a fixed theme", () => {
    // The unreadable-preference case is first run, and following the operating system is the
    // answer that is wrong for the fewest people.
    expect(DEFAULT_THEME_CHOICE).toBe("system");
    expect(readStoredTheme(fakeStorage())).toBe("system");
  });

  it("returns the stored choice when there is one", () => {
    expect(readStoredTheme(fakeStorage({ "cc.theme": "light" }))).toBe("light");
    expect(readStoredTheme(fakeStorage({ "cc.theme": "dark" }))).toBe("dark");
  });

  it("falls back rather than trusting a stored value it did not write", () => {
    // Someone editing localStorage by hand, or a future version that renamed a choice.
    expect(readStoredTheme(fakeStorage({ "cc.theme": "sepia" }))).toBe("system");
  });

  it("survives storage that throws on read", () => {
    // Some privacy configurations throw instead of returning null, and a theme is not worth a
    // broken page.
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => readStoredTheme(throwing)).not.toThrow();
    expect(readStoredTheme(throwing)).toBe("system");
  });

  it("stores the choice, not the theme it resolved to", () => {
    // Storing the resolved value is the bug this whole module is arranged to avoid: it would
    // silently turn `system` into whichever theme the machine was in at the time.
    const storage = fakeStorage();
    storeTheme("system", storage);
    expect(storage.read()["cc.theme"]).toBe("system");
  });

  it("survives storage that throws on write", () => {
    const throwing = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => storeTheme("light", throwing)).not.toThrow();
  });
});

describe("resolving a choice", () => {
  it("resolves system through the operating system preference", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("ignores the system preference when the user made an explicit choice", () => {
    // Otherwise someone who picked dark gets a light interface at night, which is the opposite
    // of what they asked for.
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("answers dark when there is no media query to consult", () => {
    const original = globalThis.matchMedia;
    // @ts-expect-error deliberately removing a DOM global to exercise the fallback.
    delete globalThis.matchMedia;
    try {
      expect(systemPrefersLight()).toBe(false);
      // A no-op rather than a throw: a theme is not a reason to fail a render.
      expect(() => watchSystemTheme(() => {})()).not.toThrow();
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it("follows the media query and stops when the returned function is called", () => {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    globalThis.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
    })) as unknown as typeof matchMedia;

    const seen: boolean[] = [];
    const stop = watchSystemTheme((prefersLight) => seen.push(prefersLight));

    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener({ matches: true });
    expect(seen).toEqual([true]);

    // Stopping has to actually unsubscribe: a listener that outlives its component holds a
    // setState from an unmounted tree.
    stop();
    expect(listeners.size).toBe(0);
  });

  it("does not throw when the query itself is unavailable", () => {
    globalThis.matchMedia = (() => {
      throw new Error("matchMedia is not supported");
    }) as unknown as typeof matchMedia;
    expect(() => watchSystemTheme(() => {})()).not.toThrow();
    expect(systemPrefersLight()).toBe(false);
    // Restore something harmless for any later test in this file.
    globalThis.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof matchMedia;
  });
});

describe("the pre-paint script", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));

  it("agrees with the module about the storage key and the attribute", () => {
    // The logic is duplicated on purpose (an inline script would violate the page's CSP), so this
    // test is what stops the two copies from drifting apart without anyone noticing. It compares
    // against the module's own constants rather than against copies of the strings — a test that
    // restates the literal would keep passing while the real values diverged.
    const script = readFileSync(`${here}../../../${PREPAINT_SCRIPT_PATH}`, "utf8");
    const html = readFileSync(`${here}../../../apps/web/index.html`, "utf8");

    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(script).toContain(`dataset.${THEME_ATTRIBUTE}`);
    // The script has to be reachable at all, and it has to be an external file: the policy is
    // script-src 'self', so an inline one would never run.
    expect(html).toContain(`src="/${PREPAINT_SCRIPT_PATH.split("/").pop()}"`);
    expect(html).not.toContain(`dataset.${THEME_ATTRIBUTE}`); // no second inline copy
    expect(html).toContain("script-src 'self'");
  });

  it("treats a missing or unrecognised choice as system, matching the module", () => {
    const script = readFileSync(`${fileURLToPath(new URL(".", import.meta.url))}../../../apps/web/public/theme-init.js`, "utf8");
    // `choice !== "dark"` is what makes an absent or unrecognised value fall through to the
    // media query, which is the same answer `resolveTheme("system", …)` gives.
    expect(script).toContain('choice !== "dark"');
    expect(script).toContain("prefers-color-scheme: light");
  });
});

/**
 * The document attribute is what the CSS paints from, so it is what a canvas has to read. These
 * tests exist because the orb reads it, and an orb that reads a stale colour draws a visible
 * rectangle over the page — a bug that is invisible in a unit test and obvious in a screenshot.
 */
describe("the document's theme attribute", () => {
  interface FakeDocument {
    documentElement: { dataset: Record<string, string> };
  }

  function withDocument(run: (doc: FakeDocument) => void): void {
    const original = (globalThis as { document?: unknown }).document;
    const doc: FakeDocument = { documentElement: { dataset: {} } };
    (globalThis as { document?: unknown }).document = doc;
    try {
      run(doc);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  }

  it("answers dark when there is no document at all", () => {
    // Rendering outside a browser is a normal case, not a failure.
    const original = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      expect(readDocumentTheme()).toBe("dark");
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });

  it("reads the attribute rather than a stored preference", () => {
    // The attribute is already resolved, so `system` never reaches here — a canvas must match what
    // is painted, not what was chosen.
    withDocument((doc) => {
      doc.documentElement.dataset.ccTheme = "light";
      expect(readDocumentTheme()).toBe("light");
      doc.documentElement.dataset.ccTheme = "dark";
      expect(readDocumentTheme()).toBe("dark");
    });
  });

  it("treats an unrecognised attribute as dark rather than as light", () => {
    withDocument((doc) => {
      doc.documentElement.dataset.ccTheme = "sepia";
      expect(readDocumentTheme()).toBe("dark");
    });
  });

  it("notifies on a theme change and stops when unsubscribed", () => {
    const observed: string[] = [];
    const disconnected: string[] = [];
    const created: { fire: () => void }[] = [];
    class FakeObserver {
      // A parameter property would be shorter and is banned here: Node strips types without
      // transforming syntax that has runtime meaning, and the repo guards that with an invariant.
      readonly onFire: () => void;
      constructor(onFire: () => void) {
        this.onFire = onFire;
      }
      observe(_target: unknown, options: { attributeFilter?: string[] }): void {
        observed.push((options.attributeFilter ?? []).join(","));
        created.push(this);
      }
      disconnect(): void {
        disconnected.push("yes");
        this.live = false;
      }
      fire(): void {
        // Models the real observer: after `disconnect()` it delivers nothing. A fake that keeps
        // delivering would make the assertion below pass for the wrong reason.
        if (this.live) this.onFire();
      }
      live = true;
    }
    const original = (globalThis as { MutationObserver?: unknown }).MutationObserver;
    (globalThis as { MutationObserver?: unknown }).MutationObserver = FakeObserver;

    try {
      withDocument(() => {
        let fired = 0;
        const stop = subscribeToDocumentTheme(() => {
          fired += 1;
        });
        // The filter matters: observing every attribute would fire on each widget's own DOM churn.
        expect(observed).toEqual(["data-cc-theme"]);

        // The callback has to actually run when the attribute changes, or the orb would recreate
        // itself on every mutation of the page and never on the one change it cares about.
        created[0]!.fire();
        expect(fired).toBe(1);

        stop();
        expect(disconnected).toHaveLength(1);
        // Once unsubscribed, a late mutation must not call back into an unmounted component.
        created[0]!.fire();
        expect(fired).toBe(1);
      });
    } finally {
      (globalThis as { MutationObserver?: unknown }).MutationObserver = original;
    }
  });

  it("is a no-op rather than a throw when there is no document", () => {
    const original = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      expect(() => subscribeToDocumentTheme(() => {})()).not.toThrow();
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });
});
