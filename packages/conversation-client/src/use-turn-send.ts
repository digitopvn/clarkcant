import { useCallback, useEffect, useRef, useState } from "react";

import { GatewayError, type GatewayClient, type ResolvedDataset, type SnapshotPresentationResponse, type Timeline } from "./api.ts";
import { readyAttachmentIds, type AttachmentChip } from "./attachments.ts";
import { liveReferences } from "./composer-trigger.ts";
import type { ChosenReference } from "./use-composer-references.ts";
import { applyLiveEvent, type LiveSegment } from "./live-reply.ts";
import { followScrollBehavior, followsBottom } from "./follow-bottom.ts";
import { performInMountedFrame } from "./frame-performs.ts";
import type { AppIntentDecision, ComposerReference } from "@clarkcant/contracts";

/** The node's own sentence for a refused send; the code in front of it belongs in a log, not the status line. */
function sendFailure(cause: unknown): string {
  if (cause instanceof GatewayError) return cause.reason;
  return cause instanceof Error ? cause.message : String(cause);
}

export interface TurnSendState {
  busy: boolean;
  error: string | undefined;
  setError: (message: string | undefined) => void;
  /** The message the user just sent, drawn before the node has confirmed anything about it. */
  pendingUser: { text: string } | undefined;
  /** The reply as it arrives, in the order the turn produces it. */
  live: LiveSegment[];
  /**
   * Sends a message. With `references`, the message is a standalone one a surface composed — "Ask Clark" about a
   * notice — carrying exactly those references and leaving the composer as it was: the draft, its chips and its
   * references are the person's, and a message they did not write must not send or clear them.
   */
  send: (text: string, options?: SendOptions) => Promise<void>;
  /**
   * Stops the reply being written, answering whether one was running.
   *
   * The send that is waiting on it is not abandoned: the node ends the stream with its own record, the partial reply
   * labelled as stopped, and that is what replaces the live text. Cancelling the request here instead would drop the
   * record and leave the reader guessing what the node kept.
   */
  stop: () => Promise<boolean>;
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

export interface SendOptions {
  demo?: boolean;
  references?: readonly ComposerReference[];
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
  /**
   * What the person chose after `/` or `@`. A send carries the ones whose token is in the text it sends, so a message
   * sent from a suggestion chip or a card never picks up a reference that belongs to the draft.
   */
  chosenReferences: readonly ChosenReference[];
  /** A send the node accepted used them up; a refused one keeps them, with the draft, for the next try. */
  onReferencesSent: () => void;
  beginHeroExit: () => void;
  resetHero: () => void;
  setDatasets: (datasets: Record<string, ResolvedDataset>) => void;
  setSnapshots: (snapshots: Record<string, SnapshotPresentationResponse>) => void;
  setPendingIntent: (decision: AppIntentDecision | undefined) => void;
  /**
   * Empties the composer draft once a send is accepted, and on a restart.
   *
   * A draft that outlives its send is one Enter away from sending the same message again, and in
   * Autonomous mode that repeats whatever the message asked for.
   */
  clearDraft: () => void;
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
  chosenReferences,
  onReferencesSent,
  beginHeroExit,
  resetHero,
  setDatasets,
  setSnapshots,
  setPendingIntent,
  clearDraft,
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
    const metrics = { scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, clientHeight: node.clientHeight };
    node.scrollTo({ top: node.scrollHeight, behavior: followScrollBehavior(metrics) });
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
    async (text: string, options: SendOptions = {}) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const standalone = options.references !== undefined;
      // A surface's own message waits for the reply being written; only something the person typed can be a command.
      if (busy && standalone) return;
      if (busy) {
        /*
         * A command typed while a reply is being written, "dừng lại" above all.
         *
         * The node decides whether the sentence is a command, the same way it does for a click or a spoken one, and
         * the answer is carried out by the one executor. Anything that is not a command keeps its text in the
         * composer as before: a second turn cannot start until this one ends.
         */
        if (conversationId === undefined) return;
        const decision = await client
          .sendAppIntent({ text: trimmed, source: "chat", conversationId })
          .catch(() => undefined);
        if (decision === undefined || decision.kind === "none") return;
        clearDraft();
        setPendingIntent(decision);
        return;
      }

      // A selected file still uploading must remain with this draft, rather than being silently omitted from a turn.
      if (!standalone && chips.some((chip) => chip.state === "checking")) return;

      setBusy(true);
      setError(undefined);
      // Cleared here, after the guard above: a send refused for being empty or for arriving while
      // another turn is busy keeps its text. A send that fails later gets it back from `onSendFailed`.
      if (!standalone) clearDraft();
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
        const attachmentIds = standalone ? [] : readyAttachmentIds(chips);
        const references = options.references ?? liveReferences(trimmed, chosenReferences).map((entry) => entry.ref);
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
              // An agent-issued app-control action is not a transcript segment: it is handed straight
              // to the same `pendingIntent` slot a typed command uses, so it reaches the one executor
              // (`runAppIntent`) rather than being replayed from `live` on a later render.
              if (event.type === "host-control") {
                setPendingIntent(event.decision);
                return;
              }
              // An action Clark asked a widget on this page to perform: handed to its mounted frame, and what the frame
              // answered is reported back, because the node is waiting to tell Clark. Not a transcript segment either.
              if (event.type === "widget-perform") {
                const request = event.request;
                void performInMountedFrame(request)
                  .then((report) => client.reportWidgetPerform(request.performId, report))
                  .catch(() => undefined);
                return;
              }
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
          { ...(options.demo === undefined ? {} : { demo: options.demo }), attachmentIds, references: [...references] },
        );
        // Cleared only after the send succeeded: a failed send leaves the chips stored on the node,
        // so the person can press send again rather than attaching the same file a second time.
        if (!standalone) {
          dispatchChips({ type: "sent" });
          onReferencesSent();
        }
      } catch (cause) {
        if (sessionGeneration.current !== generation) return;
        // The draft is restored so a failed send does not lose the user's text. A standalone message was never in it.
        if (!standalone) onSendFailed(trimmed);
        setPendingUser(undefined);
        setLive([]);
        setError(sendFailure(cause));
      } finally {
        setBusy(false);
      }
    },
    [
      applyTimeline,
      beginHeroExit,
      busy,
      chips,
      chosenReferences,
      clearDraft,
      client,
      conversationId,
      dispatchChips,
      onConversationReady,
      onReferencesSent,
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
    clearDraft();
    setError(undefined);
    setBusy(false);
    // Back to the start screen, with the orb returning to the middle: the phase is the same fact as
    // an empty timeline, and leaving it behind is what would strand the orb at the foot of the page.
    setPendingUser(undefined);
    setLive([]);
    onSessionReset?.();
  }, [clearDraft, onSessionReset, resetHero, setConversationId, setDatasets, setSnapshots, setTimeline]);

  const stop = useCallback(async (): Promise<boolean> => {
    // Nothing to stop before the conversation exists or once the reply has ended: a quiet no-op, not an error.
    if (!busy || conversationId === undefined) return false;
    try {
      return (await client.stopTurn(conversationId)).stopped;
    } catch (cause) {
      setError(sendFailure(cause));
      return false;
    }
  }, [busy, client, conversationId]);

  return { busy, error, setError, pendingUser, live, send, stop, restartSession, scroller };
}
