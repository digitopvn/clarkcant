import { describe, expect, it } from "vitest";

import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { familyLabel } from "../src/widget-library/family-labels.ts";

const tIn = (locale: "vi" | "en") => (key: MessageKey): string => CATALOGS[locale][key];

describe("a widget family in the reader's words", () => {
  it("names a catalog family in the interface language, not by its id", () => {
    expect(familyLabel("trend", tIn("vi"))).toBe("Xu hướng");
    expect(familyLabel("trend", tIn("en"))).toBe("Trends");
    expect(familyLabel("cta", tIn("vi"))).toBe("Kêu gọi hành động");
    expect(familyLabel("tables", tIn("en"))).toBe("Tables");
  });

  it("shows a family it has no words for as it came", () => {
    expect(familyLabel("acme-gauges", tIn("vi"))).toBe("acme-gauges");
  });
});
