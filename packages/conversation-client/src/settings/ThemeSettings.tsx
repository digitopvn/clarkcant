import { useEffect, useRef, useState, type ReactElement } from "react";

import {
  BUILTIN_CLARK_THEME_REF,
  type AppearanceFallbackView,
  type ThemeContrastFailureView,
  type ThemeListingView,
  type ThemeProblemView,
  type ThemeProtectedFailureView,
  type ThemesResponse,
  type UncheckedThemePackageView,
  type AppearanceResponse,
} from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { appearanceFallbackKey } from "../appearance-actions.ts";
import { useLocale, useT } from "../i18n/locale-context.tsx";
import type { LocaleChoice } from "../i18n/locale.ts";
import type { MessageKey } from "../i18n/messages.ts";
import { laneLabel } from "../package-provenance.ts";
import type { AppearanceState } from "../use-appearance.ts";
import { InlineStatus, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import { contrastLines, protectedLines } from "./theme-contrast-lines.ts";
import { Modal } from "../Modal.tsx";
import { ThemeLabPreview } from "../theme-lab-preview.tsx";

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

const UNCHECKED_KEYS: Readonly<Record<UncheckedThemePackageView["code"], MessageKey>> = {
  NO_DIRECTORY: "settings.experience.themePicker.unchecked.NO_DIRECTORY",
  NOT_IN_DIRECTORY: "settings.experience.themePicker.unchecked.NOT_IN_DIRECTORY",
  NOT_LOCAL: "settings.experience.themePicker.unchecked.NOT_LOCAL",
  UNREADABLE: "settings.experience.themePicker.unchecked.UNREADABLE",
};

type Translate = (key: MessageKey) => string;

/** What an audit found, as data: the pairs without enough contrast, and the protected checks a theme fails. */
interface AuditFindings {
  contrast?: readonly ThemeContrastFailureView[] | undefined;
  protected?: readonly ThemeProtectedFailureView[] | undefined;
}

function hasFindings(findings: AuditFindings): boolean {
  return (findings.contrast?.length ?? 0) > 0 || (findings.protected?.length ?? 0) > 0;
}

/** The failing pairs and checks, one per line, each list under its own lead sentence. */
function AuditLists({ findings, t, locale }: { findings: AuditFindings; t: Translate; locale: LocaleChoice }): ReactElement {
  const contrast = findings.contrast ?? [];
  const hidden = findings.protected ?? [];
  return (
    <>
      {contrast.length === 0 ? null : (
        <>
          <p>{t("settings.experience.themePicker.contrast.lead")}</p>
          <ul className="cc-theme-contrast" data-theme-contrast={contrast.length}>
            {contrastLines(contrast, t, locale).map((line, index) => (
              <li key={`${String(index)}:${line}`}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {hidden.length === 0 ? null : (
        <>
          <p>{t("settings.experience.themePicker.protected.lead")}</p>
          <ul className="cc-theme-contrast" data-theme-protected={hidden.length}>
            {protectedLines(hidden, t, locale).map((line, index) => (
              <li key={`${String(index)}:${line}`}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Why the chosen theme is not drawn, in the reader's words: built from the code, the reference and the pairs. */
function FallbackDetail({ fallback, selectedRef, t, locale }: {
  fallback: AppearanceFallbackView;
  selectedRef: string;
  t: Translate;
  locale: LocaleChoice;
}): ReactElement {
  if ((fallback.code === "THEME_LOW_CONTRAST" || fallback.code === "THEME_PROTECTED") && hasFindings(fallback)) {
    return (
      <div className="cc-theme-notice-detail">
        <AuditLists findings={fallback} t={t} locale={locale} />
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
      {hasFindings(problem) ? (
        <AuditLists findings={problem} t={t} locale={locale} />
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
  /**
   * Counts requests to open the list of themes ("mở danh sách chủ đề"). Each new count brings the list into view and
   * puts focus on the theme in use once the list has loaded, so a keyboard or voice user lands on it.
   */
  galleryRequest?: number | undefined;
}

export function ThemeSettings({ client, prefs, appearance, galleryRequest }: ThemeSettingsProps): ReactElement {
  const t = useT();
  const locale = useLocale();
  const [listing, setListing] = useState<ThemesResponse | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);
  const answeredRequest = useRef(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [previewRef, setPreviewRef] = useState<string>(BUILTIN_CLARK_THEME_REF);
  const [preview, setPreview] = useState<AppearanceResponse>();
  const [previewProblem, setPreviewProblem] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const gallery = useRef<HTMLDivElement>(null);
  const galleryFocused = useRef(false);

  useEffect(() => {
    if (!galleryOpen) { galleryFocused.current = false; return; }
    if (listing === undefined || galleryFocused.current) return;
    const chosen = Array.from(gallery.current?.querySelectorAll<HTMLButtonElement>("[data-theme-ref]") ?? [])
      .find((button) => button.dataset.themeRef === previewRef);
    if (chosen === undefined) return;
    chosen.focus();
    galleryFocused.current = true;
  }, [galleryOpen, listing]);

  useEffect(() => {
    if (!galleryOpen) return;
    let current = true;
    setPreviewPending(true);
    setPreviewProblem(false);
    client.appearance(previewRef).then((next) => {
      if (!current) return;
      setPreview(next);
      setPreviewPending(false);
    }, () => {
      if (!current) return;
      setPreviewProblem(true);
      setPreviewPending(false);
    });
    return () => { current = false; };
  }, [client, galleryOpen, previewRef, appearance.generation]);

  useEffect(() => {
    if (galleryRequest === undefined || galleryRequest === answeredRequest.current || listing === undefined) return;
    answeredRequest.current = galleryRequest;
    setPreviewRef(appearance.appearance?.selectedRef ?? BUILTIN_CLARK_THEME_REF);
    setGalleryOpen(true);
  }, [galleryRequest, listing]);

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
  const storedRecent = prefs.preference("experience.recentThemes")?.value;
  const recent = Array.isArray(storedRecent)
    ? storedRecent.flatMap((ref) => {
        const theme = listing?.themes.find((candidate) => candidate.themeRef === ref);
        return theme === undefined ? [] : [theme];
      })
    : [];
  const choose = (ref: string): void => {
    prefs.write("experience.themeRef", ref, () => {
      prefs.reload();
      void appearance.refresh();
    });
  };

  /*
   * The theme changed without this list writing it: a typed or spoken request, or the agent, chose one while Settings
   * was open. Re-read, so the pressed entry is the one the node stored rather than the one the panel opened on.
   */
  const nodeSelected = appearance.appearance?.selectedRef;
  const seenSelected = useRef(nodeSelected);
  useEffect(() => {
    if (seenSelected.current === nodeSelected) return;
    seenSelected.current = nodeSelected;
    if (nodeSelected !== undefined && nodeSelected !== selectedRef) prefs.reload();
    // `prefs.reload` is a fresh closure each render; the node's answer is the trigger.
  }, [nodeSelected]);

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
        ) : galleryOpen ? null : (
          <div
            className="cc-theme-options"
            role="group"
            aria-label={t("settings.experience.themePicker.label")}
            data-theme-gallery
          >
            {listing.themes.map((theme) => (
              <ThemeOption
                key={theme.themeRef}
                theme={theme}
                selected={selectedRef === theme.themeRef}
                applied={appliedRef === theme.themeRef}
                pending={prefs.pending === "experience.themeRef"}
                onChoose={() => choose(theme.themeRef)}
                t={t}
              />
            ))}
          </div>
        )}
      </SettingsRow>
      {galleryOpen || recent.length === 0 ? null : <div className="cc-theme-recent" role="group" aria-label={t("themeLab.recent")} data-theme-recent>
        <span>{t("themeLab.recent")}</span>
        {recent.map((theme) => <button key={theme.themeRef} type="button" className="cc-badge"
          aria-pressed={selectedRef === theme.themeRef} disabled={prefs.pending !== undefined}
          onClick={() => choose(theme.themeRef)}>{theme.displayName}</button>)}
      </div>}
      <button type="button" className="cc-btn" data-theme-browse onClick={() => {
        setPreviewRef(selectedRef);
        setGalleryOpen(true);
      }}>{t("themeLab.browse")}</button>
      <Modal open={galleryOpen} onClose={() => setGalleryOpen(false)} title={t("themeLab.title")}
        width="min(70rem, calc(100vw - var(--cc-space-xl)))">
        <div className="cc-theme-gallery-layout" data-theme-gallery ref={gallery}>
          <div className="cc-theme-options" role="group" aria-label={t("settings.experience.themePicker.label")}>
            {listing?.themes.map((theme) => <ThemeOption key={theme.themeRef} theme={theme}
              selected={previewRef === theme.themeRef} applied={appliedRef === theme.themeRef}
              pending={false} onChoose={() => setPreviewRef(theme.themeRef)} t={t} />)}
          </div>
          {previewPending ? <p role="status">{t("themeLab.loading")}</p> : null}
          {previewProblem ? <p role="status">{t("themeLab.unreachable")}</p> : null}
          {preview === undefined ? null : <ThemeLabPreview theme={preview.theme} themeRef={preview.appliedRef}
            customization={preview.customization} problem={preview.fallback?.message ?? preview.customizationFallback?.message} />}
          <button type="button" className="cc-btn" data-theme-apply
            disabled={previewPending || previewProblem || preview === undefined || preview.selectedRef !== previewRef || preview.fallback !== null || prefs.pending !== undefined}
            onClick={() => choose(previewRef)}>{t("themeLab.apply")}</button>
          <InlineStatus status={prefs.status} forKey="experience.themeRef" />
        </div>
      </Modal>
      {unreachable && listing !== undefined ? (
        <p className="cc-panel-note" data-theme-list="stale">
          {t("settings.experience.themePicker.unreachable")}
        </p>
      ) : null}

      {fallback === null ? null : (
        <div className="cc-theme-notice" role="status" data-theme-fallback={fallback.code}>
          <p>{t(appearanceFallbackKey(fallback.code))}</p>
          <details>
            <summary>{t("settings.experience.themePicker.details")}</summary>
            <FallbackDetail fallback={fallback} selectedRef={appearance.appearance?.selectedRef ?? selectedRef} t={t} locale={locale} />
          </details>
        </div>
      )}
      {localProblem === undefined ? null : (
        <div className="cc-theme-notice" role="status" data-theme-local-problem="true">
          <p>{t("settings.experience.themePicker.localProblem")}</p>
          {hasFindings(localProblem) ? (
            <div className="cc-theme-notice-detail">
              <AuditLists findings={localProblem} t={t} locale={locale} />
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
