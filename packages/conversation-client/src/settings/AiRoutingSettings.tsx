import { useEffect, useState, type ReactElement } from "react";

import { SearchSelect } from "../search-select.tsx";
import type { GatewayClient } from "../api.ts";
import { PERSONAL_INSTRUCTIONS_MAX_CHARS, type ModelPool } from "@clarkcant/contracts";
import { InlineStatus, SettingsRow, ToggleSwitch } from "./controls/primitives.tsx";
import { CredentialsSection, type CredentialEntry } from "./controls/credentials-manager-section.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { useT } from "../i18n/locale-context.tsx";

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
  model: { provider: string; id: string; maxWallClockMs: number; maxTokens: number } | null;
}

export interface AiRoutingSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  facts: NodeFacts | undefined;
}

export function AiRoutingSettings({ client, prefs, facts }: AiRoutingSettingsProps): ReactElement {
  const t = useT();
  const [catalogue, setCatalogue] = useState<
    | { id: string; models: { provider: string; id: string; contextWindow?: number; current: boolean }[] }[]
    | undefined
  >(undefined);
  const [providerDraft, setProviderDraft] = useState<string | undefined>(undefined);
  const [modelDraft, setModelDraft] = useState<string | undefined>(undefined);
  const [modelStatus, setModelStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
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
              ? t("settings.ai.model.status.appliesNextSession")
              : t("settings.ai.model.status.appliesNextRestart")),
        ),
      )
      .catch(() => setModelStatus(t("settings.ai.model.status.saveFailed")));
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
              <code>
                {facts.model.maxWallClockMs} ms · {facts.model.maxTokens} token
              </code>
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

      <CredentialsSection client={client} entries={CREDENTIAL_ENTRIES} />

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
      <p className="cc-panel-note">{t("settings.modelPool.intro")}</p>
      {pool.profiles.length === 0 ? (
        <p className="cc-panel-note" data-model-pool="none">
          {t("settings.modelPool.empty")}
        </p>
      ) : (
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
                  <td>{profile.roles.join(", ")}</td>
                  <td>
                    <input
                      type="number"
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
      )}

      <div className="cc-panel-row">
        <button
          type="button"
          className="cc-chip"
          data-model-pool-save="true"
          onClick={() => {
            client
              .putModelPool(pool)
              .then((answer) => setPool(answer.pool))
              .then(() => setStatus(t("settings.modelPool.saved")))
              .catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : t("settings.modelPool.saveFailed")));
          }}
        >
          {t("settings.modelPool.save")}
        </button>
      </div>
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
