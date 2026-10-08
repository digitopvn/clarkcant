import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type CommandCard, type WidgetDevSessionView, instantSchema } from "@clarkcant/contracts";

import { GatewayClient } from "../src/api.ts";
import { CommandCardBlock } from "../src/command-card.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { developOutcomeMessage, forgetOutcomeMessage, forgetRefused } from "../src/use-block-actions.ts";

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

  it("offers a Forget button on a chosen folder, and drops a row's old badge once a press on it has settled", () => {
    const chosen: CommandCard = {
      ...CARD,
      rows: [
        {
          rowId: "chosen:0",
          label: "/home/me/widgets",
          note: "Clark may develop in this folder and every folder inside it.",
          badge: { text: "you chose", tone: "success" },
          actions: [{ actionId: "forget", label: "Forget", action: { kind: "develop-folder-forget", root: "/home/me/widgets" } }],
        },
      ],
    };
    const actions = { onCommandAction: () => undefined };
    const before = renderToStaticMarkup(createElement(CommandCardBlock, { block: chosen, t: en, actions }));
    expect(before).toContain("you chose");
    expect(before).toContain(">Forget</button>");
    expect(before).toContain("every folder inside it");

    const forgotten = en("commandCard.develop.forgotten").replace("{folder}", "/home/me/widgets");
    const after = renderToStaticMarkup(
      createElement(CommandCardBlock, {
        block: chosen,
        t: en,
        actions: { ...actions, commandAction: { "card_develop/chosen:0/forget": { status: "done", message: forgotten } } },
      }),
    );
    expect(after).not.toContain("you chose");
    expect(after).toContain(forgotten.replaceAll("'", "&#x27;"));

    // A failed press leaves what was true when the card was drawn.
    const failed = renderToStaticMarkup(
      createElement(CommandCardBlock, { block: chosen, t: en, actions: { ...actions, commandAction: { "card_develop/chosen:0/forget": { status: "failed", message: "no" } } } }),
    );
    expect(failed).toContain("you chose");
    expect(MESSAGES_VI["commandCard.develop.forgotten"]).toContain("{folder}");
    expect(MESSAGES_EN["commandCard.develop.notChosen"]).toContain("{folder}");
  });

  it("settles a Forget whose answer this app cannot read as unknown, keeping the row's badge", async () => {
    // The node answered the forget with a field this app does not know; that answer is read strictly, so it refuses.
    const fetchImpl = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === "/node"
        ? Response.json({ clarkVersion: "0.3.0" })
        : Response.json({ root: "/home/me/widgets", forgotten: true, keptFor: "a newer reason" })) as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8765", token: "tok", fetchImpl, appVersion: "0.2.1" });
    const cause = await client.forgetWidgetDevFolder("/home/me/widgets").then(
      () => undefined,
      (error: unknown) => error,
    );

    const state = forgetRefused(cause, en);
    expect(state).toEqual({
      status: "unknown",
      message: `${en("shell.nodeView.answered")} ${en("shell.nodeView.newer").replace("{node}", "0.3.0").replace("{app}", "0.2.1")}`,
    });
    expect(forgetRefused(cause, vi)).toMatchObject({ status: "unknown", message: expect.stringMatching(/^Node đã trả lời, /u) as string });
    // Any other error is the node's reason, said as a failure.
    expect(forgetRefused(new Error("offline"), en)).toEqual({ status: "failed", message: "offline" });

    // Neither forgotten nor kept is claimed: the row keeps the badge it was drawn with, and the line is not a success.
    const chosen: CommandCard = {
      ...CARD,
      rows: [
        {
          rowId: "chosen:0",
          label: "/home/me/widgets",
          badge: { text: "you chose", tone: "success" },
          actions: [{ actionId: "forget", label: "Forget", action: { kind: "develop-folder-forget", root: "/home/me/widgets" } }],
        },
      ],
    };
    const drawn = renderToStaticMarkup(
      createElement(CommandCardBlock, { block: chosen, t: en, actions: { onCommandAction: () => undefined, commandAction: { "card_develop/chosen:0/forget": state } } }),
    );
    expect(drawn).toContain('data-result="unknown"');
    expect(drawn).toContain("you chose");
  });

  it("says when a press was not kept as a folder Clark may use, and why", () => {
    const kept = developOutcomeMessage(view({ chosenByPerson: true }), en, "/home/me/timer");
    expect(kept).not.toContain(en("commandCard.develop.notKeptLink").slice(0, 20));
    const link = developOutcomeMessage(view({ root: "/home/me/wide" }), en, "/home/me/timer");
    expect(link).toContain("The path you gave leads to /home/me/wide");
    const broad = developOutcomeMessage(view({ root: "/home/me" }), en, "/home/me/");
    expect(broad).toContain(en("commandCard.develop.notKeptBroad"));
    // Without a press (a record of the session), nothing is said about choosing.
    expect(developOutcomeMessage(view({}), en)).not.toContain(en("commandCard.develop.notKeptBroad"));
  });

  it("says a forgotten folder is still reachable through a folder that holds it", () => {
    expect(forgetOutcomeMessage({ root: "/a/b", forgotten: true, stillCoveredBy: "/a" }, en)).toBe(
      en("commandCard.develop.forgottenCovered").replace("{folder}", "/a/b").replace("{cover}", "/a"),
    );
    expect(forgetOutcomeMessage({ root: "/a/b", forgotten: false, stillCoveredBy: "/a" }, vi)).toContain("/a");
    expect(forgetOutcomeMessage({ root: "/a", forgotten: true }, en)).toBe(en("commandCard.develop.forgotten").replace("{folder}", "/a"));
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
