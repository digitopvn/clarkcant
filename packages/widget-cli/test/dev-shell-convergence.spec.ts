import { describe, expect, it } from "vitest";

import { PREVIEW_THEMES, applyPreviewAction, type PreviewState } from "@clarkcant/widget-catalog/preview";

import { DEV_THEMES, applyShellAction, initialState } from "../src/dev-shell.ts";

/**
 * The dev host and the Widget Lab share one preview vocabulary.
 *
 * They used to keep separate copies of the same three rules - unknown fixture ignored, unknown theme
 * ignored, reduced motion is a boolean - which is a way for two playgrounds to start disagreeing about
 * what an author sees. These assertions compare the two implementations directly, so drift fails here
 * rather than being noticed by somebody comparing two windows.
 *
 * The viewport vocabulary is deliberately *not* shared, and the last case pins that down: the dev host
 * previews a standalone package (including a 1024 px desktop size) while the Lab previews conversation
 * widths. That difference is documented rather than hidden.
 */

const known = { fixtures: ["a", "b"], capabilities: [] as readonly string[] };

function labState(overrides: Partial<PreviewState> = {}): PreviewState {
  return { fixture: "a", viewport: "conversation", theme: "system", reducedMotion: false, ...overrides };
}

function shellState() {
  return initialState({ fixtures: known.fixtures, requestedCapabilities: [] });
}

describe("dev shell and widget lab convergence", () => {
  it("uses the shared theme list rather than a second copy", () => {
    expect(DEV_THEMES).toEqual(PREVIEW_THEMES);
  });

  it("ignores an unknown fixture the same way", () => {
    const shell = applyShellAction(shellState(), { kind: "fixture", value: "nope" }, known);
    const lab = applyPreviewAction(labState(), { kind: "fixture", value: "nope" }, { fixtures: known.fixtures });
    expect(shell.fixture).toBe(lab.fixture);
  });

  it("accepts a known fixture the same way", () => {
    const shell = applyShellAction(shellState(), { kind: "fixture", value: "b" }, known);
    const lab = applyPreviewAction(labState(), { kind: "fixture", value: "b" }, { fixtures: known.fixtures });
    expect(shell.fixture).toBe("b");
    expect(lab.fixture).toBe("b");
  });

  it("ignores an unknown theme the same way", () => {
    const shell = applyShellAction(shellState(), { kind: "theme", value: "neon" }, known);
    const lab = applyPreviewAction(labState(), { kind: "theme", value: "neon" }, { fixtures: known.fixtures });
    expect(shell.theme).toBe(lab.theme);
  });

  it("treats reduced motion the same way", () => {
    const shell = applyShellAction(shellState(), { kind: "reduced-motion", value: true }, known);
    const lab = applyPreviewAction(
      labState(),
      { kind: "reduced-motion", value: true },
      { fixtures: known.fixtures },
    );
    expect(shell.reducedMotion).toBe(true);
    expect(lab.reducedMotion).toBe(true);
  });

  it("keeps the dev host's own viewport vocabulary, which is the documented difference", () => {
    const state = shellState();
    expect(applyShellAction(state, { kind: "viewport", value: "narrow-320" }, known).viewport).toBe("narrow-320");
    expect(applyShellAction(state, { kind: "viewport", value: "nope" }, known).viewport).toBe(state.viewport);
  });
});
