import { useEffect, useState, type ReactElement } from "react";

import type { VoiceCapabilities } from "@clarkcant/contracts";

import { DevicePairingPanel } from "../DevicePairingPanel.tsx";
import { MicrophoneCheck } from "../microphone-check.tsx";
import { SearchSelect } from "../search-select.tsx";
import { wakeAvailability } from "../wake-word.ts";
import type { GatewayClient } from "../api.ts";
import { InlineStatus, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { useT } from "../i18n/locale-context.tsx";

/**
 * Devices & Voice: how Clark hears and speaks.
 *
 * The voice provider, the voice itself, the microphone and the wake phrase are one tab because they are one
 * decision chain: a session needs a provider, a provider offers voices, and the microphone is what feeds it.
 * Splitting them across tabs would mean configuring voice in three places.
 *
 * What is **not** here yet, deliberately: the wake phrase. Its reason is its own — there is no local detector
 * yet, so the honest state is a row that says so rather than a toggle that cannot turn anything on.
 *
 * The voice picker and its preview come from the provider's own capability report. A provider that cannot
 * select a voice shows no selector, and one that cannot preview shows a disabled control with the reason the
 * provider itself gave. Nothing here knows a provider's voice names, which is the point: a list written into
 * this component would be offered to every provider, including the ones that have never heard of it.
 */

export interface DevicesVoiceSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  facts: { nodeId: string; label: string } | undefined;
}

export function DevicesVoiceSettings({ client, prefs, facts }: DevicesVoiceSettingsProps): ReactElement {
  const t = useT();
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | undefined>(undefined);
  /*
   * Asked rather than assumed.
   *
   * The surface reports whatever the seam answers, so wiring a detector later changes this row without changing
   * this component — and today's answer, with its reason, is the seam's rather than a sentence written here.
   */
  const wake = wakeAvailability();

  return (
    <>
      <section className="cc-panel-section">
        <h3>{t("settings.devices.heading")}</h3>
        <DevicePairingPanel
          nodeId={facts?.nodeId ?? t("settings.developer.node.unread")}
          nodeLabel={facts?.label ?? t("settings.developer.node.unread")}
          unblockedBy={t("settings.devices.unblockedBy")}
          t={t}
        />
      </section>

      <section className="cc-panel-section" data-voice-settings="true">
        <h3>{t("settings.devices.voice.heading")}</h3>
        <VoicePicker client={client} prefs={prefs} />
        <InlineStatus status={prefs.status} forKey="voice.voiceName" />

        {/*
          The wake phrase, reported from the seam rather than decided here.

          This build ships with no local detector, and the fallback — streaming ambient audio to a provider so it
          can listen for a phrase — is the one the plan forbids. So the row is disabled with the seam's own
          reason instead of a toggle: a switch that could only turn on a remote listening mode would be a
          privacy decision disguised as a preference.
        */}
        {wake.available ? (
          <SettingsRow label={t("settings.devices.wake.label")} description={t("settings.devices.wake.local")}>
            <span className="cc-badge">{wake.detector?.id ?? t("settings.devices.wake.localBadge")}</span>
          </SettingsRow>
        ) : (
          // wake.reason is worded by wake-word.ts, outside this file's ownership, so the row is marked as
          // node/seam data rather than swept up as UI copy.
          <div data-out-of-scope-i18n="wake-reason">
            <SettingsRow
              label={t("settings.devices.wake.label")}
              /* Spread rather than passing `undefined`: with exactOptionalPropertyTypes an optional prop may be
                 absent, but may not be explicitly undefined. */
              {...(wake.reason === undefined ? {} : { description: wake.reason })}
              state="absent"
            >
              <span className="cc-badge" data-tone="warn" data-wake-unavailable="true">
                {t("settings.devices.wake.unavailableBadge")}
              </span>
            </SettingsRow>
          </div>
        )}

        {/*
          The key the live voice provider needs.

          It lives beside the microphone because that is what it is for: a session that cannot start without it.
          The name it is stored under is the node's own, and it cannot be imported here because the runtime is
          not something the browser ships.
        */}
        <form
          className="cc-credential-form"
          data-settings-key-form="gemini"
          onSubmit={(event) => {
            event.preventDefault();
            const value = keyDraft.trim();
            if (value === "") return;
            client
              .putCredential({ fields: [{ name: "gemini", value }] })
              .then((result) => {
                // Cleared the moment it is sent, so nothing later can read it off the screen or out of state.
                setKeyDraft("");
                setKeyStatus(
                  result.names.includes("gemini")
                    ? t("settings.key.status.saved")
                    : t("settings.key.status.sentNoName"),
                );
              })
              .catch(() =>
                // The message says nothing about what was typed: an error that repeated the value would be the leak
                // this field exists to avoid.
                setKeyStatus(t("settings.key.status.saveFailed")),
              );
          }}
        >
          <label className="cc-credential-field">
            <span>{t("settings.devices.gemini.label")}</span>
            <input
              type="password"
              name="gemini"
              autoComplete="off"
              data-settings-key-field="gemini"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="cc-icon-btn"
            style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
            disabled={keyDraft.trim() === ""}
            data-settings-key-submit="gemini"
          >
            {t("settings.key.save")}
          </button>
          <p className="cc-freshness">{t("settings.devices.gemini.purpose")}</p>
          {keyStatus === undefined ? null : (
            <p className="cc-freshness" data-settings-key-status="gemini">
              {keyStatus}
            </p>
          )}
          <button
            type="button"
            className="cc-chip"
            data-settings-key-remove="gemini"
            onClick={() => {
              client
                .deleteCredential("gemini")
                .then(() => setKeyStatus(t("settings.key.status.signedOut")))
                .catch(() =>
                  // A refusal here usually means there was nothing to remove, which is a different answer from a
                  // failure and is said as one rather than dressed up as an error.
                  setKeyStatus(t("settings.key.status.removeFailed")),
                );
            }}
          >
            {t("settings.key.signOut")}
          </button>
        </form>

        <MicrophoneCheck />
      </section>
    </>
  );
}

/**
 * The voice control, drawn from what the provider says it can do.
 *
 * Three states, and each one is reported rather than smoothed over:
 *
 *   - the node has no voice gateway, so there is nothing to choose from and the row says so;
 *   - the provider cannot select a voice, so there is no selector — a control that changed nothing would
 *     suggest the choice existed;
 *   - the provider offers voices, so the picker is a searchable list, because thirty names is past what a
 *     `<select>` can hold comfortably and typing is how somebody finds one.
 *
 * The preview button follows the provider's own answer for the same reason, and a provider that cannot
 * preview says why in its own words rather than this component inventing a reason.
 */
function VoicePicker({ client, prefs }: { client: GatewayClient; prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .voiceCapabilities()
      .then((answer) => {
        if (!cancelled) setCapabilities(answer.capabilities);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Reported rather than left blank: a node that cannot answer and a node with no voice gateway would
        // otherwise look identical, and only one of them is worth acting on.
        setProblem(cause instanceof Error ? cause.message : t("settings.voice.capabilitiesFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [client, t]);

  if (problem !== undefined) {
    return (
      <p className="cc-panel-note" data-voice-capabilities="error">
        {problem}
      </p>
    );
  }
  if (capabilities === undefined) {
    return <p className="cc-panel-note">{t("settings.common.loading")}</p>;
  }

  const current = prefs.text("voice.voiceName", "");

  return (
    <div data-voice-capabilities={capabilities.provider}>
      <SettingsRow label={t("settings.ai.provider.label")} description={t("settings.voice.provider.description")}>
        <code>{capabilities.provider}</code>
      </SettingsRow>

      {!capabilities.supportsVoiceSelection || capabilities.voices.length === 0 ? (
        // capabilities.note is worded by the provider/node (see apps/runtime/src/test-support/voice-fixture.ts
        // for the fixture case), outside this file's ownership, so it is marked as node data rather than swept
        // up as UI copy whenever the provider actually supplies one.
        <div data-out-of-scope-i18n={capabilities.note === undefined ? undefined : "voice-capability-note"}>
          <SettingsRow
            label={t("settings.voice.select.label")}
            description={capabilities.note ?? t("settings.voice.select.unsupported")}
            state="absent"
          >
            <span className="cc-badge" data-tone="warn">
              {t("settings.voice.select.unsupportedBadge")}
            </span>
          </SettingsRow>
        </div>
      ) : (
        <>
          <label className="cc-credential-field">
            <span>{t("settings.voice.label")}</span>
            <SearchSelect
              name="voice"
              placeholder={t("settings.voice.placeholder")}
              value={current}
              options={capabilities.voices.map((voice) => ({
                value: voice.id,
                label: voice.label,
                ...(voice.locale === undefined ? {} : { note: voice.locale }),
              }))}
              onChange={(next) => prefs.write("voice.voiceName", next)}
              emptyNote={t("settings.voice.noMatches")}
            />
          </label>
          {/* Said plainly, because the registry declares it: a session already speaking does not change voice. */}
          <p className="cc-panel-note" data-voice-applies="true">
            {t("settings.voice.appliesNote")}
          </p>
        </>
      )}

      {/*
        The preview follows the provider's own answer. Disabled with the provider's reason rather than hidden:
        a button that silently does nothing is worse than one that says why it cannot.
      */}
      <div className="cc-panel-row">
        <button
          type="button"
          className="cc-chip"
          data-voice-preview="true"
          disabled={!capabilities.supportsPreview}
          title={capabilities.supportsPreview ? undefined : (capabilities.note ?? t("settings.voice.previewUnsupported"))}
        >
          {t("settings.voice.preview")}
        </button>
        {capabilities.supportsPreview ? null : (
          // Same provider/node-worded note as above; only marked out-of-scope when the provider actually
          // supplied one, since the fallback translated text still belongs to this file's coverage.
          <span
            className="cc-setting-desc"
            data-voice-preview-blocked="true"
            data-out-of-scope-i18n={capabilities.note === undefined ? undefined : "voice-capability-note"}
          >
            {capabilities.note ?? t("settings.voice.previewUnsupported")}
          </span>
        )}
      </div>
    </div>
  );
}
