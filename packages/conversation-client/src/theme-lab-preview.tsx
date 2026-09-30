import { useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";

import { type ThemeDocument, type AppearanceCustomization, checkThemeDocument } from "@clarkcant/contracts";
import { appearanceDeclarations, compileAppearance, auditThemeDocument, customizedTheme, CLARK_THEME, themeDrawProblem } from "@clarkcant/design-tokens";
import { CATALOG_ENTRIES } from "@clarkcant/widget-catalog";

import { ApprovalCardBlock, ConnectionCardBlock, TextBlock } from "./blocks.tsx";
import { ConversationComposerBar } from "./ConversationComposerBar.tsx";
import { TranscriptRow } from "./transcript-row.tsx";
import { WidgetPreview } from "./widget-library/WidgetPreview.tsx";
import { Orb } from "./Orb.tsx";
import { resolveOrbProfile } from "./orb-profile.ts";
import { Modal } from "./Modal.tsx";
import { SettingsRow, SegmentedControl, ToggleSwitch } from "./settings/controls/primitives.tsx";
import { useT } from "./i18n/locale-context.tsx";
import { usePlatformReducedMotion } from "./typewriter.ts";

export interface ThemeLabPreviewProps {
  theme: ThemeDocument | null;
  themeRef: string;
  customization?: AppearanceCustomization | undefined;
  /** A failed author reload is shown honestly while the production preview retains its last checked document. */
  problem?: string | undefined;
}

/** Production component specimens with local-only example state; no gateway client or privileged action exists here. */
export function ThemeLabPreview({ theme, themeRef, problem, customization }: ThemeLabPreviewProps): ReactElement {
  const t = useT();
  const [scheme, setScheme] = useState<"dark" | "light">("dark");
  const [viewport, setViewport] = useState<"normal" | "narrow" | "compact">("normal");
  const [chosenReduced, setReduced] = useState(false);
  const platformReduced = usePlatformReducedMotion();
  const reduced = chosenReduced || platformReduced;
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [notice, setNotice] = useState<string>();
  const [modal, setModal] = useState(false);
  const [field, setField] = useState("");
  const composerWrap = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const checked = useMemo(() => theme === null ? undefined : checkThemeDocument(theme), [theme]);
  const refused = checked?.ok === false ? checked.problems.join("; ") : themeDrawProblem(customizedTheme(theme ?? CLARK_THEME, customization))?.message;
  const safeTheme = refused === undefined ? theme : null;
  const snapshot = useMemo(() => compileAppearance(safeTheme === null ? { scheme, reducedMotion: reduced, customization: refused === undefined ? customization : undefined }
    : { scheme, reducedMotion: reduced, theme: safeTheme, themeRef, customization }), [safeTheme, themeRef, scheme, reduced, customization, refused]);
  const declarations = appearanceDeclarations(snapshot);
  const { "color-scheme": colorScheme, ...variables } = declarations;
  const style = { ...variables, colorScheme, width: viewport === "narrow" ? "320px" : viewport === "compact" ? "480px" : "960px", maxWidth: "100%" } as CSSProperties;
  const profile = resolveOrbProfile({ theme: safeTheme?.orb, reducedMotion: reduced });
  const widget = CATALOG_ENTRIES.find((entry) => entry.fixtures.length > 0);
  const fixture = widget?.fixtures[0];
  const submit = (): void => {
    if (draft.trim() === "") return;
    setMessages((kept) => [...kept, draft]);
    setDraft("");
  };
  return <div className="cc-theme-lab" data-theme-lab>
    <p className="cc-panel-note" data-preview-examples>{t("themeLab.examples")}</p>
    {problem === undefined && refused === undefined ? null : <div className="cc-theme-notice" role="status">
      {refused === undefined ? problem : <>{t("themeLab.refused")} <span lang="en">{refused}</span></>}
    </div>}
    <div className="cc-theme-lab-controls">
      <SegmentedControl name="preview-scheme" label={t("themeLab.scheme")} options={[
        { value: "dark", label: t("settings.experience.theme.dark") }, { value: "light", label: t("settings.experience.theme.light") },
      ]} value={scheme} onChange={setScheme} />
      <SegmentedControl name="preview-viewport" label={t("themeLab.viewport")} options={[
        { value: "normal", label: t("themeLab.normal") }, { value: "narrow", label: t("themeLab.narrow") }, { value: "compact", label: t("themeLab.compact") },
      ]} value={viewport} onChange={setViewport} />
      <SettingsRow label={t("themeLab.reduced")}><ToggleSwitch name="preview-reduced" label={t("themeLab.reduced")} checked={reduced} onChange={setReduced} /></SettingsRow>
    </div>
    <div className="cc-theme-lab-canvas" data-theme-preview-canvas data-cc-theme={scheme} data-cc-reduced-motion={reduced ? "true" : "false"}
      data-preview-revision={snapshot.revision} style={style}>
      <Orb size={96} profile={profile} appearanceRevision={snapshot.revision} />
      <h3>{t("themeLab.conversation")}</h3>
      <TranscriptRow role="assistant" index={0} settled={false}><TextBlock block={{ content: t("themeLab.reply") }} /></TranscriptRow>
      {messages.map((text, index) => <TranscriptRow key={index} role="user" index={index} settled={false}><TextBlock block={{ content: text }} /></TranscriptRow>)}
      <ConversationComposerBar composerWrap={composerWrap} composerInput={composerInput} attachmentInput={attachmentInput}
        dragging={false} setDragging={() => setNotice(t("themeLab.localOnly"))} addFiles={async () => setNotice(t("themeLab.localOnly"))}
        chips={[]} onRemoveChip={() => setNotice(t("themeLab.localOnly"))} draft={draft} setDraft={setDraft}
        placeholder={t("themeLab.composer")} busy={false} onSubmit={submit} onStop={() => setNotice(t("themeLab.localOnly"))}
        onOpenVoice={() => setNotice(t("themeLab.localOnly"))} modelAlias={undefined} modelNote="" error={undefined} messages={[]} />
      {notice === undefined ? null : <p role="status">{notice}</p>}
      <section className="cc-panel-section"><h3>{t("themeLab.controls")}</h3>
        <SettingsRow label={t("themeLab.field")}><input className="cc-input" aria-label={t("themeLab.field")} value={field} onChange={(event) => setField(event.target.value)} /></SettingsRow>
        <button type="button" className="cc-btn" onClick={() => setModal(true)}>{t("themeLab.modal")}</button>
        <button type="button" className="cc-btn" disabled>{t("settings.applies.immediate")}</button>
      </section>
      <SettingsRow label={t("themeLab.settings")}><ToggleSwitch name="example-motion" label={t("themeLab.reduced")} checked={reduced} onChange={setReduced} /></SettingsRow>
      {widget === undefined || fixture === undefined ? null : <WidgetPreview entry={widget} fixture={fixture} />}
      <ApprovalCardBlock block={{ owner: "host", operationDescription: t("themeLab.approval"), decision: "preview", effectCategory: "destructive" }} />
      <p className="cc-error" role="status">{t("themeLab.error")}</p>
      <section aria-label={t("themeLab.status")}>
        {(["connected", "unconfigured", "revoked"] as const).map((status) => <ConnectionCardBlock key={status} block={{ owner: "host", provider: t("themeLab.status"), status }} />)}
      </section>
      <Modal open={modal} onClose={() => setModal(false)} title={t("themeLab.settings")} description={t("themeLab.examples")}>
        <SettingsRow label={t("themeLab.field")}><input className="cc-input" aria-label={t("themeLab.field")} value={field} onChange={(event) => setField(event.target.value)} /></SettingsRow>
      </Modal>
    </div>
    <details><summary>{t("themeLab.tokens")}</summary><pre data-preview-tokens>{JSON.stringify(snapshot.tokens, null, 2)}</pre></details>
    <details><summary>{t("themeLab.audit")}</summary><p>{refused ?? t("themeLab.passed")}</p>
      <pre data-preview-audit>{JSON.stringify(auditThemeDocument(customizedTheme(safeTheme ?? CLARK_THEME, refused === undefined ? customization : undefined)), null, 2)}</pre>
    </details>
  </div>;
}
