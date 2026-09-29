import { useEffect, useState, type ReactElement } from "react";

import { BUILTIN_CLARK_THEME_REF, type AppearanceFallbackCode, type ThemeListingView, type ThemesResponse } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { useT } from "../i18n/locale-context.tsx";
import type { MessageKey } from "../i18n/messages.ts";
import { laneLabel, shortDigest } from "../package-provenance.ts";
import type { AppearanceState } from "../use-appearance.ts";
import { InlineStatus, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

/**
 * Choosing a theme.
 *
 * The list is the node's registry: Clark Default, then every theme an installed package provides. Each one names where
 * it came from — package, version, trust lane and digest — because a theme reaches the whole window, and a person
 * should be able to see which package is painting it.
 *
 * Choosing writes `experience.themeRef` through the preference registry like any other setting, and the page redraws
 * once the node has stored it. When the chosen theme cannot be drawn, the page shows Clark Default and says why, and
 * the choice itself is kept: reinstalling the package brings the theme back without choosing it again.
 */

const FALLBACK_KEYS: Readonly<Record<AppearanceFallbackCode, MessageKey>> = {
  THEME_NOT_INSTALLED: "settings.experience.themePicker.fallback.notInstalled",
  THEME_INVALID: "settings.experience.themePicker.fallback.invalid",
  THEME_LOW_CONTRAST: "settings.experience.themePicker.fallback.lowContrast",
  THEME_UNAVAILABLE: "settings.experience.themePicker.fallback.unavailable",
  THEME_UNKNOWN: "settings.experience.themePicker.fallback.unknown",
};

function providerLine(theme: ThemeListingView, t: (key: MessageKey) => string): string {
  if (theme.provider.kind === "builtin") return t("settings.experience.themePicker.builtIn");
  const { packageId, version, lane, digest } = theme.provider;
  return `${packageId}@${version} · ${laneLabel(lane, t)} · ${shortDigest(digest)}`;
}

export interface ThemeSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  appearance: AppearanceState;
}

export function ThemeSettings({ client, prefs, appearance }: ThemeSettingsProps): ReactElement {
  const t = useT();
  const [listing, setListing] = useState<ThemesResponse | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);

  // Re-read whenever the appearance was re-read: that is when a package may have come or gone.
  useEffect(() => {
    let current = true;
    client.themes().then(
      (next) => {
        if (!current) return;
        setListing(next);
        setUnreachable(false);
      },
      () => {
        if (current) setUnreachable(true);
      },
    );
    return () => {
      current = false;
    };
  }, [client, appearance.generation]);

  const selectedRef = prefs.text("experience.themeRef", BUILTIN_CLARK_THEME_REF);
  const appliedRef = appearance.appearance?.appliedRef;
  const fallback = appearance.appearance?.fallback ?? null;
  const problems = listing?.problems ?? [];
  const unchecked = listing?.unchecked ?? [];

  return (
    <>
      <SettingsRow
        label={t("settings.experience.themePicker.label")}
        description={t("settings.experience.themePicker.description")}
        layout="stacked"
      >
        {listing === undefined ? (
          <p className="cc-panel-note" data-theme-list="loading">
            {unreachable ? t("settings.experience.themePicker.unreachable") : t("settings.experience.themePicker.loading")}
          </p>
        ) : (
          <div className="cc-theme-options" role="group" aria-label={t("settings.experience.themePicker.label")}>
            {listing.themes.map((theme) => (
              <button
                key={theme.themeRef}
                type="button"
                className="cc-theme-option"
                aria-pressed={selectedRef === theme.themeRef}
                data-selected={selectedRef === theme.themeRef}
                data-theme-ref={theme.themeRef}
                data-theme-applied={appliedRef === theme.themeRef}
                disabled={prefs.pending === "experience.themeRef"}
                onClick={() => prefs.write("experience.themeRef", theme.themeRef, () => void appearance.refresh())}
              >
                <span className="cc-theme-option-name">{theme.displayName}</span>
                {theme.description === undefined ? null : (
                  <span className="cc-theme-option-desc">{theme.description}</span>
                )}
                <span className="cc-theme-option-provider" data-theme-provider={theme.provider.kind}>
                  {providerLine(theme, t)}
                </span>
              </button>
            ))}
          </div>
        )}
      </SettingsRow>
      {unreachable && listing !== undefined ? (
        <p className="cc-panel-note" data-theme-list="stale">
          {t("settings.experience.themePicker.unreachable")}
        </p>
      ) : null}

      {fallback === null ? null : (
        <div className="cc-theme-notice" role="status" data-theme-fallback={fallback.code}>
          <p>{t(FALLBACK_KEYS[fallback.code])}</p>
          <details>
            <summary>{t("settings.experience.themePicker.details")}</summary>
            <p className="cc-theme-notice-detail">{fallback.message}</p>
          </details>
        </div>
      )}
      {appearance.localProblem === undefined ? null : (
        <div className="cc-theme-notice" role="status" data-theme-local-problem="true">
          <p>{t("settings.experience.themePicker.localProblem")}</p>
          <p className="cc-theme-notice-detail">{appearance.localProblem}</p>
        </div>
      )}

      {problems.length === 0 && unchecked.length === 0 ? null : (
        <details className="cc-theme-problems" data-theme-problems={problems.length + unchecked.length}>
          <summary>{t("settings.experience.themePicker.problems")}</summary>
          <ul>
            {problems.map((problem) => (
              <li key={`${problem.packageId}@${problem.version}:${problem.message}`} data-theme-problem={problem.themeRef ?? ""}>
                <code>
                  {problem.packageId}@{problem.version}
                </code>{" "}
                {problem.message}
              </li>
            ))}
            {unchecked.map((entry) => (
              <li key={`${entry.packageId}@${entry.version}`} data-theme-unchecked={entry.code}>
                <code>
                  {entry.packageId}@{entry.version}
                </code>{" "}
                {entry.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <InlineStatus status={prefs.status} forKey="experience.themeRef" />
    </>
  );
}
