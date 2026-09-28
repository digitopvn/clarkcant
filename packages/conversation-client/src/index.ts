/**
 * @clarkcant/conversation-client
 *
 * The shared conversation surface. Rendered by both the web client and the desktop shell,
 * and dependent on nothing from Node so the same components run in either.
 *
 * The package also owns the stylesheet, so the two hosts cannot drift into looking like
 * two different products. Colours and durations come from `@clarkcant/design-tokens`,
 * whose palette the test suite audits for WCAG AA in both themes.
 */

import { themeStylesheet } from "@clarkcant/design-tokens";

import { APP_CSS } from "./styles.ts";

export { APP_CSS } from "./styles.ts";
export { DetachedWidgetSurface, type DetachedBridge } from "./DetachedWidgetSurface.tsx";
export { WidgetFrame, type WidgetFrameProps } from "./WidgetFrame.tsx";
export {
  MiniAppSurface,
  unavailableSections,
  type CompositeSurfaceAction,
  type CompositeSurfaceSection,
  type CompositeSurfaceView,
  type MiniAppSurfaceProps,
  type RegionAvailability,
  type SurfaceIntent,
} from "./mini-app-surface.tsx";
export {
  CATALOG,
  RENDERER_IDS,
  resolveRenderer,
  toRendererDataset,
  type CatalogRenderer,
  type RendererDataset,
  type RendererProps,
} from "./renderers.tsx";
export {
  rendererDataset,
  WidgetPreview,
  type WidgetPreviewProps,
} from "./widget-library/WidgetPreview.tsx";
export type {
  CalendarEventView,
  CompositionResponse,
  ImageView,
} from "./api.ts";
export {
  ApprovalCardBlock,
  ArtifactBlock,
  CodeDiffCardBlock,
  ConnectionCardBlock,
  CredentialCardBlock,
  EvidenceBlock,
  HOST_OWNED_BLOCK_TYPES,
  ProjectPickerCardBlock,
  QuestionCardBlock,
  FormCardBlock,
  ControlSessionCardBlock,
  ReconnectCardBlock,
  SystemCardBlock,
  TaskOverviewCardBlock,
  TaskProgressCardBlock,
  TaskSummaryCardBlock,
  TextBlock,
  renderBlock,
} from "./blocks.tsx";
export { TerminalCardBlock } from "./terminal-card.tsx";
export { Conversation, type ConversationProps } from "./Conversation.tsx";
export { desktopBridge, requestWindowMode, sessionFromBridge } from "./desktop-compact.ts";
export { DesktopChrome } from "./desktop-chrome.tsx";
export { DotGrid } from "./dot-grid.tsx";
export type {
  SessionHandover,
  WindowBounds,
  WindowMode,
  WindowModeAction,
  WindowModeAnswer,
} from "./desktop-compact.ts";
export {
  SettingsPanel,
  type SettingsPanelProps,
  SettingsRow,
  type SettingsRowProps,
  ToolRow,
  type ToolRowProps,
} from "./settings/SettingsPanel.tsx";
export { TokenSpecimens, readVar } from "./TokenSpecimens.tsx";
export { Modal, type ModalProps } from "./Modal.tsx";
export { VoiceUnavailable } from "./voice-unavailable.tsx";
export { VoiceOverlay, waveformBars, WAVEFORM_BARS, type VoiceOverlayProps } from "./VoiceOverlay.tsx";
export {
  type StartVoiceSessionOptions,
  type VoiceSession,
  type VoiceSessionEvents,
  type VoiceTranscriptUpdate,
  startVoiceSession,
  toPcm16,
  voiceSocketUrl,
} from "./voice-session.ts";
export { DevicePairingPanel, type DevicePairingPanelProps } from "./DevicePairingPanel.tsx";
export {
  DesktopNotification,
  MenuBarPopover,
  type DesktopNotificationProps,
  type MenuBarPopoverProps,
} from "./DesktopSurfaces.tsx";
export { Orb, type OrbProps } from "./Orb.tsx";
export {
  DEFAULT_ORB_PROFILE,
  orbFallbackBackground,
  resolveOrbProfile,
  type OrbOptical,
  type OrbPaletteOverride,
  type OrbPhysics,
  type ResolvedOrbProfile,
} from "./orb-profile.ts";
export {
  AGENT_STATES,
  INPUT_MODALITIES,
  agentStateAttribute,
  agentStateFrom,
  attachInputModality,
  isAgentState,
  modalityFor,
  type AgentState,
  type InputModality,
  type InputModalityHandle,
  type InputSignal,
} from "./input-modality.ts";
export { prefersReducedMotion } from "./typewriter.ts";
export {
  WAKE_STATUSES,
  WAKE_UNAVAILABLE_REASON,
  agentStateForWake,
  createFixtureWakeDetector,
  wakeAvailability,
  type WakeAvailability,
  type WakeStatus,
  type WakeWordDetector,
} from "./wake-word.ts";
export { useOrbProfile, type OrbProfileHandle } from "./use-orb-profile.ts";
export { usePreferences, type PreferencesHandle, type PreferenceStatus } from "./settings/controls/use-preferences.ts";
export {
  InlineStatus,
  RangeField,
  SegmentedControl,
  ToggleSwitch,
  type InlineStatusProps,
  type RangeFieldProps,
  type SegmentedControlProps,
  type SegmentedOption,
  type ToggleSwitchProps,
} from "./settings/controls/primitives.tsx";
// Re-exported so a host can type the preference it reads without depending on the contracts package for one
// shape it only passes through.
export type { RegisteredPreference } from "@clarkcant/contracts";
export { ORB_DRAW_SIZE, ORB_RADIUS } from "./use-hero-orb-layout.ts";
export { createOrbRenderer, type OrbOptions, type OrbRenderer } from "./orb.ts";
export { ORB_PALETTE, ORB_SHAPE, ORB_SHADER_STATUS } from "./orb-shader.ts";
export {
  GatewayClient,
  GatewayError,
  type GatewayClientOptions,
  type ResolvedDataset,
  type Timeline,
  type TimelineInstance,
  type TimelineMessage,
} from "./api.ts";

let installed = false;

/**
 * Install the token variables and component stylesheet once.
 *
 * Idempotent because both the web client and the desktop shell may mount more than one
 * surface, and injecting the sheet twice would make every override fight itself.
 */
export {
  DEFAULT_THEME_CHOICE,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  type ThemeChoice,
  isThemeChoice,
  readDocumentTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersLight,
} from "./theme.ts";

export function installStyles(theme: "dark" | "light" = "dark"): void {
  if (typeof document === "undefined") return;
  if (!installed) {
    const css = `${themeStylesheet()}\n${APP_CSS}`;
    /*
     * A constructed sheet rather than a `<style>` element: the desktop shell's policy has no `'unsafe-inline'` in
     * `style-src`, which blocks a script-made `<style>` and left the window with no stylesheet at all. `style-src`
     * does not govern an adopted sheet, so the same policy stands and the styles still apply. The element stays
     * as the fallback for an engine without constructable sheets.
     */
    if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } else {
      const style = document.createElement("style");
      style.dataset.clarkcant = "styles";
      style.textContent = css;
      document.head.append(style);
    }
    installed = true;
  }
  document.documentElement.dataset.ccTheme = theme;
}
export { firstRunSteps, type FirstRunStep, type NodeReadiness } from "./first-run.ts";
export {
  SEARCH_SELECT_MAX_OPTIONS,
  SearchSelect,
  matchingOptions,
  type SearchSelectOption,
  type SearchSelectProps,
} from "./search-select.tsx";
export { useLocale, type LocaleState } from "./i18n/use-locale.ts";
export { LocaleProvider, useT, useLocaleState } from "./i18n/locale-context.tsx";
export { LOCALE_CHOICES, type LocaleChoice } from "./i18n/locale.ts";
