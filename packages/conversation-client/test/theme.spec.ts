import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME_CHOICE,
  isThemeChoice,
  readStoredTheme,
  resolveTheme,
  storeTheme,
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
    // The logic is duplicated on purpose (an inline script would violate the page's CSP), so
    // this test is what stops the two copies from drifting apart without anyone noticing.
    const script = readFileSync(`${here}../../../apps/web/public/theme-init.js`, "utf8");
    const html = readFileSync(`${here}../../../apps/web/index.html`, "utf8");

    expect(script).toContain('localStorage.getItem("cc.theme")');
    expect(script).toContain("dataset.ccTheme");
    // The script has to be reachable at all, and it has to be an external file: the policy is
    // `script-src 'self'`, so an inline one would never run.
    expect(html).toContain('src="/theme-init.js"');
    expect(html).not.toContain("dataset.ccTheme"); // no second inline copy
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
