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
  ORB_BASE_PALETTE,
  ORB_PRESET_PALETTES,
  PROTECTED_MINIMUMS,
  SURFACE_EFFECT_OVERLAY,
  auditProtected,
  auditProtectedSchemes,
  colorDistance,
  compileAppearance,
  composite,
  contrastRatio,
  finishedSurfaces,
  identityDeclarations,
  identityOverrides,
  identityStylesheet,
  modalGlassBlur,
  orbLitColors,
  resolveIdentity,
  themeDrawProblem,
  themeOrbPalette,
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
    // The names the host's own token sheet declares, read from Clark's sheet, plus identity's own.
    const known = new Set<string>([...names, ...[...themeStylesheet().matchAll(/(--cc-[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? "")]);
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
                // A value cannot end its declaration, open a block, fetch anything, win the cascade or hide the rest.
                expect(value, `${component}=${recipe} ${name}`).not.toMatch(/[;{}<>@\\]|url\(|expression|import|!important|\/\*|\*\//i);
                // Every variable a value reads is a host token or another identity variable, never a name a theme chose.
                for (const reference of value.matchAll(/var\((--[a-z0-9-]+)/gi)) {
                  expect(known.has(reference[1] ?? ""), `${name} reads ${reference[1] ?? ""}`).toBe(true);
                }
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
    const glass = (intensity: number) => resolveIdentity(theme({ effects: { surface: { kind: "glass", intensity } } }));
    // Clark's own palette stays readable under a moderate glass.
    expect(auditProtectedSchemes(CLARK_SCHEMES, glass(0.3))).toEqual([]);
    // A canvas bright enough to wash the frosted card out does not.
    const washed = auditProtected("dark", { ...DARK, canvas: "#FFFFFF" }, glass(0.3));
    expect(washed).toContainEqual(expect.objectContaining({ check: "surface-readable", second: "card" }));
    // The same palette with no surface effect leaves the card as the contrast audit measured it.
    const plain = auditProtected("dark", { ...DARK, canvas: "#FFFFFF" }, CLARK_IDENTITY);
    expect(plain.some((f) => f.check === "surface-readable" && f.second === "card")).toBe(false);
  });

  it("measures the translucent modal over the brightest page its scrim can cover, not over the page's own colour", () => {
    // The modal is the one translucent glass surface. What is behind it is not known, so a bright page is assumed.
    const full = auditProtected("dark", DARK, resolveIdentity(theme({ effects: { surface: { kind: "glass", intensity: 1 } } })));
    expect(full).toContainEqual(expect.objectContaining({ check: "surface-readable", second: "elevated" }));
    const bright = finishedSurfaces(DARK, resolveIdentity(theme({ effects: { surface: { kind: "glass", intensity: 1 } } })));
    expect(bright.filter(({ surface }) => surface === "elevated")).toHaveLength(2);
    // Cards and the composer take glass as an opaque tint of the card toward the page, so the Orb never shows through.
    expect(bright.find(({ surface }) => surface === "card")?.color).toBe(composite(DARK.card, DARK.canvas, SURFACE_EFFECT_OVERLAY.glass.alpha));
  });

  it("blurs only the modal under glass, and never more than 12px", () => {
    // One blurred element on screen at a time, however long the conversation; cards and the composer are tinted only.
    expect(modalGlassBlur(0)).toBe("blur(4px)");
    expect(modalGlassBlur(1)).toBe("blur(12px)");
    const declarations = identityDeclarations(resolveIdentity(theme({ effects: { surface: { kind: "glass", intensity: 1 } } })));
    const blurred = Object.entries(declarations).filter(([, value]) => String(value).includes("blur("));
    expect(blurred).toEqual([["--cc-modal-filter", "blur(12px)"]]);
  });

  it("holds status colours, the accent and the focus ring to their own minimums on a finished surface", () => {
    // A danger just readable on the bare card: the contrast audit passes it.
    const danger = Array.from({ length: 128 }, (_, step) => `#${(0x80 + step).toString(16)}3a3a`).find(
      (hex) => contrastRatio(hex, DARK.card) >= 4.55,
    );
    if (danger === undefined) throw new Error("no danger colour in range");
    expect(contrastRatio(danger, DARK.card)).toBeLessThan(5);
    const bare = auditProtected("dark", { ...DARK, danger }, CLARK_IDENTITY);
    expect(bare.some((failure) => failure.check === "surface-readable")).toBe(false);
    // Grain lifts the dark card toward the text colour, and the deny label and error lines on it drop under 4.5:1.
    const grain = resolveIdentity(theme({ effects: { surface: { kind: "grain", intensity: 1 } } }));
    expect(auditProtected("dark", { ...DARK, danger }, grain)).toContainEqual(
      expect.objectContaining({ check: "surface-readable", first: "danger", second: "card", minimum: 4.5 }),
    );
    // A focus ring barely visible on the bare card is measured at the non-text minimum on the finished one.
    const focus = Array.from({ length: 200 }, (_, step) => {
      const channel = (0x30 + step).toString(16).padStart(2, "0");
      return `#${channel}${channel}${channel}`;
    }).find((hex) => contrastRatio(hex, DARK.card) >= 3.05);
    if (focus === undefined) throw new Error("no focus colour in range");
    expect(auditProtected("dark", { ...DARK, focus }, grain)).toContainEqual(
      expect.objectContaining({ check: "surface-readable", first: "focus", second: "card", minimum: 3 }),
    );
  });

  it("measures the page under the backdrop and its pointer light, which follows the theme's strength", () => {
    const backdrop = (kind: "scanlines" | "hard-grid", intensity: number, scale: number) =>
      resolveIdentity(theme({ effects: { backdrop: { kind, intensity, scale } } }));
    // Dense scanlines lit in the accent under the pointer: text on the page is no longer readable there.
    expect(auditProtected("dark", DARK, backdrop("scanlines", 1, 8))).toContainEqual(
      expect.objectContaining({ check: "surface-readable", second: "canvas" }),
    );
    // Even faint scanlines paint a quarter of the page; lit, that is enough to sink tertiary text on a light page.
    expect(auditProtected("light", LIGHT, backdrop("scanlines", 0.25, 24))).toContainEqual(
      expect.objectContaining({ check: "surface-readable", first: "textTertiary", second: "canvas" }),
    );
    // The lit layer is as strong as the backdrop, never a fixed 55% whatever the theme asked for.
    expect(identityDeclarations(backdrop("scanlines", 0.2, 8))["--cc-backdrop-lit"]).toBe("22%");
    expect(identityDeclarations(backdrop("scanlines", 1, 8))["--cc-backdrop-lit"]).toBe("55%");
    // Clark's own sparse grid, and a faint wide grid, leave the page readable.
    expect(auditProtectedSchemes(CLARK_SCHEMES, CLARK_IDENTITY)).toEqual([]);
    expect(auditProtectedSchemes(CLARK_SCHEMES, backdrop("hard-grid", 0.3, 24))).toEqual([]);
  });

  it("refuses an Orb palette that vanishes into the page, and passes Clark's Orb and every preset", () => {
    const black = [0, 0, 0] as const;
    const blackout = theme({
      orb: {
        profile: "clark",
        palette: Object.fromEntries(
          ["glowColor", "highlight", "shellInner", "shellMid", "shellEdge", "sheenColor", "colorA", "colorB", "colorC", "colorD"].map((channel) => [channel, black]),
        ),
      },
    });
    const problem = themeDrawProblem(blackout);
    expect(problem?.code).toBe("THEME_PROTECTED");
    if (problem?.code === "THEME_PROTECTED") {
      expect(problem.protected).toContainEqual(expect.objectContaining({ scheme: "dark", check: "orb-visible", first: "orb", second: "canvas", value: 0 }));
    }
    for (const profile of Object.keys(ORB_PRESET_PALETTES) as (keyof typeof ORB_PRESET_PALETTES)[]) {
      const failures = auditProtectedSchemes(CLARK_SCHEMES, CLARK_IDENTITY, { profile });
      expect(failures, profile).toEqual([]);
      // Every preset clears the minimum with room, in both schemes.
      for (const canvas of [DARK.canvas, LIGHT.canvas]) {
        const brightest = Math.max(...orbLitColors(canvas, themeOrbPalette({ profile })).map((lit) => colorDistance(lit, canvas)));
        expect(brightest, `${profile} on ${canvas}`).toBeGreaterThan(PROTECTED_MINIMUMS["orb-visible"] * 1.5);
      }
    }
  });

  it("never lets a theme set the page colour the Orb sits on", () => {
    const checked = checkThemeDocument({ ...V2, orb: { profile: "clark", palette: { canvas: [1, 1, 1] } } });
    expect(checked.ok).toBe(false);
    expect(themeOrbPalette({ profile: "clark" }).canvas).toEqual(ORB_BASE_PALETTE.canvas);
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
