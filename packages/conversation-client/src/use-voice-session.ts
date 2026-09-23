import { useCallback, useEffect, useRef, useState } from "react";

import type { GatewayClient } from "./api.ts";

/** How often the conversation is re-read while a spoken turn runs, at most. */
const VOICE_REFRESH_INTERVAL_MS = 400;

export interface VoiceSessionState {
  /**
   * Whether the voice surface is up.
   *
   * Opened from the composer's microphone button. Speaking is a mode of the conversation, so it
   * belongs here rather than behind a disabled control.
   */
  voiceOpen: boolean;
  setVoiceOpen: (open: boolean) => void;
  /**
   * Whether this window is showing the compact surface only.
   *
   * A test hook, and named as one: `?cc-compact=1` puts a browser into the presentation the
   * desktop window takes when it shrinks, so the browser suite can prove that surface without
   * pretending to have a shell. Nothing changes it, because the real path into it is the window
   * resizing rather than anything in the document.
   */
  compactSurface: boolean;
  /**
   * Opens the voice surface, with a conversation for it to answer in.
   *
   * The node answers a spoken sentence inside the conversation the agent works in, so a session
   * opened before any conversation exists has nowhere to put what was said. So the conversation is
   * made first, which is also what the first attachment does.
   */
  openVoice: () => Promise<void>;
  /**
   * The same conversation read as `refreshTimeline`, throttled to run while a spoken turn is still
   * live.
   *
   * A sentence someone has just spoken should appear as a message, and the answer should grow as
   * it is written, instead of both arriving when the turn ends. Throttled, because the transcript
   * updates per delta and reading the whole conversation per delta would be a request storm that
   * adds no information.
   */
  scheduleVoiceRefresh: () => void;
}

export interface VoiceSessionDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  onConversationCreated: (conversationId: string) => void;
  onOpenFailed: (message: string) => void;
  refreshTimeline: () => void;
}

export function useVoiceSession({
  client,
  conversationId,
  onConversationCreated,
  onOpenFailed,
  refreshTimeline,
}: VoiceSessionDeps): VoiceSessionState {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [compactSurface] = useState(
    () => new URLSearchParams(window.location.search).get("cc-compact") === "1",
  );
  const voiceRefreshTimer = useRef<number | undefined>(undefined);

  const scheduleVoiceRefresh = useCallback((): void => {
    if (voiceRefreshTimer.current !== undefined) return;
    voiceRefreshTimer.current = window.setTimeout(() => {
      voiceRefreshTimer.current = undefined;
      refreshTimeline();
    }, VOICE_REFRESH_INTERVAL_MS);
  }, [refreshTimeline]);

  useEffect(
    () => () => {
      if (voiceRefreshTimer.current !== undefined) window.clearTimeout(voiceRefreshTimer.current);
    },
    [],
  );

  const openVoice = useCallback(async (): Promise<void> => {
    if (conversationId !== undefined) {
      setVoiceOpen(true);
      return;
    }
    try {
      const target = (await client.createConversation("Conversation")).conversationId;
      onConversationCreated(target);
      setVoiceOpen(true);
    } catch (cause) {
      // Said where the person is looking, and the microphone stays off: a session that cannot
      // answer is worse than an honest refusal.
      onOpenFailed(
        cause instanceof Error ? `Không mở được phiên giọng nói: ${cause.message}` : "Không mở được phiên giọng nói.",
      );
    }
  }, [client, conversationId, onConversationCreated, onOpenFailed]);

  /*
   * The compact surface opens voice by itself.
   *
   * A desktop window shrinking to the voice bar is the same act as pressing the voice button, so
   * it goes through the same path and gets a conversation to answer in.
   */
  useEffect(() => {
    if (compactSurface) void openVoice();
  }, [compactSurface, openVoice]);

  return { voiceOpen, setVoiceOpen, compactSurface, openVoice, scheduleVoiceRefresh };
}
