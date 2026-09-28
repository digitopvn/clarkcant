import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import {
  hasCloseControl,
  hasDesktopChrome,
  hasWindowControls,
  readShellWindow,
  requestClose,
  requestFullScreen,
  requestMinimize,
  requestWindowMode,
  subscribeWindowState,
  type WindowMode,
} from "./desktop-compact.ts";
import { useT } from "./i18n/locale-context.tsx";

/**
 * The window's own chrome, for a window that has none.
 *
 * The desktop window is frameless, so dragging and the controls a title bar would carry have to live in the
 * document. It renders nothing at all in a browser, which is the point: the same client is served to both, and
 * a browser must not grow a window strip it cannot honour.
 *
 * Everything it shows is what the shell last reported, never the last thing that was asked: the mode and the pin
 * come from the shell's answers (and from the window itself on mount, so a reload does not reset them), and full
 * screen from the window's own events, so a change the OS made shows here too.
 */
export function DesktopChrome(): ReactElement | null {
  const t = useT();
  const desktop = useMemo(() => hasDesktopChrome(), []);
  // Only when the shell has both verbs: a button an older shell cannot honour would be a fake control.
  const controls = useMemo(() => hasWindowControls(), []);
  const closable = useMemo(() => hasCloseControl(), []);
  const [mode, setMode] = useState<WindowMode>("normal");
  const [pinned, setPinned] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  // What the shell last refused, so a refusal is visible rather than silent.
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!desktop) return undefined;
    // The strip takes the top of the window, so the layout moves down for it rather than sitting underneath it.
    document.documentElement.dataset.windowChrome = "true";
    let cancelled = false;
    // Where the window really is. A reload keeps the window's pin, and a toggle started from the default flipped it
    // the wrong way.
    void readShellWindow().then((current) => {
      if (cancelled || current === undefined) return;
      setMode(current.mode);
      setPinned(current.alwaysOnTop);
      setFullScreen(current.fullScreen);
    });
    const unsubscribe = controls ? subscribeWindowState((state) => setFullScreen(state.fullScreen)) : () => {};
    return () => {
      cancelled = true;
      unsubscribe();
      delete document.documentElement.dataset.windowChrome;
    };
  }, [desktop, controls]);

  const ask = useCallback((action: Parameters<typeof requestWindowMode>[0]) => {
    void requestWindowMode(action).then((next) => {
      setProblem(next.ok ? undefined : next.refused);
      if (!next.ok) return;
      setMode(next.mode);
      setPinned(next.alwaysOnTop);
      // Leaving the voice bar or entering it takes the window out of full screen in the shell.
      if (action.type !== "set-always-on-top") setFullScreen(false);
    });
  }, []);

  const minimize = useCallback(() => {
    void requestMinimize().then((next) => setProblem(next.ok ? undefined : next.refused));
  }, []);

  const toggleFullScreen = useCallback((value: boolean) => {
    void requestFullScreen(value).then((next) => {
      if (next.ok) setFullScreen(next.fullScreen);
      setProblem(next.ok ? undefined : next.refused);
    });
  }, []);

  const close = useCallback(() => {
    void requestClose().then((next) => setProblem(next.ok ? undefined : next.refused));
  }, []);

  if (!desktop) return null;

  const compact = mode === "compact";
  // The label says only what is not the ordinary window, so the strip stays quiet when nothing is unusual.
  const modeLabel = fullScreen ? t("shell.desktop.modeFullScreen") : compact ? t("shell.desktop.modeCompact") : undefined;

  return (
    <div className="cc-desktop-chrome" data-desktop-chrome="true">
      {/* The strip is the drag handle: a frameless window has nowhere else to be dragged by. */}
      <div className="cc-desktop-drag" aria-hidden="true" />
      {problem !== undefined && <span className="cc-desktop-problem">{problem}</span>}
      {modeLabel !== undefined && (
        <span className="cc-desktop-mode" data-desktop-mode={fullScreen ? "fullscreen" : mode}>
          {modeLabel}
        </span>
      )}
      <div className="cc-desktop-controls">
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
          <ChromeIcon name="pin" />
        </button>
        {/* One place for the voice bar: shrink into it, or grow back out of it. */}
        {compact ? (
          <button
            type="button"
            className="cc-desktop-button"
            data-desktop-expand="true"
            aria-label={t("shell.desktop.expandAria")}
            title={t("shell.desktop.expandTitle")}
            onClick={() => ask({ type: "expand" })}
          >
            <ChromeIcon name="restore" />
          </button>
        ) : (
          <button
            type="button"
            className="cc-desktop-button"
            data-desktop-compact="true"
            aria-label={t("shell.desktop.compactAria")}
            title={t("shell.desktop.compactTitle")}
            onClick={() => ask({ type: "enter-compact" })}
          >
            <ChromeIcon name="bar" />
          </button>
        )}
        <span className="cc-desktop-separator" aria-hidden="true" />
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
              <ChromeIcon name="minimize" />
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
              <ChromeIcon name={fullScreen ? "restore" : "maximize"} />
            </button>
          </>
        )}
        {closable && (
          <button
            type="button"
            className="cc-desktop-button"
            data-desktop-close="true"
            aria-label={t("shell.desktop.closeAria")}
            title={t("shell.desktop.closeTitle")}
            onClick={close}
          >
            <ChromeIcon name="close" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The controls' glyphs, drawn rather than typed: the text glyphs they replaced rendered at different sizes and
 * baselines per font, which is most of why the strip looked unfinished. `currentColor` so they follow the theme.
 */
function ChromeIcon({ name }: { name: "pin" | "bar" | "minimize" | "maximize" | "restore" | "close" }): ReactElement {
  const paths: Record<typeof name, ReactElement> = {
    close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
    pin: <path d="M6 2.5h4M7 2.5v4L5 9h6L9 6.5v-4M8 9v4.5" />,
    bar: <rect x="2.5" y="9.5" width="11" height="4" rx="2" />,
    minimize: <path d="M3.5 8h9" />,
    maximize: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />,
    restore: (
      <>
        <rect x="3" y="5.5" width="7.5" height="7.5" rx="1.5" />
        <path d="M5.5 5.5V4.5A1.5 1.5 0 0 1 7 3h4.5A1.5 1.5 0 0 1 13 4.5V9a1.5 1.5 0 0 1-1.5 1.5h-1" />
      </>
    ),
  };
  return (
    <svg
      className="cc-desktop-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
