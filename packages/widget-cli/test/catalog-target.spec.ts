import { describe, expect, it } from "vitest";

import { catalogEntry } from "@clarkcant/widget-catalog";

import { catalogFrameHtml, catalogTarget } from "../src/catalog-target.ts";

/**
 * What the dev host's builtin frame draws.
 *
 * These are the decisions the frame makes, kept out of the page so they are checked here rather than by opening a
 * browser: which entry and fixture to draw, and what the page that draws them says.
 */
describe("the catalog frame's target", () => {
  it("draws the catalog entry and the fixture the frame was told to draw", () => {
    const entry = catalogEntry("canvas.line@1");
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const second = entry.fixtures[1];
    expect(second, "this test needs an entry with more than one fixture").toBeDefined();
    if (second === undefined) return;

    const target = catalogTarget({ definitionId: "canvas.line@1", fixtureId: second.id });
    expect(target?.entry.definition.id).toBe("canvas.line@1");
    expect(target?.fixture.id).toBe(second.id);
  });

  it("falls back to the entry's first fixture when the named one is gone", () => {
    // The shell's fixture control lists what the entry has, so a name that has gone means the page is one reload
    // behind rather than that the request was wrong.
    const entry = catalogEntry("canvas.line@1");
    const target = catalogTarget({ definitionId: "canvas.line@1", fixtureId: "no-such-fixture" });
    expect(target?.fixture.id).toBe(entry?.fixtures[0]?.id);
  });

  it("refuses a definition the catalog does not have, rather than drawing nothing quietly", () => {
    expect(catalogTarget({ definitionId: "canvas.nope@1", fixtureId: "default" })).toBeUndefined();
  });
});

describe("the catalog frame's page", () => {
  it("names the entry, carries what to draw, and loads the runtime module", () => {
    const html = catalogFrameHtml({ definitionId: "canvas.note@1", fixtureId: "default" });

    expect(html).toContain("<title>canvas.note@1</title>");
    // The bootstrap is the one way the page says what to draw, so the module reads it rather than a second source.
    expect(html).toContain('window.__CC_CATALOG__ = {"definitionId":"canvas.note@1","fixtureId":"default"}');
    expect(html).toContain('src="/src/catalog-runtime.tsx"');
    expect(html).toContain('id="cc-catalog-root"');
  });

  it("cannot be closed early by a value that contains a tag", () => {
    const html = catalogFrameHtml({ definitionId: "canvas.note@1", fixtureId: "</script><script>alert(1)</script>" });

    // Escaped rather than stripped, so the value still arrives intact and the tag it sits in is still one tag.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script");
  });
});
