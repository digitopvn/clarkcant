import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { ProviderAuthEntryView, ProviderSignInView } from "@clarkcant/contracts";

import { GatewayError, type GatewayClient } from "../../api.ts";
import { fillMessage } from "../../i18n/fill-message.ts";
import { useT } from "../../i18n/locale-context.tsx";
import type { MessageKey } from "../../i18n/messages.ts";
import { AfterSignIn, type ModelPickerPort } from "../../model-picker.tsx";
import { SignInPanel } from "../../provider-sign-in-panel.tsx";
import { useModelPickerPort } from "../../use-model-picker-port.ts";
import { useProviderSignIns } from "../../use-provider-sign-ins.ts";

export type ProviderListing =
  | { status: "loading" }
  | { status: "ready"; providers: readonly ProviderAuthEntryView[] }
  | { status: "unavailable" }
  | { status: "failed"; reason: string };

export type ProviderRowOutcome = { status: "pending" } | { status: "done" | "failed"; message: string };

/** Where a configured provider's credential comes from, as a person reads it. */
const SOURCE_NOTE: Record<NonNullable<ProviderAuthEntryView["source"]>, MessageKey> = {
  stored: "settings.providers.source.stored",
  environment: "settings.providers.source.environment",
  runtime: "settings.providers.source.runtime",
  models_json: "settings.providers.source.models_json",
  fallback: "settings.providers.source.fallback",
};

/**
 * Only a credential pi stored is pi's to remove; one from the environment, the startup hand-over, models.json or pi's
 * own fallback lives somewhere else. The node refuses the rest (`SIGN_OUT_NOT_HERE`), so no button offers it.
 */
export function providerSignOutAvailable(provider: ProviderAuthEntryView): boolean {
  return provider.configured && provider.source === "stored";
}

/** What a provider row says under its name: where the credential comes from when signed in, its account otherwise. */
export function providerSourceNote(provider: ProviderAuthEntryView, t: (key: MessageKey) => string): string | undefined {
  if (!provider.configured) return provider.oauth?.label;
  return t(provider.source === undefined ? "settings.providers.source.unknown" : SOURCE_NOTE[provider.source]);
}

/** The node's own sentence for a refusal, without the code in front of it. */
function reasonOf(error: unknown): string {
  if (error instanceof GatewayError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

/** A listing the node refused: no pi to sign in through is said as such, anything else with the node's reason. */
export function providerListingRefused(error: unknown): ProviderListing {
  return error instanceof GatewayError && error.code === "PROVIDER_AUTH_UNAVAILABLE" ? { status: "unavailable" } : { status: "failed", reason: reasonOf(error) };
}

/**
 * Settings → AI & Routing → Provider sign-in.
 *
 * The providers pi can answer with, each with the ways in pi advertises for it — an account sign-in (OAuth) only when
 * pi offers one, an API key only when pi takes one — and, once signed in, where the credential comes from. The same
 * capability `/login` and `/logout` use: one node route, one sign-in registry, and the shared `useProviderSignIns`
 * path, so a sign-in started here is the one a card would follow. What the person types goes straight to pi; nothing
 * here holds or shows it. A finished sign-in or sign-out tells the client's model listeners, which reloads this list
 * and the model catalogue beside it.
 *
 * A section of its own, so a sibling section (such as the decision provider) sits beside it without touching it.
 */
export function ProviderSignInSection({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [listing, setListing] = useState<ProviderListing>({ status: "loading" });
  const [outcomes, setOutcomes] = useState<Record<string, ProviderRowOutcome>>({});
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const onError = useCallback(
    (message: string) => setNotice(fillMessage(t("settings.providers.answerFailed"), { reason: message })),
    [t],
  );
  const signIns = useProviderSignIns(client, onError);
  // The step after a sign-in is the one a `/login` card offers: that provider's models in the same picker, or keeping the model in use.
  const modelPicker = useModelPickerPort(client, t);

  const load = useCallback(() => {
    client.providerAuth().then(
      (answer) => setListing({ status: "ready", providers: answer.providers }),
      (error: unknown) => setListing(providerListingRefused(error)),
    );
  }, [client]);

  useEffect(() => {
    load();
    // A sign-in or sign-out anywhere on this page — here, or a `/login` card — changes who is signed in.
    return client.onModelChange(load);
  }, [client, load]);

  const settle = (providerId: string, outcome: ProviderRowOutcome | undefined): void =>
    setOutcomes((current) => {
      const { [providerId]: _previous, ...rest } = current;
      return outcome === undefined ? rest : { ...rest, [providerId]: outcome };
    });

  return (
    <ProviderSignInList
      t={t}
      listing={listing}
      signIns={signIns.signIns}
      modelPicker={modelPicker}
      outcomes={outcomes}
      notice={notice}
      onRetry={load}
      onStart={(provider, method) => {
        setNotice(undefined);
        settle(provider.providerId, { status: "pending" });
        signIns.start(provider.providerId, provider.providerId, method).then(
          () => settle(provider.providerId, undefined),
          (error: unknown) =>
            settle(provider.providerId, { status: "failed", message: fillMessage(t("settings.providers.startFailed"), { reason: reasonOf(error) }) }),
        );
      }}
      onSignOut={(provider) => {
        setNotice(undefined);
        settle(provider.providerId, { status: "pending" });
        signIns.signOut(provider.providerId).then(
          (result) =>
            settle(provider.providerId, {
              status: "done",
              message: t(result.signedOut ? "commandCard.signOut.done" : "settings.providers.signOutNothing"),
            }),
          (error: unknown) =>
            settle(provider.providerId, { status: "failed", message: fillMessage(t("settings.providers.signOutFailed"), { reason: reasonOf(error) }) }),
        );
      }}
      onAnswer={(providerId, signInId, value) => signIns.answer({ key: providerId, signInId, value })}
      onCancel={(providerId, signInId) => signIns.cancel({ key: providerId, signInId })}
    />
  );
}

export interface ProviderSignInListProps {
  t: (key: MessageKey) => string;
  listing: ProviderListing;
  /** Sign-ins started from this section, keyed by provider id. */
  signIns: Readonly<Record<string, ProviderSignInView>>;
  /** What a finished sign-in offers next: the model picker for that provider. Without it, nothing is offered. */
  modelPicker?: ModelPickerPort | undefined;
  outcomes: Readonly<Record<string, ProviderRowOutcome>>;
  notice?: string | undefined;
  onRetry: () => void;
  onStart: (provider: ProviderAuthEntryView, method: "oauth" | "api_key") => void;
  onSignOut: (provider: ProviderAuthEntryView) => void;
  onAnswer: (providerId: string, signInId: string, value: string) => void;
  onCancel: (providerId: string, signInId: string) => void;
}

/** The section as drawn: a pure function of what the node said and what this section started. */
export function ProviderSignInList({
  t,
  listing,
  signIns,
  modelPicker,
  outcomes,
  notice,
  onRetry,
  onStart,
  onSignOut,
  onAnswer,
  onCancel,
}: ProviderSignInListProps): ReactElement {
  return (
    <section className="cc-panel-section" data-provider-sign-in="true">
      <h3>{t("settings.providers.heading")}</h3>
      <p className="cc-panel-note">{t("settings.providers.intro")}</p>
      {listing.status === "loading" ? (
        <p className="cc-panel-note" role="status">
          {t("settings.common.loading")}
        </p>
      ) : listing.status === "unavailable" ? (
        <p className="cc-panel-note" data-provider-sign-in-state="unavailable">
          {t("settings.providers.unavailable")}
        </p>
      ) : listing.status === "failed" ? (
        <div className="cc-panel-row" data-provider-sign-in-state="failed">
          <p className="cc-panel-note" role="alert">
            {t("settings.providers.readFailed")} {listing.reason}
          </p>
          <button type="button" className="cc-chip" onClick={onRetry}>
            {t("settings.providers.retry")}
          </button>
        </div>
      ) : listing.providers.length === 0 ? (
        <p className="cc-panel-note" data-provider-sign-in-state="empty">
          {t("settings.providers.empty")}
        </p>
      ) : (
        <ul className="cc-list" aria-label={t("settings.providers.heading")}>
          {listing.providers.map((provider) => {
            const signIn = signIns[provider.providerId];
            const signingIn = signIn !== undefined && (signIn.state === "running" || signIn.state === "waiting");
            const outcome = outcomes[provider.providerId];
            const busy = signingIn || outcome?.status === "pending";
            const removable = providerSignOutAvailable(provider);
            const note = providerSourceNote(provider, t);
            return (
              <li
                key={provider.providerId}
                className="cc-list-item cc-command-row"
                data-provider-id={provider.providerId}
                data-configured={provider.configured ? "true" : "false"}
                data-source={provider.source}
              >
                <div className="cc-list-main">
                  <div className="cc-list-text">
                    <span className="cc-list-title">{provider.name}</span>
                    {note === undefined ? null : (
                      <span className="cc-list-subtitle" data-provider-source-note="true">
                        {note}
                      </span>
                    )}
                  </div>
                  <span className="cc-badge" data-tone={provider.configured ? "ok" : undefined}>
                    {t(provider.configured ? "settings.providers.badge.signedIn" : "settings.providers.badge.signedOut")}
                  </span>
                </div>
                <div className="cc-command-actions">
                  {provider.oauth === undefined ? null : (
                    <button
                      type="button"
                      className="cc-action"
                      data-emphasis="primary"
                      data-provider-method="oauth"
                      disabled={busy}
                      onClick={() => onStart(provider, "oauth")}
                    >
                      {t(
                        removable
                          ? "settings.providers.method.oauthAgain"
                          : provider.oauth.subscription
                            ? "settings.providers.method.account"
                            : "settings.providers.method.oauth",
                      )}
                    </button>
                  )}
                  {provider.apiKey ? (
                    <button
                      type="button"
                      className="cc-action"
                      data-emphasis={provider.oauth === undefined ? "primary" : undefined}
                      data-provider-method="api_key"
                      disabled={busy}
                      onClick={() => onStart(provider, "api_key")}
                    >
                      {t(removable ? "settings.providers.method.apiKeyReplace" : "settings.providers.method.apiKey")}
                    </button>
                  ) : null}
                  {removable ? (
                    <button
                      type="button"
                      className="cc-action"
                      data-tone="danger"
                      data-provider-sign-out="true"
                      disabled={busy}
                      onClick={() => onSignOut(provider)}
                    >
                      {t("settings.providers.signOut")}
                    </button>
                  ) : null}
                </div>
                {outcome === undefined ? null : outcome.status === "pending" ? (
                  <p className="cc-command-status" role="status">
                    {t("commandCard.working")}
                  </p>
                ) : (
                  <p className="cc-command-status" role="status" data-result={outcome.status}>
                    {outcome.message}
                  </p>
                )}
                {signIn === undefined ? null : (
                  <SignInPanel
                    signIn={signIn}
                    providerName={provider.name}
                    t={t}
                    onAnswer={(value) => onAnswer(provider.providerId, signIn.signInId, value)}
                    onCancel={() => onCancel(provider.providerId, signIn.signInId)}
                    after={
                      <AfterSignIn
                        key={signIn.signInId}
                        t={t}
                        signInKey={`settings/${provider.providerId}`}
                        signInId={signIn.signInId}
                        providerId={provider.providerId}
                        providerName={provider.name}
                        port={modelPicker}
                      />
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {notice === undefined ? null : (
        <p className="cc-panel-note" role="alert">
          {notice}
        </p>
      )}
    </section>
  );
}
