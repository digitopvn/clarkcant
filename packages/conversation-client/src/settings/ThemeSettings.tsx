import { useEffect, useState, type ReactElement } from "react";

import {
  BUILTIN_CLARK_THEME_REF,
  type AppearanceFallbackCode,
  type AppearanceFallbackView,
  type ThemeContrastFailureView,
  type ThemeListingView,
  type ThemeProblemView,
  type ThemesResponse,
  type UncheckedThemePackageView,
} from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { useLocale, useT } from "../i18n/locale-context.tsx";
import type { LocaleChoice } from "../i18n/locale.ts";
import type { MessageKey } from "../i18n/messages.ts";
import { laneLabel } from "../package-provenance.ts";
import type { AppearanceState } from "../use-appearance.ts";
import { InlineStatus, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { contrastLines } from "./theme-contrast-lines.ts";

/**
 * Choosing a theme.
 *
 * The list is the node's registry: Clark Default, then every theme an installed package provides. Each entry shows its
 * name, its description and the package's trust lane, because a theme reaches the whole window and a person should be
 * able to tell at a glance what kind of package is painting it. The package id, version and digest are one click away,
 * behind a disclosure on the entry: they identify the exact build, which matters when checking it, not when choosing.
 *
 * Choosing writes `experience.themeRef` through the preference registry like any other setting, and the page redraws
 * once the node has stored it. When the chosen theme cannot be drawn, the page shows Clark Default and says why in the
 * reader's language — from the fallback code and, for colours, from the failing pairs as data, never from the node's
 * English message — and the choice itself is kept: reinstalling the package brings the theme back without choosing it
 * again.
 */

const FALLBACK_KEYS: Readonly<Record<AppearanceFallbackCode, MessageKey>> = {
  THEME_NOT_INSTALLED: "settings.experience.themePicker.fallback.notInstalled",
  THEME_INVALID: "settings.experience.themePicker.fallback.invalid",
  THEME_LOW_CONTRAST: "settings.experience.themePicker.fallback.lowContrast",
  THEME_UNAVAILABLE: "settings.experience.themePicker.fallback.unavailable",
  THEME_UNKNOWN: "settings.experience.themePicker.fallback.unknown",
};

const UNCHECKED_KEYS: Readonly<Record<UncheckedThemePackageView["code"], MessageKey>> = {
  NO_DIRECTORY: "settings.experience.themePicker.unchecked.NO_DIRECTORY",
  NOT_IN_DIRECTORY: "settings.experience.themePicker.unchecked.NOT_IN_DIRECTORY",
  NOT_LOCAL: "settings.experience.themePicker.unchecked.NOT_LOCAL",
  UNREADABLE: "settings.experience.themePicker.unchecked.UNREADABLE",
};

type Translate = (key: MessageKey) => string;

/** The failing pairs, one per line. */
function ContrastList({ contrast, t, locale }: { contrast: readonly ThemeContrastFailureView[]; t: Translate; locale: LocaleChoice }): ReactElement {
  return (
    <ul className="cc-theme-contrast" data-theme-contrast={contrast.length}>
      {contrastLines(contrast, t, locale).map((line, index) => (
        <li key={`${String(index)}:${line}`}>{line}</li>
      ))}
    </ul>
  );
}

/** Why the chosen theme is not drawn, in the reader's words: built from the code, the reference and the pairs. */
function FallbackDetail({ fallback, selectedRef, t, locale }: {
  fallback: AppearanceFallbackView;
  selectedRef: string;
  t: Translate;
  locale: LocaleChoice;
}): ReactElement {
  if (fallback.code === "THEME_LOW_CONTRAST" && fallback.contrast !== undefined && fallback.contrast.length > 0) {
    return (
      <div className="cc-theme-notice-detail">
        <p>{t("settings.experience.themePicker.contrast.lead")}</p>
        <ContrastList contrast={fallback.contrast} t={t} locale={locale} />
      </div>
    );
  }
  const sentence =
    fallback.code === "THEME_NOT_INSTALLED"
      ? t("settings.experience.themePicker.detail.notInstalled").replace("{theme}", selectedRef)
      : fallback.code === "THEME_UNKNOWN"
        ? t("settings.experience.themePicker.detail.unknown").replace("{theme}", selectedRef)
        : t("settings.experience.themePicker.detail.diagnostics");
  return <p className="cc-theme-notice-detail">{sentence}</p>;
}

function ProblemEntry({ problem, t, locale }: { problem: ThemeProblemView; t: Translate; locale: LocaleChoice }): ReactElement {
  return (
    <li data-theme-problem={problem.themeRef ?? ""}>
      <code>
        {problem.packageId}@{problem.version}
      </code>{" "}
      {problem.contrast !== undefined && problem.contrast.length > 0 ? (
        <>
          {t("settings.experience.themePicker.contrast.lead")}
          <ContrastList contrast={problem.contrast} t={t} locale={locale} />
        </>
      ) : (
        // A schema or packaging error names fields and files, which have no translation: it is shown as the technical
        // text it is, marked as English for assistive technology.
        <>
          {t("settings.experience.themePicker.detail.technical")} <span lang="en">{problem.message}</span>
        </>
      )}
    </li>
  );
}

function ThemeOption({ theme, selected, applied, pending, onChoose, t }: {
  theme: ThemeListingView;
  selected: boolean;
  applied: boolean;
  pending: boolean;
  onChoose: () => void;
  t: Translate;
}): ReactElement {
  const provider = theme.provider;
  return (
    <div className="cc-theme-option" data-selected={selected}>
      <button
        type="button"
        className="cc-theme-option-choose"
        aria-pressed={selected}
        data-theme-ref={theme.themeRef}
        data-theme-applied={applied}
        disabled={pending}
        onClick={onChoose}
      >
        <span className="cc-theme-option-name">{theme.displayName}</span>
        {theme.description === undefined ? null : <span className="cc-theme-option-desc">{theme.description}</span>}
        <span className="cc-theme-option-lane" data-theme-provider={provider.kind}>
          {provider.kind === "builtin" ? t("settings.experience.themePicker.builtIn") : laneLabel(provider.lane, t)}
        </span>
      </button>
      {provider.kind === "builtin" ? null : (
        <details className="cc-theme-option-provenance" data-theme-provenance={theme.themeRef}>
          <summary>{t("settings.experience.themePicker.provenance")}</summary>
          <dl className="cc-fields">
            <dt>{t("settings.experience.themePicker.packageLabel")}</dt>
            <dd>
              <code data-theme-package>
                {provider.packageId}@{provider.version}
              </code>
            </dd>
            <dt>{t("widgets.provenance.digestLabel")}</dt>
            <dd>
              <code data-theme-digest>{provider.digest}</code>
            </dd>
          </dl>
        </details>
      )}
    </div>
  );
}

export interface ThemeSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  appearance: AppearanceState;
}

export function ThemeSettings({ client, prefs, appearance }: ThemeSettingsProps): ReactElement {
  const t = useT();
  const locale = useLocale();
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
  const localProblem = appearance.localProblem;
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
              <ThemeOption
                key={theme.themeRef}
                theme={theme}
                selected={selectedRef === theme.themeRef}
                applied={appliedRef === theme.themeRef}
                pending={prefs.pending === "experience.themeRef"}
                onChoose={() => prefs.write("experience.themeRef", theme.themeRef, () => void appearance.refresh())}
                t={t}
              />
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
            <FallbackDetail fallback={fallback} selectedRef={appearance.appearance?.selectedRef ?? selectedRef} t={t} locale={locale} />
          </details>
        </div>
      )}
      {localProblem === undefined ? null : (
        <div className="cc-theme-notice" role="status" data-theme-local-problem="true">
          <p>{t("settings.experience.themePicker.localProblem")}</p>
          {localProblem.contrast !== undefined && localProblem.contrast.length > 0 ? (
            <div className="cc-theme-notice-detail">
              <p>{t("settings.experience.themePicker.contrast.lead")}</p>
              <ContrastList contrast={localProblem.contrast} t={t} locale={locale} />
            </div>
          ) : (
            <details>
              <summary>{t("settings.experience.themePicker.details")}</summary>
              <p className="cc-theme-notice-detail">
                {t("settings.experience.themePicker.detail.technical")} <span lang="en">{localProblem.message}</span>
              </p>
            </details>
          )}
        </div>
      )}

      {problems.length === 0 && unchecked.length === 0 ? null : (
        <details className="cc-theme-problems" data-theme-problems={problems.length + unchecked.length}>
          <summary>{t("settings.experience.themePicker.problems")}</summary>
          <ul>
            {problems.map((problem) => (
              <ProblemEntry key={`${problem.packageId}@${problem.version}:${problem.message}`} problem={problem} t={t} locale={locale} />
            ))}
            {unchecked.map((entry) => (
              <li key={`${entry.packageId}@${entry.version}`} data-theme-unchecked={entry.code}>
                <code>
                  {entry.packageId}@{entry.version}
                </code>{" "}
                {t(UNCHECKED_KEYS[entry.code])}
              </li>
            ))}
          </ul>
        </details>
      )}
      <InlineStatus status={prefs.status} forKey="experience.themeRef" />
    </>
  );
}
