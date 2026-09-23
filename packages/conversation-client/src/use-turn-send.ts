import { useCallback, useEffect, useRef, useState } from "react";

import type { GatewayClient, ResolvedDataset, SnapshotPresentationResponse, Timeline } from "./api.ts";
import { readyAttachmentIds, type AttachmentChip } from "./attachments.ts";
import { applyLiveEvent, type LiveSegment } from "./live-reply.ts";
import { followsBottom } from "./follow-bottom.ts";
import type { AppIntentDecision } from "@clarkcant/contracts";

export interface TurnSendState {
  busy: boolean;
  error: string | undefined;
  setError: (message: string | undefined) => void;
  /** The message the user just sent, drawn before the node has confirmed anything about it. */
  pendingUser: { text: string } | undefined;
  /** The reply as it arrives, in the order the turn produces it. */
  live: LiveSegment[];
  send: (text: string, options?: { demo?: boolean }) => Promise<void>;
  /**
   * Back to the start screen, with a new session.
   *
   * Deliberately not a delete: the conversation stays in the node's history, because that is a
   * record of what happened rather than a draft to discard. This only stops the interface from
   * showing it, and the next message opens a new one.
   */
  restartSession: () => void;
  /** The scroll container, and the reader's own decision to follow the bottom or not. */
  scroller: React.RefObject<HTMLDivElement | null>;
}

export interface TurnSendDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  setConversationId: (id: string | undefined) => void;
  onConversationReady: ((conversationId: string) => void) | undefined;
  onSessionReset: (() => void) | undefined;
  applyTimeline: (next: Timeline) => void;
  timeline: Timeline | undefined;
  setTimeline: (timeline: Timeline | undefined) => void;
  chips: readonly AttachmentChip[];
  dispatchChips: (action: { type: "sent" }) => void;
  beginHeroExit: () => void;
  resetHero: () => void;
  setDatasets: (datasets: Record<string, ResolvedDataset>) => void;
  setSnapshots: (snapshots: Record<string, SnapshotPresentationResponse>) => void;
  setPendingIntent: (decision: AppIntentDecision | undefined) => void;
  /** A failed send restores the user's text to the composer draft, so nothing typed is lost. */
  onSendFailed: (originalText: string) => void;
}

/**
 * Sending a turn, and everything that follows from having sent one.
 *
 * The busy flag, the placeholder the user's own message draws as, the reply as it streams in, and
 * the scroll position's own decision to follow it or not, are one lifecycle: they start together
 * when `send` is called and they end together when the node answers or refuses. Splitting them
 * further would mean threading the same session generation guard through several hooks instead of
 * one.
 */
export function useTurnSend({
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
  setPendingIntent,
  onSendFailed,
}: TurnSendDeps): TurnSendState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pendingUser, setPendingUser] = useState<{ text: string } | undefined>(undefined);
  const [live, setLive] = useState<LiveSegment[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  /**
   * Whether the reader is at the bottom of the transcript.
   *
   * Following is something the reader chooses by being at the bottom, not a property of the
   * transcript: a streamed answer grows on every delta, and a view that follows it unconditionally
   * pulls the page back down each time someone scrolls up to read what came before.
   */
  const followBottom = useRef(true);
  /**
   * Which session the interface is showing.
   *
   * Incremented by a restart, and captured by anything that is about to write a result back. A
   * reply that arrives after the user restarted belongs to a conversation they have left, so it is
   * dropped rather than drawn into the fresh start screen.
   */
  const sessionGeneration = useRef(0);

  useEffect(() => {
    const node = scroller.current;
    if (node === null || !followBottom.current) return;
    node.scrollTop = node.scrollHeight;
    // The streamed reply is as much a reason to follow the bottom as a stored message is: without
    // it the answer grows below the fold while the view stays where the question was. It is
    // conditional because that is a reason to follow, not a licence to interrupt someone reading
    // further up.
  }, [live, pendingUser, timeline]);

  /* Reading away from the bottom stops the following; coming back to it starts it again. */
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const onScroll = (): void => {
      followBottom.current = followsBottom({
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  const send = useCallback(
    async (text: string, options: { demo?: boolean } = {}) => {
      const trimmed = text.trim();
      if (trimmed === "" || busy) return;

      setBusy(true);
      setError(undefined);
      // Drawn from here rather than from the node's answer: the user's own message is not in
      // doubt, and waiting for the round trip to show it makes the interface feel slower than it
      // is.
      setPendingUser({ text: trimmed });
      // Sending is a decision to be at the newest turn, whatever the view was doing before it.
      followBottom.current = true;
      setLive([]);
      beginHeroExit();
      const generation = sessionGeneration.current;
      try {
        const attachmentIds = readyAttachmentIds(chips);
        const target = conversationId ?? (await client.createConversation("Conversation")).conversationId;
        // The user may have restarted while the conversation was being created or the model was
        // answering. Everything after this point belongs to the session they left.
        if (sessionGeneration.current !== generation) return;
        if (conversationId === undefined) {
          setConversationId(target);
          onConversationReady?.(target);
        }
        await client.streamMessage(
          target,
          trimmed,
          {
            onEvent: (event) => {
              if (sessionGeneration.current !== generation) return;
              setLive((segments) => applyLiveEvent(segments, event));
            },
            onDone: (result) => {
              if (sessionGeneration.current !== generation) return;
              // The node's own record replaces both placeholders in one update, so the reply is
              // never on screen twice: the stored message and the text that stood in for it change
              // together.
              applyTimeline(result.timeline);
              setPendingUser(undefined);
              setLive([]);
              // A command is answered by the host and not by a model, so the node sends the
              // decision along with the record. `none` means the text was not a command at all and
              // the turn above was the real answer.
              if (result.appIntent !== undefined && result.appIntent.kind !== "none") {
                setPendingIntent(result.appIntent);
              }
            },
          },
          { ...options, attachmentIds },
        );
        // Cleared only after the send succeeded: a failed send leaves the chips stored on the node,
        // so the person can press send again rather than attaching the same file a second time.
        dispatchChips({ type: "sent" });
      } catch (cause) {
        if (sessionGeneration.current !== generation) return;
        // The draft is restored so a failed send does not lose the user's text.
        onSendFailed(trimmed);
        setPendingUser(undefined);
        setLive([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [
      applyTimeline,
      beginHeroExit,
      busy,
      chips,
      client,
      conversationId,
      dispatchChips,
      onConversationReady,
      onSendFailed,
      setConversationId,
      setPendingIntent,
    ],
  );

  const restartSession = useCallback((): void => {
    // Measured first, so the composer's return to the middle of the screen is a move rather than a
    // jump: a restart is the same layout change in the opposite direction.
    resetHero();
    sessionGeneration.current += 1;
    setConversationId(undefined);
    setTimeline(undefined);
    setDatasets({});
    setSnapshots({});
    setError(undefined);
    setBusy(false);
    // Back to the start screen, with the orb returning to the middle: the phase is the same fact as
    // an empty timeline, and leaving it behind is what would strand the orb at the foot of the page.
    setPendingUser(undefined);
    setLive([]);
    onSessionReset?.();
  }, [onSessionReset, resetHero, setConversationId, setDatasets, setSnapshots, setTimeline]);

  return { busy, error, setError, pendingUser, live, send, restartSession, scroller };
}
