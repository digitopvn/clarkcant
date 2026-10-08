import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type CommandCard, type FeedbackCard, feedbackCardSchema, instantSchema } from "@clarkcant/contracts";

import { GatewayClient, GatewayError, NODE_NOT_ANSWERING, NodeViewUnreadable } from "../src/api.ts";
import type { BlockActions, CommandActionState, FeedbackCardState } from "../src/blocks.tsx";
import { CommandCardBlock, commandActionRetryable } from "../src/command-card.tsx";
import { FEEDBACK_PRESS_PHASE, FeedbackCardBlock, FeedbackResult } from "../src/feedback-card.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { retryableFailure } from "../src/node-view-refusal.ts";
import { type CommandPressDeps, commandPresses, developStartRefused, feedbackPressFailed, feedbackReportToReuse, forgetRefused } from "../src/use-block-actions.ts";
import { signInStartRefused, signOutRefused } from "../src/use-provider-sign-ins.ts";
import { findAll, textOf } from "./block-helpers.ts";

/**
 * Try again where the shared status says a failure can be retried, and nowhere else; and a feedback answer this app
 * cannot read said as "not known whether it was filed" with Check again, never as a failure with the schema's text.
 */

const en = (key: MessageKey): string => MESSAGES_EN[key];
const vi = (key: MessageKey): string => MESSAGES_VI[key];

const offline = (): TypeError => new TypeError("Failed to fetch");
const timedOut = (): GatewayError => new GatewayError(504, NODE_NOT_ANSWERING, "the node did not answer in time");
const policy = (): GatewayError => new GatewayError(403, "POLICY_REFUSED", "not allowed by policy");
const unreadable = (): NodeViewUnreadable => new NodeViewUnreadable({ node: "0.9.0", app: "0.8.0" }, new Error("Invalid input: expected string"));

describe("which failures can be tried again", () => {
  it("is the ones that did not reach the node or got no answer in time", () => {
    expect(retryableFailure(offline())).toBe(true);
    expect(retryableFailure(timedOut())).toBe(true);
    for (const status of [408, 429, 502, 503, 504]) expect(retryableFailure(new GatewayError(status, "BUSY", "later"))).toBe(true);
  });

  it("is never a decision of the node's, its own failure, or an answer this app cannot read", () => {
    expect(retryableFailure(policy())).toBe(false);
    for (const status of [400, 401, 404, 409, 422, 500]) expect(retryableFailure(new GatewayError(status, "NO", "no"))).toBe(false);
    expect(retryableFailure(unreadable())).toBe(false);
    expect(retryableFailure(new GatewayError(502, "MALFORMED_RESPONSE", "not JSON"))).toBe(false);
    expect(retryableFailure(new Error("something else"))).toBe(false);
    expect(retryableFailure("a string")).toBe(false);
  });
});

const CARD: CommandCard = {
  type: "command-card",
  owner: "host",
  cardId: "card_1",
  command: "thinking",
  title: "Thinking",
  updatedAt: instantSchema.parse("2026-10-08T00:00:00.000Z"),
  rows: [{ rowId: "high", label: "High", actions: [{ actionId: "set", label: "Use", action: { kind: "set-thinking", level: "high" } }] }],
};

const drawCard = (state: CommandActionState, t = en): string =>
  renderToStaticMarkup(createElement(CommandCardBlock, { block: CARD, t, actions: { onCommandAction: () => undefined, commandAction: { "card_1/high/set": state } } }));

describe("a command card row's Try again", () => {
  it("is offered beside a press that did not get through, in the reader's language", () => {
    const failed: CommandActionState = { status: "failed", message: "offline", next: "retry", attempt: 1 };
    expect(commandActionRetryable(failed)).toBe(true);
    expect(drawCard(failed)).toContain('data-command-retry="set"');
    expect(drawCard(failed)).toContain(`>${MESSAGES_EN["surface.retry"]}</button>`);
    expect(drawCard(failed, vi)).toContain(`>${MESSAGES_VI["surface.retry"]}</button>`);
  });

  it("is not offered for a refusal, a success, a reply nobody can read, or while the press runs", () => {
    const states: CommandActionState[] = [
      { status: "failed", message: "refused" },
      { status: "done", message: "ok" },
      { status: "unknown", message: "?" },
      { status: "pending", attempt: 2 },
    ];
    for (const state of states) {
      expect(commandActionRetryable(state)).toBe(false);
      expect(drawCard(state)).not.toContain("data-command-retry");
    }
  });
});

const answered = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("presses on a command card settle with Try again only where it can help", () => {
  type Client = CommandPressDeps["client"];

  function runner(over: Partial<Omit<CommandPressDeps, "client">> & { client?: Partial<Client> } = {}) {
    let attempts = 0;
    let actions: Readonly<Record<string, CommandActionState>> = {};
    const presses = commandPresses({
      conversationId: "c1",
      t: en,
      nextAttempt: () => ++attempts,
      updateActions: (change) => (actions = change(actions)),
      updateFolderEntries: () => undefined,
      startSignIn: () => Promise.resolve(),
      signOut: () => Promise.resolve({ signedOut: true }),
      ...over,
      client: { nodeOnThisMachine: () => true, ...over.client } as Client,
    });
    return { presses, actions: () => actions };
  }

  const setHigh = { cardId: "card_1", rowId: "high", actionId: "set", action: { kind: "set-thinking", level: "high" } } as const;

  it("offers it for a /thinking press that did not reach the node, and not for one the node refused", async () => {
    const lost = runner({ client: { writePreference: () => Promise.reject(offline()) } });
    lost.presses.press(setHigh);
    await answered();
    expect(lost.actions()["card_1/high/set"]).toMatchObject({ status: "failed", next: "retry" });

    const refused = runner({ client: { writePreference: () => Promise.reject(new GatewayError(409, "PREFERENCE_REFUSED", "locked")) } });
    refused.presses.press(setHigh);
    await answered();
    expect(refused.actions()["card_1/high/set"]).not.toHaveProperty("next");
  });

  it("keeps the typed folder on a /develop start that timed out, so Try again starts the same folder", async () => {
    const { presses, actions } = runner({ client: { startWidgetDevSession: () => Promise.reject(timedOut()) } });
    presses.developTyped({ cardId: "card_1", rowId: "dev", actionId: "pick", root: "/work/widget" });
    await answered();
    expect(actions()["card_1/dev/pick"]).toMatchObject({ status: "failed", next: "retry", root: "/work/widget" });
  });

  it("offers it for a sign-in or sign-out that did not get through", async () => {
    const signIn = runner({ startSignIn: () => Promise.reject(offline()) });
    signIn.presses.press({ cardId: "card_1", rowId: "fake", actionId: "sign-in", action: { kind: "provider-sign-in", providerId: "fake", method: "oauth" } });
    await answered();
    expect(signIn.actions()["card_1/fake/sign-in"]).toMatchObject({ status: "failed", next: "retry" });
  });

  it("words each refusal as before, with next only for what can be tried again", () => {
    expect(signInStartRefused(offline(), en)).toMatchObject({ status: "failed", next: "retry" });
    expect(signInStartRefused(policy(), en)).not.toHaveProperty("next");
    expect(signOutRefused(timedOut(), en)).toMatchObject({ status: "failed", next: "retry" });
    expect(signOutRefused(new GatewayError(409, "SIGN_OUT_NOT_HERE", "env"), en)).not.toHaveProperty("next");
    expect(developStartRefused(policy(), en, "/work")).not.toHaveProperty("next");
    expect(developStartRefused(unreadable(), en, "/work")).toMatchObject({ status: "unknown" });
    expect(forgetRefused(offline(), en)).toMatchObject({ status: "failed", next: "retry" });
    expect(forgetRefused(unreadable(), en)).toMatchObject({ status: "unknown" });
  });
});

describe("a terminal view that did not load", () => {
  // The browser keeps a failed import for the page's life, so pressing again in the page would bring the same failure
  // back: no Try again is offered, and the notice says what does load it — reloading the app.
  it("says that reloading the app loads it again, in both languages", () => {
    expect(MESSAGES_EN["blocks.terminal.loadFailed"]).toContain("reload the app");
    expect(MESSAGES_VI["blocks.terminal.loadFailed"]).toContain("tải lại ứng dụng");
  });
});

describe("a feedback press that did not come back readable", () => {
  it("reads an unreadable publish answer as not known whether it was filed, in both languages, never the schema", () => {
    for (const [t, messages] of [
      [en, MESSAGES_EN],
      [vi, MESSAGES_VI],
    ] as const) {
      const state = feedbackPressFailed(unreadable(), t, { press: "create", intent: "send", reportId: "rpt_1", requestKey: "k", published: true });
      expect(state).toMatchObject({ status: "unknown", reportId: "rpt_1", requestKey: "k" });
      expect(state.status === "unknown" ? state.message : "").toMatch(new RegExp(`^${messages["feedback.unread"].replace(/[.?]/gu, "\\$&")} `, "u"));
      expect(JSON.stringify(state)).not.toMatch(/Invalid|expected/u);
    }
    expect(FEEDBACK_PRESS_PHASE.unknown).toBe("partial");
  });

  it("reads an unreadable preparation as a whole sentence that nothing was filed, with nothing to repeat", () => {
    const state = feedbackPressFailed(unreadable(), en, { press: "preview", requestKey: "k", published: false });
    expect(state).toMatchObject({ status: "failed", requestKey: "k" });
    expect(state).not.toHaveProperty("next");
    expect(state).not.toHaveProperty("press");
    expect(state.status === "failed" ? state.message.startsWith(MESSAGES_EN["shell.nodeView.read"]) : false).toBe(true);
  });

  it("offers Try again for a press that did not get through, and nothing for a refusal", () => {
    expect(feedbackPressFailed(offline(), en, { press: "create", intent: "send", reportId: "rpt_1", published: true })).toMatchObject({
      status: "failed",
      press: "create",
      intent: "send",
      reportId: "rpt_1",
      next: "retry",
    });
    expect(feedbackPressFailed(new GatewayError(409, "NOTHING_SENT", "never sent"), en, { press: "create", intent: "check", reportId: "rpt_1", published: true })).not.toHaveProperty(
      "next",
    );
  });

  it("keeps the report an unknown answer is about, so a later press for the same words acts on it", () => {
    expect(feedbackReportToReuse({ status: "unknown", message: "?", reportId: "rpt_1", requestKey: "k" }, "k")).toBe("rpt_1");
    expect(feedbackReportToReuse({ status: "unknown", message: "?", reportId: "rpt_1", requestKey: "k" }, "other")).toBeUndefined();
  });
});

describe("the gateway client's feedback answers", () => {
  const client = (body: unknown): GatewayClient =>
    new GatewayClient({
      baseUrl: "http://node.test",
      token: "t",
      appVersion: "0.8.0",
      fetchImpl: (input) =>
        Promise.resolve(
          new Response(JSON.stringify(String(input).endsWith("/node") ? { clarkVersion: "0.9.0" } : body), { status: 200, headers: { "content-type": "application/json" } }),
        ),
    });

  it("says a publish answer it cannot read as NodeViewUnreadable, not the schema's error", async () => {
    await expect(client({ timeline: { messages: [] }, surprise: true }).publishFeedback("rpt_1", "c1")).rejects.toBeInstanceOf(NodeViewUnreadable);
  });

  it("says a preparation answer it cannot read as NodeViewUnreadable, not the schema's error", async () => {
    await expect(client({ nothing: "useful" }).prepareFeedback({ kind: "bug", description: "the orb freezes" } as never)).rejects.toBeInstanceOf(NodeViewUnreadable);
  });
});

const AT = "2026-10-06T09:00:00.000Z";
const BASE = { type: "feedback-card", owner: "host", repository: "digitopvn/clarkcant", kind: "bug", diagnostics: [], updatedAt: AT };
const RESULT: FeedbackCard = feedbackCardSchema.parse({
  ...BASE,
  cardId: "card_result",
  stage: "result",
  reportId: "rpt_1",
  title: "bug: the orb freezes",
  publication: { status: "failed", reportId: "rpt_1", reason: "GitHub refused", retryable: true },
});
const PREPARED: FeedbackCard = feedbackCardSchema.parse({
  ...BASE,
  cardId: "card_draft",
  stage: "compose",
  reportId: "rpt_1",
  title: "bug: the orb freezes",
  preview: { body: "The orb freezes." },
});

type Pressed = Parameters<NonNullable<BlockActions["onFeedbackCreate"]>>[0];

function pressing(cardId: string, state: FeedbackCardState): { actions: BlockActions; pressed: Pressed[] } {
  const pressed: Pressed[] = [];
  return { actions: { onFeedbackCreate: (input) => pressed.push(input), feedback: { [cardId]: state } }, pressed };
}

/** The press note's controls as drawn: the note is a plain function of its props, so it is called like one. */
function noteOf(card: ReactElement | null): ReactElement<Record<string, unknown>> {
  const call = (element: ReactElement): ReactElement<Record<string, unknown>> => (element.type as (props: unknown) => ReactElement<Record<string, unknown>>)(element.props);
  // A card that hands its stage to another component (a prepared report) is drawn one level down first.
  const drawn = card !== null && typeof card.type === "function" ? call(card) : card;
  const note = findAll(drawn, "state").find((element) => typeof element.type === "function");
  if (note === undefined) throw new Error("no press note");
  return call(note);
}

describe("a feedback card's press note", () => {
  it("offers Try again for a publish that did not get through, and that press sends the same report the same way", () => {
    const { actions, pressed } = pressing("card_result", { status: "failed", message: "offline", press: "create", intent: "send", reportId: "rpt_1", next: "retry" });
    const drawn = noteOf(FeedbackResult({ block: RESULT, t: en, actions }));
    const retry = findAll(drawn, "data-feedback-retry");
    expect(retry).toHaveLength(1);
    expect(textOf(retry[0])).toBe(MESSAGES_EN["surface.retry"]);
    (retry[0]!.props.onClick as () => void)();
    expect(pressed).toEqual([{ cardId: "card_result", reportId: "rpt_1", intent: "send" }]);
  });

  it("offers nothing to repeat beside a refusal the node decided", () => {
    const { actions } = pressing("card_result", { status: "failed", message: "refused", press: "create", intent: "send", reportId: "rpt_1" });
    const html = renderToStaticMarkup(createElement(FeedbackCardBlock, { block: RESULT, t: en, actions }));
    expect(html).not.toContain("data-feedback-retry");
    expect(html).toContain('data-result="failed"');
  });

  it("says an unreadable publish as partial, with Check again that only checks", () => {
    const message = feedbackPressFailed(unreadable(), vi, { press: "create", intent: "send", reportId: "rpt_1", published: true });
    const { actions, pressed } = pressing("card_draft", message);
    const html = renderToStaticMarkup(createElement(FeedbackCardBlock, { block: PREPARED, t: vi, actions }));
    expect(html).toContain('data-result="unknown"');
    expect(html).toContain('data-surface-phase="partial"');
    expect(html).toContain(MESSAGES_VI["feedback.unread"]);
    expect(html).not.toContain(MESSAGES_VI["feedback.failed"].split("{reason}")[0]!);
    const check = findAll(noteOf(FeedbackCardBlock({ block: PREPARED, t: vi, actions })), "data-feedback-check-unread");
    expect(check).toHaveLength(1);
    (check[0]!.props.onClick as () => void)();
    expect(pressed).toEqual([{ cardId: "card_draft", reportId: "rpt_1", intent: "check" }]);
  });
});
