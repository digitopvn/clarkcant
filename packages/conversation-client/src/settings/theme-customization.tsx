import { useEffect, useState, type ReactElement } from "react";

import { compileAppearance } from "@clarkcant/design-tokens";

import { useT } from "../i18n/locale-context.tsx";
import type { AppearanceState } from "../use-appearance.ts";
import { InlineStatus, SegmentedControl, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

const RESET_KEYS = ["experience.accent", "experience.density", "experience.motion", "orb.profile", "orb.custom"] as const;

export function ThemeCustomization({ prefs, appearance, onOrbChange }: {
  prefs: PreferencesHandle; appearance: AppearanceState; onOrbChange: () => void;
}): ReactElement {
  const t = useT();
  const selected = appearance.appearance;
  const own = prefs.record("experience.accent");
  const themeAccent = (scheme: "dark" | "light"): string => compileAppearance(selected?.theme == null
    ? { scheme } : { scheme, theme: selected.theme, themeRef: selected.appliedRef }).tokens.color.accent;
  const [dark, setDark] = useState(() => themeAccent("dark"));
  const [light, setLight] = useState(() => themeAccent("light"));
  useEffect(() => {
    setDark(typeof own?.dark === "string" ? own.dark : themeAccent("dark"));
    setLight(typeof own?.light === "string" ? own.light : themeAccent("light"));
  }, [own?.dark, own?.light, selected?.theme]);
  const refresh = (): void => { void appearance.refresh(); };
  const reset = (index: number): void => {
    const key = RESET_KEYS[index];
    if (key === undefined) { refresh(); onOrbChange(); prefs.reload(); return; }
    prefs.reset(key, () => { refresh(); if (key.startsWith("orb.") || key === "experience.motion") onOrbChange(); reset(index + 1); });
  };
  return <div data-theme-customization>
    <h4>{t("themeLab.customize")}</h4>
    <SettingsRow label={t("themeLab.accent")} layout="stacked" description={t("themeLab.accentNote")}>
      <form className="cc-theme-accent" onSubmit={(event) => {
        event.preventDefault();
        prefs.write("experience.accent", { dark, light }, refresh);
      }}>
        <label>{t("settings.experience.theme.dark")} <input data-accent-scheme="dark" type="text" pattern="#[0-9a-fA-F]{6}"
          maxLength={7} value={dark} onChange={(event) => setDark(event.currentTarget.value)} required /></label>
        <label>{t("settings.experience.theme.light")} <input data-accent-scheme="light" type="text" pattern="#[0-9a-fA-F]{6}"
          maxLength={7} value={light} onChange={(event) => setLight(event.currentTarget.value)} required /></label>
        <button className="cc-btn" type="submit" disabled={prefs.pending !== undefined} data-accent-save>{t("themeLab.saveAccent")}</button>
        <button className="cc-btn" type="button" disabled={prefs.pending !== undefined}
          onClick={() => prefs.reset("experience.accent", refresh)}>{t("themeLab.themeAccent")}</button>
      </form>
    </SettingsRow>
    {prefs.status?.key === "experience.accent" && prefs.status.tone === "error" ? <div className="cc-panel-note" role="status" data-accent-refused>
      <p>{t("themeLab.accentRefused")}</p>
      {prefs.status.status.kind !== "writeFailed" || prefs.status.status.detail === undefined ? null : <details>
        <summary>{t("settings.experience.themePicker.details")}</summary><span lang="en">{prefs.status.status.detail}</span>
      </details>}
    </div> : <InlineStatus status={prefs.status} forKey="experience.accent" />}
    {selected?.customizationFallback === undefined ? null : <p className="cc-theme-notice" role="status" data-accent-fallback>{t("themeLab.accentFallback")}</p>}
    <SettingsRow label={t("themeLab.density")}>
      <SegmentedControl name="density" label={t("themeLab.density")} options={[
        { value: "comfortable", label: t("themeLab.comfortable") }, { value: "compact", label: t("themeLab.compact") },
      ]} value={prefs.text("experience.density", "comfortable")} pending={prefs.pending !== undefined}
        onChange={(value) => prefs.write("experience.density", value, refresh)} />
    </SettingsRow>
    <InlineStatus status={prefs.status} forKey="experience.density" />
    <button type="button" className="cc-btn" disabled={prefs.pending !== undefined} data-theme-customization-reset onClick={() => reset(0)}>{t("themeLab.reset")}</button>
    <p className="cc-panel-note">{t("themeLab.resetNote")}</p>
    {prefs.status?.key === "orb.custom" ? <InlineStatus status={prefs.status} forKey="orb.custom" /> : null}
  </div>;
}
