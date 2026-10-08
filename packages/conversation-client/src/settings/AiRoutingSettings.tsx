import { useEffect, useState, type ReactElement } from "react";

import { SearchSelect } from "../search-select.tsx";
import { fillMessage } from "../i18n/fill-message.ts";
import { GatewayError, type GatewayClient } from "../api.ts";
import { PERSONAL_INSTRUCTIONS_MAX_CHARS, THINKING_LEVELS, type ModelPool, type ModelRole } from "@clarkcant/contracts";
import type { MessageKey } from "../i18n/messages.ts";
import { InlineStatus, SegmentedControl, SettingsRow, ToggleSwitch } from "./controls/primitives.tsx";
import { CredentialsSection, type CredentialEntry } from "./controls/credentials-manager-section.tsx";
import { DecisionProviderSection } from "./controls/decision-provider-section.tsx";
import { ProviderSignInSection } from "./controls/provider-sign-in-section.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { useLocale, useT } from "../i18n/locale-context.tsx";
import { modelSwitchShortcut } from "../use-model-alias.ts";

/** A model's roles in the interface language: the ids are the contract's, and read as English words in a Vietnamese panel. */
const MODEL_ROLE_LABEL: Record<ModelRole, MessageKey> = {
  foreground: "settings.modelPool.role.foreground",
  background: "settings.modelPool.role.background",
  coding: "settings.modelPool.role.coding",
  research: "settings.modelPool.role.research",
  fast: "settings.modelPool.role.fast",
  "long-context": "settings.modelPool.role.long-context",
};

/**
 * Every credential the node holds, listed once. DESIGN.md 11.6 keeps a key's row in the domain that explains
 * it (Gemini for voice, TypeSafe for Jev routing), so this array lives beside the routing tab that already
 * hosted the TypeSafe form, and Devices & Voice now links here instead of embedding its own form (review U5).
 */
const CREDENTIAL_ENTRIES: readonly CredentialEntry[] = [
  { name: "typesafe", labelKey: "settings.credentials.typesafe.label", purposeKey: "settings.credentials.typesafe.purpose" },
  { name: "gemini", labelKey: "settings.credentials.gemini.label", purposeKey: "settings.credentials.gemini.purpose" },
];

/**
 * AI & Routing: what answers, and what it costs to run.
 *
 * The model and the Jev key sit together because they answer one question — what this node runs — and the
 * credential is asked for in the tab that explains what it pays for. Personal instructions are here because
 * they are about how the model is briefed, which is the same subject.
 *
 * Routing preferences (`ai.backgroundRouting`, `ai.modelFavorites`) are declared in the registry but
 * deliberately have **no control here yet**: nothing reads them until the shared app-control registry and the
 * background-routing work land, and a control that changes nothing teaches the user that the settings screen
 * is decorative.
 */

interface NodeFacts {
  model: { provider: string; id: string; maxWallClockMs?: number; maxTokens: number } | null;
}

export interface AiRoutingSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  facts: NodeFacts | undefined;
}

export function AiRoutingSettings({ client, prefs, facts }: AiRoutingSettingsProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  // In the units a person reads a limit in: "2 phút · 32.000 token" rather than "120000 ms · 32000 token".
  const turnCap = (ms: number | undefined, tokens: number): string => {
    const time =
      ms === undefined
        ? t("settings.ai.turnCap.unlimited")
        : ms >= 60_000 && ms % 60_000 === 0
        ? `${String(ms / 60_000)} ${t("settings.ai.turnCap.minutes")}`
        : `${String(Math.round(ms / 1000))} ${t("settings.ai.turnCap.seconds")}`;
    return `${time} · ${tokens.toLocaleString(locale)} token`;
  };
  const [catalogue, setCatalogue] = useState<
    | { id: string; models: { provider: string; id: string; contextWindow?: number; current: boolean }[] }[]
    | undefined
  >(undefined);
  const [providerDraft, setProviderDraft] = useState<string | undefined>(undefined);
  const [modelDraft, setModelDraft] = useState<string | undefined>(undefined);
  const [modelStatus, setModelStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void client
        .model()
        .then((answer) => {
          if (!cancelled) setCatalogue(answer.catalogue);
        })
        .catch(() => {
          // An empty list rather than an error: the question this section answers is what can be chosen, and a
          // failure to read the list is not something the person in front of the panel can act on.
          if (!cancelled) setCatalogue([]);
        });
    };
    read();
    // Signing in to or out of a provider changes what can be chosen, so the catalogue is read again then.
    const stop = client.onModelChange(read);
    return () => {
      cancelled = true;
      stop();
    };
  }, [client]);

  const chosenProvider = providerDraft ?? facts?.model?.provider ?? catalogue?.[0]?.id ?? "";
  const chosenModels = catalogue?.find((provider) => provider.id === chosenProvider)?.models ?? [];

  const saveModelChoice = (): void => {
    const provider = chosenProvider.trim();
    const id = (modelDraft ?? facts?.model?.id ?? "").trim();
    if (provider === "" || id === "") {
      setModelStatus(t("settings.ai.model.status.choose"));
      return;
    }
    if (catalogue !== undefined && catalogue.length > 0 && !chosenModels.some((model) => model.id === id)) {
      // Refused in front of the field it was typed into, rather than by the node after a round trip.
      setModelStatus(`${provider} ${t("settings.ai.model.status.noSuchModel")} ${id}.`);
      return;
    }
    client
      .chooseModel({ provider, id })
      .then((answer) =>
        setModelStatus(
          `${t("settings.ai.model.status.saved")} ${provider}/${id}. ` +
            (answer.applies === "next-session"
              ? t("settings.ai.model.status.appliesNextMessage")
              : t("settings.ai.model.status.appliesNextRestart")),
        ),
      )
      // A refusal the node explains, such as a signed-out provider, is shown in its words; anything else stays generic.
      .catch((error: unknown) =>
        setModelStatus(
          error instanceof GatewayError && error.status === 409
            ? fillMessage(t("settings.ai.model.status.refused"), { reason: error.reason })
            : t("settings.ai.model.status.saveFailed"),
        ),
      );
  };

  return (
    <>
      <section className="cc-panel-section">
        <h3>{t("settings.ai.currentModel.heading")}</h3>
        {facts === undefined ? (
          <p className="cc-panel-note">{t("settings.common.loading")}</p>
        ) : facts.model === null ? (
          // A node with no model is a working node. Saying so is the point.
          <p className="cc-panel-note" data-model="none">
            {t("settings.ai.currentModel.none")}
          </p>
        ) : (
          <>
            <SettingsRow label={t("settings.ai.provider.label")} description={t("settings.ai.provider.description")}>
              <code>{facts.model.provider}</code>
            </SettingsRow>
            <SettingsRow label={t("settings.ai.model.label")} description={t("settings.ai.model.description")}>
              <code>{facts.model.id}</code>
            </SettingsRow>
            <SettingsRow label={t("settings.ai.turnCap.label")} description={t("settings.ai.turnCap.description")}>
              <code>{turnCap(facts.model.maxWallClockMs, facts.model.maxTokens)}</code>
            </SettingsRow>
          </>
        )}
      </section>

      <section className="cc-panel-section" data-providers="true">
        <h3>{t("settings.ai.chooseProvider.heading")}</h3>
        {catalogue === undefined ? (
          <p className="cc-panel-note">{t("settings.common.loading")}</p>
        ) : catalogue.length === 0 ? (
          <p className="cc-panel-note" data-providers="none">
            {t("settings.ai.chooseProvider.none")}
          </p>
        ) : (
          <>
            <label className="cc-credential-field">
              <span>{t("settings.ai.provider.label")}</span>
              <SearchSelect
                name="provider"
                placeholder={t("settings.ai.provider.placeholder")}
                value={chosenProvider}
                options={catalogue.map((provider) => ({
                  value: provider.id,
                  label: provider.id,
                  note: `${provider.models.length} ${t("settings.ai.provider.modelCountSuffix")}`,
                }))}
                onChange={(next) => {
                  setProviderDraft(next);
                  // A different provider is a different catalogue, so a model chosen for the old one is not a
                  // choice any more - keeping it would offer a pair this node cannot run.
                  setModelDraft("");
                }}
                emptyNote={t("settings.ai.provider.noMatches")}
              />
            </label>

            <label className="cc-credential-field">
              <span>{t("settings.ai.model.label")}</span>
              <SearchSelect
                name="model"
                placeholder={t("settings.ai.model.placeholder")}
                value={modelDraft ?? facts?.model?.id ?? ""}
                options={chosenModels.map((model) => ({
                  value: model.id,
                  label: model.id,
                  ...(model.contextWindow === undefined
                    ? {}
                    : { note: `${Math.round(model.contextWindow / 1000)}K` }),
                }))}
                onChange={setModelDraft}
                emptyNote={t("settings.ai.model.noMatches")}
              />
            </label>

            <div className="cc-chip-row">
              <button type="button" className="cc-chip" data-model-save="true" onClick={saveModelChoice}>
                {t("settings.ai.model.save")}
              </button>
            </div>
          </>
        )}
        {modelStatus === undefined ? null : (
          <p className="cc-panel-note" data-model-status="true">
            {modelStatus}
          </p>
        )}
      </section>

      <ProviderSignInSection client={client} />
      {/* The decision role, separate from the conversation model above: who answers Clark's typed decisions. */}
      <DecisionProviderSection client={client} />

      <CredentialsSection client={client} entries={CREDENTIAL_ENTRIES} />

      <ThinkingAndTime prefs={prefs} />

      <PersonalInstructions prefs={prefs} />

      <ModelPoolSection client={client} />
    </>
  );
}

/**
 * The pool of models, as a table.
 *
 * A table rather than a list of cards because the fields are the point: a person comparing profiles compares
 * priority, roles and whether each one is on. Editing is limited to the two fields that decide what a hotkey does
 * — enabled and priority — because the identifiers belong to the provider and are checked against the node's
 * catalogue; a profile added here with a model the node cannot run would be refused by the node anyway, and saying
 * so afterwards is worse than not offering the field.
 */
function ModelPoolSection({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [pool, setPool] = useState<ModelPool | undefined>(undefined);
  const [checked, setChecked] = useState<{ alias: string; ok: boolean; message?: string }[]>([]);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("");
  const shortcut = modelSwitchShortcut(typeof navigator === "undefined" ? undefined : navigator.platform);

  useEffect(() => {
    let live = true;
    client
      .modelPool()
      .then((answer) => {
        if (!live) return;
        setPool(answer.pool);
        setChecked(answer.checked);
        setCurrent(answer.currentAlias);
      })
      .catch(() => {
        if (live) setStatus(t("settings.modelPool.readFailed"));
      });
    return () => {
      live = false;
    };
  }, [client, t]);

  if (pool === undefined) {
    return (
      <section className="cc-panel-section" data-model-pool="none">
        <h3>{t("settings.modelPool.heading")}</h3>
        <p className="cc-panel-note">{status === "" ? t("settings.common.loading") : status}</p>
      </section>
    );
  }

  const edit = (alias: string, patch: { enabled?: boolean; priority?: number }): void => {
    setPool({
      profiles: pool.profiles.map((profile) => (profile.alias === alias ? { ...profile, ...patch } : profile)),
    });
  };

  return (
    <section className="cc-panel-section" data-model-pool="true">
      <h3>{t("settings.modelPool.heading")}</h3>
      <p className="cc-panel-note">{t("settings.modelPool.intro").replace("{shortcut}", shortcut)}</p>
      {pool.profiles.length === 0 ? (
        <p className="cc-panel-note" data-model-pool="none">
          {t("settings.modelPool.empty").replace("{shortcut}", shortcut)}
        </p>
      ) : (
        // Scrolls on its own rather than widening the dialog: five columns do not fit a phone, and a table that
        // pushes the panel sideways takes every other setting with it.
        <div className="cc-table-scroll" role="region" aria-label={t("settings.modelPool.heading")} tabIndex={0}>
          <table className="cc-model-pool" data-model-pool-table="true">
            <thead>
              <tr>
                <th>{t("settings.modelPool.table.alias")}</th>
                <th>{t("settings.modelPool.table.model")}</th>
                <th>{t("settings.modelPool.table.roles")}</th>
                <th>{t("settings.modelPool.table.priority")}</th>
                <th>{t("settings.modelPool.table.enabled")}</th>
              </tr>
            </thead>
            <tbody>
              {pool.profiles.map((profile) => {
                const check = checked.find((entry) => entry.alias === profile.alias);
                return (
                  <tr key={profile.alias} data-model-profile={profile.alias} data-current={current === profile.alias}>
                    <td>
                      {profile.alias}
                      {current === profile.alias && <span className="cc-badge">{t("settings.modelPool.current")}</span>}
                    </td>
                    <td>
                      {profile.provider}/{profile.modelId}
                      {check !== undefined && !check.ok && (
                        <span className="cc-freshness" data-model-unavailable="true">
                          {check.message}
                        </span>
                      )}
                    </td>
                    <td>{profile.roles.map((role) => t(MODEL_ROLE_LABEL[role])).join(", ")}</td>
                    <td>
                      <input
                        type="number"
                        className="cc-model-priority"
                        min={0}
                        value={profile.priority}
                        data-model-priority={profile.alias}
                        onChange={(event) => edit(profile.alias, { priority: Number(event.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={profile.enabled}
                        data-model-enabled={profile.alias}
                        onChange={(event) => edit(profile.alias, { enabled: event.target.checked })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Nothing to save until there is a profile to order: a save button over an empty list only looks like a step. */}
      {pool.profiles.length > 0 && (
        <div className="cc-panel-row">
          <button
            type="button"
            className="cc-chip"
            data-model-pool-save="true"
            onClick={() => {
              client
                .putModelPool(pool)
                .then((answer) => setPool(answer.pool))
                .then(() => setStatus(t("settings.modelPool.saved").replace("{shortcut}", shortcut)))
                .catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : t("settings.modelPool.saveFailed")));
            }}
          >
            {t("settings.modelPool.save")}
          </button>
        </div>
      )}
      {status === "" ? null : <p className="cc-panel-note">{status}</p>}
    </section>
  );
}

/**
 * The user's own instructions, as a section inside the system prompt.
 *
 * Three things this control is careful about, and each is a way the feature could mislead:
 *
 *   - **It says where the text goes.** "Clark will also receive…" rather than "instructions", because a
 *     field labelled only that way invites somebody to think it replaces the product's behaviour. The note
 *     states the precedence: these refine style and defaults, they do not override the rules above them,
 *     and they cannot grant permission.
 *   - **It says when it applies.** From the next turn, which is what `applies: "next-turn"` in the registry
 *     declares, and which is neither "now" nor "after a restart".
 *   - **It reports the size.** The bound is the whole safety story of a text field that becomes prompt text,
 *     so the count is shown before somebody reaches it rather than as a refusal afterwards.
 *
 * The draft is local and only written on blur, so typing does not put a request on the wire per keystroke.
 */
function PersonalInstructions({ prefs }: { prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  const stored = prefs.preference("ai.personalInstructions")?.value;
  const record = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const enabled = record.enabled === true;
  const text = typeof record.text === "string" ? record.text : "";

  /** Local while typing; committed on blur. A write per keystroke would be a request per keystroke. */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown = draft ?? text;
  const overBound = shown.length > PERSONAL_INSTRUCTIONS_MAX_CHARS;

  const commit = (): void => {
    if (draft === undefined || draft === text) return;
    prefs.write("ai.personalInstructions", { enabled, text: draft });
    setDraft(undefined);
  };

  return (
    <section className="cc-panel-section" data-personal-instructions="true">
      <h3>{t("settings.personalInstructions.heading")}</h3>
      <SettingsRow
        label={t("settings.personalInstructions.toggle.label")}
        description={t("settings.personalInstructions.toggle.description")}
      >
        <ToggleSwitch
          name="personal-instructions"
          label={t("settings.personalInstructions.toggle.label")}
          checked={enabled}
          pending={prefs.pending === "ai.personalInstructions"}
          onChange={(next) => prefs.write("ai.personalInstructions", { enabled: next, text })}
        />
      </SettingsRow>

      <label className="cc-credential-field">
        <span>{t("settings.personalInstructions.content.label")}</span>
        <textarea
          className="cc-personal-instructions"
          data-personal-instructions-input="true"
          rows={5}
          spellCheck={false}
          // Disabled rather than hidden while the toggle is off: the text is kept, and a field that
          // disappeared would make it look as though turning the toggle off had discarded it.
          disabled={!enabled}
          value={shown}
          placeholder={t("settings.personalInstructions.content.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      </label>

      <p className="cc-panel-note" data-personal-instructions-count="true" data-over-bound={overBound}>
        {shown.length} / {PERSONAL_INSTRUCTIONS_MAX_CHARS} {t("settings.personalInstructions.count.suffix")}
      </p>

      <p className="cc-panel-note">{t("settings.personalInstructions.note")}</p>

      <div className="cc-panel-row">
        <button
          type="button"
          className="cc-chip"
          data-personal-instructions-reset="true"
          onClick={() => {
            setDraft(undefined);
            // `reset` rather than `undo`: the label promises the default, and this preference may have been
            // edited more than once.
            prefs.reset("ai.personalInstructions");
          }}
        >
          {t("settings.personalInstructions.reset")}
        </button>
      </div>

      <InlineStatus status={prefs.status} forKey="ai.personalInstructions" />
    </section>
  );
}

/**
 * How hard the model thinks, and how long one turn may run.
 *
 * Both are read by the node when the next turn starts, so a change here reaches the next message; `/thinking` in the
 * conversation writes the same preference. No limit is the default: Stop always ends a turn, and a ceiling that fires
 * on ordinary use teaches the person to raise it rather than to trust it.
 */
function ThinkingAndTime({ prefs }: { prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  const thinking = prefs.preference("ai.thinkingLevel")?.value;
  const limit = prefs.preference("ai.turnTimeLimit")?.value;
  return (
    <section className="cc-panel-section" data-thinking-and-time="true">
      <h3>{t("settings.ai.thinking.heading")}</h3>
      <p className="cc-panel-note">{t("settings.ai.thinking.intro")}</p>
      <SettingsRow label={t("settings.ai.thinking.label")}>
        <SegmentedControl
          name="thinking-level"
          label={t("settings.ai.thinking.label")}
          options={[
            { value: "default", label: t("settings.ai.thinking.default") },
            ...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
          ]}
          value={typeof thinking === "string" ? thinking : "default"}
          pending={prefs.pending === "ai.thinkingLevel"}
          onChange={(value) => prefs.write("ai.thinkingLevel", value === "default" ? null : value)}
        />
      </SettingsRow>
      <InlineStatus status={prefs.status} forKey="ai.thinkingLevel" />
      <SettingsRow label={t("settings.ai.turnLimit.label")}>
        <SegmentedControl
          name="turn-time-limit"
          label={t("settings.ai.turnLimit.label")}
          options={[
            { value: "none", label: t("settings.ai.turnLimit.none"), note: t("settings.ai.turnLimit.noneNote") },
            ...[5, 15, 30, 60].map((minutes) => ({
              value: String(minutes),
              label: `${String(minutes)} ${t("settings.ai.turnCap.minutes")}`,
            })),
          ]}
          value={typeof limit === "number" ? String(limit) : "none"}
          pending={prefs.pending === "ai.turnTimeLimit"}
          onChange={(value) => prefs.write("ai.turnTimeLimit", value === "none" ? null : Number(value))}
        />
      </SettingsRow>
      <InlineStatus status={prefs.status} forKey="ai.turnTimeLimit" />
    </section>
  );
}
