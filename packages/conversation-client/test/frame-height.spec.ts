import { describe, expect, it } from "vitest";

import { DEFAULT_FRAME_HEIGHT, frameHeight } from "../src/WidgetFrame.tsx";

/**
 * The height a widget's resize request gets.
 *
 * The widget is untrusted: it may say how tall its content is, and the frame follows, but it cannot make the frame
 * cover the conversation or collapse to nothing.
 */
describe("sizing a widget frame from its own request", () => {
  it("follows what the widget asked for, rounded to a pixel", () => {
    expect(frameHeight(263.4)).toBe(263);
  });

  it("keeps the frame between a floor and a ceiling", () => {
    expect(frameHeight(0)).toBe(80);
    expect(frameHeight(-500)).toBe(80);
    expect(frameHeight(100_000)).toBe(1200);
  });

  it("keeps the default for a request that is not a number", () => {
    expect(frameHeight(Number.NaN)).toBe(DEFAULT_FRAME_HEIGHT);
    expect(frameHeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FRAME_HEIGHT);
  });
});
