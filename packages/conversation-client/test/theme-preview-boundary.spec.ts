import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI } from "../src/i18n/messages.ts";
import { PreviewBoundary } from "../src/settings/ThemeSettings.tsx";

/**
 * A theme preview that throws while drawing stays inside the gallery.
 *
 * Nothing above the preview catches a render error, so without this boundary one throw unmounted the whole window and
 * left a blank page with no way back. The repo has no DOM test environment, so the boundary's two halves are checked
 * directly: a caught error flips it to the notice, and the notice says what was kept and what to do next.
 */
describe("the theme preview boundary", () => {
  const fallback = MESSAGES_EN["themeLab.previewFailed"];

  it("draws the preview while nothing has failed", () => {
    const html = renderToStaticMarkup(createElement(PreviewBoundary, { fallback, children: createElement("p", null, "preview") }));
    expect(html).toBe("<p>preview</p>");
  });

  it("replaces a preview that threw with a notice instead of unmounting the window", () => {
    expect(PreviewBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new PreviewBoundary({ fallback, children: null });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain("data-theme-preview-failed");
    expect(html).toContain('role="status"');
    expect(html).toContain("could not be drawn. Your current theme and conversation were kept");
  });

  it("says what was kept and what to do next, in both languages", () => {
    expect(MESSAGES_EN["themeLab.previewFailed"]).toMatch(/kept.*choose another theme or close/u);
    expect(MESSAGES_VI["themeLab.previewFailed"]).toMatch(/giữ nguyên.*chọn chủ đề khác hoặc đóng/u);
  });
});
