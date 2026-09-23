import { useEffect, useState, type ReactElement } from "react";

import type { GatewayClient } from "../../api.ts";
import { useT } from "../../i18n/locale-context.tsx";
import type { MessageKey } from "../../i18n/messages.ts";

/**
 * The unified Credentials section (DESIGN.md 11.6, review U5).
 *
 * Every stored secret the node holds used to have its own key form scattered across tabs (TypeSafe in
 * AI & Routing, Gemini in Devices & Voice). Reading which keys were connected meant visiting every tab that
 * happened to embed one. This is the one place that lists all of them -- name, purpose, connection status,
 * Replace, Remove -- and the tabs that used to hold a form now link here instead.
 *
 * Connection status comes from `client.readiness().credentials`, which is already the node's own list of
 * credential *names* it holds -- never values -- so this section adds no new route, it just reads the one
 * that already answers "what does the node already know".
 *
 * The stored value is never rendered back: the input is a write-only draft, cleared the instant it is sent,
 * and the node's answer to a read is a name, never a value.
 */

export interface CredentialEntry {
  /** The name the node stores this credential under, e.g. "typesafe" or "gemini". */
  name: string;
  labelKey: MessageKey;
  purposeKey: MessageKey;
}

export interface CredentialsSectionProps {
  client: GatewayClient;
  entries: readonly CredentialEntry[];
}

export function CredentialsSection({ client, entries }: CredentialsSectionProps): ReactElement {
  const t = useT();
  const [connected, setConnected] = useState<string[] | undefined>(undefined);
  const [readError, setReadError] = useState<string | undefined>(undefined);

  const readStatus = (): void => {
    client
      .readiness()
      .then((answer) => {
        setConnected(answer.credentials);
        setReadError(undefined);
      })
      .catch(() => setReadError(t("settings.credentials.readFailed")));
  };

  useEffect(() => {
    readStatus();
    // Only on mount: each row refreshes the shared list itself after a save/remove, so this effect does not
    // need `client` as a reactive dependency beyond the initial read.
  }, []);

  return (
    <section className="cc-panel-section" data-credentials-section="true">
      <h3>{t("settings.credentials.heading")}</h3>
      <p className="cc-panel-note">{t("settings.credentials.intro")}</p>
      {readError === undefined ? null : (
        <p className="cc-panel-note" data-credentials-read-error="true">
          {readError}
        </p>
      )}
      {entries.map((entry) => (
        <CredentialRow
          key={entry.name}
          client={client}
          entry={entry}
          connected={connected?.includes(entry.name) ?? false}
          knownConnectionState={connected !== undefined}
          onChanged={readStatus}
        />
      ))}
    </section>
  );
}

function CredentialRow({
  client,
  entry,
  connected,
  knownConnectionState,
  onChanged,
}: {
  client: GatewayClient;
  entry: CredentialEntry;
  connected: boolean;
  knownConnectionState: boolean;
  onChanged: () => void;
}): ReactElement {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | undefined>(undefined);

  const replace = (): void => {
    const value = draft.trim();
    if (value === "") return;
    client
      .putCredential({ fields: [{ name: entry.name, value }] })
      .then((result) => {
        // Cleared the moment it is sent: nothing later can read it off the screen or out of state.
        setDraft("");
        setStatus(
          result.names.includes(entry.name)
            ? t("settings.credentials.status.saved")
            : t("settings.credentials.status.sentNoName"),
        );
        onChanged();
      })
      .catch(() =>
        // What failed, what's preserved, what to do -- the previous key (if any) is untouched, so the copy says so.
        setStatus(t("settings.credentials.status.saveFailed")),
      );
  };

  const remove = (): void => {
    client
      .deleteCredential(entry.name)
      .then(() => {
        setStatus(t("settings.credentials.status.removed"));
        onChanged();
      })
      .catch(() => setStatus(t("settings.credentials.status.removeFailed")));
  };

  return (
    <form
      className="cc-credential-form"
      data-credential-row={entry.name}
      onSubmit={(event) => {
        event.preventDefault();
        replace();
      }}
    >
      <div className="cc-panel-row" data-credential-header={entry.name}>
        <strong>{t(entry.labelKey)}</strong>
        <span className="cc-badge" data-tone={connected ? "ok" : "warn"} data-credential-status={entry.name}>
          {knownConnectionState
            ? connected
              ? t("settings.credentials.status.connected")
              : t("settings.credentials.status.notConnected")
            : t("settings.common.loading")}
        </span>
      </div>
      <p className="cc-freshness">{t(entry.purposeKey)}</p>

      <label className="cc-credential-field">
        <span>{t("settings.credentials.field.label")}</span>
        <input
          type="password"
          name={entry.name}
          autoComplete="off"
          placeholder={t("settings.credentials.field.placeholder")}
          data-credential-field={entry.name}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>

      <div className="cc-chip-row">
        <button type="submit" className="cc-chip" disabled={draft.trim() === ""} data-credential-replace={entry.name}>
          {t("settings.credentials.replace")}
        </button>
        <button type="button" className="cc-chip" data-credential-remove={entry.name} onClick={remove}>
          {t("settings.credentials.remove")}
        </button>
      </div>

      {status === undefined ? null : (
        <p className="cc-freshness" data-credential-status-message={entry.name} role="status">
          {status}
        </p>
      )}
    </form>
  );
}
