import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STATUS_TONES, TIMELINE_ID, TIMELINE_SELECT_OPERATION, readTimeline, timelinePage } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { RENDERER_IDS } from "../src/renderers.tsx";
import {
  TIMELINE_FOLD_CHARS,
  clampTimelinePage,
  foldedTimelineDescription,
  moveTimelineFocus,
  timelineDescriptionFolds,
  timelineTabStop,
  timelineToggle,
} from "../src/timeline-layout.ts";

/**
 * The activity timeline's keyboard, paging and folding rules, and what its renderer must keep saying.
 *
 * The repo has no DOM test environment, so what a person sees and presses is asserted in the browser journey. What is
 * asserted here is the logic the component leans on, and what a later edit could quietly break in its source: the one
 * view operation it sends, the tone said in words, the live region and the Escape key.
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

describe("timeline keyboard", () => {
  it("moves one entry at a time with the arrows, to either end with Home and End, and never off the list", () => {
    expect(moveTimelineFocus("ArrowDown", 0, 3)).toBe(1);
    expect(moveTimelineFocus("ArrowRight", 1, 3)).toBe(2);
    expect(moveTimelineFocus("ArrowUp", 2, 3)).toBe(1);
    expect(moveTimelineFocus("ArrowLeft", 1, 3)).toBe(0);
    expect(moveTimelineFocus("Home", 2, 3)).toBe(0);
    expect(moveTimelineFocus("End", 0, 3)).toBe(2);
    expect(moveTimelineFocus("ArrowDown", 2, 3)).toBeUndefined();
    expect(moveTimelineFocus("ArrowUp", 0, 3)).toBeUndefined();
    expect(moveTimelineFocus("Home", 0, 3)).toBeUndefined();
    expect(moveTimelineFocus("End", 2, 3)).toBeUndefined();
    expect(moveTimelineFocus("Enter", 1, 3)).toBeUndefined();
    expect(moveTimelineFocus("ArrowDown", 0, 0)).toBeUndefined();
  });

  it("keeps one tab stop: the entry last focused, else the selected one, else the first", () => {
    const page = ["a", "b", "c"];
    expect(timelineTabStop(page, "c", "b")).toBe("c");
    expect(timelineTabStop(page, undefined, "b")).toBe("b");
    // An entry focused or selected on another page gives the stop back to this page's first.
    expect(timelineTabStop(page, "z", "y")).toBe("a");
    expect(timelineTabStop([], undefined, undefined)).toBeUndefined();
  });

  it("selects an entry, and pressing the selected one again clears it", () => {
    expect(timelineToggle(undefined, "a")).toBe("a");
    expect(timelineToggle("b", "a")).toBe("a");
    expect(timelineToggle("a", "a")).toBeUndefined();
  });
});

describe("timeline pages and descriptions", () => {
  it("keeps a page within the timeline", () => {
    expect(clampTimelinePage(-1, 3)).toBe(0);
    expect(clampTimelinePage(5, 3)).toBe(2);
    expect(clampTimelinePage(1.7, 3)).toBe(1);
    expect(clampTimelinePage(0, 0)).toBe(0);
  });

  it("groups a page's entries by day in the timeline's timezone", () => {
    const timeline = readTimeline({
      timezone: "Asia/Saigon",
      pageSize: 5,
      entries: Array.from({ length: 7 }, (_, index) => ({ id: `e${String(index)}`, at: `2026-09-${String(24 + index)}T18:00:00Z`, title: `E${String(index)}` })),
    });
    if (timeline === undefined) throw new Error("not a timeline");
    // 18:00 UTC is 01:00 the next day in Saigon, so each entry is on the day after the one its instant names.
    expect(timelinePage(timeline, 0).map((day) => day.day)).toEqual(["2026-10-01", "2026-09-30", "2026-09-29", "2026-09-28", "2026-09-27"]);
    expect(timelinePage(timeline, 1).map((day) => day.day)).toEqual(["2026-09-26", "2026-09-25"]);
  });

  it("folds a long description, or one of many lines, and cuts it at a word", () => {
    expect(timelineDescriptionFolds(undefined)).toBe(false);
    expect(timelineDescriptionFolds("short")).toBe(false);
    expect(timelineDescriptionFolds("x".repeat(TIMELINE_FOLD_CHARS + 1))).toBe(true);
    expect(timelineDescriptionFolds("a\nb\nc\nd")).toBe(true);
    expect(foldedTimelineDescription("a\nb\nc\nd")).toBe("a\nb\nc…");
    const words = "word ".repeat(60).trim();
    const folded = foldedTimelineDescription(words);
    expect(folded.endsWith("word…")).toBe(true);
    expect(folded.length).toBeLessThanOrEqual(TIMELINE_FOLD_CHARS + 1);
    // A character outside the Basic Multilingual Plane is never cut in half.
    const emoji = foldedTimelineDescription("🙂".repeat(TIMELINE_FOLD_CHARS + 5));
    expect(emoji).toBe(`${"🙂".repeat(TIMELINE_FOLD_CHARS)}…`);
  });
});

describe("the timeline renderer", () => {
  const body = functionBody("renderers.tsx", "ActivityTimeline");

  it("has a renderer, so it never falls back to its text alternative", () => {
    expect(RENDERER_IDS).toContain(TIMELINE_ID);
  });

  it("sends one view operation, the one the node binds, with an empty id to clear", () => {
    expect(TIMELINE_SELECT_OPERATION).toBe("timeline.select");
    expect(body).toContain('onAction?.(TIMELINE_SELECT_OPERATION, { selectedId: next ?? "" });');
    expect(body).toContain("onStateChange?.({ selectedId: next });");
  });

  it("says a tone with a symbol and a word, clears on Escape, and announces the selection", () => {
    expect(body).toContain("TONE_MARK[entry.tone]");
    expect(body).toContain("widgets.status.tone.${entry.tone}");
    expect(body).toContain('keyEvent.key === "Escape"');
    expect(body).toContain('aria-live="polite"');
    expect(body).toContain("aria-pressed={isSelected}");
    expect(body).toContain("tabIndex={entry.id === tabStop ? 0 : -1}");
    expect(body).toContain('role="status"');
    expect(body).toContain("withHiddenMarkers");
  });

  it("says every tone and every timeline message in both languages", () => {
    const keys = [
      ...STATUS_TONES.map((tone) => `widgets.status.tone.${tone}`),
      ...Object.keys(MESSAGES_EN).filter((key) => key.startsWith("widgets.timeline.")),
    ] as MessageKey[];
    expect(keys.filter((key) => key.startsWith("widgets.timeline.")).length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(MESSAGES_VI[key], key).toBeTruthy();
      expect(MESSAGES_EN[key], key).toBeTruthy();
    }
    // Every key the renderer names exists.
    for (const [, key] of body.matchAll(/"(widgets\.timeline\.[\w.]+)"/gu)) {
      expect(Object.hasOwn(MESSAGES_EN, key ?? ""), key).toBe(true);
    }
  });
});
