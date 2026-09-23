import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { AppIntentDecision, VoiceState } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";
import { Orb } from "./Orb.tsx";
import { VoiceUnavailable } from "./voice-unavailable.tsx";
import type { VoiceSession, VoiceTranscriptUpdate } from "./voice-session.ts";

/**
 * Voice, as its own screen.
 *
 * The session itself lived in a card inside settings, which was the wrong place for it twice over: a
 * settings panel is where configuration lives, and a voice conversation is not configuration; and the
 * microphone button in the composer was disabled with a tooltip, so the one control a user would press
 * to start talking was the one control that did nothing.
 *
 * This is the surface that button opens. It covers the conversation rather than sitting beside it,
 * because speaking and reading are different modes and a half-screen version of both is worse than
 * either — which is what the design reference asks for, including the waveform, the live transcript and
 * the three controls.
 *
 * Two states are honest rather than decorative: the waveform is driven by the loudness of actual frames
 * in both directions, so it moves when the microphone hears something and when the model speaks, and a
 * session with no node behind it says what is missing instead of showing a microphone that records
 * nothing.
 */

/** How many bars the waveform has. The design's number, and it is what fits the width at this size. */
export const WAVEFORM_BARS = 23;

/**
 * The bar heights for a history of levels, tallest in the middle.
 *
 * The envelope is what makes a waveform read as one: a row of bars that all follow the same number is a
 * level meter, and a level meter is not what the design draws. The newest level is the loudest the bars
 * get, and the taper towards the ends is fixed, so the shape stays recognisable while the sound changes.
 *
 * Pure, so the shape can be asserted without an audio device.
 */
export function waveformBars(levels: readonly number[], count = WAVEFORM_BARS): number[] {
  const middle = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    // Newest samples at the ends so the row reads as a wave passing through, oldest in the middle.
    const sample = levels[levels.length - 1 - Math.abs(index - middle)] ?? 0;
    const envelope = 1 - Math.abs(index - middle) / (middle + 1);
    // A floor so the row is always visible: silence is still a microphone that is open.
    return Math.max(0.06, Math.min(1, sample) * (0.35 + 0.65 * envelope));
  });
}

const STATE_WORD_KEYS: Record<VoiceState, MessageKey> = {
  idle: "voice.state.idle",
  connecting: "voice.state.connecting",
  listening: "voice.state.listening",
  thinking: "voice.state.thinking",
  speaking: "voice.state.speaking",
  reconnecting: "voice.state.reconnecting",
  ended: "voice.state.ended",
  failed: "voice.state.failed",
};

/**
 * Fold one transcript update into what is on screen.
 *
 * A non-final update is the same sentence still being written, and it carries the text so far rather than a
 * fragment to append - so it replaces the entry before it. Appending instead produces a wall of fragments,
 * each one the answer as it stood a moment ago, which is what "streaming" looks like when it is done wrong.
 */
export function foldTranscriptUpdate(
  current: readonly VoiceTranscriptUpdate[],
  update: VoiceTranscriptUpdate,
): VoiceTranscriptUpdate[] {
  const last = current[current.length - 1];
  if (update.final || last === undefined || last.role !== update.role || last.final) {
    return [...current, update];
  }
  return [...current.slice(0, -1), update];
}

export interface VoiceOverlayProps {
  /** Absent when this surface has no node to talk to; it can then only describe the gap. */
  client?: GatewayClient;
  /** Omitted before the first message of a conversation; the node then records nothing. */
  conversationId?: string;
  /** Leaves the voice mode. The session is ended with it, never left recording behind a closed view. */
  onClose: (intent: { focusComposer: boolean }) => void;
  /**
   * The conversation gained a message while this session was open.
   *
   * The voice socket writes its messages through the same turn a typed message takes, but it is a
   * different socket: nothing on it draws the conversation, so the surface that owns the timeline has to
   * be told to read it again.
   */
  onAnswered?: () => void;
  /**
   * Called while a spoken turn is still running, so the conversation behind the overlay can show the message
   * and the answer as they arrive rather than all at once at the end.
   *
   * Separate from `onAnswered` because the two have different weights: this one fires per transcript update
   * and the caller is expected to throttle it, while `onAnswered` fires once and is the end of the turn.
   */
  onProgress?: () => void;
  /**
   * A decision the node made about a command spoken during this session.
   *
   * Handed to whoever owns the executor rather than acted on here: one function runs an intent whether it came from
   * a click or a voice, and this overlay is deliberately not that function.
   */
  onAppIntent?: (decision: AppIntentDecision) => void;
  /**
   * A spoken widget action has run on the node; the host should re-read the surface. Typed structurally so this prop
   * does not depend on the session module's exported shape.
   */
  onWidgetActionResult?:
    | ((result: { ok: boolean; say: string; instanceId?: string | undefined; revision?: number | undefined }) => void)
    | undefined;
  /**
   * The widget on screen, if any.
   *
   * An id, because the node builds the view it decides against from what it holds. Passed down rather than read from
   * the client here: this overlay owns the microphone, and what is on screen belongs to the surface behind it.
   */
  focusedInstanceId?: string | undefined;
  /**
   * Start out of the way, showing only the bar.
   *
   * The collapsed presentation is what the desktop window becomes when it shrinks, and this is how a browser can
   * be put into it too - without pretending to have a shell, and without the test inventing a second bar.
   */
  startCollapsed?: boolean | undefined;
  requires?: string;
  unblockedBy?: string;
}

export function VoiceOverlay({
  client,
  conversationId,
  onClose,
  onAnswered,
  onProgress,
  onAppIntent,
  onWidgetActionResult,
  focusedInstanceId,
  startCollapsed = false,
  requires,
  unblockedBy,
}: VoiceOverlayProps): ReactElement {
  const t = useT();
  const effectiveRequires = requires ?? t("voice.defaultRequires");
  const effectiveUnblockedBy = unblockedBy ?? t("voice.defaultUnblockedBy");
  const [state, setState] = useState<VoiceState>("connecting");
  const [muted, setMuted] = useState(false);
  /**
   * Whether the session is out of the way.
   *
   * The session keeps running while it is collapsed: this hides the body, not the microphone.
   */
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /**
   * The credential the node refused the session for, when it refused for one.
   *
   * A refusal is not the same as a failure: a node with no key for the live provider is asking a question, and the
   * person can answer it here rather than reading that voice does not work and guessing why.
   */
  const [needsKey, setNeedsKey] = useState<string | undefined>(undefined);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | undefined>(undefined);
  /**
   * A sentence the agent could not answer.
   *
   * Kept apart from `problem`, which means the session itself failed: this one leaves the microphone
   * open and the next sentence gets its own attempt, so it must not read as a broken session.
   */
  const [answerProblem, setAnswerProblem] = useState<string | undefined>(undefined);
  const [utterances, setUtterances] = useState<VoiceTranscriptUpdate[]>([]);
  const [recordedMessages, setRecordedMessages] = useState<number | undefined>(undefined);
  const [bars, setBars] = useState<number[]>(() => waveformBars([0, 0, 0, 0, 0]));
  const [level, setLevel] = useState(0);
  /**
   * Frame counts in both directions.
   *
   * Published as attributes because "the microphone is open" and "audio is actually moving" are
   * different claims, and only the second one is a working session. The browser suite reads them; a
   * person debugging a silent session reads them.
   */
  const [frames, setFrames] = useState({ captured: 0, heard: 0 });

  const sessionRef = useRef<VoiceSession | undefined>(undefined);
  /**
   * Tell the node which widget is on screen.
   *
   * Sent when the session appears and whenever the focus changes. The session state is in the dependencies because the
   * session comes into existence after this component has already rendered: without it, a session opened while a
   * surface was already up would never say so, and the first spoken action on that widget would be answered with
   * "nothing is open" - a wrong answer that looks exactly like a working one.
   */
  useEffect(() => {
    sessionRef.current?.focus(focusedInstanceId);
  }, [focusedInstanceId, state]);
  /** Rolling levels, newest last. A ref because it is read per frame and only summarised into bars. */
  const levels = useRef<number[]>(new Array(WAVEFORM_BARS).fill(0));

  const endSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = undefined;
    void session?.end().catch(() => undefined);
    setMuted(false);
  }, []);

  // A surface that unmounts mid-session must not leave the microphone open: leaving the voice view is
  // the moment the recording stops, whether the user ended it or navigated away.
  useEffect(() => endSession, [endSession]);

  const startingRef = useRef(false);
  const start = useCallback((): void => {
    /*
     * One session per request, guarded synchronously.
     *
     * `sessionRef` is only assigned once the session has actually opened, so a second call arriving while the first
     * was still connecting passed the check and opened a second socket. In development React mounts an effect twice,
     * which made that the rule rather than the exception: measured in a real browser, one click produced two voice
     * sessions, the second refused `VOICE_SESSION_BUSY`, with the surface still reading that it was listening. The guard
     * is therefore set before anything is awaited, and cleared wherever an attempt ends.
     */
    if (client === undefined || startingRef.current || sessionRef.current !== undefined) return;
    /*
     * A session with no conversation cannot answer.
     *
     * The node answers a spoken sentence inside the conversation the agent works in, so without one it transcribes the
     * sentence and drops it: no reply, no error, and a surface that looks like it is listening. Saying so here is the
     * difference between a person who knows what is missing and a person who reports that voice does not work.
     */
    if (conversationId === undefined) {
      setProblem(t("voice.noSessionNoConversation"));
      setState("failed");
      return;
    }
    startingRef.current = true;
    setProblem(undefined);
    setAnswerProblem(undefined);
    setRecordedMessages(undefined);
    setUtterances([]);
    levels.current = new Array(WAVEFORM_BARS).fill(0);
    setState("connecting");

    void client
      .openVoiceSession({
        ...(conversationId === undefined ? {} : { conversationId }),
        events: {
          onState: setState,
          onTranscript: (update) => {
            // A transcript means the path is working again, so a failure from an earlier sentence is
            // no longer news.
            setAnswerProblem(undefined);
            setUtterances((current) => foldTranscriptUpdate(current, update));
            //
            // The conversation is re-read as the turn runs, not only when it ends.
            //
            // It used to be read once, at the end, on the reasoning that a stored message is the record and a
            // delta is not. True, and beside the point: someone who has just spoken sees nothing at all until
            // the whole turn finishes, which reads as the interface having ignored them. The caller throttles
            // this, so "as it arrives" costs a handful of reads per turn rather than one per token.
            onProgress?.();
            if (update.role === "assistant" && update.final) onAnswered?.();
          },
          onLevel: ({ level: heard }) => {
            const history = levels.current;
            //
            // Held for a few frames rather than shown for one.
            //
            // The session reports a level for the microphone and for its own voice, and audio arrives in bursts:
            // a bar that falls straight back to zero between them is a bar that looks broken while the thing it
            // is following is still talking - which is what the reading voice looked like.
            const previous = history[history.length - 1] ?? 0;
            history.push(Math.max(heard, previous * 0.6));
            if (history.length > WAVEFORM_BARS) history.shift();
            setLevel(heard);
            setBars(waveformBars(history));
          },
          onCaptureFrame: (sent) => setFrames((current) => ({ ...current, captured: sent })),
          onAnswerFailed: (failure) => setAnswerProblem(failure.message),
          ...(onAppIntent === undefined ? {} : { onAppIntent }),
          ...(onWidgetActionResult === undefined ? {} : { onWidgetActionResult }),
          onAudioFrame: (received) => setFrames((current) => ({ ...current, heard: received })),
          onError: (message) => {
            setProblem(message);
            setState("failed");
            sessionRef.current = undefined;
            startingRef.current = false;
          },
          onRefused: (refusal) => {
            // Only the refusal that has something to do about it sets this: the name comes from the node, so the field
            // asks for the credential the node actually wants rather than for one this code assumes.
            if (refusal.reason === "missing-credential" && refusal.credentialName !== undefined) {
              setNeedsKey(refusal.credentialName);
            }
          },
          onEnded: (count) => {
            setRecordedMessages(count);
            setState("ended");
            sessionRef.current = undefined;
            startingRef.current = false;
            // A sentence the agent could not answer is still written, by the fallback, when the session
            // closes. Asking once more here is what makes that visible without a reload.
            onAnswered?.();
          },
        },
      })
      .then((session) => {
        sessionRef.current = session;
        startingRef.current = false;
        setState(session.state);
      })
      .catch((cause: unknown) => {
        // The node's refusal is worded for a person, so it is shown as it arrived.
        setProblem(cause instanceof Error ? cause.message : t("voice.startFailedGeneric"));
        setState("failed");
        sessionRef.current = undefined;
        startingRef.current = false;
      });
  }, [client, conversationId, onAnswered, t]);

  // Opening the view is the act of starting to talk: the button that opened it said "voice", and a
  // surface that then waits for a second confirmation is a step nobody asked for.
  useEffect(() => {
    start();
  }, [start]);

  const toggleMute = useCallback((): void => {
    const next = !muted;
    setMuted(next);
    sessionRef.current?.setMuted(next);
  }, [muted]);

  const live = state === "listening" || state === "speaking" || state === "thinking" || state === "connecting" || state === "reconnecting";
  const latestUser = [...utterances].reverse().find((utterance) => utterance.role === "user");
  const latestAgent = [...utterances].reverse().find((utterance) => utterance.role === "assistant");

  if (client === undefined) {
    return (
      <div className="cc-voice-scrim" role="presentation" onClick={() => onClose({ focusComposer: true })}>
        <div className="cc-voice" role="dialog" aria-modal="true" aria-label={t("voice.dialogLabel")} data-voice-state="unavailable" onClick={(event) => event.stopPropagation()}>
          <div className="cc-voice-body">
            <VoiceUnavailable requires={effectiveRequires} unblockedBy={effectiveUnblockedBy} />
            <div className="cc-voice-controls">
              <button type="button" className="cc-voice-action" data-voice-type-instead="true" onClick={() => onClose({ focusComposer: true })}>
                <span className="cc-voice-action-icon" aria-hidden="true">⌨</span>
                {t("voice.typeInstead")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-voice-scrim" role="presentation" data-voice-collapsed={collapsed ? "true" : "false"}>
      <section
        className="cc-voice"
        role="dialog"
        aria-modal="true"
        aria-label={t("voice.dialogLabel")}
        data-voice-state={state}
        data-voice-level={level.toFixed(2)}
        data-voice-capture-frames={frames.captured}
        data-voice-audio-frames={frames.heard}
      >
        <header className="cc-voice-head">
          <div className="cc-brand">
            <Orb size={22} className="cc-orb" label="" />
            <span>ClarkCant</span>
          </div>
          <div className="cc-voice-status">
            <span className="cc-dot" data-state={muted ? "connecting" : live ? "ready" : "offline"} aria-hidden="true" />
            <span data-voice-state-label={state}>{muted && live ? t("voice.micOff") : t(STATE_WORD_KEYS[state])}</span>
          </div>
        </header>

        <div className="cc-voice-body">
          <div className="cc-voice-orb" data-voice-orb="true" style={{ transform: `scale(${(1 + level * 0.06).toFixed(3)})` }}>
            <Orb size={190} className="cc-voice-orb-canvas" label="" />
          </div>

          <h1 className="cc-voice-headline">
            {state === "failed"
              ? t("voice.headline.failed")
              : state === "ended"
                ? t("voice.headline.ended")
                : muted
                  ? t("voice.micOff")
                  : t("voice.headline.listening")}
          </h1>
          <p className="cc-voice-sub">{muted ? t("voice.sub.muted") : t("voice.sub.active")}</p>

          <div className="cc-voice-wave" data-voice-wave="true" aria-hidden="true">
            {bars.map((height, index) => (
              // `transform: scaleY()` rather than `height`: the bar's box stays full height and only the
              // paint scales, which the browser can animate without laying the row out again every frame.
              <span key={index} className="cc-voice-bar" style={{ transform: `scaleY(${height.toFixed(3)})` }} />
            ))}
          </div>

          {problem !== undefined && (
            <p className="cc-voice-problem" data-voice-problem="true">
              {problem} — {effectiveUnblockedBy}
            </p>
          )}
          {needsKey !== undefined && client !== undefined && (
            <form
              className="cc-credential-form"
              data-voice-key-ask={needsKey}
              onSubmit={(event) => {
                event.preventDefault();
                const value = keyDraft.trim();
                if (value === "") return;
                const name = needsKey;
                client
                  .putCredential({ fields: [{ name, value }] })
                  .then((result) => {
                    // The draft is cleared the moment it is sent, and only the name comes back: the node never hands a
                    // secret back, so there is nothing here to show a second time.
                    setKeyDraft("");
                    setKeyStatus(
                      result.names.includes(name)
                        ? t("voice.keySaved")
                        : t("voice.keySentNoName"),
                    );
                  })
                  .catch(() => setKeyStatus(t("voice.keySaveFailed")));
              }}
            >
              <label className="cc-credential-field">
                <span>{t("voice.credentialLabel").replace("{name}", needsKey)}</span>
                <input
                  type="password"
                  name={needsKey}
                  autoComplete="off"
                  data-voice-key-field={needsKey}
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="cc-voice-action"
                disabled={keyDraft.trim() === ""}
                data-voice-key-submit="true"
              >
                {t("voice.saveKey")}
              </button>
            </form>
          )}
          {keyStatus !== undefined && (
            <p className="cc-freshness" data-voice-key-status="true">
              {keyStatus}
            </p>
          )}

          {problem === undefined && answerProblem !== undefined && (
            <p className="cc-voice-problem" data-voice-answer-problem="true">
              {t("voice.answerProblem").replace("{message}", answerProblem)}
            </p>
          )}

          {problem === undefined && latestUser !== undefined && (
            <p className="cc-voice-transcript" data-voice-transcript="true">
              “{latestUser.text === "" ? "…" : latestUser.text}”
            </p>
          )}
          {problem === undefined && latestAgent !== undefined && (
            <p className="cc-voice-transcript-agent" data-voice-transcript-agent="true">
              {latestAgent.text}
            </p>
          )}

          {state === "ended" && (
            <p className="cc-voice-note" data-voice-ended="true">
              {recordedMessages === 0
                ? t("voice.endedNone")
                : t("voice.endedCount").replace("{count}", String(recordedMessages))}
            </p>
          )}
          {live && conversationId !== undefined && (
            <p className="cc-voice-note" data-voice-records-as-spoken="true">
              {t("voice.recordsAsSpoken")}
            </p>
          )}
          {live && conversationId === undefined && (
            <p className="cc-voice-note" data-voice-will-record="false">
              {t("voice.willNotRecord")}
            </p>
          )}
        </div>

        <footer className="cc-voice-controls">
          <button
            type="button"
            className="cc-voice-action"
            data-voice-mute="true"
            data-muted={muted ? "true" : "false"}
            aria-label={muted ? t("voice.unmute") : t("voice.mute")}
            onClick={toggleMute}
            disabled={!live}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">{muted ? "🎙" : "🔇"}</span>
            <span className="cc-voice-action-text">{muted ? t("voice.unmute") : t("voice.mute")}</span>
          </button>
          <button
            type="button"
            className="cc-voice-action"
            data-voice-minimize="true"
            aria-pressed={collapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("voice.expand") : t("voice.collapse")}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">{collapsed ? "▣" : "▭"}</span>
            <span className="cc-voice-action-text">{collapsed ? t("voice.expand") : t("voice.collapse")}</span>
          </button>
          <button
            type="button"
            className="cc-voice-action cc-voice-action-end"
            data-voice-end="true"
            aria-label={t("voice.end")}
            onClick={() => {
              endSession();
              onClose({ focusComposer: false });
            }}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">✕</span>
            <span className="cc-voice-action-text">{t("voice.end")}</span>
          </button>
          <button
            type="button"
            className="cc-voice-action"
            data-voice-type-instead="true"
            onClick={() => {
              endSession();
              onClose({ focusComposer: true });
            }}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">⌨</span>
            {t("voice.typeInstead")}
          </button>
        </footer>
      </section>
    </div>
  );
}
