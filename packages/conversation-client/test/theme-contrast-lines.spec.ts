import { describe, expect, it } from "vitest";

import { COLOR_TOKEN_NAMES, type ThemeContrastFailureView } from "@clarkcant/contracts";
import { themeContrastProblem } from "@clarkcant/design-tokens";

import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { contrastLines } from "../src/settings/theme-contrast-lines.ts";

const vi = (key: MessageKey): string => CATALOGS.vi[key];
const en = (key: MessageKey): string => CATALOGS.en[key];

const ACCENT_ON_PAGE: ThemeContrastFailureView = { scheme: "dark", foreground: "accent", background: "canvas", ratio: 2, minimum: 4.5 };

describe("a theme's failing colour pairs, in the reader's language", () => {
  it("says each pair on its own line, with the numbers written the Vietnamese way", () => {
    expect(contrastLines([ACCENT_ON_PAGE], vi, "vi")).toEqual(["Chữ nhấn trên nền trang (tối): 2,00:1, cần 4,5:1"]);
    expect(
      contrastLines(
        [
          { scheme: "light", foreground: "onAccent", background: "accent", ratio: 3.456, minimum: 4.5 },
          { scheme: "dark", foreground: "border", background: "card", ratio: 1.1, minimum: 1.2 },
          { scheme: "dark", foreground: "focus", background: "elevated", ratio: 2.5, minimum: 3 },
        ],
        vi,
        "vi",
      ),
    ).toEqual([
      "Nhãn nút trên nút màu nhấn (sáng): 3,46:1, cần 4,5:1",
      "Đường kẻ trên thẻ (tối): 1,10:1, cần 1,2:1",
      "Viền tiêu điểm trên bề mặt nổi (tối): 2,50:1, cần 3:1",
    ]);
  });

  it("says the same pairs in English with English numbers", () => {
    expect(contrastLines([ACCENT_ON_PAGE], en, "en")).toEqual(["Accent text on the page (dark): 2.00:1, needs 4.5:1"]);
    expect(contrastLines([{ scheme: "light", foreground: "onAccent", background: "accent", ratio: 3.4, minimum: 4.5 }], en, "en")).toEqual([
      "Button label on an accent button (light): 3.40:1, needs 4.5:1",
    ]);
  });

  it("words every pair the audit can fail, in both languages, without leaving a token name or English in Vietnamese", () => {
    const dim = themeContrastProblem({
      appearanceApi: { min: 1, max: 1 },
      id: "murk",
      displayName: "Murk",
      colors: {
        dark: { accent: "#222222", success: "#222222", warning: "#222222", danger: "#222222", textTertiary: "#222222", focus: "#222222" },
        light: { accent: "#EEEEEE", onAccent: "#EEEEEE", textMuted: "#EEEEEE", border: "#FFFFFF" },
      },
    });
    const failures = dim?.failures ?? [];
    expect(failures.length).toBeGreaterThan(20);
    const viLines = contrastLines(failures, vi, "vi");
    const enLines = contrastLines(failures, en, "en");
    expect(viLines).toHaveLength(failures.length);
    expect(enLines).toHaveLength(failures.length);
    for (const line of viLines) {
      expect(line).not.toMatch(/\{|\}|\b(on|needs|text|the|dark|light)\b/);
      for (const token of COLOR_TOKEN_NAMES) expect(line).not.toContain(` ${token} `);
    }
    for (const line of enLines) expect(line).not.toMatch(/\{|\}| trên |cần/);
  });
});
