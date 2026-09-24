import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import {
  hasDesktopChrome,
  hasWindowControls,
  requestFullScreen,
  requestMinimize,
  requestWindowMode,
  subscribeWindowState,
  type WindowModeAnswer,
} from "./desktop-compact.ts";
import { useT } from "./i18n/locale-context.tsx";

/**
 * The window's own chrome, for a window that has none.
 *
 * The desktop window is frameless, so dragging and the controls a title bar would carry have to live in the
 * document. It renders nothing at all in a browser, which is the point: the same client is served to both, and
 * a browser must not grow a window strip it cannot honour.
 *
 * The mode it shows is the last thing the shell answered, never the last thing that was asked. A window that
 * said it is still expanded is expanded.
 */
export function DesktopChrome(): ReactElement | null {
  const t = useT();
  const desktop = useMemo(() => hasDesktopChrome(), []);
  const controls = useMemo(() => hasWindowControls(), []);
  const [answer, setAnswer] = useState<WindowModeAnswer | undefined>(undefined);
  // Full screen as the window last reported it, whether the button or the OS changed it.
  const [fullScreen, setFullScreen] = useState(false);
  const [stateRefusal, setStateRefusal] = useState<string | undefined>(undefined);

  const ask = useCallback((action: Parameters<typeof requestWindowMode>[0]) => {
    void requestWindowMode(action).then((next) => {
      setAnswer(next);
      // Leaving the voice bar or entering it takes the window out of full screen in the shell.
      if (next.ok && action.type !== "set-always-on-top") setFullScreen(false);
    });
  }, []);

  const minimize = useCallback(() => {
    void requestMinimize().then((next) => setStateRefusal(next.ok ? undefined : next.refused));
  }, []);

  const toggleFullScreen = useCallback((value: boolean) => {
    void requestFullScreen(value).then((next) => {
      if (next.ok) setFullScreen(next.fullScreen);
      setStateRefusal(next.ok ? undefined : next.refused);
    });
  }, []);

  useEffect(() => {
    if (!controls) return undefined;
    return subscribeWindowState((state) => setFullScreen(state.fullScreen));
  }, [controls]);

  if (!desktop) return null;

  const mode = answer?.ok === true ? answer.mode : "normal";
  const pinned = answer?.ok === true && answer.alwaysOnTop;
  const problem = answer?.ok === false ? answer.refused : stateRefusal;

  return (
    <div className="cc-desktop-chrome" data-desktop-chrome="true">
      {/* The strip is the drag handle: a frameless window has nowhere else to be dragged by. */}
      <div className="cc-desktop-drag" aria-hidden="true" />
      <div className="cc-desktop-controls">
        <button
          type="button"
          className="cc-desktop-button"
          data-desktop-compact="true"
          aria-label={t("shell.desktop.compactAria")}
          title={t("shell.desktop.compactTitle")}
          onClick={() => ask({ type: "enter-compact" })}
        >
          ▾
        </button>
        <button
          type="button"
          className="cc-desktop-button"
          data-desktop-expand="true"
          aria-label={t("shell.desktop.expandAria")}
          title={t("shell.desktop.expandTitle")}
          onClick={() => ask({ type: "expand" })}
        >
          ▴
        </button>
        <button
          type="button"
          className="cc-desktop-button"
          data-desktop-pin="true"
          data-pinned={pinned ? "true" : "false"}
          aria-pressed={pinned}
          aria-label={t("shell.desktop.pinAria")}
          title={t("shell.desktop.pinTitle")}
          onClick={() => ask({ type: "set-always-on-top", value: !pinned })}
        >
          ⚲
        </button>
        {/* Only when the shell has both verbs: a button an older shell cannot honour would be a fake control. */}
        {controls && (
          <>
            <button
              type="button"
              className="cc-desktop-button"
              data-desktop-minimize="true"
              aria-label={t("shell.desktop.minimizeAria")}
              title={t("shell.desktop.minimizeTitle")}
              onClick={minimize}
            >
              −
            </button>
            <button
              type="button"
              className="cc-desktop-button"
              data-desktop-fullscreen="true"
              data-fullscreen={fullScreen ? "true" : "false"}
              aria-pressed={fullScreen}
              aria-label={t(fullScreen ? "shell.desktop.exitFullScreenAria" : "shell.desktop.fullScreenAria")}
              title={t(fullScreen ? "shell.desktop.exitFullScreenTitle" : "shell.desktop.fullScreenTitle")}
              onClick={() => toggleFullScreen(!fullScreen)}
            >
              {fullScreen ? "⤡" : "⤢"}
            </button>
          </>
        )}
      </div>
      {/* What the shell last said, so a refusal is visible rather than silent. */}
      <span className="cc-desktop-mode" data-desktop-mode={fullScreen ? "fullscreen" : mode}>
        {fullScreen
          ? t("shell.desktop.modeFullScreen")
          : mode === "compact"
            ? t("shell.desktop.modeCompact")
            : t("shell.desktop.modeFull")}
      </span>
      {problem !== undefined && <span className="cc-desktop-problem">{problem}</span>}
    </div>
  );
}
