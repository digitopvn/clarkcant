import { useEffect, useState, type ReactElement } from "react";

import { CLARK_IDENTITY, compileAppearance, fontStack, monoFontStack, resolveIdentity } from "@clarkcant/design-tokens";

import { useT } from "../i18n/locale-context.tsx";
import type { AppearanceState } from "../use-appearance.ts";
import { InlineStatus, SegmentedControl, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

const RESET_KEYS = [
  "experience.accent", "experience.density", "experience.font", "experience.codeFont", "experience.motion", "orb.profile", "orb.custom",
] as const;

type FontOption = { value: string; label: string; stack: string };

/**
 * A choice of typeface, where every option is its own specimen: the sample and the name are set in the face they
 * describe, so the choice is made by looking rather than by knowing font names. The empty value is the theme's own.
 */
function FontPicker({ name, label, sample, options, value, onChange, pending }: {
  name: string; label: string; sample: string; options: readonly FontOption[]; value: string;
  onChange: (value: string) => void; pending: boolean;
}): ReactElement {
  return <div className="cc-font-picker" role="group" aria-label={label} data-font-picker={name} data-pending={pending}>
    {options.map((option) => <button key={option.value} type="button" className="cc-font-option"
      aria-pressed={option.value === value} data-selected={option.value === value} data-font-option={option.value || "theme"}
      style={{ fontFamily: option.stack }} onClick={() => onChange(option.value)}>
      <span className="cc-font-option-sample" aria-hidden="true">{sample}</span>
      <span className="cc-font-option-name">{option.label}</span>
    </button>)}
  </div>;
}

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
  const themeTypography = (selected?.theme == null ? CLARK_IDENTITY : resolveIdentity(selected.theme)).typography;
  // The theme's own face is the absence of a personal one, so choosing it clears the preference rather than storing a copy.
  const choose = (key: "experience.font" | "experience.codeFont", value: string): void => {
    if (value === "") prefs.reset(key, refresh); else prefs.write(key, value, refresh);
  };
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
        <button className="cc-action" type="submit" disabled={prefs.pending !== undefined} data-accent-save>{t("themeLab.saveAccent")}</button>
        <button className="cc-action" type="button" disabled={prefs.pending !== undefined}
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
    <SettingsRow label={t("themeLab.density")} description={t("themeLab.densityNote")}>
      <SegmentedControl name="density" label={t("themeLab.density")} options={[
        { value: "comfortable", label: t("themeLab.comfortable") }, { value: "compact", label: t("themeLab.compact") },
      ]} value={prefs.text("experience.density", "comfortable")} pending={prefs.pending !== undefined}
        onChange={(value) => prefs.write("experience.density", value, refresh)} />
    </SettingsRow>
    <InlineStatus status={prefs.status} forKey="experience.density" />
    <SettingsRow label={t("themeLab.font")} layout="stacked" description={t("themeLab.fontNote")}>
      <FontPicker name="font" label={t("themeLab.font")} sample="Ag" pending={prefs.pending !== undefined}
        value={prefs.text("experience.font", "")} onChange={(value) => choose("experience.font", value)} options={[
          { value: "", label: t("themeLab.fontTheme"), stack: fontStack(themeTypography.body) },
          { value: "clark", label: "Jakarta", stack: fontStack("clark") },
          { value: "inter", label: "Inter", stack: fontStack("inter") },
          { value: "geist", label: "Geist", stack: fontStack("geist") },
          { value: "system", label: t("themeLab.fontSystem"), stack: fontStack("system") },
          { value: "serif", label: t("themeLab.fontSerif"), stack: fontStack("serif") },
          { value: "rounded", label: t("themeLab.fontRounded"), stack: fontStack("rounded") },
        ]} />
    </SettingsRow>
    <InlineStatus status={prefs.status} forKey="experience.font" />
    <SettingsRow label={t("themeLab.codeFont")} layout="stacked" description={t("themeLab.codeFontNote")}>
      <FontPicker name="code-font" label={t("themeLab.codeFont")} sample="{0l}" pending={prefs.pending !== undefined}
        value={prefs.text("experience.codeFont", "")} onChange={(value) => choose("experience.codeFont", value)} options={[
          { value: "", label: t("themeLab.fontTheme"), stack: monoFontStack(themeTypography.mono) },
          { value: "jetbrains", label: "JetBrains", stack: monoFontStack("jetbrains") },
          { value: "geist-mono", label: "Geist Mono", stack: monoFontStack("geist-mono") },
          { value: "clark", label: t("themeLab.fontSystem"), stack: monoFontStack("clark") },
          { value: "typewriter", label: t("themeLab.fontTypewriter"), stack: monoFontStack("typewriter") },
        ]} />
    </SettingsRow>
    <InlineStatus status={prefs.status} forKey="experience.codeFont" />
    <button type="button" className="cc-action" disabled={prefs.pending !== undefined} data-theme-customization-reset onClick={() => reset(0)}>{t("themeLab.reset")}</button>
    <p className="cc-panel-note">{t("themeLab.resetNote")}</p>
    {prefs.status?.key === "orb.custom" ? <InlineStatus status={prefs.status} forKey="orb.custom" /> : null}
  </div>;
}
