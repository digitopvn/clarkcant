import { describe, expect, it } from "vitest";

import {
  THEME_BACKDROP_EFFECTS,
  THEME_RECIPES,
  THEME_SURFACE_EFFECTS,
  checkThemeDocument,
  type ThemeDocument,
} from "@clarkcant/contracts";

import {
  CLARK_IDENTITY,
  CLARK_SCHEMES,
  DARK,
  IDENTITY_VARIABLES,
  LIGHT,
  PROTECTED_MINIMUMS,
  auditProtected,
  auditProtectedSchemes,
  colorDistance,
  compileAppearance,
  identityDeclarations,
  identityOverrides,
  identityStylesheet,
  resolveIdentity,
  themeDrawProblem,
  themeStylesheet,
} from "../src/index.ts";

/**
 * Identity and the protected-semantics audit.
 *
 * Two claims. A theme's identity reaches the page only as host-written values under a closed list of names, so no
 * choice a theme makes can carry a selector or a rule. And a theme that would make a protected state hard to tell apart
 * — danger from warning, the focus ring from every other edge, disabled from enabled, the host's own card edge from the
 * page, text on a finished surface — is refused, measured on the colours and identity the page would actually draw.
 */

const V2 = { appearanceApi: { min: 2, max: 2 }, id: "depth", displayName: "Depth" } as const;

/** A version 2 theme, validated by the contract so a test cannot build one the boundary would refuse. */
function theme(extra: Readonly<Record<string, unknown>>): ThemeDocument {
  const checked = checkThemeDocument({ ...V2, ...extra });
  if (!checked.ok) throw new Error(checked.problems.join("\n"));
  return checked.document;
}

describe("identity", () => {
  it("adds nothing to Clark Default's sheet", () => {
    expect(identityOverrides(CLARK_IDENTITY)).toEqual([]);
    expect(identityStylesheet(CLARK_IDENTITY)).toBe("");
    expect(themeStylesheet(theme({}), "package:x#depth")).not.toContain("--cc-button-");
  });

  it("writes only closed names and host-written values for every recipe and effect at every bound", () => {
    const names = new Set<string>(IDENTITY_VARIABLES);
    for (const [component, recipes] of Object.entries(THEME_RECIPES)) {
      for (const recipe of recipes) {
        for (const backdrop of THEME_BACKDROP_EFFECTS) {
          for (const surface of THEME_SURFACE_EFFECTS) {
            for (const [intensity, scale] of [[0, 8], [1, 48]] as const) {
              const identity = resolveIdentity(
                theme({
                  recipes: { [component]: recipe },
                  shadow: { style: "hard", offset: 8, color: "accent" },
                  effects: { backdrop: { kind: backdrop, intensity, scale }, surface: { kind: surface, intensity } },
                }),
              );
              for (const [name, value] of Object.entries(identityDeclarations(identity))) {
                expect(names.has(name), name).toBe(true);
                if (value === undefined) continue;
                // A value cannot end its declaration, open a block, or fetch anything.
                expect(value, `${component}=${recipe} ${name}`).not.toMatch(/[;{}<>@\\]|url\(|expression|import/i);
              }
              const sheet = identityStylesheet(identity);
              expect(sheet).not.toMatch(/url\(|@import|<\/?style/i);
              // The only selectors identity writes: the root and scheme scopes, and the host's own backdrop layer.
              for (const selector of sheet.matchAll(/^([^\s{}][^{}]*)\{/gm)) {
                expect(selector[1]?.trim()).toMatch(/^(?::root,\s*\[data-cc-theme\]|\.cc-dot-grid,\s*\.cc-dot-grid::after)$/);
              }
            }
          }
        }
      }
    }
  });

  it("changes the look through recipes, effects, fonts and shadows, and keeps reduced motion at none", () => {
    const depth = theme({
      typography: { body: "serif", mono: "typewriter", headingWeight: 800 },
      shadow: { style: "hard", offset: 4, color: "text" },
      motion: { speed: 0.5, easing: "stepped" },
      recipes: { button: "raised", card: "flat", composer: "framed" },
      effects: { backdrop: { kind: "scanlines", intensity: 1, scale: 24 }, surface: { kind: "paper", intensity: 1 } },
    });
    const sheet = themeStylesheet(depth, "package:x#depth");
    for (const expected of ["--cc-font-body:", "--cc-font-mono:", "--cc-weight-heading: 800", "--cc-card-edge: transparent", "--cc-button-shadow: 4px 4px 0 var(--cc-text)", "--cc-surface-image:", "--cc-composer-line: 2px solid"]) {
      expect(sheet).toContain(expected);
    }
    const snapshot = compileAppearance({ scheme: "dark", theme: depth, themeRef: "package:x#depth" });
    // The theme slowed motion down; reduced motion is still the host's own, identical to Clark's.
    expect(snapshot.tokens.motion.micro).toBe("240ms");
    expect(snapshot.tokens.motion.easing).toBe("steps(4)");
    expect(snapshot.tokens.motionReduced).toEqual(compileAppearance({ scheme: "dark" }).tokens.motionReduced);
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--cc-motion-micro: 0ms/);
  });
});

describe("the protected audit", () => {
  it("passes Clark Default in both schemes, with room under every minimum", () => {
    expect(auditProtectedSchemes(CLARK_SCHEMES, CLARK_IDENTITY)).toEqual([]);
    expect(colorDistance(LIGHT.warning, LIGHT.success)).toBeGreaterThan(PROTECTED_MINIMUMS["status-distinct"]);
  });

  it("refuses a palette that makes danger and warning one colour", () => {
    const failures = auditProtected("dark", { ...DARK, warning: DARK.danger }, CLARK_IDENTITY);
    expect(failures).toContainEqual(expect.objectContaining({ check: "status-distinct", first: "danger", second: "warning" }));
  });

  it("refuses a focus ring in the colour of every other edge", () => {
    const failures = auditProtected("light", { ...LIGHT, focus: LIGHT.border }, CLARK_IDENTITY);
    expect(failures).toContainEqual(expect.objectContaining({ check: "focus-vs-border" }));
  });

  it("refuses disabled text that reads as enabled", () => {
    const failures = auditProtected("dark", { ...DARK, textTertiary: DARK.text }, CLARK_IDENTITY);
    expect(failures).toContainEqual(expect.objectContaining({ check: "disabled-distinct" }));
  });

  it("refuses an edge that disappears into the card or the page, which would hide the host's own cards", () => {
    const card = auditProtected("dark", { ...DARK, border: DARK.card }, CLARK_IDENTITY);
    expect(card).toContainEqual(expect.objectContaining({ check: "edge-visible", second: "card" }));
    const canvas = auditProtected("light", { ...LIGHT, border: LIGHT.canvas }, CLARK_IDENTITY);
    expect(canvas).toContainEqual(expect.objectContaining({ check: "edge-visible", second: "canvas" }));
  });

  it("measures text on a finished surface against the effect at its strongest", () => {
    const glass = resolveIdentity(theme({ effects: { surface: { kind: "glass", intensity: 1 } } }));
    // Clark's own palette stays readable under glass at full strength.
    expect(auditProtectedSchemes(CLARK_SCHEMES, glass)).toEqual([]);
    // A canvas bright enough to wash the card out does not.
    const washed = auditProtected("dark", { ...DARK, canvas: "#FFFFFF" }, glass);
    expect(washed).toContainEqual(expect.objectContaining({ check: "surface-readable", second: "card" }));
    // The same palette with no surface effect is not measured this way.
    expect(auditProtected("dark", { ...DARK, canvas: "#FFFFFF" }, CLARK_IDENTITY).some((f) => f.check === "surface-readable")).toBe(false);
  });

  it("is the one decision: unreadable before hidden, and nothing for a theme that is fine", () => {
    expect(themeDrawProblem(theme({ recipes: { button: "beveled" }, effects: { backdrop: { kind: "grain" } } }))).toBeUndefined();

    const camouflage = themeDrawProblem(theme({ colors: { dark: { warning: DARK.danger }, light: { warning: LIGHT.danger } } }));
    expect(camouflage?.code).toBe("THEME_PROTECTED");
    if (camouflage?.code === "THEME_PROTECTED") {
      expect(camouflage.protected.map((failure) => failure.scheme).sort()).toEqual(["dark", "light"]);
      expect(camouflage.message).toContain("status-distinct");
    }

    const unreadable = themeDrawProblem(theme({ colors: { dark: { text: DARK.canvas, warning: DARK.danger } } }));
    expect(unreadable?.code).toBe("THEME_LOW_CONTRAST");
  });
});
