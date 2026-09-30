import { describe, expect, it } from "vitest";

import {
  APPEARANCE_API_OLDEST,
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
    if (!future.ok) expect(future.problems[0]).toContain(`provides ${String(APPEARANCE_API_OLDEST)}–${String(APPEARANCE_API_VERSION)}`);
    expect(checkThemeDocument({ ...minimal, appearanceApi: { min: 2, max: 1 } }).ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const result = checkThemeDocument({ appearanceApi: { min: 1, max: 1 }, id: "", displayName: "", colors: { dark: { accent: "red" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("theme identity: recipes, effects and the rest of the look", () => {
  const v2 = { appearanceApi: { min: 2, max: 2 }, id: "neo", displayName: "Neo" };

  /** Refused, with a problem naming `path`. */
  function refusedAt(document: unknown, path: string): void {
    const result = checkThemeDocument(document);
    expect(result.ok, JSON.stringify(document)).toBe(false);
    if (!result.ok) expect(result.problems.join("\n"), JSON.stringify(document)).toContain(path);
  }

  it("accepts every recipe, effect and bounded parameter the host ships", () => {
    const full = checkThemeDocument({
      ...v2,
      typography: { body: "system", display: "serif", mono: "typewriter", headingWeight: 800 },
      border: { width: 3, style: "dashed" },
      shadow: { style: "hard", offset: 8, color: "accent" },
      motion: { speed: 0.5, easing: "stepped" },
      icons: { stroke: 2.5 },
      radius: { field: 0 },
      recipes: { button: "beveled", card: "raised", input: "underlined", modal: "framed", badge: "square", composer: "framed" },
      effects: { backdrop: { kind: "scanlines", intensity: 1, scale: 48 }, surface: { kind: "glass", intensity: 0 } },
      orb: { profile: "plasma", palette: { glowColor: [1, 0.5, 0] } },
    });
    expect(full.ok, full.ok ? "" : full.problems.join("\n")).toBe(true);
  });

  it("refuses selectors, CSS and markup wherever a recipe or effect is named", () => {
    for (const value of [
      ".cc-button { display: none }",
      "outlined; } .cc-approve { opacity: 0",
      "url(https://x.test/a.png)",
      "var(--cc-danger)",
      "<style>",
    ]) {
      refusedAt({ ...v2, recipes: { button: value } }, "recipes.button");
      refusedAt({ ...v2, effects: { backdrop: { kind: value } } }, "effects.backdrop.kind");
      refusedAt({ ...v2, effects: { surface: { kind: value } } }, "effects.surface.kind");
      refusedAt({ ...v2, typography: { body: value } }, "typography.body");
    }
    // A field for raw styling does not exist, at the top or inside a group.
    refusedAt({ ...v2, recipes: { button: "solid", css: "* { color: red }" } }, "recipes");
    refusedAt({ ...v2, effects: { backdrop: { kind: "grain", image: "url(x)" } } }, "effects.backdrop");
    refusedAt({ ...v2, selectors: { ".cc-stop": { display: "none" } } }, "document");
  });

  it("refuses a recipe, effect or component the host does not ship", () => {
    refusedAt({ ...v2, recipes: { button: "invisible" } }, "recipes.button");
    refusedAt({ ...v2, recipes: { approval: "flat" } }, "recipes");
    refusedAt({ ...v2, recipes: { card: "beveled" } }, "recipes.card");
    refusedAt({ ...v2, effects: { backdrop: { kind: "video" } } }, "effects.backdrop.kind");
    refusedAt({ ...v2, effects: { surface: { kind: "scanlines" } } }, "effects.surface.kind");
    refusedAt({ ...v2, orb: { profile: "custom" } }, "orb.profile");
    refusedAt({ ...v2, orb: { profile: "plasma", palette: { glowColor: [2, 0, 0] } } }, "orb.palette");
    refusedAt({ ...v2, orb: { profile: "plasma", palette: { fragmentShader: [0, 0, 0] } } }, "orb.palette");
    refusedAt({ ...v2, orb: { profile: "plasma", shader: "void main(){}" } }, "orb");
  });

  it("keeps every parameter inside its bounds", () => {
    for (const [document, path] of [
      [{ typography: { headingWeight: 900 } }, "typography.headingWeight"],
      [{ typography: { headingWeight: 450 } }, "typography.headingWeight"],
      [{ border: { width: 0 } }, "border.width"],
      [{ border: { width: 4 } }, "border.width"],
      [{ shadow: { offset: 9 } }, "shadow.offset"],
      [{ shadow: { offset: 0 } }, "shadow.offset"],
      [{ motion: { speed: 0.1 } }, "motion.speed"],
      [{ motion: { speed: 3 } }, "motion.speed"],
      [{ icons: { stroke: 4 } }, "icons.stroke"],
      [{ effects: { backdrop: { kind: "grain", intensity: 1.5 } } }, "effects.backdrop.intensity"],
      [{ effects: { backdrop: { kind: "grain", intensity: -0.1 } } }, "effects.backdrop.intensity"],
      [{ effects: { backdrop: { kind: "dot-grid", scale: 4 } } }, "effects.backdrop.scale"],
      [{ effects: { backdrop: { kind: "dot-grid", scale: 200 } } }, "effects.backdrop.scale"],
      [{ effects: { surface: { kind: "glass", intensity: 2 } } }, "effects.surface.intensity"],
      [{ radius: { field: 3 } }, "radius.field"],
    ] as const) {
      refusedAt({ ...v2, ...document }, path);
    }
  });

  it("refuses identity in a document that says an appearance API 1 build could draw it", () => {
    for (const field of [
      { recipes: { button: "solid" } },
      { effects: { backdrop: { kind: "grain" } } },
      { typography: { body: "serif" } },
      { orb: { profile: "calm" } },
      { radius: { field: 0.5 } },
    ]) {
      refusedAt({ ...v2, appearanceApi: { min: 1, max: 2 }, ...field }, "appearanceApi.min");
    }
    // A version 1 document without identity still loads.
    expect(checkThemeDocument({ ...v2, appearanceApi: { min: 1, max: 2 } }).ok).toBe(true);
  });
});
