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
import {
  type AppIntentDecision,
  type AppIntentKind,
  NOTICE_DISMISS_UNDO_WINDOW_MS,
  type NoticeOperationId,
  type NoticeOperationSource,
  type OrbProfileName,
  type SettingsTab,
} from "@clarkcant/contracts";
import { CLOSED_LIBRARY, applyLibraryAction, type WidgetLibraryState } from "./widget-library/widget-library-state.ts";
import type { MessageKey } from "./i18n/messages.ts";

/** The kinds whose outcome the model note beside the composer already shows, success or failure. */
const MODEL_SWITCH_KINDS: ReadonlySet<AppIntentKind> = new Set<AppIntentKind>(["model.cycle", "model.select"]);

/** The node's own reason when it gave one, the generic sentence otherwise. */
function modelSwitchFailure(t: (key: MessageKey) => string, cause: unknown): string {
  return cause instanceof Error && cause.message !== "" ? cause.message : t("intents.modelSwitchFailed");
}

/**
 * The Undo a dismissal by a sentence leaves in the conversation.
 *
 * `offered` while the node can still bring the notice back (`NOTICE_DISMISS_UNDO_WINDOW_MS` from when it said it had
 * dismissed it), `restoring` while that is on its way, then `restored`, `failed` or `expired`.
 */
export type NoticeUndoPhase = "offered" | "restoring" | "restored" | "failed" | "expired";

export interface NoticeUndo {
  noticeId: string;
  /** The transcript message it sits under: the newest one when the dismissal ran, which is Clark's reply about it. */
  afterMessageId: string | undefined;
  /** When the node said it was dismissed, in epoch milliseconds; the window runs from here. */
  offeredAt: number;
  phase: NoticeUndoPhase;
  /** What the line says: what the node did while the undo is offered, then how it ended. */
  text: string;
}

export interface AppIntentSurfacesState {
  uiCheckOpen: boolean;
  setUiCheckOpen: (open: boolean) => void;
  settingsTab: SettingsTab | undefined;
  /** Opens Settings on a tab, closing the inbox: the same state an "open settings" intent lands on. */
  openSettings: (tab?: SettingsTab) => void;
  widgetLibrary: WidgetLibraryState;
  setWidgetLibrary: React.Dispatch<React.SetStateAction<WidgetLibraryState>>;
  openWidgetLibrary: (mode: "browse" | "develop") => void;
  /** Whether the inbox is open over the conversation. */
  inboxOpen: boolean;
  setInboxOpen: (open: boolean) => void;
  /**
   * The notice or waiting item the inbox was last opened on (`inboxTargetSchema`), from a clicked OS or web notification;
   * cleared once the panel has shown it.
   */
  inboxTarget: string | undefined;
  clearInboxTarget: () => void;
  intentNotice: string | undefined;
  /** The Undo the latest typed or spoken dismissal left in the conversation, drawn under Clark's reply about it. */
  noticeUndo: NoticeUndo | undefined;
  /** Brings the dismissed notice back through the node's own restore, and says how that went on the same line. */
  undoNoticeDismissal: () => void;
  /** Shows a notice outside the click/voice/typed-command path, e.g. a voice session that failed to open. */
  setIntentNotice: (message: string) => void;
  /** Carry out a decision, whichever way it arrived (click, voice, or a typed command). */
  runIntent: (decision: AppIntentDecision) => void;
  /** Ask the node what a click means, then do it. `inboxTarget` goes only with `inbox.open`. */
  clickIntent: (kind: AppIntentKind, extra?: { inboxTarget?: string }) => void;
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
   * working host: `runAppIntent` reports the limitation honestly rather than throwing. Rejects with the
   * reason when voice could not open.
   */
  openVoice?: () => Promise<void>;
  /** Stops the reply being written, the same call the Stop button makes. */
  stopTurn?: () => void;
  /** The inbox's "Ask Clark" for its newest notice; rejects with the reason when it cannot. */
  askAboutLatestNotice?: () => Promise<void>;
  /** The inbox's "It took effect" / "It did not take effect" for the effect the node named; rejects with the reason. */
  recordEffectOutcome?: (effectId: string, outcome: "confirmed" | "failed") => Promise<void>;
  /**
   * One of a notice's own actions, on the notice the node named; resolves to what the node did, rejects with why not.
   * `source` is given only for a press (the line's own "Undo"); otherwise the host says whether it was typed or spoken.
   */
  actOnNotice?: (noticeId: string, action: NoticeOperationId, source?: NoticeOperationSource) => Promise<string>;
  /** The newest message in the transcript on screen, read when a dismissal runs so its Undo sits under that reply. */
  latestMessageId?: () => string | undefined;
  /**
   * The model switches the hotkey makes (`useModelAlias`), so an intent that switches the model updates
   * the alias and note on screen exactly as the hotkey does.
   */
  cycleModel: () => Promise<string>;
  selectModel: (alias: string) => Promise<string>;
  /**
   * Saves an orb style through the preference the Settings control writes, and refreshes the orb on screen.
   * Resolves with the sentence to report; rejects with the node's reason. Optional so a host with nowhere to
   * save it is refused with a sentence instead of reporting a change that would not survive a reload.
   */
  selectOrbProfile?: (profile: OrbProfileName) => Promise<string>;
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
  stopTurn,
  askAboutLatestNotice,
  recordEffectOutcome,
  actOnNotice,
  latestMessageId,
  cycleModel,
  selectModel,
  selectOrbProfile,
  t,
}: AppIntentSurfacesDeps): AppIntentSurfacesState {
  const [uiCheckOpen, setUiCheckOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [widgetLibrary, setWidgetLibrary] = useState<WidgetLibraryState>(CLOSED_LIBRARY);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxTarget, setInboxTarget] = useState<string | undefined>(undefined);
  const clearInboxTarget = useCallback(() => setInboxTarget(undefined), []);
  const [intentNotice, setIntentNotice] = useState<string | undefined>(undefined);
  const [noticeUndo, setNoticeUndo] = useState<NoticeUndo | undefined>(undefined);
  const [pendingIntent, setPendingIntent] = useState<AppIntentDecision | undefined>(undefined);
  const [liveRefresh, setLiveRefresh] = useState(0);
  const bumpLiveRefresh = useCallback(() => setLiveRefresh((count) => count + 1), []);

  // Settings and the inbox are both modals, and modals do not nest: opening one closes the other.
  const openSettings = useCallback((tab?: SettingsTab): void => {
    setInboxOpen(false);
    setSettingsTab(tab);
    setUiCheckOpen(true);
  }, []);

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
      openSettings,
      openInbox: (target?: string) => {
        setUiCheckOpen(false);
        setWidgetLibrary(CLOSED_LIBRARY);
        // Only a notification's own target is kept; any other opening starts at the top of the list, as before.
        setInboxTarget(target);
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
      // Awaited, so "switched" is reported only once the pool has switched; a refusal becomes the run's reason.
      cycleModel: async () => {
        try {
          return await cycleModel();
        } catch (cause) {
          throw new Error(modelSwitchFailure(t, cause), { cause });
        }
      },
      selectModel: async (alias: string) => {
        try {
          return await selectModel(alias);
        } catch (cause) {
          throw new Error(modelSwitchFailure(t, cause), { cause });
        }
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
      ...(stopTurn === undefined ? {} : { stopTurn }),
      ...(askAboutLatestNotice === undefined ? {} : { askAboutLatestNotice }),
      ...(recordEffectOutcome === undefined ? {} : { recordEffectOutcome }),
      ...(actOnNotice === undefined ? {} : { actOnNotice }),
      ...(selectOrbProfile === undefined ? {} : { selectOrbProfile }),
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
  }, [
    openSettings,
    attachmentInput,
    restartSession,
    setVoiceOpen,
    openVoice,
    stopTurn,
    askAboutLatestNotice,
    recordEffectOutcome,
    actOnNotice,
    cycleModel,
    selectModel,
    selectOrbProfile,
    t,
  ]);

  const runIntent = useCallback(
    (decision: AppIntentDecision): void => {
      void runAppIntent(decision, intentHost).then((run) => {
        // Only a failure is announced: a command that worked is already visible as the panel that
        // just opened, or read back out loud by the voice surface. A model switch that failed already
        // says why in the note beside the model label - near the thing it is about - so it is not said twice.
        if (!run.ran && !(decision.kind === "intent" && MODEL_SWITCH_KINDS.has(decision.intent.kind))) {
          setIntentNotice(run.say);
        } else if (run.ran && decision.kind === "intent" && decision.intent.kind === "notice.act") {
          // A notice action leaves nothing on screen that says it happened — the inbox may not even be open — so what
          // the node did is said, in the same words the panel uses for the same press. A dismissal says it in the
          // conversation, under Clark's reply about it, with "Undo" for as long as the node can bring the notice back.
          const { noticeId, noticeAction } = decision.intent;
          if (noticeAction === "dismiss" && noticeId !== undefined && actOnNotice !== undefined) {
            setNoticeUndo({ noticeId, afterMessageId: latestMessageId?.(), offeredAt: Date.now(), phase: "offered", text: run.say });
          } else {
            setIntentNotice(run.say);
            // "Undo dismissing the notification" said instead of pressed: the Undo left for it has nothing left to offer.
            if (noticeAction === "restore" && noticeId !== undefined) {
              setNoticeUndo((shown) =>
                shown?.noticeId === noticeId && (shown.phase === "offered" || shown.phase === "restoring")
                  ? { ...shown, phase: "restored", text: t("inbox.act.undoRestored") }
                  : shown,
              );
            }
          }
        }
        // An action the agent asked for is reported back, run or not: the agent's tool is waiting to
        // tell the model whether the screen changed, and "sent" is not an answer it may give as "done".
        if (decision.kind === "intent" && decision.controlId !== undefined) {
          client.reportHostControl(decision.controlId, run).catch(() => undefined);
        }
      });
    },
    [client, intentHost, actOnNotice, latestMessageId, t],
  );

  const undoNoticeDismissal = useCallback((): void => {
    const current = noticeUndo;
    if (current?.phase !== "offered" || actOnNotice === undefined) return;
    // Only this Undo's own line changes, and only if it is still the one on screen when the answer comes.
    const settle = (phase: NoticeUndoPhase, text: string) =>
      setNoticeUndo((shown) => (shown?.offeredAt === current.offeredAt && shown.noticeId === current.noticeId ? { ...shown, phase, text } : shown));
    // Marked at once, so a second press cannot send a second restore while the first is on its way.
    setNoticeUndo({ ...current, phase: "restoring" });
    actOnNotice(current.noticeId, "restore", "click").then(
      () => settle("restored", t("inbox.act.undoRestored")),
      (cause: unknown) =>
        settle(
          "failed",
          cause instanceof Error && cause.message !== ""
            ? cause.message
            : t("inbox.act.undoFailed").replace("{reason}", `${t("inbox.reason.unavailable")}.`),
        ),
    );
  }, [noticeUndo, actOnNotice, t]);

  // The undo is offered exactly as long as the node keeps the notice restorable, then says quietly that it has passed.
  useEffect(() => {
    if (noticeUndo?.phase !== "offered") return;
    const { offeredAt, noticeId } = noticeUndo;
    const timer = setTimeout(
      () =>
        setNoticeUndo((shown) =>
          shown?.phase === "offered" && shown.offeredAt === offeredAt && shown.noticeId === noticeId
            ? { ...shown, phase: "expired", text: t("inbox.act.undoExpired") }
            : shown,
        ),
      Math.max(0, offeredAt + NOTICE_DISMISS_UNDO_WINDOW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [noticeUndo, t]);

  // It belongs to the conversation it was said in.
  useEffect(() => {
    setNoticeUndo(undefined);
  }, [conversationId]);

  const clickIntent = useCallback(
    (kind: AppIntentKind, extra?: { inboxTarget?: string }): void => {
      if (client === undefined) return;
      void client
        .sendAppIntent({
          kind,
          source: "click",
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(extra?.inboxTarget === undefined ? {} : { inboxTarget: extra.inboxTarget }),
        })
        .then((decision) => {
          if (decision.kind !== "none") runIntent(decision);
        })
        .catch(() => setIntentNotice(t("intents.commandLookupFailed")));
    },
    [client, conversationId, runIntent, setIntentNotice, t],
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
    openSettings,
    widgetLibrary,
    setWidgetLibrary,
    openWidgetLibrary,
    inboxOpen,
    setInboxOpen,
    inboxTarget,
    clearInboxTarget,
    intentNotice,
    noticeUndo,
    undoNoticeDismissal,
    setIntentNotice,
    runIntent,
    clickIntent,
    pendingIntent,
    setPendingIntent,
    liveRefresh,
    bumpLiveRefresh,
  };
}
