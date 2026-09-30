import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { libraryEntries } from "@clarkcant/widget-catalog";
import { widgetDefinitionSchema } from "@clarkcant/contracts";
import { WidgetGallery } from "../src/widget-library/WidgetGallery.tsx";
import { WidgetLibrarySurface } from "../src/widget-library/WidgetLibrarySurface.tsx";
import { CLOSED_LIBRARY } from "../src/widget-library/widget-library-state.ts";
import { MarketplaceResultsBlock } from "../src/blocks.tsx";

describe("fixed appearance disclosure", () => {
  const entry = libraryEntries()[0]!;
  const fixed = { ...entry, definition: { ...entry.definition, appearanceMode: "fixed" as const } };
  it("accepts an explicit mode and keeps legacy definitions adaptive by default", () => {
    expect(widgetDefinitionSchema.parse(fixed.definition).appearanceMode).toBe("fixed");
    expect(widgetDefinitionSchema.parse(entry.definition).appearanceMode ?? "adaptive").toBe("adaptive");
    expect(widgetDefinitionSchema.safeParse({ ...entry.definition, appearanceMode: "privileged" }).success).toBe(false);
  });
  it("discloses the widget's own visual system in the gallery, detail and developer Lab", () => {
    expect(renderToStaticMarkup(createElement(WidgetGallery, { entries: [fixed], onSelect: () => {} }))).toContain('data-widget-appearance="fixed"');
    for (const mode of ["browse", "develop"] as const) {
      const html = renderToStaticMarkup(createElement(WidgetLibrarySurface, {
        state: { ...CLOSED_LIBRARY, open: true, mode, selectedId: fixed.cardId }, entries: [fixed], onAction: () => {},
      }));
      expect(html).toContain('data-widget-appearance="fixed"');
      expect(html).toContain("giao diện riêng");
    }
    expect(renderToStaticMarkup(createElement(WidgetGallery, { entries: [entry], onSelect: () => {} }))).not.toContain('data-widget-appearance="fixed"');
  });
  it("discloses directory claims without guessing a mode when the index did not provide one", () => {
    const result = { packageId: "example", widgetAppearance: [{ id: "main", mode: "fixed" }] };
    expect(renderToStaticMarkup(createElement(MarketplaceResultsBlock, { block: { results: [result] } }))).toContain('data-widget-appearance="fixed"');
    expect(renderToStaticMarkup(createElement(MarketplaceResultsBlock, { block: { results: [{ packageId: "example" }] } }))).not.toContain('data-widget-appearance="fixed"');
  });
});
