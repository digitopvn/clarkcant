import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { COMMAND_BADGE_PHASE, type CommandCard, type ProviderSignInView, SIGN_IN_PHASE, instantSchema } from "@clarkcant/contracts";

import { GatewayError } from "../src/api.ts";
import { type BlockActions, type CommandActionState, CredentialCardBlock } from "../src/blocks.tsx";
import { COMMAND_ACTION_PHASE, CommandCardBlock, latestCommandAction, settleCommandAction } from "../src/command-card.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import type { LocaleChoice } from "../src/i18n/locale.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { SignInPanel, signInStatusText } from "../src/provider-sign-in-panel.tsx";
import { TERMINAL_NOTICE_PHASE, TERMINAL_SHELL_PHASE, terminalNotice } from "../src/terminal-card.tsx";
import { settleCredentialSave } from "../src/use-block-actions.ts";
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
    expect(COMMAND_BADGE_PHASE).toEqual({ active: "pending", success: "success", warning: "partial", danger: "error" });
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
    expect(refusal.message).toBe("SIGN_OUT_NOT_HERE: the key comes from the environment");
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
    const actions: BlockActions = { credentialStatus: { requestId: "r1", phase: "error", message: vi("shell.credential.saveFailed"), attempt: 1 } };
    const markup = inLocale("en", createElement(CredentialCardBlock, { block, actions }));
    expect(markup).toContain('data-surface-phase="error"');
    expect(markup).not.toContain('data-surface-phase="success"');
  });

  it("says saving while a save is on its way, in both languages", () => {
    for (const locale of ["en", "vi"] as const) {
      const t = locale === "en" ? en : vi;
      const actions: BlockActions = { credentialStatus: { requestId: "r1", phase: "pending", message: t("shell.credential.saving"), attempt: 2 } };
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
