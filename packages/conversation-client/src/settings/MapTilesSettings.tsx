import { useEffect, useId, useState, type FormEvent, type ReactElement } from "react";

import {
  MAP_TILE_POLICY_PREFERENCE,
  MAP_TILE_SECRET_CONSUMER,
  type MapTilePolicyView,
  type MapTileProvider,
  mapTilePolicySchema,
} from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { fillMessage } from "../i18n/fill-message.ts";
import { useT } from "../i18n/locale-context.tsx";
import { InlineStatus } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

/**
 * The maps' tile provider, in host-owned Settings.
 *
 * Maps always draw the offline basemap; this turns on raster tiles from one provider the person names, and off again.
 * The policy is the registered preference `maps.tilePolicy`, written through the same person-only route and the same
 * runtime writer Clark's approved card uses. The provider's key is stored as a node secret for `maps:tiles` and never
 * read back: the field is a password field that starts empty every time, and the section says only whether a key is
 * saved and usable.
 */

/** The secret name a key typed here is stored under, unless the policy already names another. */
const DEFAULT_KEY_SECRET = "map_tiles_key";

function storedPolicy(prefs: PreferencesHandle): MapTileProvider | null {
  const parsed = mapTilePolicySchema.safeParse(prefs.preference(MAP_TILE_POLICY_PREFERENCE)?.value ?? null);
  return parsed.success ? parsed.data : null;
}

export function MapTilesSettings({ client, prefs }: { client: GatewayClient; prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  const id = useId();
  const policy = storedPolicy(prefs);
  const [view, setView] = useState<MapTilePolicyView | undefined>(undefined);
  const [viewProblem, setViewProblem] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  const [origin, setOrigin] = useState(policy?.origin ?? "");
  const [template, setTemplate] = useState(policy?.template ?? "");
  const [attribution, setAttribution] = useState(policy?.attribution ?? "");
  const [maxZoom, setMaxZoom] = useState(String(policy?.maxZoom ?? 18));
  const [key, setKey] = useState("");
  const [placement, setPlacement] = useState<"header" | "query">(policy?.credential?.query === undefined ? "header" : "query");
  const [keyName, setKeyName] = useState(policy?.credential?.header ?? policy?.credential?.query ?? "");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // The fields follow what the node stored, so a change Clark made on an approved card shows here too. The key never does.
  const storedKey = JSON.stringify(policy);
  useEffect(() => {
    setOrigin(policy?.origin ?? "");
    setTemplate(policy?.template ?? "");
    setAttribution(policy?.attribution ?? "");
    setMaxZoom(String(policy?.maxZoom ?? 18));
    setPlacement(policy?.credential?.query === undefined ? "header" : "query");
    setKeyName(policy?.credential?.header ?? policy?.credential?.query ?? "");
  }, [storedKey]); // `storedKey` is the policy's identity; the fields are set from the policy it names.

  useEffect(() => {
    let live = true;
    client.mapTilePolicy().then(
      (answer) => { if (live) { setView(answer); setViewProblem(undefined); } },
      (cause: unknown) => { if (live) setViewProblem(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { live = false; };
  }, [client, generation, storedKey]);

  const refresh = (): void => setGeneration((current) => current + 1);
  const pending = busy || prefs.pending === MAP_TILE_POLICY_PREFERENCE;

  const save = (event: FormEvent): void => {
    event.preventDefault();
    setProblem(undefined);
    const secret = policy?.credential?.secret ?? DEFAULT_KEY_SECRET;
    const sendsKey = key !== "" || policy?.credential !== undefined;
    const name = keyName.trim();
    if (sendsKey && name === "") {
      setProblem(t("settings.mapTiles.keyNeedsName"));
      return;
    }
    const next = {
      origin: origin.trim().replace(/\/+$/u, ""),
      template: template.trim(),
      attribution: attribution.trim(),
      maxZoom: Number(maxZoom),
      ...(sendsKey ? { credential: { secret, ...(placement === "header" ? { header: name } : { query: name }) } } : {}),
    };
    // Checked here before the key is stored, so a policy the node would refuse never leaves a key behind it.
    const checked = mapTilePolicySchema.safeParse(next);
    if (!checked.success) {
      setProblem(checked.error.issues.slice(0, 2).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    const write = (): void => {
      prefs.write(MAP_TILE_POLICY_PREFERENCE, checked.data, () => { setKey(""); refresh(); });
    };
    if (key === "") {
      write();
      return;
    }
    setBusy(true);
    client
      .putCredential({
        fields: [{ name: secret, value: key, kind: "api-key", consumer: MAP_TILE_SECRET_CONSUMER, description: `Map tile provider key for ${next.origin}` }],
      })
      .then(() => { setKey(""); write(); }, () => setProblem(t("settings.mapTiles.keyFailed")))
      .finally(() => setBusy(false));
  };

  const turnOff = (): void => {
    setProblem(undefined);
    prefs.write(MAP_TILE_POLICY_PREFERENCE, null, refresh);
  };

  const forgetKey = (): void => {
    if (policy?.credential === undefined) return;
    setProblem(undefined);
    const { credential, ...withoutKey } = policy;
    prefs.write(MAP_TILE_POLICY_PREFERENCE, withoutKey, () => {
      // The value goes too, but only a secret this section created; one Clark asked for under another name stays.
      if (credential.secret === DEFAULT_KEY_SECRET) void client.deleteCredential(credential.secret).catch(() => undefined).finally(refresh);
      else refresh();
    });
  };

  const state = view === undefined ? undefined : view.provider === null ? "off" : "on";
  const keyUsable = view?.offline !== "key-unavailable";
  return (
    <section className="cc-panel-section" data-map-tiles-settings="true">
      <h3>{t("settings.mapTiles.heading")}</h3>
      <p className="cc-panel-note">{t("settings.mapTiles.intro")}</p>
      <p className="cc-panel-note" role="status" data-map-tiles-state={state ?? "unknown"} data-map-tiles-offline={view?.offline}>
        {viewProblem !== undefined
          ? fillMessage(t("settings.mapTiles.readFailed"), { detail: viewProblem })
          : view === undefined
            ? t("settings.mapTiles.reading")
            : view.provider !== null
              ? fillMessage(t("settings.mapTiles.on"), { origin: view.provider.origin, attribution: view.provider.attribution })
              : view.offline === "key-unavailable"
                ? fillMessage(t("settings.mapTiles.offKey"), { origin: policy?.origin ?? "" })
                : t("settings.mapTiles.offNoProvider")}
      </p>
      {policy === null ? null : (
        <p className="cc-panel-note" data-map-tiles-key={policy.credential === undefined ? "none" : keyUsable ? "set" : "unavailable"}>
          {policy.credential === undefined
            ? t("settings.mapTiles.keyNone")
            : keyUsable
              ? t("settings.mapTiles.keySet")
              : t("settings.mapTiles.keyUnavailable")}
        </p>
      )}
      <form onSubmit={save} data-map-tiles-form="true" style={{ display: "grid", gap: "var(--cc-space-sm)" }}>
        <label className="cc-field" htmlFor={`${id}-origin`}>
          <span className="cc-field-label">{t("settings.mapTiles.origin")}</span>
          <input id={`${id}-origin`} className="cc-field-input" type="url" required maxLength={300} autoComplete="off" spellCheck={false}
            placeholder="https://tiles.example.com" value={origin} onChange={(event) => setOrigin(event.currentTarget.value)}
            aria-describedby={`${id}-origin-hint`} data-map-tiles-field="origin" />
          <span className="cc-panel-note" id={`${id}-origin-hint`}>{t("settings.mapTiles.originHint")}</span>
        </label>
        <label className="cc-field" htmlFor={`${id}-template`}>
          <span className="cc-field-label">{t("settings.mapTiles.template")}</span>
          <input id={`${id}-template`} className="cc-field-input" type="text" required maxLength={300} autoComplete="off" spellCheck={false}
            placeholder="/tiles/{z}/{x}/{y}.png" value={template} onChange={(event) => setTemplate(event.currentTarget.value)}
            aria-describedby={`${id}-template-hint`} data-map-tiles-field="template" />
          <span className="cc-panel-note" id={`${id}-template-hint`}>{t("settings.mapTiles.templateHint")}</span>
        </label>
        <label className="cc-field" htmlFor={`${id}-attribution`}>
          <span className="cc-field-label">{t("settings.mapTiles.attribution")}</span>
          <input id={`${id}-attribution`} className="cc-field-input" type="text" required maxLength={200} value={attribution}
            onChange={(event) => setAttribution(event.currentTarget.value)} data-map-tiles-field="attribution" />
        </label>
        <label className="cc-field" htmlFor={`${id}-zoom`}>
          <span className="cc-field-label">{t("settings.mapTiles.maxZoom")}</span>
          <input id={`${id}-zoom`} className="cc-field-input" type="number" required min={0} max={19} step={1} value={maxZoom}
            onChange={(event) => setMaxZoom(event.currentTarget.value)} data-map-tiles-field="max-zoom" />
        </label>
        <label className="cc-field" htmlFor={`${id}-key`}>
          <span className="cc-field-label">{t("settings.mapTiles.key")}</span>
          {/* Never prefilled: the node does not hand a saved key back, and this field only ever sends a new one. */}
          <input id={`${id}-key`} className="cc-field-input" type="password" autoComplete="new-password" spellCheck={false} value={key}
            onChange={(event) => setKey(event.currentTarget.value)} aria-describedby={`${id}-key-hint`} data-map-tiles-field="key" />
          <span className="cc-panel-note" id={`${id}-key-hint`}>
            {policy?.credential === undefined ? t("settings.mapTiles.keyHint") : t("settings.mapTiles.keyKeep")}
          </span>
        </label>
        <fieldset className="cc-field">
          <legend className="cc-field-label">{t("settings.mapTiles.keyPlacement")}</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cc-space-sm)", alignItems: "center" }}>
            <label><input type="radio" name={`${id}-placement`} value="header" checked={placement === "header"}
              onChange={() => setPlacement("header")} data-map-tiles-field="placement-header" /> {t("settings.mapTiles.keyHeader")}</label>
            <label><input type="radio" name={`${id}-placement`} value="query" checked={placement === "query"}
              onChange={() => setPlacement("query")} data-map-tiles-field="placement-query" /> {t("settings.mapTiles.keyQuery")}</label>
            <input className="cc-field-input" type="text" maxLength={64} autoComplete="off" spellCheck={false} value={keyName}
              aria-label={t("settings.mapTiles.keyName")} placeholder={placement === "header" ? "x-api-key" : "key"}
              onChange={(event) => setKeyName(event.currentTarget.value)} data-map-tiles-field="key-name" />
          </div>
        </fieldset>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cc-space-sm)" }}>
          <button type="submit" className="cc-action" disabled={pending} data-map-tiles-save="true">
            {policy === null ? t("settings.mapTiles.turnOn") : t("settings.mapTiles.update")}
          </button>
          {policy === null ? null : (
            <button type="button" className="cc-action" disabled={pending} onClick={turnOff} data-map-tiles-off="true">
              {t("settings.mapTiles.turnOff")}
            </button>
          )}
          {policy?.credential === undefined ? null : (
            <button type="button" className="cc-action" disabled={pending} onClick={forgetKey} data-map-tiles-forget-key="true">
              {t("settings.mapTiles.forgetKey")}
            </button>
          )}
        </div>
      </form>
      {problem === undefined ? null : <p className="cc-panel-note" role="alert" data-map-tiles-problem="true">{problem}</p>}
      <InlineStatus status={prefs.status} forKey={MAP_TILE_POLICY_PREFERENCE} />
      <p className="cc-panel-note">{t("settings.mapTiles.askClark")}</p>
    </section>
  );
}
