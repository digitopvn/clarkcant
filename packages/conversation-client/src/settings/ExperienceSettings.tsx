import { useEffect, useId, useState, type ReactElement } from "react";

import {
  ORB_MOTION_BOUNDS,
  ORB_OPTICAL_BOUNDS,
  ORB_PHYSICS_BOUNDS,
  ORB_PROFILE_LABELS,
  ORB_PROFILE_NAMES,
  type OrbProfileName,
} from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { Orb } from "../Orb.tsx";
import { orbPaletteGradient, resolveOrbProfile } from "../orb-profile.ts";
import { usePlatformReducedMotion } from "../typewriter.ts";
import { THEME_CHOICES, type ThemeChoice } from "../theme.ts";
import type { AppearanceState } from "../use-appearance.ts";
import type { ResolvedColorScheme } from "@clarkcant/contracts";
import { InlineStatus, RangeField, SegmentedControl, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { ThemeSettings } from "./ThemeSettings.tsx";
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

const ORB_PRESET_NOTES: Readonly<Record<OrbProfileName, MessageKey>> = {
  clark: "settings.experience.orb.clark.note",
  calm: "settings.experience.orb.calm.note",
  jelly: "settings.experience.orb.jelly.note",
  glass: "settings.experience.orb.glass.note",
  pearl: "settings.experience.orb.pearl.note",
  plasma: "settings.experience.orb.plasma.note",
  custom: "settings.experience.orb.custom.note",
};

/**
 * Every profile the registry accepts, in its own order, so a preset added to the contract appears here
 * without a second list to keep in step. Labels are the contract's proper names, the same words the agent
 * and the read-back use.
 */
function orbPresets(t: (key: MessageKey) => string): readonly { value: OrbProfileName; label: string; note: string }[] {
  return ORB_PROFILE_NAMES.map((value) => ({ value, label: ORB_PROFILE_LABELS[value], note: t(ORB_PRESET_NOTES[value]) }));
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
  client: GatewayClient;
  prefs: PreferencesHandle;
  /** The theme being drawn, kept by the conversation so it applies whether or not this panel is open. */
  appearance: AppearanceState;
  themeChoice: ThemeChoice;
  resolvedTheme: ResolvedColorScheme;
  onThemeChoice: (choice: ThemeChoice) => void;
  /** Called after a write that changes the orb, so the orb on screen follows the control that changed it. */
  onOrbChange: () => void;
}

export function ExperienceSettings({
  client,
  prefs,
  appearance,
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
  /** Whether the preview is drawn by WebGL, as the orb itself reports it rather than as guessed here. */
  const [previewMode, setPreviewMode] = useState<"gl" | "fallback">("gl");
  /** Followed live, so the preview starts moving again when the platform switch is turned back off. */
  const platformReducedMotion = usePlatformReducedMotion();
  /** Unique per mounted instance, so two copies of this tab never share a description id. */
  const presetNoteId = useId();

  /*
   * The preview.
   *
   * Resolved through the same function the running orb uses, from the values the node just confirmed, so what
   * is shown is what will be drawn rather than a second implementation of the same idea. Reduced motion follows
   * the same rule as the orb in the conversation: the stored preference or the platform's switch, either one.
   */
  const preview = resolveOrbProfile({
    profile: profileName,
    custom,
    reducedMotion: prefs.text("experience.motion", "system") === "reduced" || platformReducedMotion,
  });

  /** Write one field of the custom patch, keeping the fields that were not touched. */
  const patchCustom = (group: "physics" | "optical" | "motion", key: string, value: number): void => {
    const kept = numbers(custom[group]);
    // A size stored before the registry refused one would make every later edit a refused write; the orb
    // already ignores it, so it is dropped here rather than carried forward.
    delete kept.radius;
    const next = {
      ...custom,
      [group]: { ...kept, [key]: value },
    };
    // The orb on screen re-reads once the node has stored the value, not before: a refresh sent with the
    // write would read the value being replaced.
    prefs.write("orb.custom", next, onOrbChange);
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
          <div className="cc-segmented" role="group" aria-label={t("settings.experience.theme.label")}>
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
        <InlineStatus status={prefs.status} forKey="experience.colorScheme" />
        <ThemeSettings client={client} prefs={prefs} appearance={appearance} />
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
            onChange={(value) => prefs.write("experience.motion", value, onOrbChange)}
          />
        </SettingsRow>
        <InlineStatus status={prefs.status} forKey="experience.motion" />
      </section>

      <section className="cc-panel-section" data-orb-settings="true">
        <h3>{t("settings.experience.orb.heading")}</h3>
        <p className="cc-panel-note">{t("settings.experience.orb.intro")}</p>

        {/*
          One live orb, and the preset list below it as flat swatches.

          A grid of preset previews would mean a WebGL context per preset, which is a GPU program each for a
          difference a still swatch already shows. The selected preset feeds this one renderer instead, and each
          swatch is the preset's own palette as a gradient, so it cannot promise colours the orb would not draw.
        */}
        <div className="cc-orb-preview" data-orb-preview="true" data-orb-preview-mode={previewMode}>
          <div className="cc-orb-preview-stage">
            <Orb
              size={96}
              className="cc-orb-preview-canvas"
              label={`${t("settings.experience.orb.previewLabelPrefix")} ${ORB_PROFILE_LABELS[preview.name]}`}
              profile={preview}
              onRenderMode={setPreviewMode}
              // A small preview does not need a retina buffer: the difference is invisible and the fragments
              // are not free.
              maxPixelRatio={1.5}
            />
          </div>
          <div className="cc-setting-text">
            <span className="cc-setting-label" data-orb-preview-name={preview.name}>
              {ORB_PROFILE_LABELS[preview.name]}
            </span>
            <span className="cc-setting-desc" data-orb-preview-motion={preview.reducedMotion ? "reduced" : "full"}>
              {/* A fallback gradient never moves, so saying "animating" over it would report motion that is not there. */}
              {previewMode === "fallback"
                ? t("settings.experience.orb.still")
                : preview.reducedMotion
                  ? t("settings.experience.orb.reducedMotion")
                  : t("settings.experience.orb.moving")}
            </span>
          </div>
        </div>
        {previewMode === "fallback" ? (
          <p className="cc-panel-note" data-orb-fallback-note="true">
            {t("settings.experience.orb.fallback")}
          </p>
        ) : null}

        <SettingsRow
          label={t("settings.experience.orb.style.label")}
          description={t("settings.experience.orb.style.description")}
          layout="stacked"
        >
          {/*
            Each style's description, as the accessible description of its button. `hidden` keeps them off screen
            (the selected one is shown below as text), and a hidden element still supplies a description. The
            title stays for a pointer hovering over a style it has not chosen.
          */}
          <div hidden>
            {ORB_PRESETS.map((preset) => (
              <span key={preset.value} id={`${presetNoteId}-${preset.value}`}>
                {preset.note}
              </span>
            ))}
          </div>
          <div className="cc-orb-presets" role="group" aria-label={t("settings.experience.orb.style.label")}>
            {ORB_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className="cc-orb-preset"
                aria-pressed={profileName === preset.value}
                aria-describedby={`${presetNoteId}-${preset.value}`}
                data-selected={profileName === preset.value}
                data-orb-preset={preset.value}
                title={preset.note}
                onClick={() => {
                  // Opening the advanced controls on the way in, because choosing "custom" without being
                  // offered what to customise is a dead end.
                  if (preset.value === "custom") setDraftOpen(true);
                  prefs.write("orb.profile", preset.value, onOrbChange);
                }}
              >
                <span
                  className="cc-orb-preset-swatch"
                  aria-hidden="true"
                  style={{
                    background: orbPaletteGradient(resolveOrbProfile({ profile: preset.value, custom }).palette),
                  }}
                />
                <span className="cc-orb-preset-label">{preset.label}</span>
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
              prefs.write("orb.profile", "clark", onOrbChange);
              prefs.undo("orb.custom", onOrbChange);
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
