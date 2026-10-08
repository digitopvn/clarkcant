import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { COMMAND_BADGE_PHASE, type CommandCard, type ProviderSignInView, SIGN_IN_PHASE, instantSchema } from "@clarkcant/contracts";

import { GatewayError, type Timeline, codedMessage } from "../src/api.ts";
import { type BlockActions, type CommandActionState, CredentialCardBlock, type CredentialSaveStatus, type FolderEntryReason } from "../src/blocks.tsx";
import { COMMAND_ACTION_PHASE, CommandCardBlock, latestCommandAction, settleCommandAction } from "../src/command-card.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import type { LocaleChoice } from "../src/i18n/locale.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { refusalSentence } from "../src/node-view-refusal.ts";
import { SignInPanel, signInStatusText } from "../src/provider-sign-in-panel.tsx";
import { TERMINAL_NOTICE_PHASE, TERMINAL_SHELL_PHASE, terminalNotice } from "../src/terminal-card.tsx";
import {
  type CommandPressDeps,
  type ConversationOpening,
  TerminalAnnouncements,
  approvalRefusalText,
  artifactOpenRefused,
  browserSessionRefused,
  commandPresses,
  developStartRefused,
  feedbackRefusalReason,
  forgetRefused,
  freshTerminalIds,
  installRefusalState,
  nextConversationOpening,
  questionRefusalText,
  settleCredentialSave,
  submitCredentialSave,
  taskStopRefused,
} from "../src/use-block-actions.ts";
import { signInStartRefused, signOutRefused, signOutSettled } from "../src/use-provider-sign-ins.ts";

/**
 * Command cards, the sign-in panel, the credential card and the terminal, read through the shared status contract:
 * live regions that exist before an answer, a cancel that is not a failure, a reply nobody can read that is not a
 * success, the latest press shown over an older one, and late answers dropped.
 */

const en = (key: MessageKey): string => MESSAGES_EN[key];
const vi = (key: MessageKey): string => MESSAGES_VI[key];

const CARD: CommandCard = {
  type: "command-card",
  owner: "host",
  cardId: "card_1",
  command: "thinking",
  title: "Thinking",
  updatedAt: instantSchema.parse("2026-10-08T00:00:00.000Z"),
  rows: [
    {
      rowId: "high",
      label: "High",
      badge: { text: "signed in", tone: "success" },
      actions: [
        { actionId: "set", label: "Use", action: { kind: "set-thinking", level: "high" } },
        { actionId: "other", label: "Other", action: { kind: "set-thinking", level: "low" } },
      ],
    },
  ],
};

function drawCard(actions: BlockActions, t = en): string {
  return renderToStaticMarkup(createElement(CommandCardBlock, { block: CARD, t, actions }));
}

const live = { onCommandAction: () => undefined };

/** The row's outcome paragraph, wherever the live note placed it. */
function outcome(markup: string): string | undefined {
  return /<p class="cc-command-status"[^>]*>[^<]*<\/p>/u.exec(markup)?.[0];
}

describe("a command card row's outcome", () => {
  it("has both live regions, empty, before anything is pressed, so the answer is heard when it arrives", () => {
    const markup = drawCard(live);
    expect(markup).toContain('<div role="status" aria-live="polite" aria-atomic="true"></div>');
    expect(markup).toContain('<div role="alert" aria-live="assertive" aria-atomic="true"></div>');
    expect(outcome(markup)).toBeUndefined();
  });

  it("draws no regions on a record of the card, which has nothing to press", () => {
    expect(drawCard({})).not.toContain("data-surface-live");
  });

  it("reads each press state through the contract, so a reply nobody can read is never a success", () => {
    expect(COMMAND_ACTION_PHASE).toEqual({ pending: "pending", done: "success", failed: "error", unknown: "partial" });
    const failed = outcome(drawCard({ ...live, commandAction: { "card_1/high/set": { status: "failed", message: "no" } } }));
    expect(failed).toContain('data-surface-phase="error"');
    expect(failed).toContain('data-result="failed"');
    const unknown = outcome(drawCard({ ...live, commandAction: { "card_1/high/set": { status: "unknown", message: "?" } } }));
    expect(unknown).toContain('data-surface-phase="partial"');
  });

  it("says nothing for an outcome already there when the row is drawn again (a reload, a scroll back)", () => {
    const markup = drawCard({ ...live, commandAction: { "card_1/high/set": { status: "failed", message: "no" } } });
    expect(markup).toContain('data-surface-live="off"');
    expect(markup).toContain('<div role="alert" aria-live="assertive" aria-atomic="true"></div>');
  });

  it("shows the latest press among the row's buttons, not the first button's older outcome", () => {
    const states: Record<string, CommandActionState> = {
      "card_1/high/set": { status: "failed", message: "older", attempt: 1 },
      "card_1/high/other": { status: "done", message: "newer", attempt: 2 },
    };
    const markup = drawCard({ ...live, commandAction: states }, vi);
    expect(outcome(markup)).toContain("newer");
    expect(markup).not.toContain("older");
    expect(latestCommandAction([states["card_1/high/set"], undefined, states["card_1/high/other"]])).toBe(states["card_1/high/other"]);
  });

  it("says it is working in the reader's language while any press on the row is on its way", () => {
    const markup = drawCard({ ...live, commandAction: { "card_1/high/set": { status: "pending", attempt: 3 } } }, vi);
    expect(outcome(markup)).toContain(MESSAGES_VI["commandCard.working"]);
    expect(markup).toContain('aria-disabled="true"');
  });

  it("draws the node's badge with the mark its tone claims, and a neutral badge plain", () => {
    expect(COMMAND_BADGE_PHASE).toEqual({ active: "pending", success: "success", danger: "error" });
    expect(drawCard(live)).toContain('<span class="cc-badge" data-tone="ok" data-surface-phase="success">signed in</span>');
    const neutral = renderToStaticMarkup(
      createElement(CommandCardBlock, {
        block: { ...CARD, rows: [{ ...CARD.rows[0]!, badge: { text: "queued", tone: "neutral" } }] },
        t: en,
        actions: live,
      }),
    );
    expect(neutral).toContain('data-surface-phase="unknown">queued</span>');
  });

  it("draws a warning badge plain: a folder not found now or a stopped task is not a half-done outcome", () => {
    // The node writes `warning` for "not found now", "stopped" and "interrupted": no one phase is true of all three.
    for (const text of ["not found now", "stopped", "interrupted"]) {
      const markup = renderToStaticMarkup(
        createElement(CommandCardBlock, {
          block: { ...CARD, rows: [{ ...CARD.rows[0]!, badge: { text, tone: "warning" } }] },
          t: en,
          actions: live,
        }),
      );
      expect(markup).toContain(`<span class="cc-badge" data-tone="" data-surface-phase="unknown">${text}</span>`);
      expect(markup).not.toContain('data-surface-phase="partial"');
    }
  });
});

describe("settling a press's late answers", () => {
  const done = (attempt: number): CommandActionState => ({ status: "done", message: `done ${String(attempt)}`, attempt });
  const failed = (attempt: number): CommandActionState => ({ status: "failed", message: `failed ${String(attempt)}`, attempt });

  it("drops an answer for an earlier press that arrives after a newer one", () => {
    const newer: CommandActionState = { status: "pending", attempt: 2 };
    expect(settleCommandAction(newer, failed(1))).toBe(newer);
    expect(settleCommandAction(done(2), failed(1))).toEqual(done(2));
  });

  it("keeps a press's first outcome: a late 'working' or a second outcome does not replace it", () => {
    expect(settleCommandAction(failed(4), { status: "pending", attempt: 4 })).toEqual(failed(4));
    expect(settleCommandAction(failed(4), done(4))).toEqual(failed(4));
  });

  it("lets a new press replace what the row said", () => {
    expect(settleCommandAction(failed(4), { status: "pending", attempt: 5 })).toEqual({ status: "pending", attempt: 5 });
    expect(settleCommandAction(undefined, done(1))).toEqual(done(1));
  });
});

describe("the /logout card's sign-out", () => {
  it("says a refused sign-out in the person's words with the node's reason, never 'CODE: message'", () => {
    const refusal = new GatewayError(409, "SIGN_OUT_NOT_HERE", "the key comes from the environment");
    // The code is the program's fact, apart from the sentence: no surface that shows `message` can show it.
    expect(refusal.message).toBe("the key comes from the environment");
    expect(refusal.code).toBe("SIGN_OUT_NOT_HERE");
    for (const t of [en, vi]) {
      const settled = signOutRefused(refusal, t);
      expect(settled.status).toBe("failed");
      expect(settled.message).not.toContain("SIGN_OUT_NOT_HERE");
      expect(settled.message).toBe(t("settings.providers.signOutFailed").replace("{reason}", "the key comes from the environment"));
    }
  });

  it("says when there was nothing to sign out of, as Settings does", () => {
    expect(signOutSettled({ signedOut: true }, en)).toEqual({ status: "done", message: en("commandCard.signOut.done") });
    expect(signOutSettled({ signedOut: false }, vi)).toEqual({ status: "done", message: vi("settings.providers.signOutNothing") });
  });

  it("says a sign-in that could not start with the node's reason, never its code", () => {
    const settled = signInStartRefused(new GatewayError(400, "PROVIDER_UNKNOWN", "no such provider"), en);
    expect(settled).toEqual({ status: "failed", message: en("settings.providers.startFailed").replace("{reason}", "no such provider") });
  });
});

describe("a refused /develop start or folder Forget", () => {
  it("says the node's reason in the reader's language, never 'CODE: message'", () => {
    const refusal = new GatewayError(403, "WIDGET_DEV_ROOT_REFUSED", "that folder is outside what Clark may use");
    for (const t of [en, vi]) {
      expect(developStartRefused(refusal, t)).toEqual({
        status: "failed",
        message: t("commandCard.develop.startFailed").replace("{reason}", "that folder is outside what Clark may use"),
      });
      expect(forgetRefused(refusal, t)).toEqual({
        status: "failed",
        message: t("commandCard.develop.forgetFailed").replace("{reason}", "that folder is outside what Clark may use"),
      });
    }
  });
});

describe("a refused task stop, artifact reopen, browser-session change, feedback press or install", () => {
  const refusal = new GatewayError(409, "TASK_NOT_RUNNING", "the task already ended");

  it("says the node's reason in the reader's words, never 'CODE: message'", () => {
    const messageOf = (state: object): unknown => (state as { message?: unknown }).message;
    const cases: [(t: (key: MessageKey) => string) => object, MessageKey][] = [
      [(t) => taskStopRefused(refusal, t), "shell.task.stopRefused"],
      [(t) => artifactOpenRefused(refusal, t), "shell.artifact.openRefused"],
      [(t) => browserSessionRefused(refusal, t), "shell.control.sessionChangeRefused"],
      [(t) => installRefusalState(refusal, undefined, t), "shell.package.installRefused"],
    ];
    for (const t of [en, vi]) {
      for (const [state, key] of cases) {
        expect(messageOf(state(t))).toBe(t(key).replace("{reason}", "the task already ended"));
        expect(messageOf(state(t))).not.toContain("TASK_NOT_RUNNING");
      }
    }
    expect(taskStopRefused(refusal, en).status).toBe("failed");
    expect(artifactOpenRefused(refusal, en).status).toBe("failed");
    expect(browserSessionRefused(refusal, en).status).toBe("failed");
    expect(installRefusalState(refusal, undefined, en).status).toBe("refused");
  });

  it("gives the feedback card the node's reason without its code, for its own sentence around it", () => {
    expect(feedbackRefusalReason(refusal, en)).toBe("the task already ended");
    expect(feedbackRefusalReason(new Error("offline"), en)).toBe("offline");
    expect(feedbackRefusalReason("offline", vi)).toBe(vi("commandCard.failed"));
  });

  it("says the surface's own words alone when the failure carried no sentence", () => {
    expect(taskStopRefused("offline", vi)).toEqual({ status: "failed", message: vi("shell.task.stopFailed") });
    expect(artifactOpenRefused("offline", vi)).toEqual({ status: "failed", message: vi("shell.artifact.openFailed") });
    expect(browserSessionRefused("offline", vi)).toEqual({ status: "failed", message: vi("shell.control.sessionChangeFailed") });
  });
});

describe("which terminal cards the person just asked for", () => {
  const terminalMessage = (messageId: string, createdAt: string, terminalId: string) => ({
    messageId,
    role: "assistant" as const,
    createdAt,
    blocks: [{ type: "terminal-session-card", owner: "host", terminalId }],
  });
  const timelineOf = (conversationId: string, messages: ReturnType<typeof terminalMessage>[]): Timeline =>
    ({ conversationId, cursor: 0, messages, pins: [], instances: [], snapshots: [], metadata: { messageCount: messages.length, taskCount: 0, updatedAt: "" }, activeTaskIds: [] }) as Timeline;
  const old = terminalMessage("m1", "2026-10-08T10:00:00.000Z", "term_old");
  const later = terminalMessage("m2", "2026-10-08T10:05:00.000Z", "term_new");

  it("counts every terminal as asked for in a conversation started on this page", () => {
    const opening = nextConversationOpening({ kind: "new" }, "c1", timelineOf("c1", [old]));
    expect(freshTerminalIds(timelineOf("c1", [old]), opening)).toEqual(["term_old"]);
  });

  it("counts a reloaded conversation's terminals as history, and one that arrives after as asked for", () => {
    let opening: ConversationOpening = { kind: "loading", conversationId: "c1" };
    expect(freshTerminalIds(undefined, nextConversationOpening(opening, "c1", undefined))).toEqual([]);
    opening = nextConversationOpening(opening, "c1", timelineOf("c1", [old]));
    expect(freshTerminalIds(timelineOf("c1", [old]), opening)).toEqual([]);
    // Settled: a later page (an answer, an older page read in front) leaves what was held at opening alone.
    opening = nextConversationOpening(opening, "c1", timelineOf("c1", [old, later]));
    expect(freshTerminalIds(timelineOf("c1", [old, later]), opening)).toEqual(["term_new"]);
  });

  it("counts everything as asked for once the page leaves the conversation it opened (/new, or one that is gone)", () => {
    const opening = nextConversationOpening({ kind: "loading", conversationId: "c1" }, undefined, undefined);
    expect(opening).toEqual({ kind: "new" });
    expect(freshTerminalIds(timelineOf("c2", [old]), nextConversationOpening(opening, "c2", timelineOf("c2", [old])))).toEqual(["term_old"]);
  });

  it("announces a terminal asked for after a reload, once, and keeps a card drawn again by a scroll back quiet", () => {
    // The page opens an existing conversation: nothing has arrived yet, then its first page is history.
    const announcements = new TerminalAnnouncements("c1");
    expect(announcements.advance("c1", undefined)).toEqual([]);
    expect(announcements.advance("c1", timelineOf("c1", [old]))).toEqual([]);
    expect(announcements.isNews("term_old")).toBe(false);
    // The person asks for a new terminal: its card is news, the reloaded one still is not.
    announcements.advance("c1", timelineOf("c1", [old, later]));
    expect(announcements.isNews("term_new")).toBe(true);
    expect(announcements.isNews("term_old")).toBe(false);
    // A render with the same timeline (StrictMode, a parent re-render) changes nothing.
    announcements.advance("c1", timelineOf("c1", [old, later]));
    expect(announcements.isNews("term_new")).toBe(true);
    // Its card settles and is heard; the same card mounted again later (scrolled out and back) is quiet.
    announcements.settled("term_new");
    expect(announcements.isNews("term_new")).toBe(false);
    const another = terminalMessage("m3", "2026-10-08T10:06:00.000Z", "term_third");
    expect(announcements.advance("c1", timelineOf("c1", [old, later, another]))).toEqual(["term_third"]);
    expect(announcements.isNews("term_new")).toBe(false);
  });

  it("still announces a terminal whose card left before it settled, since nobody heard it", () => {
    const announcements = new TerminalAnnouncements(undefined);
    announcements.advance("c1", timelineOf("c1", [later]));
    expect(announcements.isNews("term_new")).toBe(true);
    // Unmounted while still connecting: nothing told, so the card drawn again is still news.
    expect(announcements.isNews("term_new")).toBe(true);
  });
});

describe("a refused approval or question answer", () => {
  it("says a request that changed under the person as a sentence in their language, never the node's code", () => {
    for (const code of ["APPROVAL_FORGED", "APPROVAL_DIGEST_MISMATCH", "APPROVAL_STALE"]) {
      const refusal = new GatewayError(409, code, "the call changed after it was shown");
      for (const t of [en, vi]) {
        expect(approvalRefusalText(refusal, t)).toBe(t("blocks.approval.changed"));
        expect(approvalRefusalText(refusal, t)).not.toContain(code);
      }
    }
    expect(approvalRefusalText(new GatewayError(409, "APPROVAL_EXPIRED", "approval expired at 2026-10-08"), vi)).toBe(vi("inbox.decideFailed.expired"));
    expect(approvalRefusalText(new GatewayError(409, "APPROVAL_ALREADY_DECIDED", "approval was already granted"), en)).toBe(
      en("inbox.decideFailed.alreadyDecided"),
    );
  });

  it("says any other approval refusal with the node's reason inside the reader's sentence", () => {
    const refusal = new GatewayError(409, "APPROVAL_PAYLOAD_MISSING", "the approved call is gone");
    for (const t of [en, vi]) {
      expect(approvalRefusalText(refusal, t)).toBe(t("blocks.approval.decideRefused").replace("{reason}", "the approved call is gone"));
    }
    expect(approvalRefusalText("offline", vi)).toBe(vi("blocks.approval.decideFailed"));
  });

  it("says a refused answer to a question in the reader's language", () => {
    const closed = new GatewayError(409, "QUESTION_CLOSED", "Câu hỏi này đã hết hạn.");
    const gone = new GatewayError(404, "QUESTION_NOT_FOUND", "Không có câu hỏi nào với id đó trong hội thoại này.");
    const invalid = new GatewayError(409, "INVALID_ANSWER", "Lựa chọn không có trong câu hỏi.");
    for (const t of [en, vi]) {
      expect(questionRefusalText(closed, t)).toBe(t("inbox.refused.questionClosed"));
      expect(questionRefusalText(gone, t)).toBe(t("inbox.refused.questionGone"));
      expect(questionRefusalText(invalid, t)).toBe(t("blocks.question.invalidAnswer"));
      expect(questionRefusalText(new GatewayError(500, "INTERNAL", "the store is busy"), t)).toBe(
        t("blocks.question.answerRefused").replace("{reason}", "the store is busy"),
      );
      expect(questionRefusalText(undefined, t)).toBe(t("blocks.question.answerFailed"));
    }
  });

  it("says a refused terminal close in the reader's words with the node's reason", () => {
    const refusal = new GatewayError(409, "TERMINAL_UNAVAILABLE", "Terminal này không còn chạy.");
    for (const t of [en, vi]) {
      const said = refusalSentence(refusal, t, "blocks.terminal.killRefused", "blocks.terminal.killFailed");
      expect(said).toBe(t("blocks.terminal.killRefused").replace("{reason}", "Terminal này không còn chạy."));
      expect(said).not.toContain("TERMINAL_UNAVAILABLE");
    }
  });
});

describe("a node refusal handed on to a widget", () => {
  it("keeps the code in front on the widget's wire, where a program reads it, and only there", () => {
    const refusal = new GatewayError(409, "STALE_REVISION", "the widget changed");
    expect(codedMessage(refusal)).toBe("STALE_REVISION: the widget changed");
    expect(refusal.message).toBe("the widget changed");
    expect(codedMessage(new Error("offline"))).toBe("offline");
  });
});

/** A promise settled from outside, so a test decides the order answers arrive in. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets every answer already given reach its handler. */
const answered = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A state the runner updates the way React's `setState` does, read back by the test. */
function stateOf<T>(): { current: () => Readonly<Record<string, T>>; update: (change: (current: Readonly<Record<string, T>>) => Readonly<Record<string, T>>) => void } {
  let state: Readonly<Record<string, T>> = {};
  return { current: () => state, update: (change) => (state = change(state)) };
}

describe("presses on a command card (the runner useBlockActions wires)", () => {
  type Client = CommandPressDeps["client"];

  function runner(over: Partial<Omit<CommandPressDeps, "client">> & { client?: Partial<Client> } = {}, t = en) {
    let attempts = 0;
    const actions = stateOf<CommandActionState>();
    const entries = stateOf<FolderEntryReason>();
    const presses = commandPresses({
      conversationId: "c1",
      t,
      nextAttempt: () => ++attempts,
      updateActions: actions.update,
      updateFolderEntries: entries.update,
      startSignIn: () => Promise.resolve(),
      signOut: () => Promise.resolve({ signedOut: true }),
      ...over,
      client: { nodeOnThisMachine: () => true, ...over.client } as Client,
    });
    return { presses, actions: actions.current, entries: entries.current };
  }

  const thinking = (level: "high" | "low") => ({ kind: "set-thinking", level }) as const;

  it("says a refused /thinking press in the reader's language with the node's reason, never 'CODE: message'", async () => {
    for (const t of [en, vi]) {
      const { presses, actions } = runner(
        { client: { writePreference: () => Promise.reject(new GatewayError(409, "PREFERENCE_REFUSED", "the level is locked by policy")) } },
        t,
      );
      presses.press({ cardId: "card_1", rowId: "high", actionId: "set", action: thinking("high") });
      expect(actions()["card_1/high/set"]).toEqual({ status: "pending", attempt: 1 });
      await answered();
      expect(actions()["card_1/high/set"]).toEqual({
        status: "failed",
        message: t("commandCard.thinking.failed").replace("{reason}", "the level is locked by policy"),
        attempt: 1,
      });
    }
  });

  it("keeps a newer press's answer when an earlier press on the same button answers late", async () => {
    const writes = [deferred<never>(), deferred<never>()];
    let call = 0;
    const { presses, actions } = runner({ client: { writePreference: () => writes[call++]!.promise } });
    presses.press({ cardId: "card_1", rowId: "high", actionId: "set", action: thinking("high") });
    presses.press({ cardId: "card_1", rowId: "high", actionId: "set", action: thinking("high") });
    writes[1]!.resolve(undefined as never);
    await answered();
    writes[0]!.reject(new GatewayError(500, "BUSY", "late"));
    await answered();
    expect(actions()["card_1/high/set"]).toEqual({ status: "done", message: en("commandCard.thinking.set"), attempt: 2 });
  });

  it("numbers presses across buttons, so the row shows the latest even when an older sibling answers last", async () => {
    const writes = [deferred<never>(), deferred<never>()];
    let call = 0;
    const { presses, actions } = runner({ client: { writePreference: () => writes[call++]!.promise } });
    presses.press({ cardId: "card_1", rowId: "high", actionId: "set", action: thinking("high") });
    presses.press({ cardId: "card_1", rowId: "high", actionId: "other", action: thinking("low") });
    writes[1]!.resolve(undefined as never);
    await answered();
    writes[0]!.reject(new GatewayError(500, "BUSY", "older"));
    await answered();
    const states = actions();
    expect(states["card_1/high/set"]?.attempt).toBe(1);
    expect(latestCommandAction([states["card_1/high/set"], states["card_1/high/other"]])).toEqual({
      status: "done",
      message: en("commandCard.thinking.set"),
      attempt: 2,
    });
  });

  it("clears only its own press once a sign-in starts, never a newer press on the same button", async () => {
    const starts = [deferred<void>(), deferred<void>()];
    let call = 0;
    const { presses, actions } = runner({ startSignIn: () => starts[call++]!.promise });
    const signIn = { kind: "provider-sign-in", providerId: "fake", method: "oauth" } as const;
    presses.press({ cardId: "card_1", rowId: "fake", actionId: "sign-in", action: signIn });
    presses.press({ cardId: "card_1", rowId: "fake", actionId: "sign-in", action: signIn });
    starts[0]!.resolve();
    await answered();
    expect(actions()["card_1/fake/sign-in"]).toEqual({ status: "pending", attempt: 2 });
    starts[1]!.resolve();
    await answered();
    expect(actions()["card_1/fake/sign-in"]).toBeUndefined();
  });

  it("says a /logout with nothing to remove as Settings does, and a refused one without its code", async () => {
    const signOut = { kind: "provider-sign-out", providerId: "fake" } as const;
    const nothing = runner({ signOut: () => Promise.resolve({ signedOut: false }) }, vi);
    nothing.presses.press({ cardId: "card_1", rowId: "fake", actionId: "sign-out", action: signOut });
    await answered();
    expect(nothing.actions()["card_1/fake/sign-out"]).toEqual({ status: "done", message: vi("settings.providers.signOutNothing"), attempt: 1 });

    const refused = runner({ signOut: () => Promise.reject(new GatewayError(409, "SIGN_OUT_NOT_HERE", "the key comes from the environment")) });
    refused.presses.press({ cardId: "card_1", rowId: "fake", actionId: "sign-out", action: signOut });
    await answered();
    expect(refused.actions()["card_1/fake/sign-out"]).toEqual({
      status: "failed",
      message: en("settings.providers.signOutFailed").replace("{reason}", "the key comes from the environment"),
      attempt: 1,
    });
  });

  it("asks for a folder in words where no dialog can name one, and a typed path is a new attempt that closes the field", async () => {
    const start = deferred<never>();
    const { presses, actions, entries } = runner({ client: { startWidgetDevSession: () => start.promise } });
    presses.press({ cardId: "card_1", rowId: "dev", actionId: "pick", action: { kind: "develop-folder" } });
    // No desktop bridge in this test, as in a browser.
    expect(entries()).toEqual({ "card_1/dev/pick": "browser" });
    presses.developTyped({ cardId: "card_1", rowId: "dev", actionId: "pick", root: "/work/widget" });
    expect(entries()).toEqual({});
    expect(actions()["card_1/dev/pick"]).toEqual({ status: "pending", attempt: 2 });
    start.reject(new GatewayError(403, "WIDGET_DEV_ROOT_REFUSED", "outside what Clark may use"));
    await answered();
    expect(actions()["card_1/dev/pick"]).toEqual({
      status: "failed",
      message: en("commandCard.develop.startFailed").replace("{reason}", "outside what Clark may use"),
      attempt: 2,
    });
  });

  it("says a refused Forget with the node's reason", async () => {
    const { presses, actions } = runner({ client: { forgetWidgetDevFolder: () => Promise.reject(new GatewayError(404, "NOT_CHOSEN", "not a folder you chose")) } });
    presses.press({ cardId: "card_1", rowId: "dev", actionId: "forget", action: { kind: "develop-folder-forget", root: "/work" } });
    await answered();
    expect(actions()["card_1/dev/forget"]).toEqual({
      status: "failed",
      message: en("commandCard.develop.forgetFailed").replace("{reason}", "not a folder you chose"),
      attempt: 1,
    });
  });
});

const SIGN_IN: ProviderSignInView = {
  signInId: "s1",
  providerId: "fake",
  method: "api_key",
  state: "running",
  events: [],
} as unknown as ProviderSignInView;

function drawSignIn(state: ProviderSignInView["state"], t = en, error?: string): string {
  const signIn = { ...SIGN_IN, state, ...(error === undefined ? {} : { error }) } as ProviderSignInView;
  return renderToStaticMarkup(
    createElement(SignInPanel, { signIn, providerName: "Fake", t, onAnswer: () => undefined, onCancel: () => undefined }),
  );
}

describe("a sign-in's outcome", () => {
  it("marks a cancelled sign-in as cancelled, never as failed", () => {
    expect(SIGN_IN_PHASE.cancelled).toBe("cancelled");
    for (const t of [en, vi]) {
      const markup = drawSignIn("cancelled", t);
      expect(markup).toContain('data-result="cancelled"');
      expect(markup).toContain('data-surface-phase="cancelled"');
      expect(markup).not.toContain('data-result="failed"');
      expect(markup).toContain(t("commandCard.signIn.cancelled"));
    }
  });

  it("marks a failure as an error with its reason, and a finished one as a success naming the provider", () => {
    const failedMarkup = drawSignIn("failed", vi, "bad key");
    expect(failedMarkup).toContain('data-surface-phase="error"');
    expect(failedMarkup).toContain("bad key");
    const doneMarkup = drawSignIn("done");
    expect(doneMarkup).toContain('data-surface-phase="success"');
    expect(doneMarkup).toContain(en("commandCard.signIn.done").replace("{provider}", "Fake"));
  });

  it("keeps one status line for the whole sign-in, so its regions exist before it ends", () => {
    const running = drawSignIn("running");
    expect(running).toContain('data-sign-in-status="running"');
    expect(running).toContain('<div role="alert" aria-live="assertive" aria-atomic="true"></div>');
    expect(running).not.toContain("data-result=");
    expect(signInStatusText({ ...SIGN_IN, state: "waiting", prompt: { type: "text", message: "Key?" } } as ProviderSignInView, "Fake", en)).toBe(
      en("commandCard.signIn.answer"),
    );
  });
});

function inLocale(locale: LocaleChoice, element: ReactElement): string {
  const t = locale === "en" ? en : vi;
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, t, setLocale: () => {} }, children: element }));
}

describe("the credential card's save", () => {
  const block = { type: "credential-card", owner: "host", requestId: "r1", purpose: "Key for the fixture", fields: [{ name: "k" }] };

  it("stays a failure when the language changes after it, because the phase is carried, not read from the words", () => {
    // The failure was written in Vietnamese; the page is now English. The old card compared words and read "success".
    const actions: BlockActions = { credentialStatus: { r1: { requestId: "r1", phase: "error", message: vi("shell.credential.saveFailed"), attempt: 1 } } };
    const markup = inLocale("en", createElement(CredentialCardBlock, { block, actions }));
    expect(markup).toContain('data-surface-phase="error"');
    expect(markup).not.toContain('data-surface-phase="success"');
  });

  it("says saving while a save is on its way, in both languages", () => {
    for (const locale of ["en", "vi"] as const) {
      const t = locale === "en" ? en : vi;
      const actions: BlockActions = { credentialStatus: { r1: { requestId: "r1", phase: "pending", message: t("shell.credential.saving"), attempt: 2 } } };
      const markup = inLocale(locale, createElement(CredentialCardBlock, { block, actions }));
      expect(markup).toContain('data-surface-phase="pending"');
      expect(markup).toContain(t("shell.credential.saving"));
    }
  });

  it("drops a late answer for an earlier save, and keeps a save's first answer", () => {
    const newer = { requestId: "r1", phase: "pending", message: "saving", attempt: 2 } as const;
    expect(settleCredentialSave(newer, { requestId: "r1", phase: "error", message: "failed", attempt: 1 })).toBe(newer);
    const failedSave = { requestId: "r1", phase: "error", message: "failed", attempt: 2 } as const;
    expect(settleCredentialSave(failedSave, { requestId: "r1", phase: "success", message: "saved", attempt: 2 })).toBe(failedSave);
    // A second submission starts with saving, so the same failure again is a change of phase and is said again.
    expect(settleCredentialSave(failedSave, { requestId: "r1", phase: "pending", message: "saving", attempt: 3 }).phase).toBe("pending");
  });

  it("keeps each card's own answer when two cards save at once", async () => {
    const saves = [deferred<{ names: string[] }>(), deferred<{ names: string[] }>()];
    let call = 0;
    let attempts = 0;
    const status = stateOf<CredentialSaveStatus>();
    const deps = {
      client: { putCredential: () => saves[call++]!.promise },
      t: en,
      nextAttempt: () => ++attempts,
      update: status.update,
    };
    submitCredentialSave(deps, { requestId: "x", fields: [{ name: "X_KEY", value: "placeholder" }] });
    submitCredentialSave(deps, { requestId: "y", fields: [{ name: "Y_KEY", value: "placeholder" }] });
    // X answers after Y's save began: a later attempt on another card, which must not drop X's answer.
    saves[0]!.resolve({ names: ["X_KEY"] });
    await answered();
    saves[1]!.reject(new Error("offline"));
    await answered();
    expect(status.current()).toEqual({
      x: { requestId: "x", phase: "success", message: en("shell.credential.saved").replace("{names}", "X_KEY"), attempt: 1 },
      y: { requestId: "y", phase: "error", message: en("shell.credential.saveFailed"), attempt: 2 },
    });
  });

  it("draws only the card's own save", () => {
    const actions: BlockActions = {
      credentialStatus: { other: { requestId: "other", phase: "error", message: "someone else's", attempt: 1 } },
    };
    expect(inLocale("en", createElement(CredentialCardBlock, { block, actions }))).not.toContain("someone else's");
  });
});

describe("the terminal's state", () => {
  const attached = { phase: "attached" as const, exited: false, inSession: false, driver: true, running: false };

  it("draws a running command as work in progress and an idle shell as ready, each with a mark", () => {
    expect(TERMINAL_SHELL_PHASE).toEqual({ exited: "cancelled", running: "pending", idle: "success" });
  });

  it("says losing the shell as an error that interrupts, before anything it last knew", () => {
    expect(terminalNotice({ ...attached, phase: "disconnected", running: true })).toBe("disconnected");
    expect(TERMINAL_NOTICE_PHASE.disconnected).toBe("error");
    expect(TERMINAL_NOTICE_PHASE["load-failed"]).toBe("error");
    expect(terminalNotice({ ...attached, phase: "gone" })).toBe("gone");
    expect(TERMINAL_NOTICE_PHASE.gone).toBe("unavailable");
  });

  it("says nothing while loading, and what the shell does once attached", () => {
    expect(terminalNotice({ ...attached, phase: "loading" })).toBeUndefined();
    expect(terminalNotice(attached)).toBeUndefined();
    expect(terminalNotice({ ...attached, running: true })).toBe("running");
    expect(terminalNotice({ ...attached, driver: false })).toBe("observer");
    expect(terminalNotice({ ...attached, inSession: true, exited: true })).toBe("session");
    expect(terminalNotice({ ...attached, exited: true })).toBe("exited");
  });
});
