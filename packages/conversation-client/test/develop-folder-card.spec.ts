import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type CommandCard, type WidgetDevSessionView, instantSchema } from "@clarkcant/contracts";

import { CommandCardBlock } from "../src/command-card.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { developOutcomeMessage } from "../src/use-block-actions.ts";

/**
 * The `/develop` card in the page: a typed folder path where the OS folder dialog cannot answer, with the reason it is
 * asked for, and the sentence a press settles on, read from what the node said about the session it started.
 */

const en = (key: MessageKey): string => MESSAGES_EN[key];
const vi = (key: MessageKey): string => MESSAGES_VI[key];

const CARD: CommandCard = {
  type: "command-card",
  owner: "host",
  cardId: "card_develop",
  command: "develop",
  title: "Develop a widget folder",
  updatedAt: instantSchema.parse("2026-10-08T00:00:00.000Z"),
  rows: [{ rowId: "choose", label: "Another folder", actions: [{ actionId: "choose", label: "Choose folder…", tone: "primary", action: { kind: "develop-folder" } }] }],
};

const view = (change: Partial<WidgetDevSessionView>): WidgetDevSessionView =>
  ({ root: "/home/me/timer", activation: { state: "active", generation: 1 }, ...change }) as WidgetDevSessionView;

describe("the /develop card", () => {
  it("asks for a typed path with the reason the dialog cannot answer, only where the page asked for one", () => {
    const actions = { onCommandAction: () => undefined };
    const closed = renderToStaticMarkup(createElement(CommandCardBlock, { block: CARD, t: en, actions }));
    expect(closed).not.toContain("data-folder-entry");

    for (const reason of ["browser", "remote-node", "dialog-failed"] as const) {
      const open = renderToStaticMarkup(
        createElement(CommandCardBlock, { block: CARD, t: en, actions: { ...actions, folderEntries: { "card_develop/choose/choose": reason } } }),
      );
      expect(open).toContain(`data-folder-entry="${reason}"`);
      // Compared as markup: the message's apostrophes are escaped there.
      expect(open).toContain(en(`commandCard.develop.reason.${reason}`).replaceAll("'", "&#x27;"));
      expect(open).toContain(`aria-label="${en("commandCard.develop.pathLabel")}"`);
    }
  });

  it("draws no path field on a record of the card, which has nothing to start", () => {
    const record = renderToStaticMarkup(createElement(CommandCardBlock, { block: CARD, t: en, actions: { folderEntries: { "card_develop/choose/choose": "browser" } } }));
    expect(record).not.toContain("data-folder-entry");
    expect(record).not.toContain("<button");
  });

  it("says what became of the session, in the owner's language", () => {
    expect(developOutcomeMessage(view({}), en)).toContain("/home/me/timer");
    expect(developOutcomeMessage(view({ activation: { state: "refused", code: "X", message: "no room" } as never }), vi)).toContain("no room");
    const failed = developOutcomeMessage(
      view({ lastBuild: { ok: false, at: "2026-10-08T00:00:00.000Z", diagnostics: [{ message: "widget.json is missing" }] } as never, activation: { state: "none" } }),
      en,
    );
    expect(failed).toContain("widget.json is missing");
    expect(MESSAGES_VI["commandCard.develop.reason.browser"]).not.toBe(MESSAGES_EN["commandCard.develop.reason.browser"]);
  });
});
