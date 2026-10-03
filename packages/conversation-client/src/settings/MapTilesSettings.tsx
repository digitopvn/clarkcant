import { useEffect, useId, useState, type FormEvent, type ReactElement } from "react";

import {
  MAP_TILE_POLICY_PREFERENCE,
  MAP_TILE_SECRET_NAME,
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
 * runtime writer Clark's tool uses. The provider's key is the node's own `maps:tiles` secret, entered only here and bound
 * to the origin it was entered for (`PUT /map-tiles/key`); the node sends it nowhere else. It is never read back: the
 * field is a password field that starts empty every time, and the section says only whether a key is saved and which
 * origin it goes to — or "checking" while it does not know yet, and why when it cannot tell.
 */

type Field = "origin" | "template" | "attribution" | "maxZoom" | "credential";

function storedPolicy(prefs: PreferencesHandle): MapTileProvider | null {
  const parsed = mapTilePolicySchema.safeParse(prefs.preference(MAP_TILE_POLICY_PREFERENCE)?.value ?? null);
  return parsed.success ? parsed.data : null;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MapTilesSettings({ client, prefs }: { client: GatewayClient; prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  const id = useId();
  const problemId = `${id}-problem`;
  const policy = storedPolicy(prefs);
  const [view, setView] = useState<MapTilePolicyView | undefined>(undefined);
  const [viewProblem, setViewProblem] = useState<string | undefined>(undefined);
  // `undefined` while the node has not answered; `null` when no key is saved.
  const [savedKey, setSavedKey] = useState<{ origin?: string } | null | undefined>(undefined);
  const [savedKeyProblem, setSavedKeyProblem] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  const [origin, setOrigin] = useState(policy?.origin ?? "");
  const [template, setTemplate] = useState(policy?.template ?? "");
  const [attribution, setAttribution] = useState(policy?.attribution ?? "");
  const [maxZoom, setMaxZoom] = useState(String(policy?.maxZoom ?? 18));
  const [key, setKey] = useState("");
  const [placement, setPlacement] = useState<"header" | "query">(policy?.credential?.query === undefined ? "header" : "query");
  const [keyName, setKeyName] = useState(policy?.credential?.header ?? policy?.credential?.query ?? "");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState<ReadonlySet<Field>>(new Set());
  const [busy, setBusy] = useState(false);

  // The fields follow what the node stored, so a change Clark made shows here too. The key never does.
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
      (cause: unknown) => { if (live) setViewProblem(message(cause)); },
    );
    client.mapTileKey().then(
      (answer) => { if (live) { setSavedKey(answer); setSavedKeyProblem(undefined); } },
      (cause: unknown) => { if (live) setSavedKeyProblem(message(cause)); },
    );
    return () => { live = false; };
  }, [client, generation, storedKey]);

  const refresh = (): void => setGeneration((current) => current + 1);
  const pending = busy || prefs.pending === MAP_TILE_POLICY_PREFERENCE;
  const fail = (text: string, fields: Field[] = []): void => {
    setProblem(text);
    setInvalid(new Set(fields));
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) return;
    setProblem(undefined);
    setInvalid(new Set());
    const sendsKey = key !== "" || policy?.credential !== undefined;
    const name = keyName.trim();
    if (sendsKey && name === "") {
      fail(t("settings.mapTiles.keyNeedsName"), ["credential"]);
      return;
    }
    const next = {
      origin: origin.trim().replace(/\/+$/u, ""),
      template: template.trim(),
      attribution: attribution.trim(),
      maxZoom: Number(maxZoom),
      ...(sendsKey ? { credential: { secret: MAP_TILE_SECRET_NAME, ...(placement === "header" ? { header: name } : { query: name }) } } : {}),
    };
    // Checked here before the key is stored, so a policy the node would refuse never leaves a key behind it.
    const checked = mapTilePolicySchema.safeParse(next);
    if (!checked.success) {
      const issues = checked.error.issues.slice(0, 3);
      fail(
        issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        issues.map((issue) => String(issue.path[0] ?? "")).filter((field): field is Field => ["origin", "template", "attribution", "maxZoom", "credential"].includes(field)),
      );
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
    // The key is bound to the origin it is entered with: the node sends it to that origin and nowhere else.
    client
      .putMapTileKey({ origin: next.origin, value: key })
      .then(() => { setKey(""); write(); }, (cause: unknown) => fail(`${t("settings.mapTiles.keyFailed")} ${message(cause)}`, ["credential"]))
      .finally(() => { setBusy(false); refresh(); });
  };

  const turnOff = (): void => {
    if (pending) return;
    setProblem(undefined);
    prefs.write(MAP_TILE_POLICY_PREFERENCE, null, refresh);
  };

  const removeKey = (): void => {
    setBusy(true);
    client
      .deleteMapTileKey()
      .catch((cause: unknown) => fail(fillMessage(t("settings.mapTiles.forgetKeyFailed"), { detail: message(cause) })))
      .finally(() => { setBusy(false); refresh(); });
  };

  const forgetKey = (): void => {
    if (pending) return;
    setProblem(undefined);
    if (policy?.credential === undefined) {
      removeKey();
      return;
    }
    const { credential: _dropped, ...withoutKey } = policy;
    prefs.write(MAP_TILE_POLICY_PREFERENCE, withoutKey, removeKey);
  };

  const undo = (): void => {
    if (pending) return;
    setProblem(undefined);
    prefs.undo(MAP_TILE_POLICY_PREFERENCE, refresh);
  };

  const state = view === undefined ? undefined : view.provider === null ? "off" : "on";
  const keyState: { kind: string; text: string } = savedKeyProblem !== undefined
    ? { kind: "read-failed", text: fillMessage(t("settings.mapTiles.keyReadFailed"), { detail: savedKeyProblem }) }
    : savedKey === undefined
      ? { kind: "checking", text: t("settings.mapTiles.keyChecking") }
      : policy?.credential !== undefined
        ? savedKey === null
          ? { kind: "unavailable", text: t("settings.mapTiles.keyUnavailable") }
          : savedKey.origin === policy.origin
            ? { kind: "set", text: fillMessage(t("settings.mapTiles.keySet"), { origin: policy.origin }) }
            : { kind: "other-origin", text: fillMessage(t("settings.mapTiles.keyOtherOrigin"), { keyOrigin: savedKey.origin ?? "—", origin: policy.origin }) }
        : savedKey === null
          ? { kind: "none", text: policy === null ? t("settings.mapTiles.keyNoneSaved") : t("settings.mapTiles.keyNone") }
          : { kind: "unused", text: fillMessage(t("settings.mapTiles.keySavedUnused"), { keyOrigin: savedKey.origin ?? "—" }) };
  const described = (field: Field, hint?: string): { "aria-invalid"?: true; "aria-describedby"?: string } => {
    const ids = [hint, invalid.has(field) ? problemId : undefined].filter((entry): entry is string => entry !== undefined);
    return { ...(invalid.has(field) ? { "aria-invalid": true } : {}), ...(ids.length === 0 ? {} : { "aria-describedby": ids.join(" ") }) };
  };
  const canUndo = prefs.preference(MAP_TILE_POLICY_PREFERENCE)?.isDefault === false;

  return (
    <section className="cc-panel-section" data-map-tiles-settings="true" aria-busy={pending}>
      <h3>{t("settings.mapTiles.heading")}</h3>
      <p className="cc-panel-note">{t("settings.mapTiles.intro")}</p>
      <p className="cc-panel-note" role="status" data-map-tiles-state={state ?? "unknown"} data-map-tiles-offline={view?.offline}>
        {viewProblem !== undefined
          ? fillMessage(t("settings.mapTiles.readFailed"), { detail: viewProblem })
          : view === undefined
            ? t("settings.mapTiles.reading")
            : view.provider !== null
              ? fillMessage(t("settings.mapTiles.on"), { origin: view.provider.origin, attribution: view.provider.attribution })
              : view.offline === "key-origin-mismatch"
                ? fillMessage(t("settings.mapTiles.offKeyOrigin"), { origin: policy?.origin ?? "", keyOrigin: savedKey?.origin ?? "—" })
                : view.offline === "key-unavailable"
                  ? fillMessage(t("settings.mapTiles.offKey"), { origin: policy?.origin ?? "" })
                  : t("settings.mapTiles.offNoProvider")}
      </p>
      <p className="cc-panel-note" data-map-tiles-key={keyState.kind} data-map-tiles-key-origin={savedKey?.origin}>
        {keyState.text}
      </p>
      <form onSubmit={save} data-map-tiles-form="true" noValidate style={{ display: "grid", gap: "var(--cc-space-sm)" }}>
        <label className="cc-field" htmlFor={`${id}-origin`}>
          <span className="cc-field-label">{t("settings.mapTiles.origin")}</span>
          <input id={`${id}-origin`} className="cc-field-input" type="url" required maxLength={300} autoComplete="off" spellCheck={false}
            placeholder="https://tiles.example.com" value={origin} onChange={(event) => setOrigin(event.currentTarget.value)}
            {...described("origin", `${id}-origin-hint`)} data-map-tiles-field="origin" />
          <span className="cc-panel-note" id={`${id}-origin-hint`}>{t("settings.mapTiles.originHint")}</span>
        </label>
        <label className="cc-field" htmlFor={`${id}-template`}>
          <span className="cc-field-label">{t("settings.mapTiles.template")}</span>
          <input id={`${id}-template`} className="cc-field-input" type="text" required maxLength={300} autoComplete="off" spellCheck={false}
            placeholder="/tiles/{z}/{x}/{y}.png" value={template} onChange={(event) => setTemplate(event.currentTarget.value)}
            {...described("template", `${id}-template-hint`)} data-map-tiles-field="template" />
          <span className="cc-panel-note" id={`${id}-template-hint`}>{t("settings.mapTiles.templateHint")}</span>
        </label>
        <label className="cc-field" htmlFor={`${id}-attribution`}>
          <span className="cc-field-label">{t("settings.mapTiles.attribution")}</span>
          <input id={`${id}-attribution`} className="cc-field-input" type="text" required maxLength={200} value={attribution}
            onChange={(event) => setAttribution(event.currentTarget.value)} {...described("attribution")} data-map-tiles-field="attribution" />
        </label>
        <label className="cc-field" htmlFor={`${id}-zoom`}>
          <span className="cc-field-label">{t("settings.mapTiles.maxZoom")}</span>
          <input id={`${id}-zoom`} className="cc-field-input" type="number" required min={0} max={19} step={1} value={maxZoom}
            onChange={(event) => setMaxZoom(event.currentTarget.value)} {...described("maxZoom")} data-map-tiles-field="max-zoom" />
        </label>
        <label className="cc-field" htmlFor={`${id}-key`}>
          <span className="cc-field-label">{t("settings.mapTiles.key")}</span>
          {/* Never prefilled: the node does not hand a saved key back, and this field only ever sends a new one. */}
          <input id={`${id}-key`} className="cc-field-input" type="password" autoComplete="new-password" spellCheck={false} value={key}
            onChange={(event) => setKey(event.currentTarget.value)} {...described("credential", `${id}-key-hint`)} data-map-tiles-field="key" />
          <span className="cc-panel-note" id={`${id}-key-hint`}>
            {savedKey === undefined || savedKey === null ? t("settings.mapTiles.keyHint") : t("settings.mapTiles.keyKeep")}
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
              onChange={(event) => setKeyName(event.currentTarget.value)} {...described("credential")} data-map-tiles-field="key-name" />
          </div>
        </fieldset>
        {/*
          `aria-disabled` rather than `disabled` while a write is in flight: a disabled button drops the focus the person
          pressed it with to the page, and each handler refuses a second press itself.
        */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cc-space-sm)", alignItems: "center" }}>
          <button type="submit" className="cc-action" aria-disabled={pending} data-map-tiles-save="true">
            {policy === null ? t("settings.mapTiles.turnOn") : t("settings.mapTiles.update")}
          </button>
          {policy === null ? null : (
            <button type="button" className="cc-action" aria-disabled={pending} onClick={turnOff} data-map-tiles-off="true">
              {t("settings.mapTiles.turnOff")}
            </button>
          )}
          {policy?.credential === undefined && (savedKey === undefined || savedKey === null) ? null : (
            <button type="button" className="cc-action" aria-disabled={pending} onClick={forgetKey} data-map-tiles-forget-key="true">
              {t("settings.mapTiles.forgetKey")}
            </button>
          )}
          {canUndo ? (
            <button type="button" className="cc-action" aria-disabled={pending} onClick={undo} data-map-tiles-undo="true">
              {t("settings.mapTiles.undo")}
            </button>
          ) : null}
          {pending ? <span className="cc-panel-note" data-map-tiles-saving="true">{t("settings.mapTiles.saving")}</span> : null}
        </div>
      </form>
      {problem === undefined ? null : <p className="cc-panel-note" role="alert" id={problemId} data-map-tiles-problem="true">{problem}</p>}
      <InlineStatus status={prefs.status} forKey={MAP_TILE_POLICY_PREFERENCE} />
      <p className="cc-panel-note">{t("settings.mapTiles.askClark")}</p>
    </section>
  );
}
