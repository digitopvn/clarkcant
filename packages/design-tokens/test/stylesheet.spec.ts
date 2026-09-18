import { describe, expect, it } from "vitest";

import { themeStylesheet } from "../src/css.ts";
import { MOTION, MOTION_REDUCED, RADIUS, SPACE, TYPE_SCALE } from "../src/tokens.ts";

/**
 * The generated stylesheet.
 *
 * These check the sheet itself rather than the token objects, because the two can disagree:
 * a value can be correct in `tokens.ts` and still never reach a browser, and that gap is
 * invisible to a test that only reads the objects back.
 */

const CSS = themeStylesheet();

describe("the generated stylesheet", () => {
  it("declares a colour scheme for each theme", () => {
    // Without this every control the user agent draws keeps its light default on a dark
    // interface. It was found by looking at the screen, not by reading the tokens, so it is
    // checked here rather than trusted.
    expect(CSS).toMatch(/\[data-cc-theme="dark"\]\s*\{\s*color-scheme: dark;/);
    expect(CSS).toMatch(/\[data-cc-theme="light"\]\s*\{\s*color-scheme: light;/);
  });

  it("emits a size and a leading for every type token", () => {
    for (const name of Object.keys(TYPE_SCALE)) {
      const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      expect(CSS, `${kebab} size`).toContain(`--cc-text-${kebab}:`);
      expect(CSS, `${kebab} leading`).toContain(`--cc-leading-${kebab}:`);
    }
  });

  it("emits every spacing and radius step, so a token cannot exist only in TypeScript", () => {
    for (const name of Object.keys(SPACE)) expect(CSS).toContain(`--cc-space-${name}:`);
    for (const name of Object.keys(RADIUS)) expect(CSS).toContain(`--cc-radius-${name}:`);
  });

  it("emits the layout measurements", () => {
    for (const variable of [
      "--cc-conversation-max-width",
      "--cc-composer-max-width",
      "--cc-composer-min-height",
      "--cc-topbar-height",
      "--cc-modal-width",
    ]) {
      expect(CSS, variable).toContain(`${variable}:`);
    }
  });

  it("carries both themes, so switching one for the other needs no reload", () => {
    expect(CSS).toContain('[data-cc-theme="dark"]');
    expect(CSS).toContain('[data-cc-theme="light"]');
  });

  it("keeps the specification's layout numbers", () => {
    // The three numbers the design specifies, asserted where a rounding mistake would show.
    expect(CSS).toContain("--cc-conversation-max-width: 800px;");
    expect(CSS).toContain("--cc-composer-max-width: 840px;");
    expect(CSS).toContain("--cc-composer-min-height: 70px;");
    expect(CSS).toContain("--cc-topbar-height: 62px;");
  });

  it("emits every motion token, and a reduced value for each", () => {
    // The reduced block only overrides the names it declares, so a token that is missing there
    // does not lose its animation — it keeps the full-motion one. That is the failure this
    // asserts against, and it is invisible from either object on its own.
    for (const name of Object.keys(MOTION)) {
      expect(CSS, `${name} is not emitted`).toContain(`--cc-motion-${name}: ${MOTION[name as keyof typeof MOTION]};`);
      expect(
        Object.keys(MOTION_REDUCED),
        `${name} has no reduced counterpart, so it keeps its full-motion value for a reduced-motion user`,
      ).toContain(name);
    }
    // Names rather than a string test: `bounce` is an easing too, and guessing which keys are
    // durations from their spelling is how a duration slips through as a curve.
    const curves = new Set(["easing", "bounce"]);
    for (const [name, value] of Object.entries(MOTION_REDUCED)) {
      if (!curves.has(name)) expect(value, `${name} still moves under reduced motion`).toBe("0ms");
      else expect(value, `${name} must stay a timing function`).toBeTypeOf("string");
    }
  });
});
