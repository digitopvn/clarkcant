import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";

import type { GatewayClient } from "./api.ts";
import { hasDesktopChrome, requestWindowMode } from "./desktop-compact.ts";
import { runAppIntent, type AppIntentHost } from "./app-intents.ts";
import type { AppIntentDecision, AppIntentKind, SettingsTab } from "@clarkcant/contracts";
import { CLOSED_LIBRARY, applyLibraryAction, type WidgetLibraryState } from "./widget-library/widget-library-state.ts";

export interface AppIntentSurfacesState {
  uiCheckOpen: boolean;
  setUiCheckOpen: (open: boolean) => void;
  settingsTab: SettingsTab | undefined;
  widgetLibrary: WidgetLibraryState;
  setWidgetLibrary: React.Dispatch<React.SetStateAction<WidgetLibraryState>>;
  openWidgetLibrary: (mode: "browse" | "develop") => void;
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
}: AppIntentSurfacesDeps): AppIntentSurfacesState {
  const [uiCheckOpen, setUiCheckOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [widgetLibrary, setWidgetLibrary] = useState<WidgetLibraryState>(CLOSED_LIBRARY);
  const [intentNotice, setIntentNotice] = useState<string | undefined>(undefined);
  const [pendingIntent, setPendingIntent] = useState<AppIntentDecision | undefined>(undefined);
  const [liveRefresh, setLiveRefresh] = useState(0);
  const bumpLiveRefresh = useCallback(() => setLiveRefresh((count) => count + 1), []);

  const openWidgetLibrary = useCallback((mode: "browse" | "develop"): void => {
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
    return {
      openSettings: (tab?: SettingsTab) => {
        setSettingsTab(tab);
        setUiCheckOpen(true);
      },
      goHome: restartSession,
      openFilePicker: () => attachmentInput.current?.click(),
      endVoice: () => setVoiceOpen(false),
      // Closes whatever is on top of the conversation, without touching the conversation itself —
      // distinct from `goHome`, which leaves it.
      showConversation: () => {
        setUiCheckOpen(false);
        setWidgetLibrary(CLOSED_LIBRARY);
      },
      cycleModel: () => {
        void client.cycleModel().catch(() => setIntentNotice("Không chuyển được model."));
      },
      selectModel: (alias: string) => {
        void client.selectModel(alias).catch(() => setIntentNotice("Không chuyển được model."));
      },
      openWidgetLibrary: (mode: "browse" | "develop", target?: { definitionId?: string; family?: string }) => {
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
            minimiseWindow: () => {
              void requestWindowMode({ type: "enter-compact" });
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
    };
  }, [attachmentInput, restartSession, setVoiceOpen, openVoice, client]);

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
        .catch(() => setIntentNotice("Không hỏi được node về lệnh đó."));
    },
    [client, conversationId, runIntent],
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
