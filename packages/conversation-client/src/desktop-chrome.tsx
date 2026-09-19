import { type ReactElement, useCallback, useMemo, useState } from "react";

import { desktopBridge, requestWindowMode, type WindowModeAnswer } from "./desktop-compact.ts";

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
  const bridge = useMemo(() => desktopBridge(), []);
  const [answer, setAnswer] = useState<WindowModeAnswer | undefined>(undefined);

  const ask = useCallback((action: Parameters<typeof requestWindowMode>[0]) => {
    void requestWindowMode(action).then((next) => setAnswer(next));
  }, []);

  if (bridge?.setCompactMode === undefined) return null;

  const mode = answer?.ok === true ? answer.mode : "normal";
  const pinned = answer?.ok === true && answer.alwaysOnTop;

  return (
    <div className="cc-desktop-chrome" data-desktop-chrome="true">
      {/* The strip is the drag handle: a frameless window has nowhere else to be dragged by. */}
      <div className="cc-desktop-drag" aria-hidden="true" />
      <div className="cc-desktop-controls">
        <button
          type="button"
          className="cc-desktop-button"
          data-desktop-compact="true"
          aria-label="Thu nhỏ cửa sổ thành thanh thoại"
          title="Thu nhỏ thành thanh thoại"
          onClick={() => ask({ type: "enter-compact" })}
        >
          ▾
        </button>
        <button
          type="button"
          className="cc-desktop-button"
          data-desktop-expand="true"
          aria-label="Mở rộng cửa sổ"
          title="Mở rộng"
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
          aria-label="Ghim cửa sổ lên trên các cửa sổ khác"
          title="Luôn nổi trên cùng"
          onClick={() => ask({ type: "set-always-on-top", value: !pinned })}
        >
          ⚲
        </button>
      </div>
      {/* What the shell last said, so a refusal is visible rather than silent. */}
      <span className="cc-desktop-mode" data-desktop-mode={mode}>
        {mode === "compact" ? "Thanh thoại" : "Cửa sổ đầy đủ"}
      </span>
      {answer?.ok === false && <span className="cc-desktop-problem">{answer.refused}</span>}
    </div>
  );
}
