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
  ApprovalCardBlock,
  ArtifactBlock,
  CodeDiffCardBlock,
  ConnectionCardBlock,
  CredentialCardBlock,
  EvidenceBlock,
  HOST_OWNED_BLOCK_TYPES,
  ProjectPickerCardBlock,
  ReconnectCardBlock,
  SystemCardBlock,
  TaskOverviewCardBlock,
  TaskProgressCardBlock,
  TaskSummaryCardBlock,
  TextBlock,
  renderBlock,
} from "./blocks.tsx";
export { Conversation, type ConversationProps } from "./Conversation.tsx";
export { SettingsPanel, SettingsRow, ToolRow, type SettingsPanelProps, type SettingsRowProps, type ToolRowProps } from "./SettingsPanel.tsx";
export { TokenSpecimens, readVar } from "./TokenSpecimens.tsx";
export { Modal, type ModalProps } from "./Modal.tsx";
export { VoiceSurface, VoiceUnavailable, type VoiceSurfaceProps } from "./VoiceSurface.tsx";
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
export function installStyles(theme: "dark" | "light" = "dark"): void {
  if (typeof document === "undefined") return;
  if (!installed) {
    const style = document.createElement("style");
    style.dataset.clarkcant = "styles";
    style.textContent = `${themeStylesheet()}\n${APP_CSS}`;
    document.head.append(style);
    installed = true;
  }
  document.documentElement.dataset.ccTheme = theme;
}
