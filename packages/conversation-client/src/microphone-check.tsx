import { type ReactElement, useEffect, useState } from "react";

import { rmsLevel } from "./voice-session.ts";

/**
 * The microphone: asked for when it is wanted, then shown as a level.
 *
 * Two reasons this is its own control rather than part of the voice screen. A permission is asked for with the
 * reason in front of the person, so it belongs where voice is configured and not at the moment they press talk. And
 * a muted microphone and a broken one look identical from the outside, which is why the level is shown rather than
 * a message saying the microphone is fine.
 */
export function MicrophoneCheck(): ReactElement {
  const [state, setState] = useState<"idle" | "asking" | "live" | "refused" | "unavailable">("idle");
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (state !== "live") return;
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setState("unavailable");
      return;
    }

    let cancelled = false;
    let context: AudioContext | undefined;
    let stream: MediaStream | undefined;
    let frame = 0;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) return;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);

        const tick = (): void => {
          if (cancelled) return;
          analyser.getFloatTimeDomainData(samples);
          setLevel(rmsLevel(samples));
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // A refusal is a result, not an error: the browser said no, and saying so is more useful than a stack.
        if (!cancelled) setState("refused");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => undefined);
    };
  }, [state]);

  const words =
    state === "live"
      ? "Đang nghe thử. Nói gì đó để thấy mức âm thay đổi."
      : state === "refused"
        ? "Trình duyệt đã từ chối quyền micro. Mở quyền cho trang này rồi thử lại."
        : state === "unavailable"
          ? "Trình duyệt này không cho trang đọc micro."
          : "Micro chưa được hỏi quyền.";

  return (
    <div className="cc-mic-check" data-mic-check={state}>
      <p className="cc-panel-note" data-mic-status="true">
        {words}
      </p>
      <div className="cc-mic-level" aria-hidden="true">
        <span style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }} />
      </div>
      {/* The level is decorative; this is the same fact for a reader who cannot see the bar. */}
      <span className="cc-sr-only" data-mic-level={level.toFixed(3)}>
        {`mức âm ${Math.round(Math.min(1, level) * 100)} phần trăm`}
      </span>
      <button
        type="button"
        className="cc-icon-btn"
        style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
        data-mic-ask="true"
        onClick={() => {
          setLevel(0);
          // Asked for in the click, which is what a permission prompt needs: a browser refuses to prompt for a device
          // nobody asked for in a user gesture.
          setState(state === "live" ? "idle" : "live");
        }}
      >
        {state === "live" ? "Dừng thử" : "Bật micro để thử"}
      </button>
    </div>
  );
}
