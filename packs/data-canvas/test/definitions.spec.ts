import { describe, expect, it } from "vitest";

import { widgetDefinitionSchema } from "@clarkcant/contracts";

import {
  BAR_CHART,
  CALENDAR,
  CAROUSEL,
  CTA,
  DONUT_CHART,
  FAMILY_BY_DEFINITION,
  FILTER,
  GALLERY,
  IMAGE,
  LINE_CHART,
  METRICS,
  NOTE,
  OVERVIEW,
  TABLE,
  VIDEO,
  WIDGETS,
  YOUTUBE,
  familyOf,
} from "../src/index.ts";

// NOTE is exported alongside the catalog but deliberately excluded from WIDGETS (see the
// comment on its definition), so it is validated separately here rather than through WIDGETS.
const ALL_DEFINITIONS = [...WIDGETS, NOTE];

describe("data canvas pack widget definitions", () => {
  it("validates every exported definition against the widget schema", () => {
    for (const definition of ALL_DEFINITIONS) {
      const result = widgetDefinitionSchema.safeParse(definition);
      if (!result.success) {
        throw new Error(`${definition.id} failed widget schema validation: ${result.error.message}`);
      }
    }
  });

  it("gives every definition a unique id", () => {
    const ids = ALL_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every definition a non-empty text fallback", () => {
    for (const definition of ALL_DEFINITIONS) {
      expect(definition.textFallback.trim().length).toBeGreaterThan(0);
    }
  });

  it("names a family for every entry the family map claims to cover", () => {
    for (const [id, family] of Object.entries(FAMILY_BY_DEFINITION)) {
      expect(familyOf(id)).toBe(family);
    }
  });

  it("reports unknown for a definition id the family map does not name", () => {
    expect(familyOf("canvas.does-not-exist@1")).toBe("unknown");
  });

  it("individually exports the same widget instances present in WIDGETS", () => {
    expect(WIDGETS).toEqual(
      expect.arrayContaining([
        LINE_CHART,
        BAR_CHART,
        DONUT_CHART,
        TABLE,
        OVERVIEW,
        METRICS,
        FILTER,
        CALENDAR,
        IMAGE,
        CAROUSEL,
        GALLERY,
        YOUTUBE,
        VIDEO,
        CTA,
      ]),
    );
  });
});
