import { useState, type FormEvent, type ReactElement, type ReactNode } from "react";

import type { ProviderSignInView } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * A provider sign-in in progress, drawn where it was started: a `/login` card row or a Settings provider row.
 *
 * What the provider shows — a page to open, a device code, a question — and how it ended. An answer typed here goes to
 * `onAnswer` and is cleared from the field at once; the view this draws never holds it, so nothing typed is shown back.
 * A finished sign-in names the provider, and draws `after` beneath it: the next step its surface offers (the model
 * picker's `AfterSignIn`), the same in a card and in Settings.
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === "") return;
    onAnswer(value);
    setValue("");
  };
  return (
    <div className="cc-card-stack cc-sign-in" data-state={signIn.state}>
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
      {open ? (
        <div className="cc-form-foot">
          <p className="cc-list-subtitle" role="status">
            {prompt === undefined ? t("commandCard.signIn.waiting") : t("commandCard.signIn.answer")}
          </p>
          <button type="button" className="cc-action" onClick={onCancel}>
            {t("commandCard.signIn.cancel")}
          </button>
        </div>
      ) : (
        <p className="cc-command-status" role="status" data-result={signIn.state === "done" ? "done" : "failed"}>
          {signIn.state === "done"
            ? fillMessage(t("commandCard.signIn.done"), { provider: providerName })
            : signIn.state === "cancelled"
              ? t("commandCard.signIn.cancelled")
              : `${t("commandCard.signIn.failed")}${signIn.error === undefined ? "" : ` ${signIn.error}`}`}
        </p>
      )}
      {signIn.state === "done" ? after : null}
    </div>
  );
}
