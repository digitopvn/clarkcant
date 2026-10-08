import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";

import type { ProviderAuthEntryView } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * The model picker: what `/model` answers with, and what a `/login` card offers once a provider is signed in.
 *
 * Opening it never changes the model. It reads the node's catalogue, the model in use and which providers are signed
 * in; a choice goes to the node through `chooseModel` — the same validated path Settings uses — only after the person
 * confirms it, and what the node answered is said in place. The view is pure so its states can be drawn in a test; the
 * wrapper below owns the reads and the draft.
 */

type T = (key: MessageKey) => string;

export interface ModelRef {
  provider: string;
  id: string;
}

export interface CatalogueModel extends ModelRef {
  contextWindow?: number;
  current: boolean;
  toolCalls?: boolean;
}

/** What the picker reads from the node. `auth` is undefined when the sign-in status could not be read. */
export interface ModelChoices {
  current: ModelRef | null;
  catalogue: { id: string; models: CatalogueModel[] }[];
  auth: ProviderAuthEntryView[] | undefined;
}

/** What a confirmed choice came to, kept by the page beside the picker that made it. */
export type ModelChoiceState =
  | { status: "pending"; model: string }
  | { status: "done"; model: string; applies: "next-session" | "next-start" }
  | { status: "failed"; model: string; message: string };

/**
 * What the picker reads and does, handed in by the surface that draws it: the page's block actions in the conversation,
 * or the same hook (`useModelPickerPort`) wherever else a sign-in offers a model next. Without `readModelChoices` there
 * is nothing to read from, and no picker is drawn.
 */
export interface ModelPickerPort {
  /** The catalogue, the model in use and which providers are signed in, read when the picker is drawn. */
  readModelChoices?: () => Promise<ModelChoices>;
  /** Called with a re-read whenever the model or a sign-in changes; answers the unsubscribe. */
  subscribeModelChange?: (listener: () => void) => () => void;
  /** A confirmed choice, keyed by the picker that made it. A second press while one is on its way does nothing. */
  onModelChoose?: (input: { key: string; provider: string; id: string }) => void;
  /** What each picker's confirmed choice came to, keyed as `onModelChoose` was. */
  modelChoice?: Readonly<Record<string, ModelChoiceState>>;
  /** What the person chose after a sign-in, keyed by where it was signed in: open the picker, or keep the model. */
  afterSignIn?: Readonly<Record<string, "choosing" | "kept">>;
  onAfterSignIn?: (input: { key: string; choice: "choosing" | "kept" }) => void;
}

export type ModelPickerData = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; choices: ModelChoices };

export type ProviderStatus = "signed-in" | "signed-out" | "unknown";

/** The most rows drawn at once: a catalogue can hold hundreds, and typing narrows it. */
export const MODEL_PICKER_LIMIT = 40;

export function modelLabel(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Whether a provider's models can answer: signed in, signed out, or not known. A provider the sign-in list does not name
 * (one with no sign-in of its own) and an unreadable list are both `unknown`, which does not block a choice.
 */
export function providerStatus(auth: readonly ProviderAuthEntryView[] | undefined, providerId: string): ProviderStatus {
  const entry = auth?.find((candidate) => candidate.providerId === providerId);
  if (entry === undefined) return "unknown";
  return entry.configured ? "signed-in" : "signed-out";
}

const STATUS_ORDER: Record<ProviderStatus, number> = { "signed-in": 0, unknown: 1, "signed-out": 2 };

/** The catalogue's providers, the signed-in ones first, otherwise in the node's own order. */
export function orderedProviders(choices: ModelChoices): string[] {
  return choices.catalogue
    .map((entry, index) => ({ id: entry.id, index, rank: STATUS_ORDER[providerStatus(choices.auth, entry.id)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id);
}

/** The models matching every word of the query (case-insensitive, against `provider/id`), in provider order. */
export function filterModels(choices: ModelChoices, filter: { query: string; provider: string }): CatalogueModel[] {
  const words = filter.query.toLowerCase().split(/\s+/u).filter((word) => word !== "");
  const byProvider = new Map(choices.catalogue.map((entry) => [entry.id, entry.models]));
  const providers = filter.provider === "" ? orderedProviders(choices) : [filter.provider];
  return providers.flatMap((provider) =>
    (byProvider.get(provider) ?? []).filter((model) => {
      const haystack = modelLabel(model).toLowerCase();
      return words.every((word) => haystack.includes(word));
    }),
  );
}

export function isOffered(choices: ModelChoices, model: ModelRef): boolean {
  return choices.catalogue.some((entry) => entry.id === model.provider && entry.models.some((candidate) => candidate.id === model.id));
}

/** The model in use, from the node's answer or, where it names none, from the catalogue's own `current` flag. */
export function currentModel(choices: ModelChoices): ModelRef | undefined {
  if (choices.current !== null) return choices.current;
  for (const entry of choices.catalogue) {
    const found = entry.models.find((model) => model.current);
    if (found !== undefined) return { provider: found.provider, id: found.id };
  }
  return undefined;
}

/**
 * What a provider that was just signed in offers. Never assumed from the sign-in: the node's sign-in list has to say it
 * is signed in (`not-yet` until it does) and its catalogue has to hold models for it (`no-models` when it holds none,
 * which is also what a provider the catalogue does not know reads as).
 */
export type AfterSignInReadiness = { status: "not-yet" } | { status: "no-models" } | { status: "ready"; count: number };

export function afterSignInReadiness(choices: ModelChoices, providerId: string): AfterSignInReadiness {
  if (providerStatus(choices.auth, providerId) === "signed-out") return { status: "not-yet" };
  const count = choices.catalogue.find((entry) => entry.id === providerId)?.models.length ?? 0;
  return count === 0 ? { status: "no-models" } : { status: "ready", count };
}

const STATUS_KEY: Record<ProviderStatus, MessageKey> = {
  "signed-in": "modelPicker.status.signedIn",
  "signed-out": "modelPicker.status.signedOut",
  unknown: "modelPicker.status.unknown",
};

const STATUS_TONE: Record<ProviderStatus, string | undefined> = { "signed-in": "ok", "signed-out": "warn", unknown: undefined };

export interface ModelPickerViewProps {
  t: T;
  idPrefix: string;
  data: ModelPickerData;
  query: string;
  provider: string;
  selected: ModelRef | undefined;
  confirming: boolean;
  outcome: ModelChoiceState | undefined;
  onQuery: (query: string) => void;
  onProvider: (provider: string) => void;
  onSelect: (model: ModelRef) => void;
  onChoose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

/** The picker as drawn from what it is given: no reads, no state. */
export function ModelPickerView(props: ModelPickerViewProps): ReactElement {
  const { t, idPrefix, data } = props;
  if (data.status === "loading") {
    return (
      <div className="cc-card-stack cc-model-picker" data-state="loading">
        <p className="cc-list-subtitle" role="status">
          {t("modelPicker.loading")}
        </p>
      </div>
    );
  }
  if (data.status === "failed") {
    return (
      <div className="cc-card-stack cc-model-picker" data-state="failed">
        <div className="cc-form-foot">
          <p className="cc-command-status" role="alert" data-result="failed">
            {fillMessage(t("modelPicker.readFailed"), { reason: data.message })}
          </p>
          <button type="button" className="cc-action" onClick={props.onRetry}>
            {t("modelPicker.retry")}
          </button>
        </div>
      </div>
    );
  }
  const { choices } = data;
  const current = currentModel(choices);
  const total = choices.catalogue.reduce((sum, entry) => sum + entry.models.length, 0);
  const matches = filterModels(choices, { query: props.query, provider: props.provider });
  const shown = matches.slice(0, MODEL_PICKER_LIMIT);
  const pending = props.outcome?.status === "pending";
  const selected = props.selected;
  const stale = selected !== undefined && !isOffered(choices, selected);
  const selectedStatus = selected === undefined ? undefined : providerStatus(choices.auth, selected.provider);
  const isCurrent = selected !== undefined && current !== undefined && modelLabel(selected) === modelLabel(current);
  const blockedReason =
    selected === undefined
      ? undefined
      : stale
        ? fillMessage(t("modelPicker.stale"), { model: modelLabel(selected) })
        : isCurrent
          ? fillMessage(t("modelPicker.alreadyCurrent"), { model: modelLabel(selected) })
          : selectedStatus === "signed-out"
            ? fillMessage(t("modelPicker.signInFirst"), { provider: selected.provider })
            : undefined;
  const canChoose = selected !== undefined && blockedReason === undefined && !pending;
  const searchId = `${idPrefix}-search`;
  const providerId = `${idPrefix}-provider`;
  const statusId = `${idPrefix}-status`;
  return (
    <div className="cc-card-stack cc-model-picker" data-state="ready">
      <p className="cc-list-title" data-model-current={current === undefined ? undefined : modelLabel(current)}>
        {current === undefined ? t("modelPicker.currentNone") : fillMessage(t("modelPicker.current"), { model: modelLabel(current) })}
      </p>
      {choices.auth === undefined ? <p className="cc-list-subtitle">{t("modelPicker.authUnknown")}</p> : null}
      {total === 0 ? (
        <p className="cc-list-subtitle">{t("modelPicker.empty")}</p>
      ) : (
        <>
          <div className="cc-model-picker-filters">
            <label className="cc-model-picker-field" htmlFor={searchId}>
              <span className="cc-list-subtitle">{t("modelPicker.search")}</span>
              <input
                id={searchId}
                className="cc-field-input"
                type="search"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("modelPicker.searchPlaceholder")}
                value={props.query}
                onChange={(event) => props.onQuery(event.target.value)}
              />
            </label>
            <label className="cc-model-picker-field" htmlFor={providerId}>
              <span className="cc-list-subtitle">{t("modelPicker.provider")}</span>
              <select id={providerId} className="cc-field-input" value={props.provider} onChange={(event) => props.onProvider(event.target.value)}>
                <option value="">{t("modelPicker.allProviders")}</option>
                {orderedProviders(choices).map((provider) => (
                  <option key={provider} value={provider}>
                    {provider} · {t(STATUS_KEY[providerStatus(choices.auth, provider)])}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {matches.length === 0 ? (
            <p className="cc-list-subtitle" role="status">
              {fillMessage(t("modelPicker.noMatches"), { query: props.query.trim() === "" ? props.provider : props.query.trim() })}
            </p>
          ) : (
            <fieldset className="cc-model-picker-list">
              <legend className="cc-list-subtitle">{t("modelPicker.models")}</legend>
              <ul className="cc-list">
                {shown.map((model) => {
                  const label = modelLabel(model);
                  const status = providerStatus(choices.auth, model.provider);
                  const inUse = current !== undefined && label === modelLabel(current);
                  const isSelected = selected !== undefined && label === modelLabel(selected);
                  return (
                    <li key={label} className="cc-list-item" data-model={label} data-selected={isSelected ? "true" : undefined} data-current={inUse ? "true" : undefined}>
                      <label className="cc-list-main">
                        <input
                          type="radio"
                          name={`${idPrefix}-model`}
                          value={label}
                          checked={isSelected}
                          disabled={pending}
                          onChange={() => props.onSelect({ provider: model.provider, id: model.id })}
                        />
                        <span className="cc-list-text">
                          <span className="cc-list-title">
                            {model.id}
                            {inUse ? <span className="cc-command-current"> · {t("commandCard.current")}</span> : null}
                          </span>
                          <span className="cc-list-subtitle">
                            {model.provider}
                            {model.contextWindow === undefined ? "" : ` · ${fillMessage(t("modelPicker.context"), { tokens: Math.round(model.contextWindow / 1000) })}`}
                          </span>
                        </span>
                      </label>
                      <span className="cc-badge" data-tone={STATUS_TONE[status]}>
                        {t(STATUS_KEY[status])}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {matches.length > shown.length ? (
                <p className="cc-list-subtitle">{fillMessage(t("modelPicker.more"), { shown: shown.length, total: matches.length })}</p>
              ) : null}
            </fieldset>
          )}
        </>
      )}
      {props.confirming && selected !== undefined && canChoose ? (
        <div className="cc-form-foot" role="group" aria-labelledby={statusId}>
          <p className="cc-list-title" id={statusId}>
            {fillMessage(t("modelPicker.confirmQuestion"), { model: modelLabel(selected) })}
          </p>
          <button type="button" className="cc-action" data-emphasis="primary" autoFocus onClick={props.onConfirm}>
            {t("modelPicker.confirm")}
          </button>
          <button type="button" className="cc-action" onClick={props.onCancel}>
            {t("modelPicker.cancel")}
          </button>
        </div>
      ) : total === 0 ? null : (
        <div className="cc-form-foot">
          <p className="cc-list-subtitle" id={statusId}>
            {blockedReason ?? (selected === undefined ? "" : fillMessage(t("modelPicker.selected"), { model: modelLabel(selected) }))}
          </p>
          <button type="button" className="cc-action" data-emphasis="primary" disabled={!canChoose} aria-describedby={statusId} onClick={props.onChoose}>
            {t("modelPicker.choose")}
          </button>
        </div>
      )}
      <ModelChoiceOutcome t={t} outcome={props.outcome} />
    </div>
  );
}

function ModelChoiceOutcome({ t, outcome }: { t: T; outcome: ModelChoiceState | undefined }): ReactElement | null {
  if (outcome === undefined) return null;
  if (outcome.status === "pending") {
    return (
      <p className="cc-command-status" role="status">
        {t("modelPicker.applying")}
      </p>
    );
  }
  if (outcome.status === "failed") {
    return (
      <p className="cc-command-status" role="alert" data-result="failed">
        {fillMessage(t("modelPicker.applyFailed"), { model: outcome.model, reason: outcome.message })}
      </p>
    );
  }
  return (
    <p className="cc-command-status" role="status" data-result="done">
      {fillMessage(t(outcome.applies === "next-session" ? "modelPicker.appliedNextTurn" : "modelPicker.appliedNextStart"), { model: outcome.model })}
    </p>
  );
}

/**
 * Read what the picker shows, again whenever the model or a sign-in changes. A read that fails is said with a retry;
 * the sign-in list failing alone leaves the catalogue usable and says the status is unknown.
 */
export function useModelChoices(port: ModelPickerPort | undefined): { data: ModelPickerData; reload: () => void } {
  const [data, setData] = useState<ModelPickerData>({ status: "loading" });
  const read = port?.readModelChoices;
  const subscribe = port?.subscribeModelChange;
  const generation = useRef(0);
  const reload = useCallback(() => {
    if (read === undefined) return;
    const mine = ++generation.current;
    void read().then(
      (choices) => {
        if (mine === generation.current) setData({ status: "ready", choices });
      },
      (error: unknown) => {
        if (mine === generation.current) setData({ status: "failed", message: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [read]);
  useEffect(() => {
    reload();
    const stop = subscribe?.(reload);
    return () => {
      generation.current += 1;
      stop?.();
    };
  }, [reload, subscribe]);
  return { data, reload };
}

/** The live picker: the reads, the search and the draft choice, around the pure view. */
export function ModelPicker({
  t,
  pickerKey,
  initialQuery = "",
  initialProvider = "",
  port,
}: {
  t: T;
  pickerKey: string;
  initialQuery?: string;
  initialProvider?: string;
  port: ModelPickerPort | undefined;
}): ReactElement {
  const idPrefix = useId();
  const { data, reload } = useModelChoices(port);
  const [query, setQuery] = useState(initialQuery);
  const [provider, setProvider] = useState(initialProvider);
  const [selected, setSelected] = useState<ModelRef | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const outcome = port?.modelChoice?.[pickerKey];
  // A provider filter for a provider the catalogue no longer holds would hide every row; it falls back to all of them.
  const providerShown = data.status === "ready" && provider !== "" && !data.choices.catalogue.some((entry) => entry.id === provider) ? "" : provider;
  return (
    <ModelPickerView
      t={t}
      idPrefix={idPrefix}
      data={data}
      query={query}
      provider={providerShown}
      selected={selected}
      confirming={confirming}
      outcome={outcome}
      onQuery={setQuery}
      onProvider={setProvider}
      onSelect={(model) => {
        setSelected(model);
        setConfirming(false);
      }}
      onChoose={() => setConfirming(true)}
      onCancel={() => setConfirming(false)}
      onConfirm={() => {
        setConfirming(false);
        if (selected === undefined) return;
        port?.onModelChoose?.({ key: pickerKey, provider: selected.provider, id: selected.id });
      }}
      onRetry={() => {
        reload();
      }}
    />
  );
}

/** How many times a sign-in the node does not list as signed in yet is read again before saying so. */
const AFTER_SIGN_IN_RETRIES = 3;
const AFTER_SIGN_IN_RETRY_MS = 1500;

export type AfterSignInView =
  | { status: "checking" }
  | { status: "failed"; message: string }
  | { status: "not-yet" }
  | { status: "no-models" }
  | { status: "ready"; count: number; current: ModelRef | undefined };

/** The step after a successful sign-in, as drawn: what the provider offers, and the two ways on. Pure. */
export function AfterSignInPanelView({
  t,
  providerName,
  view,
  choice,
  onChoose,
  onKeep,
  onRefresh,
}: {
  t: T;
  providerName: string;
  view: AfterSignInView;
  choice: "choosing" | "kept" | undefined;
  onChoose: () => void;
  onKeep: () => void;
  onRefresh: () => void;
}): ReactElement {
  const named = { provider: providerName };
  if (view.status === "checking") {
    return (
      <p className="cc-list-subtitle" role="status">
        {fillMessage(t("modelPicker.after.checking"), named)}
      </p>
    );
  }
  if (view.status !== "ready") {
    const key: MessageKey = view.status === "failed" ? "modelPicker.after.failed" : view.status === "not-yet" ? "modelPicker.after.notYet" : "modelPicker.after.noModels";
    return (
      <div className="cc-form-foot" data-after-sign-in={view.status}>
        <p className="cc-list-subtitle" role="status">
          {fillMessage(t(key), { ...named, reason: view.status === "failed" ? view.message : "" })}
        </p>
        <button type="button" className="cc-action" onClick={onRefresh}>
          {t("modelPicker.after.refresh")}
        </button>
      </div>
    );
  }
  return (
    <div className="cc-card-stack" data-after-sign-in="ready">
      {choice === "kept" ? (
        <p className="cc-command-status" role="status" data-result="done">
          {view.current === undefined ? t("modelPicker.after.keptNone") : fillMessage(t("modelPicker.after.kept"), { model: modelLabel(view.current) })}
        </p>
      ) : (
        <p className="cc-list-subtitle">{fillMessage(t("modelPicker.after.ready"), { ...named, count: view.count })}</p>
      )}
      {choice === "choosing" ? null : (
        <div className="cc-command-actions">
          <button type="button" className="cc-action" data-emphasis="primary" onClick={onChoose}>
            {fillMessage(t("modelPicker.after.choose"), named)}
          </button>
          {choice === "kept" ? null : (
            <button type="button" className="cc-action" onClick={onKeep}>
              {t("modelPicker.after.keep")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * After a provider signs in on a `/login` card: re-read the sign-in list and the catalogue rather than assume the
 * sign-in made models available, then offer the picker for that provider in the same card, or keeping the model in use.
 * Nothing here changes the model; only the picker's own confirmed choice does.
 */
export function AfterSignIn({
  t,
  signInKey,
  providerId,
  providerName,
  port,
}: {
  t: T;
  signInKey: string;
  providerId: string;
  providerName: string;
  port: ModelPickerPort | undefined;
}): ReactElement | null {
  const { data, reload } = useModelChoices(port);
  const [retries, setRetries] = useState(0);
  const readiness = data.status === "ready" ? afterSignInReadiness(data.choices, providerId) : undefined;
  // The node can take a moment to list a fresh sign-in; read again a few times before saying it is not there yet.
  const waiting = readiness?.status === "not-yet" && retries < AFTER_SIGN_IN_RETRIES;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setRetries((count) => count + 1);
      reload();
    }, AFTER_SIGN_IN_RETRY_MS);
    return () => clearTimeout(timer);
  }, [waiting, reload, data]);
  if (port?.readModelChoices === undefined) return null;
  const view: AfterSignInView =
    data.status === "loading" || waiting
      ? { status: "checking" }
      : data.status === "failed"
        ? { status: "failed", message: data.message }
        : readiness === undefined || readiness.status !== "ready"
          ? { status: readiness?.status ?? "no-models" }
          : { status: "ready", count: readiness.count, current: currentModel(data.choices) };
  const choice = port.afterSignIn?.[signInKey];
  return (
    <div className="cc-card-stack cc-after-sign-in">
      <AfterSignInPanelView
        t={t}
        providerName={providerName}
        view={view}
        choice={choice}
        onChoose={() => port.onAfterSignIn?.({ key: signInKey, choice: "choosing" })}
        onKeep={() => port.onAfterSignIn?.({ key: signInKey, choice: "kept" })}
        onRefresh={() => {
          setRetries(0);
          reload();
        }}
      />
      {view.status === "ready" && choice === "choosing" ? <ModelPicker t={t} pickerKey={`${signInKey}/model`} initialProvider={providerId} port={port} /> : null}
    </div>
  );
}
