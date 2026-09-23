import { describe, expect, it } from "vitest";

import { fixtureDatasetSchema, widgetFixtureSchema } from "@clarkcant/contracts";

import { FIXTURES } from "../src/fixtures.ts";

/**
 * The fixture contract is the shared one in `@clarkcant/contracts`, not a shape this package invented.
 *
 * `widgetFixtureSchema` is what makes "fixtures are data, never code" checkable: it is a strict object,
 * so a fixture carrying an unexpected key - an effect binding, say - fails here instead of being
 * rendered as if it were inert. Without a test that runs it, the schema would be a declaration nothing
 * verifies.
 */

const entries = Object.entries(FIXTURES);

describe("catalog fixtures match the shared fixture contract", () => {
  it("has fixtures to validate, so the loop below cannot pass vacuously", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("validates every fixture against widgetFixtureSchema", () => {
    for (const [definitionId, fixtures] of entries) {
      for (const fixture of fixtures) {
        const parsed = widgetFixtureSchema.safeParse(fixture);
        const detail = parsed.success ? "" : JSON.stringify(parsed.error.issues);
        expect(parsed.success, `${definitionId}/${fixture.id}: ${detail}`).toBe(true);
      }
    }
  });

  it("validates every dataset a fixture carries against fixtureDatasetSchema", () => {
    for (const [definitionId, fixtures] of entries) {
      for (const fixture of fixtures) {
        if (fixture.dataset === undefined) continue;
        const parsed = fixtureDatasetSchema.safeParse(fixture.dataset);
        const detail = parsed.success ? "" : JSON.stringify(parsed.error.issues);
        expect(parsed.success, `${definitionId}/${fixture.id}: ${detail}`).toBe(true);
      }
    }
  });

  it("rejects a fixture carrying an executable payload, which is what the strict schema is for", () => {
    // If this ever passes, the schema has been loosened and the "no effect binding in a preview" rule
    // has lost its enforcement.
    const withEffect = { id: "x", label: "X", props: {}, onClick: "runSomething" };
    expect(widgetFixtureSchema.safeParse(withEffect).success).toBe(false);
  });
});
