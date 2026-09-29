import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STATUS_TONES, STEP_STATUSES } from "@clarkcant/contracts";
import { DETAILS, PROGRESS, STATUS } from "@clarkcant/data-canvas";
import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { RENDERER_IDS } from "../src/renderers.tsx";

/**
 * The status, progress and details renderers, checked where a Node suite can see them.
 *
 * The repo has no DOM test environment, so what a person sees is asserted in the browser journey. What is asserted here
 * is what a later edit could quietly break: each card has a renderer, every tone and step status is said in words in
 * both languages, and none of the three draws a freshness badge or a control, since what they show is what the model
 * wrote and nothing on them acts.
 */

const SOURCE = join(import.meta.dirname, "..", "src");

function functionBody(file: string, name: string): string {
  const text = readFileSync(join(SOURCE, file), "utf8");
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in ${file}`);
  const rest = text.slice(start);
  const end = rest.search(/\n(?:\/\*|function |export |const [A-Z_]+ =)/u);
  return end < 0 ? rest : rest.slice(0, end);
}

const RENDERERS = ["StatusCardView", "ProgressCardView", "DetailsCardView"];

describe("status cards", () => {
  it("has a renderer for each card, so none falls back to its text alternative", () => {
    expect(RENDERER_IDS).toEqual(expect.arrayContaining([STATUS.id, PROGRESS.id, DETAILS.id]));
  });

  it("says every tone and every step status in words, in both languages", () => {
    const keys: MessageKey[] = [
      ...STATUS_TONES.map((tone) => `widgets.status.tone.${tone}` as MessageKey),
      ...STEP_STATUSES.map((status) => `widgets.progress.step.${status}` as MessageKey),
    ];
    for (const key of keys) {
      expect(MESSAGES_EN[key], key).toBeTruthy();
      expect(MESSAGES_VI[key], key).toBeTruthy();
      expect(MESSAGES_VI[key], key).not.toBe(MESSAGES_EN[key]);
    }
  });

  it("names each tone for what it is, and says whose words a card shows, in both languages", () => {
    expect(MESSAGES_VI["widgets.status.tone.neutral" as MessageKey]).toBe("Ghi chú");
    expect(MESSAGES_VI["widgets.status.tone.info" as MessageKey]).toBe("Thông tin");
    expect(MESSAGES_EN["widgets.status.statedAt" as MessageKey]).toBe("As Clark stated at {time}");
    expect(MESSAGES_VI["widgets.status.statedAt" as MessageKey]).toBe("Theo Clark lúc {time}");
    expect(MESSAGES_EN["widgets.status.stated" as MessageKey]).toBe("As Clark stated");
    expect(MESSAGES_VI["widgets.status.stated" as MessageKey]).toBe("Theo lời Clark");
  });

  it("draws no freshness badge and no control on any of the three", () => {
    for (const name of RENDERERS) {
      const body = functionBody("renderers.tsx", name);
      expect(body, name).not.toMatch(/dataset=\{dataset\}/u);
      expect(body, name).toMatch(/dataset=\{undefined\}/u);
      expect(body, name).not.toMatch(/<button|<input|<select|tabIndex|onClick|onAction/u);
    }
  });

  it("gives a value of a maximum a progressbar with its range and a spoken value", () => {
    const body = functionBody("renderers.tsx", "ProgressCardView");
    for (const attribute of ['role="progressbar"', "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"]) {
      expect(body).toContain(attribute);
    }
    expect(body).toContain('aria-current={step.status === "current" ? "step" : undefined}');
  });
});
