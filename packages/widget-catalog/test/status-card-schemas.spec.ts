import { describe, expect, it } from "vitest";

import { detailsCardSchema, progressCardSchema, statusCardSchema, validateProps } from "@clarkcant/contracts";
import { DETAILS, PROGRESS, STATUS } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";

/**
 * The JSON Schema a model reads and the schema the node and the page check with say the same thing.
 *
 * A status card's props are held to both: the definition's JSON Schema first, then the card's own schema. If they drift,
 * a card the model was told is fine is refused with a reason it was never shown, or the page refuses to draw a card the
 * node stored. The cross-field rules (a value above its maximum, a label twice) are the card's alone and are not here.
 */

const CARDS = [
  { definition: STATUS, schema: statusCardSchema },
  { definition: PROGRESS, schema: progressCardSchema },
  { definition: DETAILS, schema: detailsCardSchema },
] as const;

const BAD: Record<string, Record<string, unknown>[]> = {
  [STATUS.id]: [
    { label: "Up\nDown", tone: "info" },
    { label: "Up", tone: "info", title: "Build ‮evil" },
    { label: "Up", tone: "info", detail: "a b" },
    { label: "   ", tone: "info" },
    { label: "", tone: "info" },
    { label: "x".repeat(121), tone: "info" },
    { label: "Up", tone: "red" },
    { label: "Up", tone: "info", live: true },
    { label: "Up", tone: "info", asOf: "2026-09-30T09:00:00" },
  ],
  [PROGRESS.id]: [
    { steps: [{ label: "Pack​", status: "done" }] },
    { steps: [{ label: " ", status: "done" }] },
    { steps: [{ label: "Pack", status: "done", detail: "a\tb" }] },
    { steps: [{ label: "Pack", status: "running" }] },
    { value: 1, max: 2, unit: "fi\u0085les" },
    { value: 1, max: 2, label: "﻿Photos" },
    { value: -1, max: 2 },
  ],
  [DETAILS.id]: [
    { items: [{ label: "Owner", value: "L⁦an" }] },
    { items: [{ label: "؜Owner", value: "Lan" }] },
    { items: [{ label: "Owner", value: "  " }] },
    { items: [{ label: "Owner", value: "Lan", tone: "ok" }] },
    { items: [] },
  ],
};

const GOOD: Record<string, Record<string, unknown>[]> = {
  [STATUS.id]: [{ label: "  Up  ", tone: "info", title: " " }],
  [PROGRESS.id]: [{ steps: [{ label: "👩‍💻 Code", status: "current" }] }],
  [DETAILS.id]: [{ items: [{ label: "Tên", value: "می‌خواهم" }] }],
};

describe("status card schemas", () => {
  for (const { definition, schema } of CARDS) {
    const cases = [
      ...fixturesFor(definition.id).map((fixture) => fixture.props as Record<string, unknown>),
      ...(GOOD[definition.id] ?? []),
      ...(BAD[definition.id] ?? []),
    ];

    it(`${definition.id}: the JSON Schema and the card's schema accept and refuse the same props`, () => {
      expect(fixturesFor(definition.id).length).toBeGreaterThan(0);
      for (const props of cases) {
        const json = validateProps(definition, props).ok;
        const card = schema.safeParse(props).success;
        expect({ props, json }).toEqual({ props, json: card });
      }
    });

    it(`${definition.id}: accepts every library fixture, and refuses every bad case`, () => {
      for (const fixture of fixturesFor(definition.id)) expect(schema.safeParse(fixture.props).success, fixture.id).toBe(true);
      for (const props of BAD[definition.id] ?? []) expect(validateProps(definition, props).ok, JSON.stringify(props)).toBe(false);
    });
  }

  it("names the character the JSON Schema refused, rather than its pattern", () => {
    const refused = validateProps(STATUS, { label: "Up", tone: "info", title: "Build ‮evil" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.problems).toEqual([
      'property "title": contains U+202E, a control that changes text direction, so the text would read differently from how it is drawn; remove it',
    ]);
    const empty = validateProps(DETAILS, { items: [{ label: "Owner", value: "  " }] });
    expect(empty.ok ? [] : empty.problems).toEqual(['property "items.0.value": is empty']);
  });
});
