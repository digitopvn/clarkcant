import { describe, expect, it } from "vitest";

import {
  CLARK_IDENTITY_DECLARATIONS,
  DARK,
  IDENTITY_VARIABLES,
  LIGHT,
  type IdentityVariable,
  requiredPairs,
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
      // Reading a variable is what lets a theme in; a host rule may reset one to Clark's own value.
      for (const name of styling) expect(body, `${selector} reads ${name}`).not.toContain(`var(${name}`);
    }
  });

  it("draws the host's own cards with no theme surface, texture, blur or shadow", () => {
    /*
     * A host card is drawn by every rule for `.cc-card` and then by its own; the generic rule is where a theme's surface
     * reaches a card, so the two are resolved together, the host's variable resets substituted in, and what is left is
     * what the host card actually reads.
     */
    const declarations = (body: string): [string, string][] =>
      body
        .split(";")
        .map((line) => line.trim())
        .filter((line) => line.includes(":"))
        .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]);
    const matching = (target: string) =>
      rules(APP_CSS).filter(({ selector }) => selector.split(",").map((part) => part.trim()).includes(target));
    const generic = matching(".cc-card");
    const own = matching('.cc-card[data-owner="host"]');
    expect(generic.length).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThan(0);
    const effective = new Map<string, string>([...generic, ...own].flatMap(({ body }) => declarations(body)));
    // `var()` references, with nesting, replaced by the value the host card sets for them.
    const resolve = (value: string, depth = 0): string => {
      let out = "";
      let at = 0;
      while (at < value.length) {
        const start = value.indexOf("var(", at);
        if (start < 0) return out + value.slice(at);
        out += value.slice(at, start);
        let end = start + 3;
        for (let open = 0; end < value.length; end += 1) {
          if (value[end] === "(") open += 1;
          else if (value[end] === ")" && (open -= 1) === 0) break;
        }
        const inner = value.slice(start + 4, end);
        const comma = inner.indexOf(",");
        const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
        const reset = effective.get(name);
        if (reset !== undefined && depth < 4) out += resolve(reset, depth + 1);
        else out += comma < 0 ? `var(${name})` : `var(${name}, ${resolve(inner.slice(comma + 1).trim(), depth + 1)})`;
        at = end + 1;
      }
      return out;
    };
    const theme = /var\(--cc-(?:surface|card-shadow|card-edge|modal|backdrop)[a-z0-9-]*/;
    for (const [property, value] of effective) {
      if (property.startsWith("--")) continue;
      expect(resolve(value), `${property} on a host card`).not.toMatch(theme);
      expect(property, "a host card is never blurred").not.toMatch(/backdrop-filter/);
    }
    expect(resolve(effective.get("background") ?? "")).toBe("var(--cc-card)");
    expect(resolve(effective.get("background-image") ?? "")).toBe("none");
    expect(resolve(effective.get("box-shadow") ?? "")).toBe("none");
  });

  it("draws the buttons in the host's own cards and panels as Clark's, whatever the theme's button recipe", () => {
    // A theme's recipe reaches a button only through these variables; inside a host surface each is Clark's own value.
    const buttonVariables = IDENTITY_VARIABLES.filter((name) => name.startsWith("--cc-button-"));
    expect(buttonVariables.length).toBeGreaterThan(0);
    const host = rules(APP_CSS).filter(({ selector }) => selector === '[data-owner="host"] .cc-action');
    expect(host).toHaveLength(1);
    const declared = new Map(
      (host[0]?.body ?? "")
        .split(";")
        .filter((line) => line.includes(":"))
        .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()] as const),
    );
    for (const name of buttonVariables) {
      const clark = CLARK_IDENTITY_DECLARATIONS[name];
      expect(clark, `${name} has a Clark value`).toBeDefined();
      expect(declared.get(name), `${name} inside a host surface`).toBe(clark?.replace(/\s+/g, " "));
    }

    // The primary action is filled with the accent directly, so no recipe reaches it, and the plain one beside it is
    // the elevated surface: the two differ in fill.
    const primary = rules(APP_CSS).find(({ selector }) => selector === '.cc-action[data-emphasis="primary"]:not(:disabled)')?.body ?? "";
    expect(primary).toMatch(/background:\s*var\(--cc-accent\)/);
    expect(primary).toMatch(/border-color:\s*var\(--cc-accent\)/);
    expect(primary).not.toMatch(/var\(--cc-button-/);
    expect(declared.get("--cc-button-bg")).toBe("var(--cc-elevated)");
    // And the contrast audit holds the accent to text contrast on the elevated surface, so for every theme that can be
    // drawn the filled answer stands apart from the plain one.
    for (const palette of [DARK, LIGHT]) {
      const pair = requiredPairs(palette).find((candidate) => candidate.foregroundToken === "accent" && candidate.backgroundToken === "elevated");
      expect(pair?.minimum).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("draws Stop with the host's own look, which no recipe or effect reaches", () => {
    const stop = rules(APP_CSS).filter(({ selector }) =>
      selector.split(",").some((part) => /^\.cc-icon-btn(?:$|[:[])/.test(part.trim())),
    );
    expect(stop.length).toBeGreaterThan(0);
    const styling = IDENTITY_VARIABLES.filter((name) => /^--cc-(?:button|card|input|modal|badge|composer|surface|backdrop)-/.test(name));
    for (const { selector, body } of stop) {
      for (const name of styling) expect(body, `${selector} reads ${name}`).not.toContain(`var(${name}`);
      expect(body, selector).not.toMatch(/box-shadow|backdrop-filter|background-image/);
    }
    const base = stop.find(({ selector }) => selector === ".cc-icon-btn")?.body ?? "";
    expect(base).toMatch(/background:\s*var\(--cc-elevated\)/);
    expect(base).toMatch(/var\(--cc-border\)/);
  });

  it("blurs only the modal under glass, never a card or the composer", () => {
    const blurred = rules(APP_CSS).filter(({ body }) => /(?:^|[;\s])backdrop-filter\s*:/.test(body));
    // The modal is one element on screen at a time; a blur per transcript card would grow with the conversation.
    expect(blurred.map(({ selector }) => selector)).toEqual([".cc-modal"]);
  });

  it("draws the backdrop and its pointer light at the strengths the protected audit measures", () => {
    // The audit composites text over the pattern at `--cc-backdrop-alpha` and the lit accent at `--cc-backdrop-lit`.
    const body = (target: string) => rules(APP_CSS).find(({ selector }) => selector === target)?.body ?? "";
    expect(body(".cc-dot-grid")).toMatch(/--cc-grid-dot:\s*color-mix\(in srgb, var\(--cc-text-tertiary\) var\(--cc-backdrop-alpha, 14%\), transparent\)/);
    expect(body(".cc-dot-grid::after")).toMatch(/--cc-grid-dot:\s*color-mix\(in srgb, var\(--cc-accent\) var\(--cc-backdrop-lit, 55%\), transparent\)/);
  });

  it("stops the theme's motion and the pointer light under the person's own Reduced setting, as under the system's", () => {
    const scoped = rules(APP_CSS).filter(({ selector }) => selector.startsWith('[data-cc-reduced-motion="true"]'));
    const system = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(APP_CSS.replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(system).not.toBeNull();
    // Every rule the system setting applies has its twin under the person's setting.
    for (const { selector } of rules(system?.[1] ?? "")) {
      expect(scoped.map((rule) => rule.selector), selector).toContain(`[data-cc-reduced-motion="true"] ${selector}`);
    }
    expect(scoped.find(({ selector }) => selector.endsWith(".cc-dot-grid::after"))?.body).toMatch(/display:\s*none/);
  });

  it("draws every focus ring in the protected focus colour", () => {
    const rings = rules(APP_CSS).filter(({ selector, body }) => selector.includes(":focus-visible") && /\boutline\s*:/.test(body));
    expect(rings.length).toBeGreaterThan(20);
    // A field that hands its ring to the control around it. Each one is allowed to drop its own outline only because
    // the container draws focus in the same protected colour, which is checked below rather than taken on trust.
    const delegated: Readonly<Record<string, string>> = { ".cc-composer textarea:focus-visible": ".cc-composer:focus-within" };
    for (const { selector, body } of rings) {
      const outline = /\boutline\s*:\s*([^;]+)/.exec(body)?.[1] ?? "";
      const container = delegated[selector];
      if (container !== undefined && outline.trim() === "none") {
        const ring = rules(APP_CSS).find((rule) => rule.selector === container)?.body ?? "";
        expect(ring, `${selector} delegates to ${container}`).toContain("var(--cc-focus)");
        continue;
      }
      expect(outline, selector).toContain("var(--cc-focus)");
    }
  });

  it("keeps the host's own cards edged whatever a card recipe says", () => {
    expect(APP_CSS).toMatch(/\.cc-card\[data-owner="host"\]\s*\{\s*border-color:\s*var\(--cc-border\);/);
  });
});
