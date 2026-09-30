import { describe, expect, it } from "vitest";

import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { recentEffectText } from "../src/settings/ControlSettings.tsx";

const vi = (key: MessageKey): string => CATALOGS.vi[key];
const en = (key: MessageKey): string => CATALOGS.en[key];

/** Any character from the Vietnamese-specific range of Latin Extended, which no English sentence has. */
const VIETNAMESE_DIACRITIC = /[À-ỹ]/u;

describe("an effect in the Control tab's list of what ran without asking", () => {
  const press = {
    description: "browser click “Send application” on shop.example/apply (task task_1)",
    action: { verb: "click" as const, label: "Send application", page: "shop.example/apply" },
  };

  it("words a press on a page in the language the person chose", () => {
    expect(recentEffectText(press, en)).toBe("Browser: click “Send application” on shop.example/apply");
    expect(recentEffectText(press, en)).not.toMatch(VIETNAMESE_DIACRITIC);
    expect(recentEffectText(press, vi)).toBe("Trình duyệt: bấm “Send application” trên shop.example/apply");
  });

  it("writes a button's name as it is, a dollar sign included", () => {
    const priced = { ...press, action: { ...press.action, label: "Pay $& now $1" } };
    expect(recentEffectText(priced, en)).toBe("Browser: click “Pay $& now $1” on shop.example/apply");
  });

  it("keeps the node's own words for an effect that is not a press", () => {
    expect(recentEffectText({ description: "git status --short" }, en)).toBe("git status --short");
    expect(recentEffectText({ description: "git status --short" }, vi)).toBe("git status --short");
  });
});
