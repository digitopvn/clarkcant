import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { AppIntentDecision, VoiceState } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
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

const STATE_WORDS: Record<VoiceState, string> = {
  idle: "Chưa bắt đầu",
  connecting: "Đang kết nối",
  listening: "Đang nghe",
  thinking: "Đang xử lý",
  speaking: "Đang nói",
  reconnecting: "Đang kết nối lại",
  ended: "Đã kết thúc",
  failed: "Không mở được",
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
  requires = "một phiên Live API đang mở",
  unblockedBy = "đặt GEMINI_API_KEY cho node rồi thử lại",
}: VoiceOverlayProps): ReactElement {
  const [state, setState] = useState<VoiceState>("connecting");
  const [muted, setMuted] = useState(false);
  /**
   * Whether the session is out of the way.
   *
   * The session keeps running while it is collapsed: this hides the body, not the microphone.
   */
  const [collapsed, setCollapsed] = useState(false);
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

  const start = useCallback((): void => {
    if (client === undefined || sessionRef.current !== undefined) return;
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
          onAudioFrame: (received) => setFrames((current) => ({ ...current, heard: received })),
          onError: (message) => {
            setProblem(message);
            setState("failed");
            sessionRef.current = undefined;
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
            // A sentence the agent could not answer is still written, by the fallback, when the session
            // closes. Asking once more here is what makes that visible without a reload.
            onAnswered?.();
          },
        },
      })
      .then((session) => {
        sessionRef.current = session;
        setState(session.state);
      })
      .catch((cause: unknown) => {
        // The node's refusal is worded for a person, so it is shown as it arrived.
        setProblem(cause instanceof Error ? cause.message : "không mở được phiên giọng nói");
        setState("failed");
        sessionRef.current = undefined;
      });
  }, [client, conversationId, onAnswered]);

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
        <div className="cc-voice" role="dialog" aria-modal="true" aria-label="Giọng nói" data-voice-state="unavailable" onClick={(event) => event.stopPropagation()}>
          <div className="cc-voice-body">
            <VoiceUnavailable requires={requires} unblockedBy={unblockedBy} />
            <div className="cc-voice-controls">
              <button type="button" className="cc-voice-action" data-voice-type-instead="true" onClick={() => onClose({ focusComposer: true })}>
                <span className="cc-voice-action-icon" aria-hidden="true">⌨</span>
                Viết thay vì nói
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
        aria-label="Giọng nói"
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
            <span data-voice-state-label={state}>{muted && live ? "Micro đang tắt" : STATE_WORDS[state]}</span>
          </div>
        </header>

        <div className="cc-voice-body">
          <div className="cc-voice-orb" data-voice-orb="true" style={{ transform: `scale(${(1 + level * 0.06).toFixed(3)})` }}>
            <Orb size={190} className="cc-voice-orb-canvas" label="" />
          </div>

          <h1 className="cc-voice-headline">
            {state === "failed" ? "Không mở được phiên" : state === "ended" ? "Đã kết thúc" : muted ? "Micro đang tắt" : "Tui đang nghe."}
          </h1>
          <p className="cc-voice-sub">
            {muted
              ? "Bật micro lại khi bạn sẵn sàng."
              : "Cứ nói tự nhiên. Bạn có thể ngắt lời tui bất cứ lúc nào."}
          </p>

          <div className="cc-voice-wave" data-voice-wave="true" aria-hidden="true">
            {bars.map((height, index) => (
              <span key={index} className="cc-voice-bar" style={{ height: `${Math.round(height * 100)}%` }} />
            ))}
          </div>

          {problem !== undefined && (
            <p className="cc-voice-problem" data-voice-problem="true">
              {problem} — {unblockedBy}
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
                        ? "Đã lưu khoá. Mở lại giọng nói để dùng nó."
                        : "Đã gửi, nhưng node không ghi nhận tên khoá nào.",
                    );
                  })
                  .catch(() => setKeyStatus("Không lưu được khoá. Thử lại."));
              }}
            >
              <label className="cc-credential-field">
                <span>Khoá cho {needsKey}</span>
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
                Lưu khoá
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
              Câu vừa rồi chưa trả lời được: {answerProblem}. Cứ nói tiếp, câu sau sẽ được thử lại.
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
                ? "Phiên đã kết thúc; không có nội dung nào được ghi vào hội thoại."
                : `Phiên đã kết thúc; ${recordedMessages} tin nhắn đã được ghi vào hội thoại.`}
            </p>
          )}
          {live && conversationId !== undefined && (
            <p className="cc-voice-note" data-voice-records-as-spoken="true">
              Mỗi câu bạn nói được ghi vào hội thoại ngay khi nói, và trợ lý trả lời ở đó.
            </p>
          )}
          {live && conversationId === undefined && (
            <p className="cc-voice-note" data-voice-will-record="false">
              Chưa có hội thoại nào để ghi, nên phiên này sẽ không được lưu lại.
            </p>
          )}
        </div>

        <footer className="cc-voice-controls">
          <button
            type="button"
            className="cc-voice-action"
            data-voice-mute="true"
            data-muted={muted ? "true" : "false"}
            aria-label={muted ? "Bật micro" : "Tắt micro"}
            onClick={toggleMute}
            disabled={!live}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">{muted ? "🎙" : "🔇"}</span>
            <span className="cc-voice-action-text">{muted ? "Bật micro" : "Tắt micro"}</span>
          </button>
          <button
            type="button"
            className="cc-voice-action"
            data-voice-minimize="true"
            aria-pressed={collapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Mở rộng" : "Thu gọn"}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">{collapsed ? "▣" : "▭"}</span>
            <span className="cc-voice-action-text">{collapsed ? "Mở rộng" : "Thu gọn"}</span>
          </button>
          <button
            type="button"
            className="cc-voice-action cc-voice-action-end"
            data-voice-end="true"
            aria-label="Kết thúc"
            onClick={() => {
              endSession();
              onClose({ focusComposer: false });
            }}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">✕</span>
            <span className="cc-voice-action-text">Kết thúc</span>
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
            Viết thay vì nói
          </button>
        </footer>
      </section>
    </div>
  );
}
