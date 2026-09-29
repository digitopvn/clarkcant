import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { themeStylesheet } from "@clarkcant/design-tokens";

import { APPEARANCE_ATTRIBUTE, APPEARANCE_STORAGE_KEY, applyAppearance, installStyleSheets } from "../src/appearance.ts";

/**
 * Applying a theme to a page that is already running.
 *
 * The claims are the ones a person would notice: a theme reaches the page without the component styles being touched,
 * a document the contract refuses is drawn as Clark Default rather than half-applied, and returning to Clark Default
 * draws exactly the stylesheet Clark always had.
 */

interface FakeStyle {
  dataset: Record<string, string>;
  textContent: string;
}

const appended: FakeStyle[] = [];
const root = { dataset: {} as Record<string, string> };
const stored = new Map<string, string>();
let original: unknown;
let originalStorage: unknown;

beforeAll(() => {
  original = (globalThis as { document?: unknown }).document;
  originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  };
  // No constructable sheets here, so the `<style>` fallback is what gets exercised; both paths replace one sheet.
  (globalThis as { document?: unknown }).document = {
    documentElement: root,
    head: { append: (...styles: FakeStyle[]) => appended.push(...styles) },
    createElement: (): FakeStyle => ({ dataset: {}, textContent: "" }),
  };
  installStyleSheets(".component { color: var(--cc-text); }");
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = original;
  (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
});

function tokens(): string {
  return appended[0]?.textContent ?? "";
}

function components(): string {
  return appended[1]?.textContent ?? "";
}

const DUSK = {
  appearanceApi: { min: 1, max: 1 },
  id: "dusk",
  displayName: "Dusk",
  colors: { dark: { accent: "#7AA2F7" } },
};

describe("applyAppearance", () => {
  it("starts on Clark Default, in a token sheet of its own ahead of the component sheet", () => {
    expect(appended.map((style) => style.dataset["clarkcant"])).toEqual(["tokens", "styles"]);
    expect(tokens()).toBe(themeStylesheet());
    expect(root.dataset[APPEARANCE_ATTRIBUTE]).toMatch(/^[0-9a-f]{16}-[0-9a-f]{16}$/);
  });

  it("replaces only the token sheet when a theme is applied", () => {
    const before = root.dataset[APPEARANCE_ATTRIBUTE];

    const applied = applyAppearance({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" });

    expect(applied).toMatchObject({ ok: true, themeRef: "package:com.example.dusk#dusk" });
    expect(tokens()).toContain("--cc-accent: #7AA2F7;");
    expect(components()).toBe(".component { color: var(--cc-text); }");
    expect(root.dataset[APPEARANCE_ATTRIBUTE]).not.toBe(before);
    expect(appended).toHaveLength(2);
  });

  it("draws Clark Default, and says why, when the document is not one the contract accepts", () => {
    const hostile = { ...DUSK, colors: { dark: { accent: "red; } body { display: none" } } };

    const applied = applyAppearance({ theme: hostile, themeRef: "package:com.example.dusk#dusk" });

    expect(applied).toMatchObject({ ok: false, themeRef: "builtin:clark" });
    expect(applied.ok === false && applied.problem).toMatch(/colors\.dark\.accent/);
    expect(tokens()).toBe(themeStylesheet());
    expect(tokens()).not.toContain("display: none");
  });

  it("refuses a theme whose colours fail the contrast audit, draws Clark Default, and names the pairs", () => {
    applyAppearance({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" });
    const dim = { ...DUSK, colors: { dark: { accent: "#3A3470" } } };

    const applied = applyAppearance({ theme: dim, themeRef: "package:com.example.dusk#dusk" });

    expect(applied).toMatchObject({ ok: false, themeRef: "builtin:clark" });
    expect(applied.ok === false && applied.problem).toMatch(/in the dark scheme, accent text on the page is 1\.69:1 and needs 4\.5:1/);
    expect(tokens()).toBe(themeStylesheet());
    expect(tokens()).not.toContain("#3A3470");
    expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });

  it("returns to exactly the stylesheet Clark Default always had", () => {
    applyAppearance({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" });

    const applied = applyAppearance({ theme: null, themeRef: "builtin:clark" });

    expect(applied).toMatchObject({ ok: true, themeRef: "builtin:clark" });
    expect(tokens()).toBe(themeStylesheet());
  });
});

describe("the theme a page starts in", () => {
  it("remembers the last theme drawn on this device, and forgets it on Clark Default", () => {
    applyAppearance({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" });
    expect(JSON.parse(stored.get(APPEARANCE_STORAGE_KEY) ?? "null")).toEqual({
      theme: DUSK,
      themeRef: "package:com.example.dusk#dusk",
    });

    applyAppearance({ theme: null, themeRef: "builtin:clark" });
    expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });

  it("starts a new page in the remembered theme, checked like any other document", async () => {
    stored.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" }));
    appended.length = 0;
    vi.resetModules();
    const fresh = await import("../src/appearance.ts");

    fresh.installStyleSheets(".component {}");

    expect(tokens()).toContain("--cc-accent: #7AA2F7;");
  });

  it("starts on Clark Default when what was remembered is not a document the contract accepts", async () => {
    stored.set(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ theme: { ...DUSK, colors: { dark: { accent: "url(https://example.com)" } } }, themeRef: "x" }),
    );
    appended.length = 0;
    vi.resetModules();
    const fresh = await import("../src/appearance.ts");

    fresh.installStyleSheets(".component {}");

    expect(tokens()).toBe(themeStylesheet());
    expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });

  it("starts on Clark Default when the remembered theme is one whose colours fail the contrast audit", async () => {
    stored.set(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ theme: { ...DUSK, colors: { dark: { accent: "#3A3470" } } }, themeRef: "package:com.example.dusk#dusk" }),
    );
    appended.length = 0;
    vi.resetModules();
    const fresh = await import("../src/appearance.ts");

    fresh.installStyleSheets(".component {}");

    expect(tokens()).toBe(themeStylesheet());
    expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });

  it("still installs the component styles, and draws Clark Default, when building a stylesheet throws at load", async () => {
    stored.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" }));
    appended.length = 0;
    vi.resetModules();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The compiler throws for every input: the worst a broken build can do to the first paint.
    vi.doMock("@clarkcant/design-tokens", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@clarkcant/design-tokens")>()),
      compileAppearance: () => {
        throw new Error("the compiler is broken");
      },
    }));
    try {
      const fresh = await import("../src/appearance.ts");

      expect(() => fresh.installStyleSheets(".component { color: var(--cc-text); }")).not.toThrow();

      expect(appended.map((style) => style.dataset["clarkcant"])).toEqual(["tokens", "styles"]);
      expect(components()).toBe(".component { color: var(--cc-text); }");
      expect(tokens()).toBe("");
      expect(root.dataset[APPEARANCE_ATTRIBUTE]).toBe(fresh.APPEARANCE_UNAVAILABLE);
      expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
      expect(errors).toHaveBeenCalled();
    } finally {
      vi.doUnmock("@clarkcant/design-tokens");
      errors.mockRestore();
    }
  });

  it("draws Clark Default at load when the page refuses the remembered theme's sheet", async () => {
    stored.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" }));
    appended.length = 0;
    vi.resetModules();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = globalThis.document as unknown as { createElement: () => FakeStyle };
    const createElement = fake.createElement;
    // An engine that will not take the themed sheet: the write throws, the way replacing a locked sheet does.
    fake.createElement = (): FakeStyle => {
      let text = "";
      return {
        dataset: {},
        get textContent() {
          return text;
        },
        set textContent(value: string) {
          if (value.includes("#7AA2F7")) throw new Error("the sheet cannot be replaced now");
          text = value;
        },
      };
    };
    try {
      const fresh = await import("../src/appearance.ts");

      expect(() => fresh.installStyleSheets(".component {}")).not.toThrow();

      expect(tokens()).toBe(themeStylesheet());
      expect(components()).toBe(".component {}");
      expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
      expect(errors).toHaveBeenCalled();
    } finally {
      fake.createElement = createElement;
      errors.mockRestore();
    }
  });

  it("draws Clark Default at load when only the remembered theme fails to compile", async () => {
    stored.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ theme: DUSK, themeRef: "package:com.example.dusk#dusk" }));
    appended.length = 0;
    vi.resetModules();
    vi.doMock("@clarkcant/design-tokens", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@clarkcant/design-tokens")>();
      return {
        ...actual,
        compileAppearance: (input: Parameters<typeof actual.compileAppearance>[0]) => {
          if (input.theme !== undefined) throw new Error("this theme does not compile");
          return actual.compileAppearance(input);
        },
      };
    });
    try {
      const fresh = await import("../src/appearance.ts");

      fresh.installStyleSheets(".component {}");

      expect(tokens()).toBe(themeStylesheet());
      expect(stored.has(APPEARANCE_STORAGE_KEY)).toBe(false);
    } finally {
      vi.doUnmock("@clarkcant/design-tokens");
    }
  });
});