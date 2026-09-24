import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";

import type { GatewayClient } from "./api.ts";
import {
  hasDesktopChrome,
  hasWindowControls,
  requestFullScreen,
  requestMinimize,
  requestWindowMode,
} from "./desktop-compact.ts";
import { runAppIntent, type AppIntentHost } from "./app-intents.ts";
import type { AppIntentDecision, AppIntentKind, SettingsTab } from "@clarkcant/contracts";
import { CLOSED_LIBRARY, applyLibraryAction, type WidgetLibraryState } from "./widget-library/widget-library-state.ts";
import type { MessageKey } from "./i18n/messages.ts";

export interface AppIntentSurfacesState {
  uiCheckOpen: boolean;
  setUiCheckOpen: (open: boolean) => void;
  settingsTab: SettingsTab | undefined;
  widgetLibrary: WidgetLibraryState;
  setWidgetLibrary: React.Dispatch<React.SetStateAction<WidgetLibraryState>>;
  openWidgetLibrary: (mode: "browse" | "develop") => void;
  /** Whether the inbox is open over the conversation. */
  inboxOpen: boolean;
  setInboxOpen: (open: boolean) => void;
  intentNotice: string | undefined;
  /** Shows a notice outside the click/voice/typed-command path, e.g. a voice session that failed to open. */
  setIntentNotice: (message: string) => void;
  /** Carry out a decision, whichever way it arrived (click, voice, or a typed command). */
  runIntent: (decision: AppIntentDecision) => void;
  /** Ask the node what a click means, then do it. */
  clickIntent: (kind: AppIntentKind) => void;
  /** A command a typed message resolved to, to be carried out once the send that produced it settles. */
  pendingIntent: AppIntentDecision | undefined;
  setPendingIntent: (decision: AppIntentDecision | undefined) => void;
  /**
   * Bumped when the node reports that a spoken action has run.
   *
   * The pinned surface watches it and re-reads itself, which is what the click path does after
   * its own invoke. The alternative - the voice path writing the surface's state directly - would
   * be a second way to change the same state, and the two would drift.
   */
  liveRefresh: number;
  bumpLiveRefresh: () => void;
}

export interface AppIntentSurfacesDeps {
  /**
   * The translator, passed rather than read via `useT()`: this hook runs in `Conversation`'s own
   * body, before its `<LocaleProvider>` mounts.
   */
  t: (key: MessageKey) => string;
  client: GatewayClient;
  conversationId: string | undefined;
  restartSession: () => void;
  attachmentInput: RefObject<HTMLInputElement | null>;
  setVoiceOpen: (open: boolean) => void;
  /**
   * Starts voice mode the same way the voice button does, ensuring a conversation exists first.
   *
   * Optional so a caller that has not wired voice at all (a fixture, a narrower embed) still gets a
   * working host: `runAppIntent` reports the limitation honestly rather than throwing.
   */
  openVoice?: () => void;
}

/**
 * Settings, the Widget Library and the app-intent registry, as one surface.
 *
 * Kept together because they share the one executor: a click, a spoken command and a typed
 * command that named "open settings" or "open the widget library" all have to land on the same
 * state, and a second copy of the wiring for any of them is the beginning of the two paths
 * drifting apart.
 */
export function useAppIntentSurfaces({
  client,
  conversationId,
  restartSession,
  attachmentInput,
  setVoiceOpen,
  openVoice,
  t,
}: AppIntentSurfacesDeps): AppIntentSurfacesState {
  const [uiCheckOpen, setUiCheckOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [widgetLibrary, setWidgetLibrary] = useState<WidgetLibraryState>(CLOSED_LIBRARY);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [intentNotice, setIntentNotice] = useState<string | undefined>(undefined);
  const [pendingIntent, setPendingIntent] = useState<AppIntentDecision | undefined>(undefined);
  const [liveRefresh, setLiveRefresh] = useState(0);
  const bumpLiveRefresh = useCallback(() => setLiveRefresh((count) => count + 1), []);

  const openWidgetLibrary = useCallback((mode: "browse" | "develop"): void => {
    // Modals do not nest (see openSettings/openInbox below and WidgetLibrarySurface's own note on the same rule):
    // the library is a `role="dialog" aria-modal="true"` surface itself, so it closes the inbox rather than
    // stacking a second dialog with its own Escape and Tab trap over the first.
    setInboxOpen(false);
    setWidgetLibrary((current) => applyLibraryAction(current, { kind: "open", mode }));
  }, []);

  /**
   * Everything an intent can reach.
   *
   * The window commands are absent when there is no window: `runAppIntent` refuses a desktop
   * intent when the host has no method for it, so a browser saying "thu nhỏ cửa sổ" is refused
   * with a reason rather than reported as done. Defining these unconditionally would report
   * success for a resize that never happened, because the bridge call itself fails quietly.
   */
  const intentHost = useMemo<AppIntentHost>(() => {
    const desktop = hasDesktopChrome();
    // Minimize and full screen need a shell new enough to have them; an older one leaves both intents refused.
    const windowControls = hasWindowControls();
    return {
      // Settings and the inbox are both modals, and modals do not nest: opening one closes the other.
      openSettings: (tab?: SettingsTab) => {
        setInboxOpen(false);
        setSettingsTab(tab);
        setUiCheckOpen(true);
      },
      openInbox: () => {
        setUiCheckOpen(false);
        setWidgetLibrary(CLOSED_LIBRARY);
        setInboxOpen(true);
      },
      goHome: restartSession,
      openFilePicker: () => attachmentInput.current?.click(),
      endVoice: () => setVoiceOpen(false),
      // Closes whatever is on top of the conversation, without touching the conversation itself —
      // distinct from `goHome`, which leaves it.
      showConversation: () => {
        setUiCheckOpen(false);
        setWidgetLibrary(CLOSED_LIBRARY);
        setInboxOpen(false);
      },
      cycleModel: () => {
        void client.cycleModel().catch(() => setIntentNotice(t("intents.modelSwitchFailed")));
      },
      selectModel: (alias: string) => {
        void client.selectModel(alias).catch(() => setIntentNotice(t("intents.modelSwitchFailed")));
      },
      openWidgetLibrary: (mode: "browse" | "develop", target?: { definitionId?: string; family?: string }) => {
        // Same rule as the imperative `openWidgetLibrary` above, for the path a click, a typed command or voice
        // reaches this through instead: opening the library while the inbox is open would stack two modals.
        setInboxOpen(false);
        setWidgetLibrary((current) =>
          applyLibraryAction(current, { kind: "open", mode, ...(target === undefined ? {} : { target }) }),
        );
      },
      ...(openVoice === undefined ? {} : { openVoice }),
      ...(desktop
        ? {
            expandWindow: () => {
              void requestWindowMode({ type: "expand" });
            },
            setMinimal: () => {
              // This build has one compact size, so "thu nhỏ" and "thu nhỏ tối thiểu" reach the same bar.
              void requestWindowMode({ type: "enter-compact" });
            },
            quit: () => {
              window.close();
            },
          }
        : {}),
      /*
       * "Thu nhỏ cửa sổ" reads back as going to the taskbar, so it goes to the taskbar. It used to reach the voice bar
       * because the shell had no minimize verb; a shell without one now refuses the intent rather than doing
       * something other than what was read back.
       */
      ...(windowControls
        ? {
            minimiseWindow: () => {
              void requestMinimize();
            },
            setFullScreen: (value: boolean) => {
              void requestFullScreen(value);
            },
          }
        : {}),
    };
  }, [attachmentInput, restartSession, setVoiceOpen, openVoice, client, t]);

  const runIntent = useCallback(
    (decision: AppIntentDecision): void => {
      const run = runAppIntent(decision, intentHost);
      // Only a failure is announced: a command that worked is already visible as the panel that
      // just opened, or read back out loud by the voice surface.
      if (!run.ran) setIntentNotice(run.say);
    },
    [intentHost],
  );

  const clickIntent = useCallback(
    (kind: AppIntentKind): void => {
      if (client === undefined) return;
      void client
        .sendAppIntent({
          kind,
          source: "click",
          ...(conversationId === undefined ? {} : { conversationId }),
        })
        .then((decision) => {
          if (decision.kind !== "none") runIntent(decision);
        })
        .catch(() => setIntentNotice(t("intents.commandLookupFailed")));
    },
    [client, conversationId, runIntent, t],
  );

  // A notice is a remark about something that just happened, not a permanent line of text.
  useEffect(() => {
    if (intentNotice === undefined) return;
    const timer = setTimeout(() => setIntentNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [intentNotice]);

  // A command that was typed and recognised is answered by the host, so the node sends the
  // decision with the timeline and it is carried out here — the same executor a spoken command
  // and a click use.
  useEffect(() => {
    if (pendingIntent === undefined) return;
    setPendingIntent(undefined);
    runIntent(pendingIntent);
  }, [pendingIntent, runIntent]);

  return {
    uiCheckOpen,
    setUiCheckOpen,
    settingsTab,
    widgetLibrary,
    setWidgetLibrary,
    openWidgetLibrary,
    inboxOpen,
    setInboxOpen,
    intentNotice,
    setIntentNotice,
    runIntent,
    clickIntent,
    pendingIntent,
    setPendingIntent,
    liveRefresh,
    bumpLiveRefresh,
  };
}
