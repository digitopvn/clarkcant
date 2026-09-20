import { describe, expect, it } from "vitest";

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
