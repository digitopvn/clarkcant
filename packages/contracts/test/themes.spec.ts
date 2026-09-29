import { describe, expect, it } from "vitest";

import {
  APPEARANCE_API_VERSION,
  BUILTIN_CLARK_THEME_REF,
  PREFERENCE_REGISTRY,
  checkThemeDocument,
  colorSchemeSchema,
  formatThemeRef,
  parseThemeRef,
  resolveColorScheme,
  themeRefSchema,
} from "../src/index.ts";

/**
 * The theme contract.
 *
 * A theme is data a stranger wrote, so the claims worth checking are the boundaries: which references parse, what a
 * theme document may say, and that anything outside that is refused with a reason rather than dropped or trusted.
 */

describe("theme references", () => {
  it("parses a built-in and a package reference, and formats each back to itself", () => {
    for (const value of [BUILTIN_CLARK_THEME_REF, "package:@community/pixel-arcade#pixel-arcade", "package:com.example.themes#neo@2"]) {
      const parts = parseThemeRef(value);
      expect(parts, value).toBeDefined();
      expect(formatThemeRef(parts!)).toBe(value);
    }
    expect(parseThemeRef("package:@community/pixel-arcade#pixel-arcade")).toEqual({
      kind: "package",
      packageId: "@community/pixel-arcade",
      facetId: "pixel-arcade",
    });
  });

  it("refuses anything that is not one of the two shapes", () => {
    for (const value of [
      "",
      "clark",
      "light",
      "builtin:",
      "builtin:Clark",
      "builtin:clark default",
      "package:",
      "package:#facet",
      "package:com.example",
      "package:com.example#",
      "package:com example#facet",
      "package:com.example#facet with space",
      "package:com.example#-facet",
      "https://example.com/theme.json",
      `builtin:${"a".repeat(80)}`,
      `package:${"a".repeat(200)}#facet`,
    ]) {
      expect(parseThemeRef(value), JSON.stringify(value)).toBeUndefined();
      expect(themeRefSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("colour scheme", () => {
  it("resolves System against the operating system and leaves an explicit choice alone", () => {
    expect(resolveColorScheme("system", true)).toBe("light");
    expect(resolveColorScheme("system", false)).toBe("dark");
    expect(resolveColorScheme("light", false)).toBe("light");
    expect(resolveColorScheme("dark", true)).toBe("dark");
  });

  it("is a preference of its own, separate from the theme", () => {
    expect(PREFERENCE_REGISTRY["experience.colorScheme"].default).toBe("system");
    expect(PREFERENCE_REGISTRY["experience.themeRef"].default).toBe(BUILTIN_CLARK_THEME_REF);
    expect(colorSchemeSchema.safeParse(BUILTIN_CLARK_THEME_REF).success).toBe(false);
    expect(themeRefSchema.safeParse("dark").success).toBe(false);
    expect("experience.theme" in PREFERENCE_REGISTRY).toBe(false);
  });
});

describe("theme documents", () => {
  const minimal = { appearanceApi: { min: 1, max: 1 }, id: "pixel-arcade", displayName: "Pixel Arcade" };

  it("accepts a minimal document and a full one", () => {
    expect(checkThemeDocument(minimal).ok).toBe(true);
    const full = checkThemeDocument({
      ...minimal,
      description: "Chunky pixels.",
      colors: { dark: { accent: "#C9B8FF" }, light: { accent: "#5A3FB0", canvas: "#FFFFFF" } },
      radius: { card: 0, modal: 2 },
    });
    expect(full).toMatchObject({ ok: true, document: { radius: { card: 0, modal: 2 } } });
  });

  it("refuses a value that could carry more than a colour into a stylesheet", () => {
    for (const accent of ["red", "#FFF", "#C9B8FFAA", "var(--cc-text)", "url(https://x.test/a.png)", "#C9B8FF; } *{", "rgb(0,0,0)"]) {
      const result = checkThemeDocument({ ...minimal, colors: { dark: { accent } } });
      expect(result.ok, accent).toBe(false);
      if (!result.ok) expect(result.problems.join("\n")).toContain("colors.dark.accent");
    }
  });

  it("refuses a field or a token this version does not know, rather than silently ignoring it", () => {
    for (const extra of [
      { ...minimal, css: "body { display: none }" },
      { ...minimal, script: "alert(1)" },
      { ...minimal, colors: { dark: { background: "#000000" } } },
      { ...minimal, colors: { dim: { accent: "#000000" } } },
      { ...minimal, radius: { pill: 0 } },
    ]) {
      expect(checkThemeDocument(extra).ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("keeps radii inside their bounds", () => {
    expect(checkThemeDocument({ ...minimal, radius: { card: -0.5 } }).ok).toBe(false);
    expect(checkThemeDocument({ ...minimal, radius: { card: 2.5 } }).ok).toBe(false);
    expect(checkThemeDocument({ ...minimal, radius: { card: "12px" } }).ok).toBe(false);
  });

  it("refuses a theme written for an appearance API this build does not provide, and says which", () => {
    const future = checkThemeDocument({ ...minimal, appearanceApi: { min: APPEARANCE_API_VERSION + 1, max: APPEARANCE_API_VERSION + 1 } });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.problems[0]).toContain(`provides ${String(APPEARANCE_API_VERSION)}`);
    expect(checkThemeDocument({ ...minimal, appearanceApi: { min: 2, max: 1 } }).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const result = checkThemeDocument({ appearanceApi: { min: 1, max: 1 }, id: "", displayName: "", colors: { dark: { accent: "red" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});
