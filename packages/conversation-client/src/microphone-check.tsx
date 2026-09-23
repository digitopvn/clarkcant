import { type ReactElement, useEffect, useState } from "react";

import { useT } from "./i18n/locale-context.tsx";
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
  const t = useT();
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
      ? t("settings.mic.live")
      : state === "refused"
        ? t("settings.mic.refused")
        : state === "unavailable"
          ? t("settings.mic.unavailable")
          : t("settings.mic.idle");

  return (
    <div className="cc-mic-check" data-mic-check={state}>
      <p className="cc-panel-note" data-mic-status="true">
        {words}
      </p>
      <div className="cc-mic-level" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.min(1, level).toFixed(3)})` }} />
      </div>
      {/* The level is decorative; this is the same fact for a reader who cannot see the bar. */}
      <span className="cc-sr-only" data-mic-level={level.toFixed(3)}>
        {`${Math.round(Math.min(1, level) * 100)}% ${t("settings.mic.levelSuffix")}`}
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
        {state === "live" ? t("settings.mic.stop") : t("settings.mic.start")}
      </button>
    </div>
  );
}
