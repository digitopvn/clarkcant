import type { ReactElement, RefObject } from "react";

import type { GatewayClient } from "./api.ts";
import { Orb } from "./Orb.tsx";
import { BackgroundSessionsMark } from "./background-sessions-mark.tsx";
import { InboxMark } from "./inbox/inbox-mark.tsx";
import { useT } from "./i18n/locale-context.tsx";
import type { ResolvedOrbProfile } from "./orb-profile.ts";
import type { ConnectionState } from "./use-connection-status.ts";

export interface ConversationHeaderProps {
  client: GatewayClient;
  connection: ConnectionState;
  backgroundTick: number;
  /** Changes when something may have changed the inbox, so its mark reads again now. */
  inboxRefreshKey: string;
  shell: RefObject<HTMLDivElement | null>;
  orbProfile: ResolvedOrbProfile | undefined;
  onHome: () => void;
  onOpenSettings: () => void;
  onOpenInbox: () => void;
}

/**
 * The header: the way back to the start screen, the connection status, the background-work mark,
 * the inbox mark and the one settings affordance.
 *
 * The logo is a button rather than a decorated div so it can be reached and announced: a click
 * target only a mouse can find is half a control. The status dot reports the gateway, not the
 * model — "Ready" means the runtime answered, not that a provider credential is configured.
 */
export function ConversationHeader({
  client,
  connection,
  backgroundTick,
  inboxRefreshKey,
  shell,
  orbProfile,
  onHome,
  onOpenSettings,
  onOpenInbox,
}: ConversationHeaderProps): ReactElement {
  const t = useT();
  return (
    <header className="cc-header">
      <button
        type="button"
        className="cc-brand"
        data-home="true"
        onClick={onHome}
        title={t("shell.header.restartTitle")}
        aria-label={t("shell.header.restartAria")}
      >
        <Orb size={30} className="cc-orb" label="" pointerTarget={shell} {...(orbProfile === undefined ? {} : { profile: orbProfile })} />
        <span>ClarkCant</span>
      </button>
      <div className="cc-header-end">
        <div className="cc-status" role="status" aria-live="polite" data-connection={connection}>
          <span className="cc-dot" data-state={connection} aria-hidden="true" />
          {connection === "ready" ? t("shell.status.ready") : connection === "connecting" ? t("shell.status.connecting") : t("shell.status.offline")}
        </div>
        {/* The work behind the conversation. Absent while there is none: a header that always said "0" would be a
            permanent line of noise, and the count only matters when it is not zero. `backgroundTick` is what makes it
            appear at once for work that may already be over by the next poll. */}
        <BackgroundSessionsMark client={client} refreshKey={backgroundTick} />
        {/* What is waiting for the person and what is new, drawn only while either is not zero. */}
        <InboxMark client={client} refreshKey={inboxRefreshKey} onOpen={onOpenInbox} />
        {/*
          The gear is the only settings affordance, which is why it is here rather than in a
          menu: a setting that is two clicks deep is a setting nobody checks. It opens a panel
          that reads the live tokens back off the document, so what it shows is what rendered.
        */}
        <button
          type="button"
          className="cc-icon-btn"
          aria-label={t("settings.title")}
          title={t("settings.title")}
          data-settings="true"
          data-widget-library-anchor="true"
          onClick={onOpenSettings}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
