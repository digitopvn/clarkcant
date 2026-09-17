import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { VoiceState } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import type { VoiceSession, VoiceTranscriptUpdate } from "./voice-session.ts";

/**
 * The voice surface.
 *
 * Two presentations, and the difference between them is the point:
 *
 * - **With a node connection**, it is a working control: it starts a session, shows whether the
 *   node is listening, thinking or speaking, mutes capture, and shows the live transcript. Every
 *   button does something.
 * - **Without one, or when the node refuses**, it says what is missing and what would fix it. A
 *   disabled control with no explanation reads as a bug, and a control that appears to work while
 *   recording nothing is worse.
 *
 * The muted state is reported locally *and* applied to capture, because a mute that only changes
 * the picture is the most misleading control in a voice interface.
 *
 * The transcript shown here is the session's, not the conversation's. It is written into the
 * conversation once, when the session ends, and the surface says so rather than leaving the user
 * to wonder where their words went.
 */

export interface VoiceSurfaceProps {
  /** Absent when this surface has no node to talk to; it can then only describe the gap. */
  client?: GatewayClient;
  /** Omitted before the first message of a conversation; the node then records nothing. */
  conversationId?: string;
  /** Provider capability the node would need, written for whoever can act on it. */
  requires?: string;
  /** What an operator has to do about it. */
  unblockedBy?: string;
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "chưa bắt đầu",
  connecting: "đang kết nối",
  listening: "đang nghe",
  thinking: "đang xử lý",
  speaking: "đang nói",
  reconnecting: "đang kết nối lại",
  ended: "đã kết thúc",
  failed: "lỗi",
};

/**
 * The surface when there is no node connection to record into.
 *
 * Extracted and deliberately hook-free, for two reasons: it is the honest-gap presentation rather
 * than a state of a session, and keeping it free of hooks means it can be called as a plain
 * function by the package's tests, which have no DOM renderer. The interactive half below holds
 * state and is verified in a browser instead.
 */
export function VoiceUnavailable({
  requires = "một phiên Live API đang mở",
  unblockedBy = "đặt GEMINI_API_KEY cho node rồi thử lại",
}: {
  requires?: string;
  unblockedBy?: string;
}): ReactElement {
  return (
    <section className="cc-card" data-host-card="voice" data-owner="host" data-state="blocked">
      <header className="cc-card-head">
        <span className="cc-card-title">Nói bằng giọng nói</span>
        <span className="cc-badge" data-tone="warn">
          chưa dùng được
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }} data-voice-blocked="true">
          Màn hình này chưa nối tới node nào, nên không thể mở phiên giọng nói ở đây.
        </p>
        <dl className="cc-fields">
          <dt>Cần</dt>
          <dd>{requires}</dd>
          <dt>Điều kiện mở</dt>
          <dd>{unblockedBy}</dd>
        </dl>
        {/* No microphone control, because there is nothing for it to record into. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          Không có nút ghi âm ở đây vì màn hình này không có kết nối để gửi audio tới.
        </p>
      </div>
    </section>
  );
}

export function VoiceSurface({
  client,
  conversationId,
  requires = "một phiên Live API đang mở",
  unblockedBy = "đặt GEMINI_API_KEY cho node rồi thử lại",
}: VoiceSurfaceProps): ReactElement {
  const [state, setState] = useState<VoiceState>("idle");
  const [muted, setMuted] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [willRecord, setWillRecord] = useState(false);
  const [utterances, setUtterances] = useState<VoiceTranscriptUpdate[]>([]);
  const [recordedMessages, setRecordedMessages] = useState<number | undefined>(undefined);
  const [audioFrames, setAudioFrames] = useState(0);
  const [captureFrames, setCaptureFrames] = useState(0);

  const sessionRef = useRef<VoiceSession | undefined>(undefined);

  const stopSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = undefined;
    void session?.end().catch(() => undefined);
    setMuted(false);
  }, []);

  // A surface that unmounts mid-session must not leave the microphone open. That is the failure
  // this cleanup exists for: the user closes settings and is still being recorded.
  useEffect(() => stopSession, [stopSession]);

  const start = useCallback((): void => {
    if (client === undefined || sessionRef.current !== undefined) return;
    setProblem(undefined);
    setRecordedMessages(undefined);
    setUtterances([]);
    setAudioFrames(0);
    setCaptureFrames(0);
    setState("connecting");

    void client
      .openVoiceSession({
        ...(conversationId === undefined ? {} : { conversationId }),
        events: {
          onState: setState,
          onTranscript: (update) => setUtterances((current) => [...current, update]),
          onAudioFrame: setAudioFrames,
          onCaptureFrame: setCaptureFrames,
          onError: (message) => {
            setProblem(message);
            setState("failed");
            sessionRef.current = undefined;
          },
          onEnded: (count) => {
            setRecordedMessages(count);
            setState("ended");
            sessionRef.current = undefined;
          },
        },
      })
      .then((session) => {
        sessionRef.current = session;
        setWillRecord(session.willRecord);
        setState(session.state);
      })
      .catch((cause: unknown) => {
        // The node's refusal is worded for a person, so it is shown as it arrived rather than
        // replaced with a generic failure.
        setProblem(cause instanceof Error ? cause.message : "không mở được phiên giọng nói");
        setState("failed");
        sessionRef.current = undefined;
      });
  }, [client, conversationId]);

  const toggleMute = useCallback((): void => {
    const next = !muted;
    setMuted(next);
    sessionRef.current?.setMuted(next);
  }, [muted]);

  const live = state === "listening" || state === "speaking" || state === "thinking" || state === "connecting";

  return (
    <section
      className="cc-card"
      data-host-card="voice"
      data-owner="host"
      data-voice-state={state}
      data-voice-audio-frames={audioFrames}
      data-voice-capture-frames={captureFrames}
    >
      <header className="cc-card-head">
        <span className="cc-card-title">Nói bằng giọng nói</span>
        <span className="cc-badge" data-tone={state === "failed" ? "warn" : ""}>
          {STATE_LABEL[state]}
        </span>
      </header>

      <div className="cc-card-body">
        {client === undefined ? (
          <VoiceUnavailable requires={requires} unblockedBy={unblockedBy} />
        ) : (
          <>
            <p style={{ margin: 0 }} data-voice-description="true">
              Node giữ khoá provider, trình duyệt chỉ gửi và nhận audio. Audio đi thẳng tới model
              thời gian thực rồi quay lại, nên không có bước chuyển thành văn bản nào ở giữa.
            </p>

            {problem !== undefined && (
              <p className="cc-freshness" data-voice-problem="true" style={{ margin: 0 }}>
                {problem} — {unblockedBy}
              </p>
            )}

            {state === "ended" && (
              <p className="cc-freshness" data-voice-ended="true" style={{ margin: 0 }}>
                {recordedMessages === 0
                  ? "Phiên đã kết thúc; không có nội dung nào được ghi vào hội thoại."
                  : `Phiên đã kết thúc; ${recordedMessages} tin nhắn đã được ghi lại vào hội thoại.`}
              </p>
            )}

            {utterances.length > 0 && (
              <dl className="cc-fields" data-voice-transcript="true">
                {utterances.map((utterance, index) => (
                  <div key={`${utterance.role}-${index}`}>
                    <dt>{utterance.role === "user" ? "Bạn" : "Trợ lý"}</dt>
                    <dd>{utterance.text === "" ? "…" : utterance.text}</dd>
                  </div>
                ))}
              </dl>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {!live && (
                <button type="button" className="cc-chip" data-voice-start="true" onClick={start}>
                  {state === "idle" ? "Bắt đầu nói" : "Nói lại"}
                </button>
              )}
              {live && (
                <>
                  <button
                    type="button"
                    className="cc-chip"
                    data-voice-mute="true"
                    data-muted={muted ? "true" : "false"}
                    onClick={toggleMute}
                  >
                    {muted ? "Bật micro" : "Tắt micro"}
                  </button>
                  <button type="button" className="cc-chip" data-voice-end="true" onClick={stopSession}>
                    Kết thúc
                  </button>
                </>
              )}
            </div>

            {live && willRecord && (
              <p className="cc-freshness" data-voice-will-record="true" style={{ margin: 0 }}>
                Nội dung nói sẽ được ghi vào hội thoại một lần, khi phiên kết thúc.
              </p>
            )}
            {live && !willRecord && (
              <p className="cc-freshness" data-voice-will-record="false" style={{ margin: 0 }}>
                Chưa có hội thoại nào để ghi, nên phiên này sẽ không được lưu lại.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
