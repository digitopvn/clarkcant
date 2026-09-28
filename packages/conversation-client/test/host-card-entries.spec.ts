import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { HOST_CARD_ENTRIES, visibleHostCards } from "../src/widget-library/host-card-entries.ts";

/**
 * Which host-owned cards the Widget Library lists for a filter.
 *
 * The library describes these cards rather than previewing them, so the only behaviour to pin is that they are
 * found the way a person would look for them, in either language and without tone marks, and that a family facet
 * they do not belong to hides them.
 */
const vi = (key: MessageKey): string => MESSAGES_VI[key];
const en = (key: MessageKey): string => MESSAGES_EN[key];
const ids = (list: readonly { id: string }[]): string[] => list.map((entry) => entry.id);

describe("host cards in the widget library", () => {
  it("lists the terminal with no filter", () => {
    expect(ids(visibleHostCards(HOST_CARD_ENTRIES, { family: "all", query: "" }, vi))).toEqual(["terminal-session-card"]);
  });

  it("finds it by name, alias or description, with or without tone marks", () => {
    for (const query of ["terminal", "Shell", "dòng lệnh", "dong lenh", "htop"]) {
      expect(ids(visibleHostCards(HOST_CARD_ENTRIES, { family: "all", query }, vi)), query).toEqual(["terminal-session-card"]);
    }
    expect(ids(visibleHostCards(HOST_CARD_ENTRIES, { family: "all", query: "background processes" }, en))).toEqual([
      "terminal-session-card",
    ]);
  });

  it("hides it for a query it does not match and for a family it has none of", () => {
    expect(visibleHostCards(HOST_CARD_ENTRIES, { family: "all", query: "biểu đồ" }, vi)).toEqual([]);
    expect(visibleHostCards(HOST_CARD_ENTRIES, { family: "chart", query: "" }, vi)).toEqual([]);
  });
});
