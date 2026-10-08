import { useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";

import { type ProviderSignInView, SIGN_IN_PHASE } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { LiveNote, phaseOf } from "./surface-status.tsx";

/** What can take the focus a sign-in hands on: a control that can be pressed or typed in now. */
const FOCUSABLE = 'button:not(:disabled):not([aria-disabled="true"]), a[href], input:not(:disabled), select:not(:disabled)';

/** How a finished sign-in is marked for the stylesheet and tests: a cancel is its own ending, never a failure. */
const SIGN_IN_RESULT: Record<ProviderSignInView["state"], string | undefined> = {
  running: undefined,
  waiting: undefined,
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Where a sign-in stands, in the reader's words: waiting, asked something, signed in, cancelled, or why it failed. */
export function signInStatusText(signIn: ProviderSignInView, providerName: string, t: (key: MessageKey) => string): string {
  switch (signIn.state) {
    case "running":
    case "waiting":
      return signIn.prompt === undefined ? t("commandCard.signIn.waiting") : t("commandCard.signIn.answer");
    case "done":
      return fillMessage(t("commandCard.signIn.done"), { provider: providerName });
    case "cancelled":
      return t("commandCard.signIn.cancelled");
    case "failed":
      return `${t("commandCard.signIn.failed")}${signIn.error === undefined ? "" : ` ${signIn.error}`}`;
  }
}

/**
 * A provider sign-in in progress, drawn where it was started: a `/login` card row or a Settings provider row.
 *
 * What the provider shows — a page to open, a device code, a question — and how it ended. An answer typed here goes to
 * `onAnswer` and is cleared from the field at once; the view this draws never holds it, so nothing typed is shown back.
 * A finished sign-in names the provider, and draws `after` beneath it: the next step its surface offers (the model
 * picker's `AfterSignIn`), the same in a card and in Settings.
 *
 * The focus follows the sign-in for the person who pressed: to the field when the provider asks something, to Cancel
 * while it waits on a page, and on to what comes next once a control holding it goes away. A sign-in shown again on a
 * page that just opened never takes it.
 */
export function SignInPanel({
  signIn,
  providerName,
  t,
  onAnswer,
  onCancel,
  after,
}: {
  signIn: ProviderSignInView;
  /** The provider as its row names it, so the outcome says which one was signed in. */
  providerName: string;
  t: (key: MessageKey) => string;
  onAnswer: (value: string) => void;
  onCancel: () => void;
  /** Drawn only once the sign-in is done. */
  after?: ReactNode;
}): ReactElement {
  const [value, setValue] = useState("");
  const open = signIn.state === "running" || signIn.state === "waiting";
  const prompt = signIn.prompt;
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  /** Whether the person's focus was last in this panel, so a control that leaves under it hands the focus on. */
  const focusWithin = useRef(false);
  // What the panel asks for now: the focus moves when this changes, and only then.
  const step = open ? (prompt === undefined ? "running" : `${prompt.type}:${prompt.message}`) : signIn.state;
  useEffect(() => {
    const root = panel.current;
    if (root === null) return;
    const row = root.closest("li") ?? root;
    const active = root.ownerDocument.activeElement;
    // Dropped to the page because the control holding it went away (a field answered, Cancel pressed).
    const dropped = (active === null || active === root.ownerDocument.body) && focusWithin.current;
    if (open) {
      // Taken only from the row the person pressed in, or from a control of this panel that went away: a sign-in
      // shown again on a page that just opened, or one moving on while the person is elsewhere, never pulls the focus.
      if (dropped || (active !== null && row.contains(active))) (field.current ?? cancel.current)?.focus();
      return;
    }
    if (!dropped) return;
    // What comes next instead: the step after a sign-in, or the row's buttons again.
    (root.querySelector<HTMLElement>(FOCUSABLE) ?? row.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, [step, open]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === "") return;
    onAnswer(value);
    setValue("");
  };
  return (
    <div
      ref={panel}
      className="cc-card-stack cc-sign-in"
      data-state={signIn.state}
      onFocus={() => {
        focusWithin.current = true;
      }}
      onBlur={(event) => {
        // Only a move somewhere else says the person left; a control removed under the focus moves it nowhere.
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) focusWithin.current = false;
      }}
    >
      {signIn.events.map((event, index) => {
        if (event.type === "auth_url") {
          return (
            <p key={index} className="cc-list-subtitle">
              {event.instructions ?? t("commandCard.signIn.openPage")}{" "}
              <a href={event.url} target="_blank" rel="noopener noreferrer">
                {t("commandCard.signIn.openLink")}
              </a>
            </p>
          );
        }
        if (event.type === "device_code") {
          return (
            <p key={index} className="cc-list-subtitle">
              {t("commandCard.signIn.deviceCode")} <code className="cc-sign-in-code">{event.userCode}</code>{" "}
              <a href={event.verificationUri} target="_blank" rel="noopener noreferrer">
                {t("commandCard.signIn.openLink")}
              </a>
            </p>
          );
        }
        return (
          <p key={index} className="cc-list-subtitle">
            {event.message}
          </p>
        );
      })}
      {open && prompt !== undefined ? <p className="cc-list-title">{prompt.message}</p> : null}
      {open && prompt !== undefined ? (
        <form className="cc-search-row" onSubmit={submit}>
          {prompt.type === "select" ? (
            <select
              ref={field}
              className="cc-field-input"
              aria-label={prompt.message}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">{prompt.message}</option>
              {prompt.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              ref={field}
              className="cc-field-input"
              type={prompt.type === "secret" ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              aria-label={prompt.message}
              {...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder })}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <button type="submit" className="cc-action" data-emphasis="primary" disabled={value.trim() === ""}>
            {t("commandCard.signIn.submit")}
          </button>
        </form>
      ) : null}
      {/*
        Where the sign-in stands, in one place for its whole life, so the live regions exist before it ends: waiting is
        said politely, a failure interrupts, and a sign-in that is shown again already finished says nothing.
      */}
      <LiveNote
        phase={phaseOf(SIGN_IN_PHASE, signIn.state)}
        className="cc-command-status"
        data-sign-in-status={signIn.state}
        data-result={open ? undefined : SIGN_IN_RESULT[signIn.state]}
      >
        {signInStatusText(signIn, providerName, t)}
      </LiveNote>
      {open ? (
        <div className="cc-form-foot">
          <button ref={cancel} type="button" className="cc-action" onClick={onCancel}>
            {t("commandCard.signIn.cancel")}
          </button>
        </div>
      ) : null}
      {signIn.state === "done" ? after : null}
    </div>
  );
}
