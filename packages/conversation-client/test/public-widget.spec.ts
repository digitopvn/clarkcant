import { describe, expect, it } from "vitest";
import { libraryEntries } from "@clarkcant/widget-catalog";
import { validatePublicWidget, publicWidgetCatalog, publicMediaUrl } from "../src/public-widget.tsx";

describe("public widget host", () => {
  it("accepts blog-owned media without accepting other relative or executable URLs", () => {
    const path = "/media/12345678-1234-1234-1234-123456789012";
    expect(publicMediaUrl(path)).toBe(path);
    expect(publicMediaUrl("/api/private")).toBeUndefined();
    expect(publicMediaUrl("javascript:alert(1)")).toBeUndefined();
    expect(publicMediaUrl("https://")).toBeUndefined();
  });
  it("refuses an unknown or mismatched definition instead of fetching code", () => {
    expect(validatePublicWidget({ definitionId: "external.arbitrary", version: "1", props: {}, semantic: "Readable explanation" })).toContain("unavailable");
    const entry = libraryEntries()[0]!;
    expect(validatePublicWidget({ definitionId: entry.definition.id, version: "999", props: {}, semantic: "Readable explanation" })).toContain("unavailable");
  });
  it("uses canonical props validation for a real catalog fixture", () => {
    const entry = libraryEntries().find(item => item.fixtures.length > 0)!;
    expect(validatePublicWidget({ definitionId: entry.definition.id, version: entry.definition.version, props: entry.fixtures[0]!.props, semantic: "Fixture for validation" })).toBeUndefined();
    expect(publicWidgetCatalog().length).toBeGreaterThan(0);
  });
});
