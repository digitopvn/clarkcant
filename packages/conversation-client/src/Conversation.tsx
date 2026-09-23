import { type CSSProperties, type ReactElement, useRef, useState } from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import { agentStateFrom } from "./input-modality.ts";
import type { ResolvedOrbProfile } from "./orb-profile.ts";
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
import { ConversationHeader } from "./ConversationHeader.tsx";
import { ConversationHeroEmptyState } from "./ConversationHeroEmptyState.tsx";
import { ConversationComposerBar } from "./ConversationComposerBar.tsx";
import { ConversationPinSurfaces } from "./ConversationPinSurfaces.tsx";
import { ConversationLiveReplyRow } from "./ConversationLiveReplyRow.tsx";
import { TimelineMessageRow } from "./TimelineMessageRow.tsx";
import { useTheme } from "./use-theme.ts";
import { useLocale } from "./i18n/use-locale.ts";
import { LocaleProvider } from "./i18n/locale-context.tsx";
import { useConnectionStatus } from "./use-connection-status.ts";
import { useModelAlias } from "./use-model-alias.ts";
import { useDynamicSuggestions } from "./use-dynamic-suggestions.ts";
import { useInputModalityState } from "./use-input-modality-state.ts";
import { useConversationTimeline } from "./use-conversation-timeline.ts";
import { useHeroOrbLayout, ORB_DRAW_SIZE, ORB_RADIUS } from "./use-hero-orb-layout.ts";
import { useAttachmentComposer } from "./use-attachment-composer.ts";
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
   * reload, and only the host that resolved the profile can re-resolve it.
   */
  onOrbChange?: () => void;
  /**
   * Whether this node has no model, so a turn that needs one would fail.
   *
   * Passed down rather than discovered here, because the answer comes from the node's own readiness report and
   * this surface has no business asking a second time. When it is true the empty state says what is missing and
   * offers the control that fixes it, which is the difference between a setup step and a dead end.
   */
  needsModel?: boolean;
}

/**
 * The questions the empty composer types at the user, one at a time.
 *
 * Asked as questions rather than shown as commands, because the empty state is a prompt for what to
 * say and a list of instructions reads as a menu of the only four things that work.
 */
const PLACEHOLDER_PHRASES = [
  "có cập nhật gì mới không?",
  "cần làm gì hôm nay?",
  "phân tích các commit gần nhất",
] as const;

export function Conversation({
  client,
  conversationId: initialConversationId,
  onTimelineChange,
  onConversationReady,
  onSessionReset,
  orbProfile,
  onOrbChange,
  needsModel,
}: ConversationProps): ReactElement {
  const modality = useInputModalityState();
  const connection = useConnectionStatus(client);
  const { themeChoice, resolvedTheme, applyThemeChoice } = useTheme();
  const localeState = useLocale();
  const { modelAlias, modelNote } = useModelAlias(client);
  const dynamicSuggestions = useDynamicSuggestions(client);

  const {
    conversationId,
    setConversationId,
    timeline,
    setTimeline,
    datasets,
    setDatasets,
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
  const [draft, setDraft] = useState("");

  /**
   * The control that opened the expanded live view.
   *
   * Focus has to come back somewhere specific when that view closes: a keyboard user who lands on
   * `<body>` after Escape has to re-navigate the whole page to get where they were.
   */
  const liveTrigger = useRef<HTMLElement | null>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  /** The hidden file input the `+` button opens, so the button itself is a real `<button>`. */
  const attachmentInput = useRef<HTMLInputElement>(null);

  useComposerTextareaHeight(composerInput, draft);

  const {
    chips,
    dispatchChips,
    dragging,
    setDragging,
    addFiles,
  } = useAttachmentComposer({
    client,
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
      onConversationReady?.(id);
    },
    onErrorCleared: () => setError(undefined),
  });

  const {
    busy,
    error,
    setError,
    pendingUser,
    live,
    send,
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
    beginHeroExit,
    resetHero,
    setDatasets,
    setSnapshots,
    setPendingIntent: (decision) => appIntents.setPendingIntent(decision),
    onSendFailed: (originalText) => setDraft(originalText),
  });

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
  });

  const appIntents = useAppIntentSurfaces({
    client,
    conversationId,
    restartSession,
    attachmentInput,
    setVoiceOpen,
  });

  /**
   * What the agent is doing, as one state rather than several flags a stylesheet would have to combine.
   *
   * Every input is a state a hook above already holds. Nothing is promoted to `success`: there is
   * no real completion signal here yet, and a state published without one is the interface
   * claiming to know something it does not.
   */
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
  });

  const renderSurface = useSurfaceRenderer({
    client,
    conversationId,
    timeline,
    instanceById,
    snapshots,
    datasets,
    imageUrl,
    applyTimeline,
    setError,
    liveTrigger,
  });

  const focusedInstanceId = pins.find((pin) => pin.displayMode === "expanded")?.instanceId;
  const placeholder = useTypewriterPlaceholder(PLACEHOLDER_PHRASES, heroPhase === "shown" && draft === "");
  const showTimeline = blocks.length > 0 || pendingUser !== undefined || busy;

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
      ref={shell}
      style={{ "--cc-orb-dock": "720px" } as CSSProperties}
    >
      <ConversationHeader
        client={client}
        connection={connection}
        backgroundTick={backgroundTick}
        shell={shell}
        orbProfile={orbProfile}
        onHome={() => appIntents.clickIntent("nav.home")}
        onOpenSettings={() => appIntents.clickIntent("settings.open")}
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
                <TimelineMessageRow
                  key={`${message.messageId}-${index}`}
                  message={message}
                  index={index}
                  renderSurface={renderSurface}
                  blockActions={blockActions}
                  client={client}
                  settled
                />
              ))}

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
          draft={draft}
          setDraft={setDraft}
          placeholder={placeholder}
          busy={busy}
          onSubmit={() => void send(draft)}
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
              label="Đang chờ bạn nói điều muốn làm"
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
        onClose={() => appIntents.setUiCheckOpen(false)}
        client={client}
        themeChoice={themeChoice}
        resolvedTheme={resolvedTheme}
        onThemeChoice={applyThemeChoice}
        {...(onOrbChange === undefined ? {} : { onOrbChange })}
        onOpenWidgetLibrary={appIntents.openWidgetLibrary}
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
        onExplain={(text) => void send(explainPrompt(text))}
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

