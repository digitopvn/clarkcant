import { describe, expect, it } from "vitest";

import {
  PREVIEW_THEMES,
  PREVIEW_VIEWPORTS,
  PREVIEW_WIDTHS,
  applyPreviewAction,
  initialPreviewState,
  viewportWidth,
} from "../src/preview.ts";

/**
 * The shared preview vocabulary.
 *
 * This module is the one place the Lab and `clark widget dev` agree on what "compact" means, so the
 * reducer is tested directly rather than through a rendered shell: the assertions are about state
 * transitions, and a DOM would only add noise.
 */

const fixtures = ["a", "b"];

describe("preview vocabulary", () => {
  it("starts on the first fixture at conversation width, following the system theme", () => {
    expect(initialPreviewState(fixtures)).toEqual({
      fixture: "a",
      viewport: "conversation",
      theme: "system",
      reducedMotion: false,
    });
  });

  it("honours an explicitly requested fixture", () => {
    expect(initialPreviewState(fixtures, "b").fixture).toBe("b");
  });

  it("changes the fixture when the fixture is known", () => {
    const next = applyPreviewAction(initialPreviewState(fixtures), { kind: "fixture", value: "b" }, { fixtures });
    expect(next.fixture).toBe("b");
  });

  it("ignores an unknown fixture rather than showing an empty widget for a typo", () => {
    const state = initialPreviewState(fixtures);
    const next = applyPreviewAction(state, { kind: "fixture", value: "nope" }, { fixtures });
    expect(next).toEqual(state);
  });

  it("changes the viewport and reports the matching width", () => {
    const next = applyPreviewAction(initialPreviewState(fixtures), { kind: "viewport", value: "320" }, { fixtures });
    expect(next.viewport).toBe("320");
    expect(viewportWidth(next.viewport)).toBe(320);
  });

  it("ignores an unknown viewport", () => {
    const state = initialPreviewState(fixtures);
    expect(applyPreviewAction(state, { kind: "viewport", value: "watch" }, { fixtures })).toEqual(state);
  });

  it("changes the theme only for a known theme", () => {
    const dark = applyPreviewAction(initialPreviewState(fixtures), { kind: "theme", value: "dark" }, { fixtures });
    expect(dark.theme).toBe("dark");
    const state = initialPreviewState(fixtures);
    expect(applyPreviewAction(state, { kind: "theme", value: "neon" }, { fixtures })).toEqual(state);
  });

  it("turns reduced motion on and off", () => {
    const on = applyPreviewAction(initialPreviewState(fixtures), { kind: "reduced-motion", value: true }, { fixtures });
    expect(on.reducedMotion).toBe(true);
    expect(applyPreviewAction(on, { kind: "reduced-motion", value: false }, { fixtures }).reducedMotion).toBe(false);
  });

  it("declares the widths the issue names, including the 320 px floor", () => {
    expect(PREVIEW_VIEWPORTS).toEqual(["320", "conversation", "compact", "expanded"]);
    expect(PREVIEW_WIDTHS["320"]).toBe(320);
    expect(PREVIEW_THEMES).toContain("system");
  });
});
