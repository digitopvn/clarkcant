import { describe, expect, it } from "vitest";

import {
  CLARK_IDENTITY_DECLARATIONS,
  IDENTITY_VARIABLES,
  type IdentityVariable,
  themeStylesheet,
} from "@clarkcant/design-tokens";

import { APP_CSS } from "../src/styles.ts";

/**
 * The stylesheet is a template literal.
 *
 * That boundary is silent, and it has now cost two separate debugging sessions. A stray backtick ends
 * the string early, and the failure surfaces as a parse error in a TypeScript file with no CSS in it;
 * a `${` starts an interpolation, which either fails to compile or evaluates something never meant to
 * run. The shader has had a guard for this since it happened three times there; this sheet had none
 * until a CSS comment quoting `:focus-visible` broke the build.
 *
 * Asserting on the source is the only way to catch it, because by the time the string is built the
 * damage is already done.
 */

describe("the stylesheet survives being embedded in TypeScript", () => {
  it("contains no backtick, which would end the template literal early", () => {
    expect(APP_CSS).not.toContain("`");
  });

  it("contains no interpolation sequence, which would be evaluated", () => {
    expect(APP_CSS).not.toContain("${");
  });

  it("closes every brace it opens", () => {
    // A sheet that lost a brace halfway through would silently stop applying rules, and the symptom is a
    // layout that is subtly wrong rather than a build failure.
    const opens = (APP_CSS.match(/\{/g) ?? []).length;
    const closes = (APP_CSS.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  /*
   * Deliberately no "no hard-coded duration" case here.
   *
   * It was written, and it was wrong: comparing literals against the token values cannot tell a duplicate
   * of `--cc-motion-micro` from `calc(var(--cc-chip-index, 0) * 70ms + 120ms)`, which is a stagger base delay
   * no motion token covers. A test that fails on correct code is worse than no test, and AGENTS.md's rule is
   * about a new duration where a token already expresses the interaction — a judgement a regex cannot make.
   * Token usage is reviewed in the diff instead.
   */

  it("never transitions every property", () => {
    // `transition: all` animates layout and colour together, which is how a deliberate state change turns
    // into jank. AGENTS.md forbids it outright.
    expect(APP_CSS).not.toMatch(/transition:\s*all/);
  });

  it("turns off every animation that never ends, rather than shortening it", () => {
    /*
     * The case that matters is the infinite one: `animation-duration: 0ms` does not make an endless loop
     * still, it makes a value recomputed for every frame of the session. Each endless animation therefore
     * has to be named in the reduced-motion block, and this asserts the whole set rather than that the
     * block exists.
     */
    const endless: Record<string, string> = {
      "cc-caret": ".cc-caret",
      "cc-thinking": ".cc-thinking-dot",
      "cc-glow-orbit": ".cc-composer-glow::before",
      "cc-tool-spin": '.cc-tool-mark[data-status="running"]',
    };

    const running = [...APP_CSS.matchAll(/animation:\s*(\S+)[^;]*infinite/g)].map((match) => match[1] ?? "");
    expect(running.length).toBeGreaterThan(0);

    for (const name of new Set(running)) {
      const selector = endless[name];
      expect(selector, `${name} is an endless animation this test does not know about`).toBeDefined();
      // The selector is disabled in the reduced-motion block rather than left to the blanket rule.
      expect(APP_CSS).toContain(`${selector} { animation: none !important;`);
    }
  });
});

describe("every variable the stylesheet reads exists", () => {
  /*
   * Set inline by a component rather than by a sheet, so the stylesheet cannot see where they come from.
   * Everything else must be a token or a rule-level declaration.
   */
  const RUNTIME = new Set(["--cc-chip-index", "--cc-enter-delay", "--cc-orb-dock"]);

  it("reads no variable that nothing defines, unless it names a fallback", () => {
    /*
     * An undefined custom property is not an error in CSS: the declaration quietly becomes its initial value.
     * The Widget Library read `--cc-surface` for its background, which no theme defines, so the dialog was
     * transparent and the conversation showed through it; a dozen radii and gaps were zero for the same reason.
     * Nothing about that shows up anywhere except on the screen, which is why it is asserted here.
     */
    const defined = new Set(
      [...`${themeStylesheet()}\n${APP_CSS}`.matchAll(/(--cc-[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
    );
    const unguarded = [...APP_CSS.matchAll(/var\((--cc-[a-z0-9-]+)\)/g)].map((match) => match[1] ?? "");
    const missing = [...new Set(unguarded)].filter((name) => !defined.has(name) && !RUNTIME.has(name));
    expect(missing).toEqual([]);
  });
});

/** Every `var(name, fallback)` the sheet writes, with the fallback read to its matching parenthesis. */
function fallbacks(css: string): { name: string; fallback: string }[] {
  const found: { name: string; fallback: string }[] = [];
  for (const match of css.matchAll(/var\((--cc-[a-z0-9-]+),/g)) {
    let depth = 1;
    let end = (match.index ?? 0) + match[0].length;
    const start = end;
    for (; end < css.length && depth > 0; end += 1) {
      if (css[end] === "(") depth += 1;
      if (css[end] === ")") depth -= 1;
    }
    found.push({ name: match[1] ?? "", fallback: css.slice(start, end - 1).trim().replace(/\s+/g, " ") });
  }
  return found;
}

/** The sheet's innermost rules, comments removed: a selector and the declarations under it. */
function rules(css: string): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? "").trim(),
    body: match[2] ?? "",
  }));
}

describe("the look a theme's identity reaches", () => {
  it("reads each identity variable with Clark Default's own value, so Clark draws exactly as it did", () => {
    /*
     * Clark Default writes no identity variables at all - its token sheet is byte-identical to the one before identity
     * existed - so every fallback here is what Clark draws. A fallback that drifted from Clark's value would change Clark
     * Default silently; one that matches means a theme's identity is the only thing that can change it.
     */
    const identity = new Set<string>(IDENTITY_VARIABLES);
    const checked = fallbacks(APP_CSS).filter(({ name }) => identity.has(name));
    expect(checked.length).toBeGreaterThan(40);
    for (const { name, fallback } of checked) {
      const clark = CLARK_IDENTITY_DECLARATIONS[name as IdentityVariable];
      /*
       * A variable Clark never sets falls back to another token (`var(--cc-badge-radius, var(--cc-radius-pill))`), or
       * to a token with Clark's own literal behind it (`var(--cc-input-radius, var(--cc-radius-field, 10px))`).
       */
      if (clark === undefined) {
        if (/^(?:none|auto|transparent|0)$/.test(fallback)) continue;
        const nested = /^var\((--cc-[a-z0-9-]+)(?:, ([\s\S]+))?\)$/.exec(fallback);
        expect(nested, `${name} falls back to ${fallback}`).not.toBeNull();
        const [, token = "", literal] = nested ?? [];
        if (literal === undefined) continue;
        // The literal behind a nested token is what Clark draws when that token is unset, so it must be Clark's value.
        const clarkNested = CLARK_IDENTITY_DECLARATIONS[token as IdentityVariable];
        if (clarkNested === undefined) expect(literal, name).not.toMatch(/[;{}]/);
        else expect(literal, name).toBe(clarkNested.replace(/\s+/g, " "));
        continue;
      }
      expect(fallback, name).toBe(clark.replace(/\s+/g, " "));
    }
  });

  it("never lets a recipe or an effect reach a focus ring, a disabled control, provenance or the host's own cards", () => {
    const styling = IDENTITY_VARIABLES.filter((name) =>
      /^--cc-(?:button|card|input|modal|badge|composer|surface|backdrop)-/.test(name),
    );
    const protectedRules = rules(APP_CSS).filter(({ selector }) => {
      // `:not(:disabled)` is the enabled state, which a recipe may style; only the protected state itself counts.
      const positive = selector.replace(/:not\([^)]*\)/g, "");
      // Provenance says where a widget, a theme or an effect came from, which is trust information like a host card.
      return /:focus-visible|:disabled|\[aria-disabled="true"\]|\[data-owner="host"\]|provenance/.test(positive);
    });
    expect(protectedRules.length).toBeGreaterThan(20);
    expect(protectedRules.filter(({ selector }) => selector.includes("provenance")).length).toBeGreaterThan(5);
    for (const { selector, body } of protectedRules) {
      for (const name of styling) expect(body, `${selector} reads ${name}`).not.toContain(name);
    }
  });

  it("draws every focus ring in the protected focus colour", () => {
    const rings = rules(APP_CSS).filter(({ selector, body }) => selector.includes(":focus-visible") && /\boutline\s*:/.test(body));
    expect(rings.length).toBeGreaterThan(20);
    for (const { selector, body } of rings) {
      const outline = /\boutline\s*:\s*([^;]+)/.exec(body)?.[1] ?? "";
      expect(outline, selector).toContain("var(--cc-focus)");
    }
  });

  it("keeps the host's own cards edged whatever a card recipe says", () => {
    expect(APP_CSS).toMatch(/\.cc-card\[data-owner="host"\]\s*\{\s*border-color:\s*var\(--cc-border\);/);
  });
});
