import { type ReactElement, useEffect, useState } from "react";

import type { SurfacePhase } from "@clarkcant/contracts";

import type { CredentialSource, GatewayClient, NodeReadinessAnswer } from "../../api.ts";
import { useT } from "../../i18n/locale-context.tsx";
import type { MessageKey } from "../../i18n/messages.ts";
import { LiveNote, PhaseBadge } from "../../surface-status.tsx";

/**
 * The unified Credentials section (DESIGN.md 11.6, review U5).
 *
 * Every stored secret the node holds used to have its own key form scattered across tabs (TypeSafe in
 * AI & Routing, Gemini in Devices & Voice). Reading which keys were connected meant visiting every tab that
 * happened to embed one. This is the one place that lists all of them -- name, purpose, connection status,
 * which key is in use, Replace, Remove -- and the tabs that used to hold a form now link here instead.
 *
 * Connection status comes from `client.readiness()`, which is already the node's own list of credential *names* it
 * holds and where the key in effect for each comes from -- never values -- so this section adds no new route, it just
 * reads the one that already answers "what does the node already know".
 *
 * The stored value is never rendered back: the input is a write-only draft, cleared the instant it is sent,
 * and the node's answer to a read is a name and a source, never a value.
 */

export interface CredentialEntry {
  /** The name the node stores this credential under, e.g. "typesafe" or "gemini". */
  name: string;
  labelKey: MessageKey;
  purposeKey: MessageKey;
}

/** What the section has read from the node: still reading, could not read, or the node's answer. */
export type CredentialListing =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; answer: NodeReadinessAnswer };

/** What became of the last press on one row, with the attempt that orders presses. */
export interface CredentialRowOutcome {
  phase: SurfacePhase;
  messageKey: MessageKey;
  attempt: number;
}

/** A row's connection state: the phase it is drawn with and the words that say it. */
export function credentialBadge(listing: CredentialListing, name: string): { phase: SurfacePhase; key: MessageKey } {
  if (listing.status === "loading") return { phase: "loading", key: "settings.common.loading" };
  // A failed read is not "not connected": the node may well hold the key, so the badge says it is not known.
  if (listing.status === "error") return { phase: "unavailable", key: "settings.credentials.status.unknown" };
  return listing.answer.credentials.includes(name)
    ? { phase: "success", key: "settings.credentials.status.connected" }
    : { phase: "needs-action", key: "settings.credentials.status.notConnected" };
}

/** Where the key in effect for this credential comes from, or `undefined` when the node did not say (an older node). */
export function credentialSource(listing: CredentialListing, name: string): CredentialSource | undefined {
  if (listing.status !== "ready") return undefined;
  const sources = listing.answer.sources;
  if (sources === undefined || !Object.hasOwn(sources, name)) return undefined;
  return sources[name];
}

const SOURCE_LINE: Record<Exclude<CredentialSource, "none">, MessageKey> = {
  vault: "settings.credentials.source.vault",
  environment: "settings.credentials.source.environment",
};

/**
 * Which key is in use, in words, without either value: the one saved here, or one from the node's environment that a
 * key saved here would replace. Nothing is said when no key is in use, or when the node did not report a source.
 */
export function credentialSourceLine(listing: CredentialListing, name: string): MessageKey | undefined {
  const source = credentialSource(listing, name);
  return source === undefined || source === "none" ? undefined : SOURCE_LINE[source];
}

/**
 * Whether Remove has anything to remove. The vault's key wins over the environment's, so a key in effect from the
 * environment means none is saved here, and neither does a credential with no key at all. When the node did not report
 * a source, Remove stays available: the node answers it either way.
 */
export function canRemoveCredential(listing: CredentialListing, name: string): boolean {
  const source = credentialSource(listing, name);
  return source === undefined || source === "vault";
}

export interface CredentialsSectionProps {
  client: GatewayClient;
  entries: readonly CredentialEntry[];
}

export function CredentialsSection({ client, entries }: CredentialsSectionProps): ReactElement {
  const t = useT();
  const [listing, setListing] = useState<CredentialListing>({ status: "loading" });

  const readStatus = (): void => {
    client
      .readiness()
      .then((answer) => setListing({ status: "ready", answer }))
      .catch(() => setListing({ status: "error" }));
  };

  useEffect(() => {
    readStatus();
    // Read again whenever this page saves or removes a key anywhere -- a row here, or a credential card in the
    // conversation -- so the badge and the key in use never show what was true before the change.
    return client.onCredentialsChange(readStatus);
  }, [client]);

  const checkAgain = (): void => {
    setListing({ status: "loading" });
    readStatus();
  };

  return (
    <CredentialsCard
      t={t}
      listing={listing}
      entries={entries}
      onCheckAgain={checkAgain}
      renderRow={(entry) => <CredentialRow key={entry.name} client={client} entry={entry} listing={listing} />}
    />
  );
}

export interface CredentialsCardProps {
  t: (key: MessageKey) => string;
  listing: CredentialListing;
  entries: readonly CredentialEntry[];
  onCheckAgain: () => void;
  renderRow: (entry: CredentialEntry) => ReactElement;
}

/** The section's frame: heading, what it holds, and a failed read said once with a way to read again. */
export function CredentialsCard({ t, listing, entries, onCheckAgain, renderRow }: CredentialsCardProps): ReactElement {
  return (
    <section className="cc-panel-section" data-credentials-section="true" data-credentials-listing={listing.status}>
      <h3>{t("settings.credentials.heading")}</h3>
      <p className="cc-panel-note">{t("settings.credentials.intro")}</p>
      <LiveNote phase={listing.status === "error" ? "error" : undefined} className="cc-panel-note" data-credentials-read-error="true">
        {listing.status === "error" ? t("settings.credentials.readFailed") : undefined}
      </LiveNote>
      {listing.status === "error" ? (
        <div className="cc-chip-row">
          <button type="button" className="cc-chip" data-credentials-check-again="true" onClick={onCheckAgain}>
            {t("settings.credentials.checkAgain")}
          </button>
        </div>
      ) : null}
      {entries.map(renderRow)}
    </section>
  );
}

export interface CredentialRowViewProps {
  t: (key: MessageKey) => string;
  entry: CredentialEntry;
  listing: CredentialListing;
  draft: string;
  busy: boolean;
  outcome: CredentialRowOutcome | undefined;
  onDraft: (value: string) => void;
  onReplace: () => void;
  onRemove: () => void;
}

/** One credential: name, purpose, connection state, which key is in use, the write-only field, Replace and Remove. */
export function CredentialRowView({
  t,
  entry,
  listing,
  draft,
  busy,
  outcome,
  onDraft,
  onReplace,
  onRemove,
}: CredentialRowViewProps): ReactElement {
  const badge = credentialBadge(listing, entry.name);
  const sourceLine = credentialSourceLine(listing, entry.name);
  const source = credentialSource(listing, entry.name);
  return (
    <form
      className="cc-credential-form"
      data-credential-row={entry.name}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        onReplace();
      }}
    >
      <div className="cc-panel-row" data-credential-header={entry.name}>
        <strong>{t(entry.labelKey)}</strong>
        <PhaseBadge phase={badge.phase} data-credential-status={entry.name}>
          {t(badge.key)}
        </PhaseBadge>
      </div>
      <p className="cc-freshness">{t(entry.purposeKey)}</p>
      {sourceLine === undefined ? null : (
        <p className="cc-freshness" data-credential-source={source} data-credential-source-for={entry.name}>
          {t(sourceLine)}
        </p>
      )}

      <label className="cc-credential-field">
        <span>{t("settings.credentials.field.label")}</span>
        <input
          type="password"
          name={entry.name}
          autoComplete="off"
          placeholder={t("settings.credentials.field.placeholder")}
          data-credential-field={entry.name}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
        />
      </label>

      <div className="cc-chip-row">
        <button
          type="submit"
          className="cc-chip"
          disabled={busy || draft.trim() === ""}
          data-credential-replace={entry.name}
        >
          {t("settings.credentials.replace")}
        </button>
        <button
          type="button"
          className="cc-chip"
          disabled={busy || !canRemoveCredential(listing, entry.name)}
          data-credential-remove={entry.name}
          onClick={onRemove}
        >
          {t("settings.credentials.remove")}
        </button>
      </div>

      {/*
        What became of the last press, said once. Every press passes through pending, so a second identical failure is a
        change of phase and is said again.
      */}
      <LiveNote phase={outcome?.phase} data-credential-status-message={entry.name} data-credential-attempt={outcome?.attempt}>
        {outcome === undefined ? undefined : t(outcome.messageKey)}
      </LiveNote>
    </form>
  );
}

function CredentialRow({
  client,
  entry,
  listing,
}: {
  client: GatewayClient;
  entry: CredentialEntry;
  listing: CredentialListing;
}): ReactElement {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState<CredentialRowOutcome | undefined>(undefined);

  // Each press gets the next attempt; an answer for an earlier press never replaces a newer one.
  const press = (pendingKey: MessageKey, run: () => Promise<MessageKey>, failedKey: MessageKey): void => {
    const attempt = (outcome?.attempt ?? 0) + 1;
    setOutcome({ phase: "pending", messageKey: pendingKey, attempt });
    const settle = (next: CredentialRowOutcome): void =>
      setOutcome((current) => (current !== undefined && current.attempt > attempt ? current : next));
    run().then(
      (messageKey) => settle({ phase: "success", messageKey, attempt }),
      // What failed, what's preserved, what to do -- the previous key (if any) is untouched, so the copy says so.
      () => settle({ phase: "error", messageKey: failedKey, attempt }),
    );
  };

  const replace = (): void => {
    const value = draft.trim();
    if (value === "") return;
    // Cleared the moment it is handed over: nothing later can read it off the screen or out of state.
    setDraft("");
    press(
      "settings.credentials.status.saving",
      () =>
        client
          .putCredential({ fields: [{ name: entry.name, value }] })
          .then((result) =>
            result.names.includes(entry.name) ? "settings.credentials.status.saved" : "settings.credentials.status.sentNoName",
          ),
      "settings.credentials.status.saveFailed",
    );
  };

  const remove = (): void => {
    press(
      "settings.credentials.status.removing",
      () => client.deleteCredential(entry.name).then(() => "settings.credentials.status.removed"),
      "settings.credentials.status.removeFailed",
    );
  };

  return (
    <CredentialRowView
      t={t}
      entry={entry}
      listing={listing}
      draft={draft}
      busy={outcome?.phase === "pending"}
      outcome={outcome}
      onDraft={setDraft}
      onReplace={replace}
      onRemove={remove}
    />
  );
}
