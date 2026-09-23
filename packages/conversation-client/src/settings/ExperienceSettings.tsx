import { useEffect, useState, type ReactElement } from "react";

import { ORB_MOTION_BOUNDS, ORB_OPTICAL_BOUNDS, ORB_PHYSICS_BOUNDS } from "@clarkcant/contracts";

import { Orb } from "../Orb.tsx";
import { orbFallbackBackground, resolveOrbProfile } from "../orb-profile.ts";
import { THEME_CHOICES, type ThemeChoice } from "../theme.ts";
import type { ThemeName } from "@clarkcant/design-tokens";
import { InlineStatus, RangeField, SegmentedControl, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { useT, useLocaleState } from "../i18n/locale-context.tsx";
import type { MessageKey } from "../i18n/messages.ts";

/**
 * Experience: how the product looks and moves.
 *
 * The first tab, because it is the one whose answer is visible immediately and whose effect is entirely
 * local — no provider, no key, nothing to configure first.
 *
 * Only controls whose behaviour exists are rendered. `experience.density` is declared in the registry for a
 * later phase and deliberately has no control here: a switch that changes nothing is worse than a switch
 * that is missing, because the user concludes the app is broken rather than that the feature is not here.
 */

function themeLabels(t: (key: MessageKey) => string): Record<ThemeChoice, string> {
  return {
    dark: t("settings.experience.theme.dark"),
    light: t("settings.experience.theme.light"),
    system: t("settings.experience.theme.system"),
  };
}

function motionOptions(
  t: (key: MessageKey) => string,
): readonly { value: "system" | "full" | "reduced"; label: string; note: string }[] {
  return [
    { value: "system", label: t("settings.experience.motion.system.label"), note: t("settings.experience.motion.system.note") },
    { value: "full", label: t("settings.experience.motion.full.label"), note: t("settings.experience.motion.full.note") },
    { value: "reduced", label: t("settings.experience.motion.reduced.label"), note: t("settings.experience.motion.reduced.note") },
  ];
}

function orbPresets(
  t: (key: MessageKey) => string,
): readonly { value: "clark" | "calm" | "jelly" | "glass" | "custom"; label: string; note: string }[] {
  return [
    { value: "clark", label: "Clark", note: t("settings.experience.orb.clark.note") },
    { value: "calm", label: "Calm", note: t("settings.experience.orb.calm.note") },
    { value: "jelly", label: "Jelly", note: t("settings.experience.orb.jelly.note") },
    { value: "glass", label: "Glass", note: t("settings.experience.orb.glass.note") },
    { value: "custom", label: "Custom", note: t("settings.experience.orb.custom.note") },
  ];
}

/** The patch's own shape, read defensively: a stored value may predate this control. */
function numbers(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

export interface ExperienceSettingsProps {
  prefs: PreferencesHandle;
  themeChoice: ThemeChoice;
  resolvedTheme: ThemeName;
  onThemeChoice: (choice: ThemeChoice) => void;
  /** Called after a write that changes the orb, so the orb on screen follows the control that changed it. */
  onOrbChange: () => void;
}

export function ExperienceSettings({
  prefs,
  themeChoice,
  resolvedTheme,
  onThemeChoice,
  onOrbChange,
}: ExperienceSettingsProps): ReactElement {
  const t = useT();
  const { locale, setLocale } = useLocaleState();
  const LANGUAGE_OPTIONS = [
    { value: "vi", label: t("settings.language.vi") },
    { value: "en", label: t("settings.language.en") },
  ] as const;

  /*
   * A node the user set language on from another device wins over this screen's own cache, but only
   * once — the moment the registry answers with a value the user explicitly chose. `isDefault` guards
   * this: a node that has never seen this key answers `vi` marked as a default, and applying that
   * would silently override English chosen only on this device (the node cannot see the cache).
   */
  useEffect(() => {
    const stored = prefs.preference("experience.language");
    if (stored === undefined || stored.isDefault) return;
    if (stored.value === locale) return;
    if (stored.value === "vi" || stored.value === "en") setLocale(stored.value);
    // Runs once the registry answers, and again only if the node reports a different value later.
    // `setLocale` and `locale` are intentionally left out: including `setLocale` (stable) would add
    // nothing, and including `locale` would re-run this on the write it just made, chasing its own tail.
  }, [prefs.preferences]);

  const THEME_LABELS = themeLabels(t);
  const MOTION_OPTIONS = motionOptions(t);
  const ORB_PRESETS = orbPresets(t);

  const profileName = prefs.text("orb.profile", "clark");
  const custom = prefs.record("orb.custom") ?? {};
  const customPhysics = numbers(custom.physics);
  const customOptical = numbers(custom.optical);
  const customMotion = numbers(custom.motion);
  const [draftOpen, setDraftOpen] = useState(false);

  /*
   * The preview.
   *
   * Resolved through the same function the running orb uses, from the values the node just confirmed, so what
   * is shown is what will be drawn rather than a second implementation of the same idea. Reduced motion is
   * taken from the stored preference here; the platform's own setting is applied inside the Orb itself.
   */
  const preview = resolveOrbProfile({
    profile: profileName,
    custom,
    reducedMotion: prefs.text("experience.motion", "system") === "reduced",
  });

  /** Write one field of the custom patch, keeping the fields that were not touched. */
  const patchCustom = (group: "physics" | "optical" | "motion", key: string, value: number): void => {
    const next = {
      ...custom,
      [group]: { ...numbers(custom[group]), [key]: value },
    };
    prefs.write("orb.custom", next);
    onOrbChange();
  };

  return (
    <>
      <section className="cc-panel-section">
        <h3>{t("settings.language.heading")}</h3>
        <SettingsRow label={t("settings.language.heading")} description={t("settings.language.description")}>
          <SegmentedControl
            name="language"
            label={t("settings.language.heading")}
            options={LANGUAGE_OPTIONS}
            value={locale}
            pending={prefs.pending === "experience.language"}
            onChange={(value) => {
              // Applies to this screen immediately, independent of the round trip below: a slow or
              // unreachable node must never block the one preference that has to work offline.
              setLocale(value);
              prefs.write("experience.language", value);
            }}
          />
        </SettingsRow>
        <InlineStatus status={prefs.status} forKey="experience.language" />
      </section>

      <section className="cc-panel-section">
        <h3>{t("settings.experience.appearance.heading")}</h3>
        <SettingsRow label={t("settings.experience.theme.label")} description={t("settings.experience.theme.description")}>
          <div className="cc-panel-row">
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className="cc-badge"
                aria-pressed={themeChoice === choice}
                data-selected={themeChoice === choice}
                data-theme-choice={choice}
                onClick={() => onThemeChoice(choice)}
              >
                {THEME_LABELS[choice]}
              </button>
            ))}
          </div>
        </SettingsRow>
        <p className="cc-panel-note" data-resolved-theme={resolvedTheme}>
          {t("settings.experience.theme.showingPrefix")} {THEME_LABELS[resolvedTheme]}
          {themeChoice === "system" ? ` ${t("settings.experience.theme.systemSuffix")}` : ""}
        </p>
        <InlineStatus status={prefs.status} forKey="experience.theme" />
      </section>

      <section className="cc-panel-section">
        <h3>{t("settings.experience.motion.heading")}</h3>
        <SettingsRow
          label={t("settings.experience.motion.label")}
          description={t("settings.experience.motion.description")}
        >
          <SegmentedControl
            name="motion"
            label={t("settings.experience.motion.label")}
            options={MOTION_OPTIONS}
            value={prefs.text("experience.motion", "system")}
            pending={prefs.pending === "experience.motion"}
            onChange={(value) => {
              prefs.write("experience.motion", value);
              onOrbChange();
            }}
          />
        </SettingsRow>
        <InlineStatus status={prefs.status} forKey="experience.motion" />
      </section>

      <section className="cc-panel-section" data-orb-settings="true">
        <h3>{t("settings.experience.orb.heading")}</h3>
        <p className="cc-panel-note">{t("settings.experience.orb.intro")}</p>

        {/*
          One live orb, and the preset list beside it as flat swatches.

          A grid of preset previews would mean a WebGL context per preset, which is a GPU program each for a
          difference the eye reads from the label anyway. The selected preset feeds this one renderer instead.
        */}
        <div className="cc-orb-preview" data-orb-preview="true">
          <div
            className="cc-orb-preview-stage"
            style={
              Object.keys(preview.palette).length === 0
                ? undefined
                : { background: orbFallbackBackground(preview.palette) }
            }
          >
            <Orb
              size={96}
              className="cc-orb-preview-canvas"
              label={`${t("settings.experience.orb.previewLabelPrefix")} ${preview.name}`}
              profile={preview}
              // A small preview does not need a retina buffer: the difference is invisible and the fragments
              // are not free.
              maxPixelRatio={1.5}
            />
          </div>
          <div className="cc-setting-text">
            <span className="cc-setting-label" data-orb-preview-name={preview.name}>
              {ORB_PRESETS.find((preset) => preset.value === preview.name)?.label ?? preview.name}
            </span>
            <span className="cc-setting-desc">
              {preview.reducedMotion ? t("settings.experience.orb.reducedMotion") : t("settings.experience.orb.moving")}
            </span>
          </div>
        </div>

        <SettingsRow
          label={t("settings.experience.orb.style.label")}
          description={t("settings.experience.orb.style.description")}
        >
          <div className="cc-panel-row">
            {ORB_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className="cc-badge"
                aria-pressed={profileName === preset.value}
                data-selected={profileName === preset.value}
                data-orb-preset={preset.value}
                onClick={() => {
                  prefs.write("orb.profile", preset.value);
                  // Opening the advanced controls on the way in, because choosing "custom" without being
                  // offered what to customise is a dead end.
                  if (preset.value === "custom") setDraftOpen(true);
                  onOrbChange();
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <p className="cc-panel-note" data-orb-preset-note="true">
          {ORB_PRESETS.find((preset) => preset.value === profileName)?.note ?? ""}
        </p>
        <InlineStatus status={prefs.status} forKey="orb.profile" />

        <div className="cc-panel-row">
          <button
            type="button"
            className="cc-chip"
            aria-expanded={draftOpen}
            data-orb-advanced="true"
            onClick={() => setDraftOpen((current) => !current)}
          >
            {draftOpen ? t("settings.experience.orb.advanced.hide") : t("settings.experience.orb.advanced.show")}
          </button>
          <button
            type="button"
            className="cc-chip"
            data-orb-reset="true"
            onClick={() => {
              prefs.write("orb.profile", "clark");
              prefs.undo("orb.custom");
              onOrbChange();
            }}
          >
            {t("settings.experience.orb.reset")}
          </button>
        </div>

        {!draftOpen ? null : (
          <div data-orb-advanced-panel="true">
            <p className="cc-panel-note">{t("settings.experience.orb.advanced.intro")}</p>

            <SettingsRow
              label={t("settings.experience.orb.spring.label")}
              description={t("settings.experience.orb.spring.description")}
            >
              <RangeField
                name="stiffness"
                label={t("settings.experience.orb.stiffness.label")}
                value={customPhysics.stiffness ?? ORB_PHYSICS_BOUNDS.stiffness.default}
                min={ORB_PHYSICS_BOUNDS.stiffness.min}
                max={ORB_PHYSICS_BOUNDS.stiffness.max}
                step={1}
                onChange={(value) => patchCustom("physics", "stiffness", value)}
              />
            </SettingsRow>
            <SettingsRow
              label={t("settings.experience.orb.damping.label")}
              description={t("settings.experience.orb.damping.description")}
            >
              <RangeField
                name="damping"
                label={t("settings.experience.orb.damping.label")}
                value={customPhysics.damping ?? ORB_PHYSICS_BOUNDS.damping.default}
                min={ORB_PHYSICS_BOUNDS.damping.min}
                max={ORB_PHYSICS_BOUNDS.damping.max}
                step={0.5}
                onChange={(value) => patchCustom("physics", "damping", value)}
              />
            </SettingsRow>
            <SettingsRow
              label={t("settings.experience.orb.wobble.label")}
              description={t("settings.experience.orb.wobble.description")}
            >
              <RangeField
                name="wobbleGain"
                label={t("settings.experience.orb.wobble.label")}
                value={customPhysics.wobbleGain ?? ORB_PHYSICS_BOUNDS.wobbleGain.default}
                min={ORB_PHYSICS_BOUNDS.wobbleGain.min}
                max={ORB_PHYSICS_BOUNDS.wobbleGain.max}
                step={0.05}
                onChange={(value) => patchCustom("physics", "wobbleGain", value)}
              />
            </SettingsRow>
            <SettingsRow
              label={t("settings.experience.orb.pointer.label")}
              description={t("settings.experience.orb.pointer.description")}
            >
              <RangeField
                name="pointerResponse"
                label={t("settings.experience.orb.pointer.label")}
                value={customPhysics.pointerResponse ?? ORB_PHYSICS_BOUNDS.pointerResponse.default}
                min={ORB_PHYSICS_BOUNDS.pointerResponse.min}
                max={ORB_PHYSICS_BOUNDS.pointerResponse.max}
                step={0.05}
                onChange={(value) => patchCustom("physics", "pointerResponse", value)}
              />
            </SettingsRow>
            <SettingsRow
              label={t("settings.experience.orb.speed.label")}
              description={t("settings.experience.orb.speed.description")}
            >
              <RangeField
                name="speed"
                label={t("settings.experience.orb.speed.label")}
                value={customMotion.speed ?? ORB_MOTION_BOUNDS.speed.default}
                min={ORB_MOTION_BOUNDS.speed.min}
                max={ORB_MOTION_BOUNDS.speed.max}
                step={0.05}
                onChange={(value) => patchCustom("motion", "speed", value)}
              />
            </SettingsRow>
            <SettingsRow
              label={t("settings.experience.orb.exposure.label")}
              description={t("settings.experience.orb.exposure.description")}
            >
              <RangeField
                name="exposure"
                label={t("settings.experience.orb.exposure.label")}
                value={customOptical.exposure ?? ORB_OPTICAL_BOUNDS.exposure.default}
                min={ORB_OPTICAL_BOUNDS.exposure.min}
                max={ORB_OPTICAL_BOUNDS.exposure.max}
                step={0.1}
                onChange={(value) => patchCustom("optical", "exposure", value)}
              />
            </SettingsRow>
            <SettingsRow
              label={t("settings.experience.orb.glow.label")}
              description={t("settings.experience.orb.glow.description")}
            >
              <RangeField
                name="glow"
                label={t("settings.experience.orb.glow.label")}
                value={customOptical.glow ?? ORB_OPTICAL_BOUNDS.glow.default}
                min={ORB_OPTICAL_BOUNDS.glow.min}
                max={ORB_OPTICAL_BOUNDS.glow.max}
                step={0.05}
                onChange={(value) => patchCustom("optical", "glow", value)}
              />
            </SettingsRow>
            <InlineStatus status={prefs.status} forKey="orb.custom" />
          </div>
        )}
      </section>
    </>
  );
}
