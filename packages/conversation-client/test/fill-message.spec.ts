import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fillMessage } from "../src/i18n/fill-message.ts";
import { MESSAGES_EN, MESSAGES_VI } from "../src/i18n/messages.ts";

/**
 * A message is filled in one pass: a value put into it is never read again as a placeholder, so a chart titled
 * "Top {count}" keeps its title.
 */

describe("filling a message", () => {
  it("keeps a placeholder inside a value as the value's own text", () => {
    expect(fillMessage("{title}: {count} point(s)", { title: "Top {count}", count: 5 })).toBe("Top {count}: 5 point(s)");
    expect(fillMessage("{title}: {count} điểm", { count: 5, title: "{title} {count}" })).toBe("{title} {count}: 5 điểm");
  });

  it("puts a value in as written, whatever replacement patterns it holds", () => {
    expect(fillMessage("{name} and {other}", { name: "$& $1 $$", other: "$`" })).toBe("$& $1 $$ and $`");
  });

  it("leaves a placeholder with no value as it is, and fills one used twice both times", () => {
    expect(fillMessage("{a} {missing} {a}", { a: "x" })).toBe("x {missing} x");
    // A field every object inherits is not a value.
    expect(fillMessage("{constructor}", {})).toBe("{constructor}");
  });

  it("fills every chart message the same way in both languages", () => {
    for (const messages of [MESSAGES_EN, MESSAGES_VI]) {
      expect(fillMessage(messages["widgets.xyChart.points"], { title: "Top {count}", count: 3 })).toContain("Top {count}");
    }
  });

  it("keeps an event titled with a placeholder as it was titled, in both languages", () => {
    for (const messages of [MESSAGES_EN, MESSAGES_VI]) {
      const said = fillMessage(messages["widgets.calendar.eventAria"], { title: "Review {when} and {title}", when: "10:00–11:00" });
      expect(said).toContain("Review {when} and {title}");
      expect(said).toContain("10:00–11:00");
    }
  });

  it("is what the chart and calendar renderers use, with no chain of single replacements left in them", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "renderers.tsx"), "utf8");
    for (const name of [
      "SeriesNote",
      "LineChart",
      "BarChart",
      "Donut",
      "XyTable",
      "XyChartRenderer",
      "calendarWhen",
      "calendarDuration",
      "calendarDayTime",
      "Calendar",
    ]) {
      const start = source.indexOf(`function ${name}(`);
      if (start < 0) throw new Error(`${name} is not in renderers.tsx`);
      const rest = source.slice(start);
      const end = rest.search(/\n(?:\/\*|function |export |const [A-Z_]+[:=])/u);
      const body = end < 0 ? rest : rest.slice(0, end);
      expect(body, name).not.toMatch(/\.replace\("\{\w+\}"/u);
    }
  });
});
