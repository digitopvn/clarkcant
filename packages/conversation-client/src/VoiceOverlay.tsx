import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { VoiceState } from "@clarkcant/contracts";

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
  requires?: string;
  unblockedBy?: string;
}

export function VoiceOverlay({
  client,
  conversationId,
  onClose,
  onAnswered,
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
            setUtterances((current) => [...current, update]);
            // The agent's words are the message it just wrote to the conversation, so this is the moment
            // the transcript above is worth re-reading.
            if (update.role === "assistant") onAnswered?.();
          },
          onLevel: ({ level: heard }) => {
            const history = levels.current;
            history.push(heard);
            if (history.length > WAVEFORM_BARS) history.shift();
            setLevel(heard);
            setBars(waveformBars(history));
          },
          onCaptureFrame: (sent) => setFrames((current) => ({ ...current, captured: sent })),
          onAnswerFailed: (failure) => setAnswerProblem(failure.message),
          onAudioFrame: (received) => setFrames((current) => ({ ...current, heard: received })),
          onError: (message) => {
            setProblem(message);
            setState("failed");
            sessionRef.current = undefined;
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
            <span>Agent</span>
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
            onClick={toggleMute}
            disabled={!live}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">{muted ? "🎙" : "🔇"}</span>
            {muted ? "Bật micro" : "Tắt micro"}
          </button>
          <button
            type="button"
            className="cc-voice-action"
            data-voice-minimize="true"
            aria-pressed={collapsed}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">{collapsed ? "▣" : "▭"}</span>
            {collapsed ? "Mở rộng" : "Thu gọn"}
          </button>
          <button
            type="button"
            className="cc-voice-action cc-voice-action-end"
            data-voice-end="true"
            onClick={() => {
              endSession();
              onClose({ focusComposer: false });
            }}
          >
            <span className="cc-voice-action-icon" aria-hidden="true">✕</span>
            Kết thúc
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
