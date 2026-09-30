import { type CSSProperties, Fragment, type ReactElement, useRef, useState } from "react";

import type { NoticeOperationId, NoticeOperationSource, OrbProfileName } from "@clarkcant/contracts";

import type { GatewayClient, Timeline } from "./api.ts";
import { agentStateFrom, windowModeFrom } from "./input-modality.ts";
import type { ResolvedOrbProfile } from "./orb-profile.ts";
import { selectOrbProfileShown } from "./use-orb-profile.ts";
import { Markdown } from "./markdown.tsx";
import { Orb } from "./Orb.tsx";
import { useTypewriterPlaceholder } from "./typewriter.ts";
import { VoiceOverlay } from "./VoiceOverlay.tsx";
import { SettingsPanel } from "./settings/SettingsPanel.tsx";
import { WidgetLibrarySurface } from "./widget-library/WidgetLibrarySurface.tsx";
import { applyLibraryAction } from "./widget-library/widget-library-state.ts";
import { attachedPrompt, explainPrompt } from "./selection.ts";
import { SelectionToolbar } from "./selection-toolbar.tsx";
import { DesktopChrome } from "./desktop-chrome.tsx";
import { DotGrid } from "./dot-grid.tsx";
import { ConversationHeader } from "./ConversationHeader.tsx";
import { InboxPanel } from "./inbox/inbox-panel.tsx";
import { reconcileAlreadyRecorded, sanitizeReason } from "./inbox/inbox-model.ts";
import { useInboxNoticeActions } from "./inbox/use-inbox-notice-actions.ts";
import { useInboxNotifications } from "./inbox/use-inbox-notifications.ts";
import { ConversationHeroEmptyState } from "./ConversationHeroEmptyState.tsx";
import { ConversationComposerBar } from "./ConversationComposerBar.tsx";
import { ConversationPinSurfaces } from "./ConversationPinSurfaces.tsx";
import { ConversationLiveReplyRow } from "./ConversationLiveReplyRow.tsx";
import { TimelineMessageRow } from "./TimelineMessageRow.tsx";
import { NoticeUndoRow } from "./NoticeUndoRow.tsx";
import { useAppearance } from "./use-appearance.ts";
import { chooseThemeShown, resetAppearanceShown } from "./appearance-actions.ts";
import { useTheme } from "./use-theme.ts";
import { useLocale } from "./i18n/use-locale.ts";
import { LocaleProvider } from "./i18n/locale-context.tsx";
import { useConnectionStatus } from "./use-connection-status.ts";
import { useModelAlias } from "./use-model-alias.ts";
import { useDynamicSuggestions } from "./use-dynamic-suggestions.ts";
import { useInputModalityState } from "./use-input-modality-state.ts";
import { usePolicyModeState } from "./use-policy-mode-state.ts";
import { useConversationTimeline } from "./use-conversation-timeline.ts";
import { useHeroOrbLayout, ORB_DRAW_SIZE, ORB_RADIUS } from "./use-hero-orb-layout.ts";
import { useAttachmentComposer } from "./use-attachment-composer.ts";
import { useComposerReferences } from "./use-composer-references.ts";
import { useVoiceSession } from "./use-voice-session.ts";
import { useAppIntentSurfaces } from "./use-app-intent-surfaces.ts";
import { useTurnSend } from "./use-turn-send.ts";
import { useBlockActions } from "./use-block-actions.ts";
import { useComposerTextareaHeight } from "./use-composer-textarea-height.ts";
import { useSurfaceRenderer } from "./use-surface-renderer.tsx";

/**
 * Conversation surface.
 *
 * One timeline, one composer, an optional pin shelf, and a status that never claims more
 * than it knows. There is no session picker and no sidebar, because the blueprint's
 * position is that the conversation is the interface: extra navigation is a cost the user
 * pays to learn the tool, not a feature.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 *   - **The status dot reports the gateway, not the model.** "Ready" means the runtime
 *     answered; it does not mean a provider credential is configured, and the empty state
 *     says so when nothing can answer.
 *   - **Suggestion chips are labelled as samples.** Clicking one runs a scripted recipe, so
 *     the label has to be visible before the click, not a footnote after it.
 *
 * The component itself is now a thin composition of hooks (`use-*.ts`, one state group per
 * concern) and presentational pieces (`Conversation*.tsx`, `TimelineMessageRow.tsx`). What used
 * to be one 2200-line function with 37 states is now the wiring between roughly a dozen focused
 * pieces, each of which can be read, tested and changed on its own.
 */
export interface ConversationProps {
  client: GatewayClient;
  /** Pre-existing conversation, or `undefined` to create one on first send. */
  conversationId?: string;
  /** Injected so tests can assert behaviour without waiting on a wall clock. */
  onTimelineChange?: (timeline: Timeline) => void;
  /** Called once a conversation exists, so the host can remember it across reloads. */
  onConversationReady?: (conversationId: string) => void;
  /**
   * Called when the session is restarted, so the host can forget what it remembered.
   *
   * The conversation id lives in the host's storage rather than here, and a restart that left it
   * behind would be undone by the next reload: the start screen would appear, and then the old
   * conversation would come back. Clearing it is the host's job because remembering it is.
   */
  onSessionReset?: () => void;
  /** Loads an existing conversation on mount instead of starting empty. */
  initialAfter?: number;
  /**
   * The personalized orb, resolved by the host from the stored preferences.
   *
   * Passed down rather than read here: the conversation is rendered many times per turn, and a component
   * that fetched its own preferences would rebuild the orb's GPU program on whatever schedule its own
   * re-renders happened to follow.
   */
  orbProfile?: ResolvedOrbProfile;
  /**
   * Called after a settings write that changes the orb.
   *
   * Writing a profile has to change the orb that is on screen rather than the one that appears after a
   * reload, and only the host that resolved the profile can re-resolve it. Resolves with the profile now drawn,
   * and rejects when it could not be read back, so a caller never reports a change the screen did not make.
   */
  onOrbChange?: () => Promise<ResolvedOrbProfile>;
  /**
   * Whether this node has no model, so a turn that needs one would fail.
   *
   * Passed down rather than discovered here, because the answer comes from the node's own readiness report and
   * this surface has no business asking a second time. When it is true the empty state says what is missing and
   * offers the control that fixes it, which is the difference between a setup step and a dead end.
   */
  needsModel?: boolean;
  /**
   * Opens another conversation, from the inbox.
   *
   * The host owns which conversation is on screen, the way it owns remembering it, so switching is its job. Absent,
   * the inbox does not offer to open other conversations rather than offering a button that does nothing.
   */
  onOpenConversation?: (conversationId: string) => void;
}

/**
 * The keys of the questions the empty composer types at the user, one at a time, in the catalog's own order.
 *
 * Asked as questions rather than shown as commands, because the empty state is a prompt for what to
 * say and a list of instructions reads as a menu of the only four things that work.
 */
const PLACEHOLDER_PHRASE_KEYS = ["composer.placeholder.1", "composer.placeholder.2", "composer.placeholder.3"] as const;

export function Conversation({
  client,
  conversationId: initialConversationId,
  onTimelineChange,
  onConversationReady,
  onSessionReset,
  orbProfile,
  onOrbChange,
  needsModel,
  onOpenConversation,
}: ConversationProps): ReactElement {
  const modality = useInputModalityState();
  const { policyMode, refresh: refreshPolicyMode } = usePolicyModeState(client);
  const connection = useConnectionStatus(client);
  const { themeChoice, resolvedTheme, applyThemeChoice } = useTheme();
  const appearance = useAppearance(client);
  const localeState = useLocale();
  const { modelAlias, modelNote, cycleModel, selectModel } = useModelAlias(client, localeState.t);
  const dynamicSuggestions = useDynamicSuggestions(client);

  const {
    conversationId,
    setConversationId,
    timeline,
    setTimeline,
    datasets,
    setDatasets,
    refreshDataset,
    snapshots,
    setSnapshots,
    applyTimeline,
    refreshTimeline,
    instanceById,
    imageUrl,
  } = useConversationTimeline(client, initialConversationId, onTimelineChange);

  const blocks = timeline?.messages ?? [];
  const pins = timeline?.pins ?? [];

  const { heroPhase, shell, heroOrb, composerWrap, orbPlacement, beginHeroExit, resetHero } = useHeroOrbLayout(
    blocks.length,
  );

  /**
   * A counter that tells the header's background mark to read again now.
   *
   * The mark polls, because it is a glance at a number rather than a stream. Polling alone would miss work that is
   * shorter than the interval, so the action that starts work says so and the mark reads immediately instead of
   * waiting for the next tick.
   */
  const [backgroundTick, setBackgroundTick] = useState(0);
  /** The same, for the inbox mark: bumped when the inbox panel changed something the mark counts. */
  const [inboxTick, setInboxTick] = useState(0);
  /** Bumped when a notice changed from outside the inbox panel (a sentence), so an open panel reads again. */
  const [inboxPanelRefresh, setInboxPanelRefresh] = useState(0);
  const [draft, setDraft] = useState("");

  /**
   * The control that opened the expanded live view.
   *
   * Focus has to come back somewhere specific when that view closes: a keyboard user who lands on
   * `<body>` after Escape has to re-navigate the whole page to get where they were.
   */
  const liveTrigger = useRef<HTMLElement | null>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const askAboutLatestNotice = useRef<(() => Promise<void>) | undefined>(undefined);
  const recordEffectOutcome = useRef<((effectId: string, outcome: "confirmed" | "failed") => Promise<void>) | undefined>(
    undefined,
  );
  const actOnNotice = useRef<((noticeId: string, action: NoticeOperationId, source?: NoticeOperationSource) => Promise<string>) | undefined>(
    undefined,
  );
  /** The newest message on screen, kept for the moment a dismissal runs (see `latestMessageId` below). */
  const latestMessageId = useRef<string | undefined>(undefined);
  latestMessageId.current = blocks.at(-1)?.messageId;
  /** The hidden file input the `+` button opens, so the button itself is a real `<button>`. */
  const attachmentInput = useRef<HTMLInputElement>(null);

  useComposerTextareaHeight(composerInput, draft);

  const {
    chips,
    dispatchChips,
    dragging,
    setDragging,
    addFiles,
    addStored,
  } = useAttachmentComposer({
    client,
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
      onConversationReady?.(id);
    },
    onErrorCleared: () => setError(undefined),
    t: localeState.t,
  });

  const references = useComposerReferences({ client, conversationId, draft, setDraft, input: composerInput });

  const {
    busy,
    error,
    setError,
    pendingUser,
    live,
    send,
    stop,
    restartSession,
    scroller,
  } = useTurnSend({
    client,
    conversationId,
    setConversationId,
    onConversationReady,
    onSessionReset,
    applyTimeline,
    timeline,
    setTimeline,
    chips,
    dispatchChips,
    chosenReferences: references.chosen,
    onReferencesSent: references.clear,
    beginHeroExit,
    resetHero,
    setDatasets,
    setSnapshots,
    setPendingIntent: (decision) => appIntents.setPendingIntent(decision),
    clearDraft: () => setDraft(""),
    onSendFailed: (originalText) => setDraft(originalText),
  });

  /*
   * A widget button's call or workflow that is still waiting on the node is something this conversation is doing, so
   * Stop is offered for it as for a reply, and reaches the same node stop: that stops the reply and every action running
   * in the conversation. The button then says what the stop meant for its effect.
   */
  const [actionRunning, setActionRunning] = useState(false);
  const stopConversation = (): void => {
    if (busy) {
      void stop();
      return;
    }
    if (actionRunning && conversationId !== undefined) {
      void client.stopTurn(conversationId).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const {
    voiceOpen,
    setVoiceOpen,
    compactSurface,
    openVoice,
    scheduleVoiceRefresh,
  } = useVoiceSession({
    client,
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
      onConversationReady?.(id);
    },
    onOpenFailed: (message) => appIntents.setIntentNotice(message),
    refreshTimeline,
    t: localeState.t,
  });

  const appIntents = useAppIntentSurfaces({
    t: localeState.t,
    client,
    conversationId,
    restartSession,
    attachmentInput,
    setVoiceOpen,
    // Reuses the same path the voice button already takes, so a `voice.open` intent - from a click, a
    // typed command, or the main agent's `control_app` - ensures a conversation exists first exactly as
    // clicking the button does. A surface that could not open is a failed run, not a done one.
    openVoice: async () => {
      const failed = await openVoice();
      if (failed !== undefined) throw new Error(failed);
    },
    // "Dừng lại", typed or said, reaches the same call as the Stop button.
    stopTurn: () => stopConversation(),
    // Read through a ref: the inbox actions need this hook's own inbox state, so they are made below it.
    askAboutLatestNotice: async () => {
      await askAboutLatestNotice.current?.();
    },
    // "It took effect", typed or said, reaches the same person-only route as the inbox's two buttons.
    recordEffectOutcome: async (effectId, outcome) => {
      await recordEffectOutcome.current?.(effectId, outcome);
    },
    // "Dismiss the latest notification", typed or said: the notice's own action, through the route the panel uses.
    actOnNotice: async (noticeId, action, source) => {
      if (actOnNotice.current === undefined) throw new Error(localeState.t("shell.intent.notInbox"));
      return actOnNotice.current(noticeId, action, source);
    },
    // Read when a dismissal runs: by then Clark's reply about it is the newest message, and its Undo goes under it.
    latestMessageId: () => latestMessageId.current,
    // The hotkey's own switches, so the alias and note on screen follow an agent's switch too.
    cycleModel,
    selectModel,
    /*
     * The orb style an agent or a spoken request asks for, saved with the same preference write the Settings
     * control makes and then shown with the same refresh. Offered only when the host can refresh the orb: a
     * style that was saved but not drawn until the next reload would make "done" untrue on screen.
     *
     * "Done" waits for the refresh to answer with the style now drawn; see `selectOrbProfileShown`.
     */
    ...(onOrbChange === undefined
      ? {}
      : {
          selectOrbProfile: (profile: OrbProfileName) =>
            selectOrbProfileShown(profile, {
              write: (name) => client.writePreference("orb.profile", name),
              refresh: onOrbChange,
              t: localeState.t,
            }),
        }),
    /*
     * The theme, stored through the preference write the theme picker makes and redrawn through the same appearance
     * read; light and dark through the same call as the Settings control. See `appearance-actions.ts`.
     */
    setTheme: (themeRef: string, themeName: string | undefined) =>
      chooseThemeShown(themeRef, themeName, {
        write: (ref) => client.writePreference("experience.themeRef", ref),
        refresh: appearance.refresh,
        t: localeState.t,
      }),
    setColorScheme: applyThemeChoice,
    resetAppearance: () =>
      resetAppearanceShown({
        write: (ref) => client.writePreference("experience.themeRef", ref),
        refresh: appearance.refresh,
        t: localeState.t,
        applyColorScheme: applyThemeChoice,
      }),
  });

  /**
   * What the agent is doing, as one state rather than several flags a stylesheet would have to combine.
   *
   * Every input is a state a hook above already holds. Nothing is promoted to `success`: there is
   * no real completion signal here yet, and a state published without one is the interface
   * claiming to know something it does not.
   */
  const noticeActions = useInboxNoticeActions({
    client,
    busy,
    inboxOpen: appIntents.inboxOpen,
    closeInbox: () => appIntents.setInboxOpen(false),
    send,
    insertReference: references.insert,
    composerInput,
    t: localeState.t,
    refreshTimeline,
    onInboxChanged: () => setInboxTick((tick) => tick + 1),
    refreshInboxPanel: () => setInboxPanelRefresh((tick) => tick + 1),
    locale: localeState.locale,
  });
  askAboutLatestNotice.current = noticeActions.askAboutLatestNotice;
  // A typed command arrives while the voice screen is closed, a spoken one while it is open: that is the surface the
  // person answered from, and the node records it beside the answer. A press says so itself.
  actOnNotice.current = (noticeId, action, source) => noticeActions.actOnNotice(noticeId, action, source ?? (voiceOpen ? "voice" : "chat"));
  // The same rule for "it took effect", typed or said.
  recordEffectOutcome.current = async (effectId, outcome) => {
    try {
      await noticeActions.reconcile(effectId, outcome, voiceOpen ? "voice" : "chat");
    } catch (cause) {
      throw new Error(
        reconcileAlreadyRecorded(cause)
          ? localeState.t("inbox.reconcileFailed.already")
          : localeState.t("inbox.reconcileFailed").replace("{reason}", sanitizeReason(cause) ?? localeState.t("inbox.reason.unavailable")),
        { cause },
      );
    }
  };

  const agentState = agentStateFrom({
    failed: error !== undefined,
    listening: voiceOpen,
    busy,
    tooling: live.some((segment) => segment.kind === "tool"),
    responding: live.some((segment) => segment.kind === "text" || segment.kind === "reasoning"),
  });

  const blockActions = useBlockActions({
    client,
    conversationId,
    timeline,
    applyTimeline,
    setError,
    send: (text) => void send(text),
    t: localeState.t,
  });

  const renderSurface = useSurfaceRenderer({
    t: localeState.t,
    client,
    conversationId,
    timeline,
    instanceById,
    snapshots,
    datasets,
    refreshDataset,
    imageUrl,
    applyTimeline,
    setError,
    liveTrigger,
    onActionsRunningChange: setActionRunning,
  });

  const focusedInstanceId = pins.find((pin) => pin.displayMode === "expanded")?.instanceId;
  const windowMode = windowModeFrom({
    compactSurface,
    voiceOpen,
    hasFocusedPin: focusedInstanceId !== undefined,
  });
  useInboxNotifications({
    client,
    t: localeState.t,
    windowMode,
    // A notification leads to what it was about: the inbox opens on that notice or waiting item.
    onOpenInbox: (target) => appIntents.clickIntent("inbox.open", target === undefined ? undefined : { inboxTarget: target }),
    onNoticesArrived: (conversationIds) => {
      if (conversationId !== undefined && conversationIds.includes(conversationId)) refreshTimeline();
    },
  });
  // Re-derived from the current locale on every render rather than memoized: a language switch mid-typewriter
  // must show the new language's phrases, not finish the cycle in the one that was active when it started.
  const placeholderPhrases = PLACEHOLDER_PHRASE_KEYS.map((key) => localeState.t(key));
  const placeholder = useTypewriterPlaceholder(placeholderPhrases, heroPhase === "shown" && draft === "");
  const showTimeline = blocks.length > 0 || pendingUser !== undefined || busy;
  // The Undo a dismissal by a sentence left, under the reply that said so: the last row with that message's id.
  const noticeUndo = appIntents.noticeUndo;
  const undoIndex = noticeUndo === undefined ? -1 : blocks.findLastIndex((message) => message.messageId === noticeUndo.afterMessageId);
  const noticeUndoRow =
    noticeUndo === undefined ? null : (
      <NoticeUndoRow key={`${noticeUndo.noticeId}-${String(noticeUndo.offeredAt)}`} undo={noticeUndo} onUndo={appIntents.undoNoticeDismissal} />
    );

  return (
    <LocaleProvider value={localeState}>
    <div
      className="cc-shell"
      data-view={heroPhase === "shown" ? "hero" : "conversation"}
      // The composer steps aside while a voice session is open. It cannot be covered reliably - the panel is
      // narrower than the input it sits over - so it is taken out of the way instead, which is also what the
      // mode means: while the microphone is open, the thing you talk to is not the text box.
      data-voice-open={voiceOpen ? "true" : "false"}
      data-compact={compactSurface ? "true" : "false"}
      data-input-modality={modality}
      data-agent-state={agentState}
      data-window-mode={windowMode}
      data-policy-mode={policyMode}
      ref={shell}
      style={{ "--cc-orb-dock": "720px" } as CSSProperties}
    >
      <ConversationHeader
        client={client}
        connection={connection}
        backgroundTick={backgroundTick}
        // A new message may be an approval card or a question, which is what the mark counts first.
        inboxRefreshKey={`${inboxTick}:${blocks.length}`}
        shell={shell}
        orbProfile={orbProfile}
        onHome={() => appIntents.clickIntent("nav.home")}
        onOpenSettings={() => appIntents.clickIntent("settings.open")}
        onOpenInbox={() => appIntents.clickIntent("inbox.open")}
      />

      {/* Focusable as a fallback target: when the control that opened the live view is gone from the
          document, focus has to land somewhere meaningful rather than on the body. */}
      <div className="cc-body">
        <div className="cc-scroll" ref={scroller} tabIndex={-1}>
          <ConversationHeroEmptyState
            heroPhase={heroPhase}
            heroOrb={heroOrb}
            needsModel={needsModel}
            onOpenSettings={() => appIntents.setUiCheckOpen(true)}
            dynamicSuggestions={dynamicSuggestions}
            onSend={(text, options) => void send(text, options)}
          />

          {showTimeline && (
            <div className="cc-timeline" aria-live="polite" aria-relevant="additions">
              {blocks.map((message, index) => (
                <Fragment key={`${message.messageId}-${index}`}>
                  <TimelineMessageRow
                    message={message}
                    index={index}
                    renderSurface={renderSurface}
                    blockActions={blockActions}
                    client={client}
                    settled
                  />
                  {index === undoIndex && noticeUndoRow}
                </Fragment>
              ))}
              {/* Its reply is not on screen (a dismissal said while a reply was being written): it goes after the rest. */}
              {undoIndex === -1 && noticeUndoRow}

              {pendingUser !== undefined && (
                <article className="cc-row" data-role="user" data-pending="true" style={{ "--cc-enter-delay": "0ms" } as CSSProperties}>
                  <div className="cc-bubble" data-bubble="user">
                    <Markdown text={pendingUser.text} />
                  </div>
                </article>
              )}

              {busy && <ConversationLiveReplyRow live={live} />}
            </div>
          )}
        </div>

        <ConversationPinSurfaces
          client={client}
          conversationId={conversationId}
          pins={pins}
          instanceById={instanceById}
          liveRefresh={appIntents.liveRefresh}
          applyTimeline={applyTimeline}
          setError={setError}
          liveTrigger={liveTrigger}
          scroller={scroller}
          onAttachArtifact={(attachment) =>
            addStored({
              attachmentId: attachment.attachmentId,
              filename: attachment.filename,
              mime: attachment.mime,
              sizeBytes: attachment.sizeBytes,
            })
          }
        />

        <ConversationComposerBar
          composerWrap={composerWrap}
          composerInput={composerInput}
          attachmentInput={attachmentInput}
          dragging={dragging}
          setDragging={setDragging}
          addFiles={addFiles}
          chips={chips}
          onRemoveChip={(id) => dispatchChips({ type: "remove", id })}
          references={references}
          draft={draft}
          setDraft={setDraft}
          placeholder={placeholder}
          busy={busy || actionRunning}
          onSubmit={() => void send(draft)}
          onStop={() => {
            stopConversation();
            // Back to where the next message is written: the Stop button turns back into Send, which is disabled
            // on an empty draft and would otherwise leave focus on a control that does nothing.
            composerInput.current?.focus();
          }}
          onOpenVoice={() => void openVoice()}
          modelAlias={modelAlias}
          modelNote={modelNote}
          error={error}
          messages={timeline?.messages ?? []}
        />
      </div>

      {/*
        The window's own chrome, when there is a window to be dragged and resized. It renders nothing in a
        browser, so this is one line rather than a branch around the whole conversation.
      */}
      <DesktopChrome />
      <DotGrid />

      {/*
        The one orb. It is not two elements that swap places with a transition between them: it is a
        single canvas that moves, which is what makes the move look like one, and what keeps the
        shader's own animation continuous across the change of screen.
      */}
      {orbPlacement !== undefined && (
        <div className="cc-orb-stage">
          <div
            className="cc-stage-orb"
            data-docked={orbPlacement.docked ? "true" : "false"}
            style={{
              left: `${orbPlacement.x}px`,
              top: `${orbPlacement.y}px`,
              transform: `translate(-50%, -50%) scale(${orbPlacement.scale})`,
            }}
          >
            <Orb
              size={ORB_DRAW_SIZE}
              radius={ORB_RADIUS}
              className="cc-empty-orb"
              label={localeState.t("shell.hero.orbLabel")}
              maxPixelRatio={1.25}
              pointerTarget={shell}
              {...(orbProfile === undefined ? {} : { profile: orbProfile })}
            />
          </div>
        </div>
      )}

      {/*
        What a command could not do here, or why it was refused. Rendered beside the panel rather than inside it, so
        a window command failing in a browser is still visible when no panel is open.
      */}
      {appIntents.intentNotice !== undefined && (
        <p className="cc-intent-notice" data-intent-notice="true" role="status">
          {appIntents.intentNotice}
        </p>
      )}

      <SettingsPanel
        open={appIntents.uiCheckOpen}
        {...(appIntents.settingsTab === undefined ? {} : { openAt: appIntents.settingsTab })}
        themeGalleryRequest={appIntents.themeGalleryRequest}
        onClose={() => appIntents.setUiCheckOpen(false)}
        client={client}
        themeChoice={themeChoice}
        resolvedTheme={resolvedTheme}
        onThemeChoice={applyThemeChoice}
        appearance={appearance}
        {...(onOrbChange === undefined ? {} : { onOrbChange })}
        orbProfileKey={orbProfile?.key}
        onPolicyChange={refreshPolicyMode}
        onOpenWidgetLibrary={appIntents.openWidgetLibrary}
      />

      <InboxPanel
        open={appIntents.inboxOpen}
        onClose={() => appIntents.setInboxOpen(false)}
        client={client}
        conversationId={conversationId}
        onTimeline={applyTimeline}
        {...(onOpenConversation === undefined ? {} : { onOpenConversation })}
        onChanged={() => setInboxTick((tick) => tick + 1)}
        switchGuard={{ busy, voiceOpen, draftNonEmpty: draft.trim() !== "", hasAttachments: chips.length > 0 }}
        onAskClark={noticeActions.askClark}
        onAddToContext={noticeActions.addToContext}
        onReconcile={(effectId, outcome) => noticeActions.reconcile(effectId, outcome, "click")}
        onOpenSettings={appIntents.openSettings}
        refreshKey={inboxPanelRefresh}
        {...(appIntents.inboxTarget === undefined ? {} : { target: appIntents.inboxTarget })}
        onTargetShown={appIntents.clearInboxTarget}
      />

      {/* The Widget Library, beside the conversation rather than in place of it. */}
      <WidgetLibrarySurface
        state={appIntents.widgetLibrary}
        client={client}
        onAction={(action) => appIntents.setWidgetLibrary((current) => applyLibraryAction(current, action))}
      />

      {/*
        What a highlighted passage can be turned into.

        Beside the transcript rather than inside it, and beside the voice screen rather than within it: a selection
        belongs to the text on screen, not to whichever surface happens to be open over it.
      */}
      <SelectionToolbar
        container={scroller}
        onAttach={(text) => setDraft((current) => attachedPrompt(text, current))}
        onExplain={(text) => void send(explainPrompt(text, localeState.t))}
        canBackground={conversationId !== undefined}
        onBackground={async (text) => {
          if (conversationId === undefined) return;
          await client.startBackground({ conversationId, text });
          setBackgroundTick((tick) => tick + 1);
        }}
      />

      {voiceOpen && (
        <VoiceOverlay
          client={client}
          startCollapsed={compactSurface}
          {...(conversationId === undefined ? {} : { conversationId })}
          onAnswered={refreshTimeline}
          onProgress={scheduleVoiceRefresh}
          onAppIntent={appIntents.runIntent}
          onWidgetActionResult={appIntents.bumpLiveRefresh}
          {...(focusedInstanceId === undefined ? {} : { focusedInstanceId })}
          {...(orbProfile === undefined ? {} : { orbProfile })}
          onClose={({ focusComposer }) => {
            setVoiceOpen(false);
            if (focusComposer) composerInput.current?.focus();
          }}
        />
      )}
    </div>
    </LocaleProvider>
  );
}

