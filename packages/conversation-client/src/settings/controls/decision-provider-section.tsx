import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";

import {
  DECISION_CREDENTIAL_NAMES,
  DECISION_PROVIDER_IDS,
  DECISION_REASON_CODES,
  HOST_OWNED_DECISION_CREDENTIALS,
  OPENROUTER_DECISION_MODEL_PATTERN,
  isOpenrouterRouterSlug,
  type DecisionCredentialSource,
  type DecisionProviderId,
  type DecisionProviderSelection,
  type DecisionProviderView,
  type DecisionReasonCode,
} from "@clarkcant/contracts";

import { GatewayError, type GatewayClient } from "../../api.ts";
import { fillMessage } from "../../i18n/fill-message.ts";
import { useT } from "../../i18n/locale-context.tsx";
import type { MessageKey } from "../../i18n/messages.ts";
import { SegmentedControl, type SegmentedOption } from "./primitives.tsx";

export type DecisionListing =
  | { status: "loading" }
  | { status: "ready"; view: DecisionProviderView }
  | { status: "failed"; reason: string };

/** The outcome of one write, shown beside the control that made it. */
export type DecisionOutcome = { status: "pending" } | { status: "done" | "failed"; message: string };

/** What the selector offers: following the node's environment, or one provider by name. */
export type DecisionChoice = "environment" | DecisionProviderId;

/** Where each control's outcome is shown: the selector, the model or account, or one provider's key card. */
export type DecisionOutcomeSlot = "selection" | `key:${DecisionProviderId}`;

const PROVIDER_NAME: Record<DecisionProviderId, MessageKey> = {
  typesafe: "settings.decision.provider.typesafe",
  cloudflare: "settings.decision.provider.cloudflare",
  openrouter: "settings.decision.provider.openrouter",
};

const PROVIDER_NOTE: Record<DecisionProviderId, MessageKey> = {
  typesafe: "settings.decision.note.typesafe",
  cloudflare: "settings.decision.note.cloudflare",
  openrouter: "settings.decision.note.openrouter",
};

/** The environment variable each provider's key is read from when none is saved here; a name, never a value. */
const KEY_VARIABLE: Record<DecisionProviderId, string> = {
  typesafe: "TYPESAFE_API_KEY",
  cloudflare: "CLOUDFLARE_API_TOKEN",
  openrouter: "OPENROUTER_API_KEY",
};

const KEY_SOURCE_BADGE: Record<DecisionCredentialSource, MessageKey> = {
  vault: "settings.decision.key.source.vault",
  environment: "settings.decision.key.source.environment",
  none: "settings.decision.key.source.none",
};

const KEY_SOURCE_NOTE: Record<DecisionCredentialSource, MessageKey> = {
  vault: "settings.decision.key.note.vault",
  environment: "settings.decision.key.note.environment",
  none: "settings.decision.key.note.none",
};

/**
 * Whether a provider's key is held in the Credentials list rather than on its own key card.
 *
 * Only Cloudflare's and OpenRouter's keys sit under host-owned vault names that the generic credential store refuses, so
 * their cards are the one place to enter them. TypeSafe's key is the plain `typesafe` credential the Credentials list
 * already saves, replaces and removes; a second field here would be two controls for one key, so its card points there.
 */
export function keyLivesInCredentials(provider: DecisionProviderId): boolean {
  return !HOST_OWNED_DECISION_CREDENTIALS.includes(DECISION_CREDENTIAL_NAMES[provider]);
}

/** Moves focus to a credential's row in the Credentials list, or brings the list into view when the row has nothing to focus. */
function focusCredentialRow(name: string): void {
  const row = document.querySelector(`[data-credential-row="${CSS.escape(name)}"]`);
  const target = row?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])");
  if (target) {
    target.focus();
    return;
  }
  (row ?? document.querySelector("[data-credentials-section='true']"))?.scrollIntoView({ block: "nearest" });
}

const SELECTED_BY: Record<DecisionProviderView["selectedBy"], MessageKey> = {
  settings: "settings.decision.selectedBy.settings",
  environment: "settings.decision.selectedBy.environment",
  default: "settings.decision.selectedBy.default",
};

/** The node's own sentence for a failed read, kept for diagnostics; the card itself never shows the node's English. */
function reasonOf(error: unknown): string {
  if (error instanceof GatewayError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why the decider is in its state, or why its last call got no answer, in the person's language.
 *
 * The node sends a code beside its English sentence; the card words the code and never inserts the sentence, so a
 * Vietnamese card does not carry English. A node too old to send a code, or newer and sending a code this client does
 * not know yet, gets the generic wording rather than a raw message key.
 */
export function decisionReasonText(code: string | undefined, t: (key: MessageKey) => string): string {
  return t(isKnownReasonCode(code) ? `settings.decision.reason.${code}` : "settings.decision.reason.unknown");
}

function isKnownReasonCode(code: string | undefined): code is DecisionReasonCode {
  return code !== undefined && (DECISION_REASON_CODES as readonly string[]).includes(code);
}

/**
 * What a refused write says, in the person's language: the node's 400 for a selection is a choice it would not take,
 * for a key it is a key outside the accepted length; anything else is a request that did not complete.
 */
export function decisionWriteFailure(slot: DecisionOutcomeSlot, error: unknown, t: (key: MessageKey) => string): string {
  const refused = error instanceof GatewayError && error.status === 400;
  const why = !refused ? "settings.decision.failed.other" : slot === "selection" ? "settings.decision.failed.selection" : "settings.decision.failed.key";
  return fillMessage(t("settings.decision.writeFailed"), { reason: t(why) });
}

/** Whether a slug is one the node would accept as an OpenRouter decision model, so the form refuses it before sending. */
export function isPinnedOpenrouterSlug(slug: string): boolean {
  return OPENROUTER_DECISION_MODEL_PATTERN.test(slug) && !isOpenrouterRouterSlug(slug);
}

/**
 * The selection a choice in the selector stands for, when it can be made without asking anything more.
 *
 * TypeSafe needs nothing. Cloudflare keeps the model and account id already chosen, and otherwise takes the model the
 * node is already running or the first Clef model. OpenRouter needs a pinned slug: the one already chosen or running,
 * or none, in which case `undefined` asks the card to collect one before anything is saved.
 */
export function selectionFor(choice: DecisionChoice, view: DecisionProviderView): DecisionProviderSelection | null | undefined {
  switch (choice) {
    case "environment":
      return null;
    case "typesafe":
      return { provider: "typesafe" };
    case "cloudflare": {
      if (view.selection?.provider === "cloudflare") return view.selection;
      const models = view.providers.find((entry) => entry.id === "cloudflare")?.models ?? [];
      const running = view.provider === "cloudflare" ? models.find((model) => model === view.model) : undefined;
      const model = running ?? models[0];
      if (model !== "clef" && model !== "clef-flash") return undefined;
      return { provider: "cloudflare", model };
    }
    case "openrouter":
      if (view.selection?.provider === "openrouter") return view.selection;
      return view.provider === "openrouter" && isPinnedOpenrouterSlug(view.model) ? { provider: "openrouter", model: view.model } : undefined;
  }
}

/** What the card says about the provider's state: the decider's reason, and what to do about it. */
export function decisionHint(view: DecisionProviderView, t: (key: MessageKey) => string): string {
  const provider = t(PROVIDER_NAME[view.provider]);
  const reason = decisionReasonText(view.reasonCode, t);
  switch (view.status) {
    case "ready":
      return fillMessage(t("settings.decision.hint.ready"), { host: view.endpointHost });
    case "local-only":
      return t("settings.decision.hint.local-only");
    case "misconfigured":
      return fillMessage(
        t(view.provider === "cloudflare" && view.account?.source === "none" ? "settings.decision.hint.misconfigured.cloudflare" : "settings.decision.hint.misconfigured"),
        { reason },
      );
    case "no-credential":
      return fillMessage(
        t(keyLivesInCredentials(view.provider) ? "settings.decision.hint.no-credential.credentials" : "settings.decision.hint.no-credential"),
        { provider },
      );
    case "disabled":
      return t("settings.decision.hint.disabled");
  }
}

/** The last provider call, in one line: answered, unsure, or why it got no answer. Never a body, never a key. */
export function lastCallLine(view: DecisionProviderView, t: (key: MessageKey) => string): string {
  const last = view.lastCall;
  if (last === undefined) return t("settings.decision.lastCall.none");
  const values = { model: last.model, ms: last.durationMs, reason: decisionReasonText(last.reasonCode, t) };
  if (last.status === "answered") return fillMessage(t("settings.decision.lastCall.answered"), values);
  if (last.status === "abstained") return fillMessage(t("settings.decision.lastCall.abstained"), values);
  return fillMessage(t("settings.decision.lastCall.unavailable"), values);
}

/**
 * Settings → AI & Routing → Decision provider.
 *
 * Who answers Clark's small typed decisions on this node, separate from the conversation model: the selector (or
 * following the node's environment), the provider's model, each provider's key card, the state the decider is in and
 * why, and the last call. Every write goes to the node's own decision provider routes and the card redraws from the
 * node's answer, so it never shows a choice the node did not store. A key typed here is sent once and the field is
 * cleared; nothing on the card ever shows it back.
 */
export function DecisionProviderSection({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [listing, setListing] = useState<DecisionListing>({ status: "loading" });
  const [outcomes, setOutcomes] = useState<Partial<Record<DecisionOutcomeSlot, DecisionOutcome>>>({});
  const [picked, setPicked] = useState<DecisionChoice | undefined>(undefined);

  const load = useCallback(() => {
    client.decisionProvider().then(
      (answer) => setListing({ status: "ready", view: answer.decisionProvider }),
      (error: unknown) => setListing({ status: "failed", reason: reasonOf(error) }),
    );
  }, [client]);

  useEffect(load, [load]);

  const settle = (slot: DecisionOutcomeSlot, outcome: DecisionOutcome): void =>
    setOutcomes((current) => ({ ...current, [slot]: outcome }));

  const write = (
    slot: DecisionOutcomeSlot,
    request: Promise<{ decisionProvider: DecisionProviderView }>,
    done: string,
    failed: (error: unknown) => string = (error) => decisionWriteFailure(slot, error, t),
  ): Promise<boolean> => {
    settle(slot, { status: "pending" });
    return request.then(
      (answer) => {
        setListing({ status: "ready", view: answer.decisionProvider });
        settle(slot, { status: "done", message: done });
        return true;
      },
      (error: unknown) => {
        settle(slot, { status: "failed", message: failed(error) });
        return false;
      },
    );
  };

  const choose = (selection: DecisionProviderSelection | null): Promise<boolean> =>
    write("selection", client.chooseDecisionProvider(selection), t("settings.decision.saved")).then((ok) => {
      if (ok) setPicked(undefined);
      return ok;
    });

  return (
    <DecisionProviderCard
      t={t}
      listing={listing}
      outcomes={outcomes}
      picked={picked}
      onRetry={load}
      onChoose={(choice) => {
        if (listing.status !== "ready") return;
        const selection = selectionFor(choice, listing.view);
        if (selection === undefined) {
          // Nothing is saved until the provider has what it needs; the card asks for it.
          setPicked(choice);
          return;
        }
        void choose(selection);
      }}
      onSelect={(selection) => choose(selection)}
      onSaveKey={(provider, value) => {
        const name = t(PROVIDER_NAME[provider]);
        return write(
          `key:${provider}`,
          client.saveDecisionCredential(provider, value),
          fillMessage(t("settings.decision.key.saved"), { provider: name }),
        );
      }}
      onRemoveKey={(provider) => {
        const name = t(PROVIDER_NAME[provider]);
        void write(
          `key:${provider}`,
          client.removeDecisionCredential(provider),
          fillMessage(t("settings.decision.key.removed"), { provider: name }),
          (error) =>
            error instanceof GatewayError && error.code === "RESOURCE_NOT_FOUND"
              ? fillMessage(t("settings.decision.key.removeNothing"), { provider: name })
              : decisionWriteFailure(`key:${provider}`, error, t),
        );
      }}
    />
  );
}

export interface DecisionProviderCardProps {
  t: (key: MessageKey) => string;
  listing: DecisionListing;
  outcomes: Readonly<Partial<Record<DecisionOutcomeSlot, DecisionOutcome>>>;
  /** A provider picked in the selector that still needs something (an OpenRouter slug) before it can be saved. */
  picked?: DecisionChoice | undefined;
  onRetry: () => void;
  onChoose: (choice: DecisionChoice) => void;
  /** Saves a complete selection: a model, or a Cloudflare account id. Resolves whether the node stored it. */
  onSelect: (selection: DecisionProviderSelection | null) => Promise<boolean>;
  /** Saves a key; resolves whether the node stored it, so the field is cleared only then. */
  onSaveKey: (provider: DecisionProviderId, value: string) => Promise<boolean>;
  onRemoveKey: (provider: DecisionProviderId) => void;
}

function OutcomeLine({ outcome, t, slot }: { outcome: DecisionOutcome | undefined; t: (key: MessageKey) => string; slot: string }): ReactElement | null {
  if (outcome === undefined) return null;
  if (outcome.status === "pending") {
    return (
      <p className="cc-command-status" role="status" data-decision-outcome={slot}>
        {t("commandCard.working")}
      </p>
    );
  }
  return (
    <p className="cc-command-status" role={outcome.status === "failed" ? "alert" : "status"} data-decision-outcome={slot} data-result={outcome.status}>
      {outcome.message}
    </p>
  );
}

/** The section as drawn: a pure function of what the node said and what this section is waiting on. */
export function DecisionProviderCard({
  t,
  listing,
  outcomes,
  picked,
  onRetry,
  onChoose,
  onSelect,
  onSaveKey,
  onRemoveKey,
}: DecisionProviderCardProps): ReactElement {
  return (
    <section className="cc-panel-section" data-decision-provider="true">
      <h3>{t("settings.decision.heading")}</h3>
      <p className="cc-panel-note">{t("settings.decision.intro")}</p>
      {listing.status === "loading" ? (
        <p className="cc-panel-note" role="status">
          {t("settings.common.loading")}
        </p>
      ) : listing.status === "failed" ? (
        <div className="cc-panel-row" data-decision-state="failed">
          <p className="cc-panel-note" role="alert">
            {t("settings.decision.readFailed")}
          </p>
          <button type="button" className="cc-chip" onClick={onRetry}>
            {t("settings.decision.retry")}
          </button>
        </div>
      ) : (
        <DecisionProviderReady
          t={t}
          view={listing.view}
          outcomes={outcomes}
          picked={picked}
          onChoose={onChoose}
          onSelect={onSelect}
          onSaveKey={onSaveKey}
          onRemoveKey={onRemoveKey}
        />
      )}
    </section>
  );
}

interface ReadyProps extends Omit<DecisionProviderCardProps, "listing" | "onRetry"> {
  view: DecisionProviderView;
}

function DecisionProviderReady({ t, view, outcomes, picked, onChoose, onSelect, onSaveKey, onRemoveKey }: ReadyProps): ReactElement {
  const shown: DecisionChoice = picked ?? view.selection?.provider ?? "environment";
  const options: SegmentedOption<DecisionChoice>[] = [
    { value: "environment", label: t("settings.decision.option.environment"), note: t("settings.decision.option.environment.note") },
    ...DECISION_PROVIDER_IDS.map((id) => ({ value: id, label: t(PROVIDER_NAME[id]), note: t(PROVIDER_NOTE[id]) })),
  ];
  const ready = view.status === "ready";
  return (
    <>
      <div
        className="cc-list-item cc-command-row"
        data-decision-current="true"
        data-decision-status={view.status}
        data-decision-selected-by={view.selectedBy}
        data-decision-active-provider={view.provider}
      >
        <div className="cc-list-main">
          <div className="cc-list-text">
            <span className="cc-list-title">
              {fillMessage(t("settings.decision.current"), { provider: t(PROVIDER_NAME[view.provider]), model: view.model })}
            </span>
            <span className="cc-list-subtitle" data-decision-hint="true" role={ready ? undefined : "alert"}>
              {decisionHint(view, t)}
            </span>
          </div>
          <span className="cc-badge" data-decision-selected-by-badge="true">
            {t(SELECTED_BY[view.selectedBy])}
          </span>
          <span className="cc-badge" data-tone={ready ? "ok" : "warn"} data-decision-status-badge="true">
            {t(`settings.decision.status.${view.status}`)}
          </span>
        </div>
        <p className="cc-list-subtitle" data-decision-last-call={view.lastCall?.status ?? "none"}>
          {lastCallLine(view, t)}
        </p>
      </div>

      <SegmentedControl<DecisionChoice>
        name="decision-provider"
        label={t("settings.decision.chooser")}
        options={options}
        value={shown}
        pending={outcomes.selection?.status === "pending"}
        onChange={onChoose}
      />
      {shown === "cloudflare" && view.selection?.provider === "cloudflare" ? (
        <CloudflareControls t={t} view={view} selection={view.selection} onSelect={onSelect} />
      ) : null}
      {shown === "openrouter" ? (
        <OpenrouterModelForm
          t={t}
          current={view.selection?.provider === "openrouter" ? view.selection.model : undefined}
          needed={picked === "openrouter"}
          onSelect={onSelect}
        />
      ) : null}
      <OutcomeLine outcome={outcomes.selection} t={t} slot="selection" />
      <p className="cc-panel-note" data-decision-applies="true">
        {t("settings.decision.applies")} {t("settings.decision.fallback")}
      </p>

      <h4>{t("settings.decision.keys.heading")}</h4>
      <p className="cc-panel-note">{t("settings.decision.keys.intro")}</p>
      <ul className="cc-list" aria-label={t("settings.decision.keys.heading")}>
        {view.providers.map((entry) => (
          <DecisionKeyCard
            key={entry.id}
            t={t}
            provider={entry.id}
            source={entry.credential.source}
            active={entry.id === view.provider}
            outcome={outcomes[`key:${entry.id}`]}
            onSaveKey={onSaveKey}
            onRemoveKey={onRemoveKey}
          />
        ))}
      </ul>
    </>
  );
}

function CloudflareControls({
  t,
  view,
  selection,
  onSelect,
}: {
  t: (key: MessageKey) => string;
  view: DecisionProviderView;
  selection: Extract<DecisionProviderSelection, { provider: "cloudflare" }>;
  onSelect: (selection: DecisionProviderSelection | null) => Promise<boolean>;
}): ReactElement {
  const models = (view.providers.find((entry) => entry.id === "cloudflare")?.models ?? []).filter(
    (model): model is "clef" | "clef-flash" => model === "clef" || model === "clef-flash",
  );
  const [account, setAccount] = useState(selection.accountId ?? "");
  const accountSource = view.account?.source ?? "none";
  const save = (event: FormEvent): void => {
    event.preventDefault();
    const accountId = account.trim().toLowerCase();
    if (accountId === "") return;
    void onSelect({ ...selection, accountId });
  };
  return (
    <div className="cc-form" data-decision-cloudflare="true">
      <SegmentedControl<"clef" | "clef-flash">
        name="decision-cloudflare-model"
        label={t("settings.decision.model.cloudflare")}
        options={models.map((model) => ({ value: model, label: model }))}
        value={selection.model}
        onChange={(model) => void onSelect({ ...selection, model })}
      />
      <form className="cc-search-row" onSubmit={save}>
        <input
          className="cc-field-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("settings.decision.account.label")}
          placeholder={t("settings.decision.account.placeholder")}
          data-decision-account-input="true"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
        />
        <button type="submit" className="cc-action" data-emphasis="primary" data-decision-account-save="true" disabled={account.trim() === ""}>
          {t("settings.decision.account.save")}
        </button>
      </form>
      <p className="cc-panel-note" data-decision-account-source={accountSource}>
        {t(`settings.decision.account.source.${accountSource}`)}
      </p>
      {selection.accountId === undefined ? null : (
        <button
          type="button"
          className="cc-action"
          data-decision-account-clear="true"
          onClick={() => {
            setAccount("");
            void onSelect({ provider: "cloudflare", model: selection.model });
          }}
        >
          {t("settings.decision.account.clear")}
        </button>
      )}
    </div>
  );
}

function OpenrouterModelForm({
  t,
  current,
  needed,
  onSelect,
}: {
  t: (key: MessageKey) => string;
  current: string | undefined;
  needed: boolean;
  onSelect: (selection: DecisionProviderSelection | null) => Promise<boolean>;
}): ReactElement {
  const [slug, setSlug] = useState(current ?? "");
  const trimmed = slug.trim();
  return (
    <div className="cc-form" data-decision-openrouter="true">
      <form
        className="cc-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "") return;
          // The node is the authority on what it accepts: an unpinned slug is sent and its refusal is shown as said.
          void onSelect({ provider: "openrouter", model: trimmed });
        }}
      >
        <input
          className="cc-field-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("settings.decision.model.openrouter")}
          placeholder={t("settings.decision.model.openrouter.placeholder")}
          data-decision-openrouter-model="true"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
        <button
          type="submit"
          className="cc-action"
          data-emphasis="primary"
          data-decision-model-use="true"
          disabled={trimmed === "" || trimmed === current}
        >
          {t("settings.decision.model.use")}
        </button>
      </form>
      <p className="cc-panel-note">{t("settings.decision.model.openrouter.note")}</p>
      {needed ? (
        <p className="cc-panel-note" role="status" data-decision-model-needed="true">
          {t("settings.decision.model.openrouter.needed")}
        </p>
      ) : null}
    </div>
  );
}

function DecisionKeyCard({
  t,
  provider,
  source,
  active,
  outcome,
  onSaveKey,
  onRemoveKey,
}: {
  t: (key: MessageKey) => string;
  provider: DecisionProviderId;
  source: DecisionCredentialSource;
  active: boolean;
  outcome: DecisionOutcome | undefined;
  onSaveKey: (provider: DecisionProviderId, value: string) => Promise<boolean>;
  onRemoveKey: (provider: DecisionProviderId) => void;
}): ReactElement {
  const name = t(PROVIDER_NAME[provider]);
  const busy = outcome?.status === "pending";
  const inCredentials = keyLivesInCredentials(provider);
  const note = inCredentials && source === "environment" ? "settings.decision.key.note.environment.credentials" : KEY_SOURCE_NOTE[source];
  return (
    <li
      className="cc-list-item cc-command-row"
      data-decision-key-card={provider}
      data-decision-key-source={source}
      data-active={active ? "true" : "false"}
    >
      <div className="cc-list-main">
        <div className="cc-list-text">
          <span className="cc-list-title">{name}</span>
          <span className="cc-list-subtitle">{fillMessage(t(note), { variable: KEY_VARIABLE[provider] })}</span>
        </div>
        <span className="cc-badge" data-tone={source === "none" ? undefined : "ok"}>
          {t(KEY_SOURCE_BADGE[source])}
        </span>
      </div>
      {inCredentials ? (
        <div className="cc-command-actions" data-decision-key-in-credentials={provider}>
          <p className="cc-panel-note">{fillMessage(t("settings.decision.key.inCredentials"), { provider: name })}</p>
          <button
            type="button"
            className="cc-action"
            data-decision-key-go-to-credentials={provider}
            onClick={() => focusCredentialRow(DECISION_CREDENTIAL_NAMES[provider])}
          >
            {t("settings.decision.key.goToCredentials")}
          </button>
        </div>
      ) : (
        <DecisionKeyForm
          t={t}
          provider={provider}
          name={name}
          source={source}
          busy={busy}
          onSaveKey={onSaveKey}
          onRemoveKey={onRemoveKey}
        />
      )}
      <OutcomeLine outcome={outcome} t={t} slot={`key:${provider}`} />
    </li>
  );
}

function DecisionKeyForm({
  t,
  provider,
  name,
  source,
  busy,
  onSaveKey,
  onRemoveKey,
}: {
  t: (key: MessageKey) => string;
  provider: DecisionProviderId;
  name: string;
  source: DecisionCredentialSource;
  busy: boolean;
  onSaveKey: (provider: DecisionProviderId, value: string) => Promise<boolean>;
  onRemoveKey: (provider: DecisionProviderId) => void;
}): ReactElement {
  // The draft lives only in this field and is cleared once the node has stored it; it is never rendered anywhere else.
  const [draft, setDraft] = useState("");
  return (
    <>
      <form
        className="cc-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          const value = draft.trim();
          if (value === "") return;
          void onSaveKey(provider, value).then((stored) => {
            if (stored) setDraft("");
          });
        }}
      >
        <input
          className="cc-field-input"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          aria-label={fillMessage(t("settings.decision.key.label"), { provider: name })}
          data-decision-key-input={provider}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="cc-action"
          data-emphasis="primary"
          data-decision-key-save={provider}
          disabled={busy || draft.trim() === ""}
        >
          {t(source === "vault" ? "settings.decision.key.replace" : "settings.decision.key.save")}
        </button>
      </form>
      {source === "vault" ? (
        <div className="cc-command-actions">
          <button
            type="button"
            className="cc-action"
            data-tone="danger"
            data-decision-key-remove={provider}
            disabled={busy}
            onClick={() => onRemoveKey(provider)}
          >
            {t("settings.decision.key.remove")}
          </button>
        </div>
      ) : null}
    </>
  );
}
