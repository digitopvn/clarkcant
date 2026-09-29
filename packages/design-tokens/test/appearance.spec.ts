import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COLOR_TOKEN_NAMES,
  LAYOUT_TOKEN_NAMES,
  MOTION_TOKEN_NAMES,
  RADIUS_TOKEN_NAMES,
  SPACE_TOKEN_NAMES,
  TYPE_TOKEN_NAMES,
  appearanceSnapshotSchema,
  type ThemeDocument,
} from "@clarkcant/contracts";

import {
  CLARK_THEME,
  auditAppearance,
  auditThemeDocument,
  compileAppearance,
  themeContrastProblem,
} from "../src/appearance.ts";
import { requiredPairs } from "../src/contrast.ts";
import { appearanceToCss, themeStylesheet } from "../src/css.ts";
import { DARK, LAYOUT, LIGHT, MOTION, RADIUS, SPACE, TYPE_SCALE } from "../src/tokens.ts";

/**
 * The appearance compiler.
 *
 * The first claim is the one that protects everyone who has not installed a theme: Clark Default compiles to exactly
 * the stylesheet it produced before themes existed, byte for byte. The fixture is that stylesheet, captured from the
 * code as it was, so a change to Clark's look shows up here as a deliberate fixture update rather than slipping by.
 */

const GOLDEN = readFileSync(new URL("./fixtures/clark-stylesheet.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const PIXEL: ThemeDocument = {
  appearanceApi: { min: 1, max: 1 },
  id: "pixel-arcade",
  displayName: "Pixel Arcade",
  colors: { dark: { accent: "#C9B8FF", focus: "#FFE08A" }, light: { accent: "#5A3FB0" } },
  radius: { card: 0, button: 0.125 },
};
const PIXEL_REF = "package:@community/pixel#pixel-arcade";

describe("Clark Default", () => {
  it("compiles to the stylesheet it always had, byte for byte", () => {
    expect(themeStylesheet()).toBe(GOLDEN.trimEnd());
  });

  it("is the stylesheet a theme with no changes compiles to", () => {
    expect(themeStylesheet(CLARK_THEME, "builtin:clark")).toBe(themeStylesheet());
  });
});

describe("the token contract and the token values name the same tokens", () => {
  it("has a value for every contract name and no value outside it", () => {
    expect(Object.keys(DARK)).toEqual([...COLOR_TOKEN_NAMES]);
    expect(Object.keys(LIGHT)).toEqual([...COLOR_TOKEN_NAMES]);
    expect(Object.keys(TYPE_SCALE)).toEqual([...TYPE_TOKEN_NAMES]);
    expect(Object.keys(SPACE)).toEqual([...SPACE_TOKEN_NAMES]);
    expect(Object.keys(RADIUS)).toEqual([...RADIUS_TOKEN_NAMES]);
    expect(Object.keys(MOTION)).toEqual([...MOTION_TOKEN_NAMES]);
    expect(Object.keys(LAYOUT)).toEqual([...LAYOUT_TOKEN_NAMES]);
  });
});

describe("compiling a theme", () => {
  it("applies the theme's patch in the scheme it names and keeps Clark's value for everything else", () => {
    const dark = compileAppearance({ scheme: "dark", theme: PIXEL, themeRef: PIXEL_REF });
    expect(dark.tokens.color.accent).toBe("#C9B8FF");
    expect(dark.tokens.color.focus).toBe("#FFE08A");
    expect(dark.tokens.color.canvas).toBe(DARK.canvas);
    expect(dark.tokens.radius.card).toBe("0rem");
    expect(dark.tokens.radius.button).toBe("0.125rem");
    expect(dark.tokens.radius.modal).toBe(RADIUS.modal);
    expect(dark.tokens.radius.pill).toBe(RADIUS.pill);
    expect(dark.themeRef).toBe("package:@community/pixel#pixel-arcade");

    const light = compileAppearance({ scheme: "light", theme: PIXEL, themeRef: PIXEL_REF });
    expect(light.tokens.color.accent).toBe("#5A3FB0");
    expect(light.tokens.color.focus).toBe(LIGHT.focus);
  });

  it("never names another theme's tokens after Clark Default", () => {
    // A theme without the reference it was selected by would be stamped `builtin:clark` over someone else's colours.
    // @ts-expect-error -- the type requires the reference whenever a theme is given.
    expect(() => compileAppearance({ scheme: "dark", theme: PIXEL })).toThrow(/reference/);
    // @ts-expect-error -- and refuses a package reference with no theme to compile.
    expect(() => compileAppearance({ scheme: "dark", themeRef: PIXEL_REF })).toThrow(/none was given/);
    expect(compileAppearance({ scheme: "dark" }).themeRef).toBe("builtin:clark");
    expect(compileAppearance({ scheme: "dark", themeRef: "builtin:clark" }).themeRef).toBe("builtin:clark");
  });

  it("keeps the scheme independent of the theme", () => {
    // The same theme drawn in each scheme, and each scheme drawn in two themes: the scheme decides which palette,
    // the theme decides what is patched, and neither choice changes the other.
    for (const scheme of ["dark", "light"] as const) {
      expect(compileAppearance({ scheme, theme: PIXEL, themeRef: PIXEL_REF }).scheme).toBe(scheme);
      expect(compileAppearance({ scheme }).tokens.color).toEqual(scheme === "dark" ? DARK : LIGHT);
    }
  });

  it("produces a snapshot the contract accepts, and nothing more", () => {
    const snapshot = compileAppearance({ scheme: "dark", theme: PIXEL, themeRef: PIXEL_REF });
    expect(appearanceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("gives the same revision to the same appearance and a different one to a different appearance", () => {
    const once = compileAppearance({ scheme: "dark", theme: PIXEL, themeRef: PIXEL_REF });
    const again = compileAppearance({ scheme: "dark", theme: structuredClone(PIXEL), themeRef: PIXEL_REF });
    expect(again.revision).toBe(once.revision);
    expect(compileAppearance({ scheme: "light", theme: PIXEL, themeRef: PIXEL_REF }).revision).not.toBe(once.revision);
    expect(compileAppearance({ scheme: "dark" }).revision).not.toBe(once.revision);
  });

  it("refuses to compile a value that is not a colour, rather than writing it into a stylesheet", () => {
    const hostile = {
      ...PIXEL,
      colors: { dark: { accent: "red; } body { display: none" } },
    } as unknown as ThemeDocument;
    expect(() => compileAppearance({ scheme: "dark", theme: hostile, themeRef: PIXEL_REF })).toThrow();
  });

  it("refuses a token the contract does not name", () => {
    const extra = { ...PIXEL, colors: { dark: { background: "#000000" } } } as unknown as ThemeDocument;
    expect(() => compileAppearance({ scheme: "dark", theme: extra, themeRef: PIXEL_REF })).toThrow();
  });

  it("writes a theme's values into the scheme's own block and nowhere else", () => {
    const css = appearanceToCss(compileAppearance({ scheme: "dark", theme: PIXEL, themeRef: PIXEL_REF }));
    expect(css.startsWith(':root[data-cc-theme="dark"],\n[data-cc-theme="dark"] {\n')).toBe(true);
    expect(css).toContain("  --cc-accent: #C9B8FF;");
    expect(css).toContain("  --cc-radius-card: 0rem;");
    expect(css.match(/\{/g)).toHaveLength(1);
  });
});

describe("contrast audits run against any theme, not only Clark's palettes", () => {
  it("passes Clark Default through the compiled path", () => {
    for (const audit of auditThemeDocument(CLARK_THEME)) expect(audit.failures).toEqual([]);
  });

  it("names the pairs a theme breaks, in the scheme it breaks them", () => {
    const unreadable: ThemeDocument = {
      ...PIXEL,
      colors: { light: { textMuted: "#DDDDDD" } },
    };
    const [dark, light] = auditThemeDocument(unreadable);
    expect(dark!.failures).toEqual([]);
    expect(light!.scheme).toBe("light");
    expect(light!.failures.map((failure) => failure.purpose)).toContain("caption text on a card");
  });

  it("fails a dark accent that a link on the page could not be read in", () => {
    // Links in a message and keywords in a code block are drawn in the accent, so the accent is text.
    const dim: ThemeDocument = { ...PIXEL, colors: { dark: { accent: "#3A3470", onAccent: "#FFFFFF" } } };
    const [dark, light] = auditThemeDocument(dim);
    const failed = dark!.failures.map((failure) => failure.purpose);
    expect(failed).toContain("accent text on the page");
    expect(failed).toContain("accent text on a code block");
    expect(failed).not.toContain("label on an accent button");
    expect(light!.failures).toEqual([]);
  });

  it("says why a theme cannot be drawn readably, in one sentence the node and the page share", () => {
    const dim: ThemeDocument = { ...PIXEL, colors: { dark: { accent: "#3A3470", onAccent: "#FFFFFF" } } };

    expect(themeContrastProblem(CLARK_THEME)).toBeUndefined();
    expect(themeContrastProblem({ ...PIXEL, colors: { dark: { accent: "#7AA2F7" } } })).toBeUndefined();
    const problem = themeContrastProblem(dim);
    expect(problem).toMatch(/^its colours are too close to read: in the dark scheme, accent text on the page is 1\.69:1 and needs 4\.5:1, /);
    expect(problem).not.toMatch(/light scheme/);
  });

  it("holds the accent and every status colour to the text threshold on every surface text is drawn on", () => {
    const audited = requiredPairs(DARK).map((pair) => `${pair.purpose}@${String(pair.minimum)}`);
    for (const color of ["accent text", "success status text", "warning status text", "error status text"]) {
      for (const surface of ["the page", "the window", "a card", "an elevated surface", "a code block"]) {
        expect(audited).toContain(`${color} on ${surface}@4.5`);
      }
    }
  });

  it("fails a status colour on the surface where it becomes unreadable, not only on a card", () => {
    // Readable on a light card (#FFFFFF) at 4.6:1, but not on the darker code block behind it.
    const theme: ThemeDocument = { ...PIXEL, colors: { light: { danger: "#D0342C", code: "#E6E6E0" } } };
    const light = auditThemeDocument(theme)[1]!;
    const failed = light.failures.map((failure) => failure.purpose);
    expect(failed).toContain("error status text on a code block");
    expect(failed).not.toContain("error status text on a card");
  });

  it("audits a compiled snapshot by the same pairs as Clark Default", () => {
    const clark = auditAppearance(compileAppearance({ scheme: "dark" }));
    const themed = auditAppearance(compileAppearance({ scheme: "dark", theme: PIXEL, themeRef: PIXEL_REF }));
    expect(themed.checked).toBe(clark.checked);
  });
});
