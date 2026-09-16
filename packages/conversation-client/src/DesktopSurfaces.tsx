/**
 * Menu bar pieces for the desktop shell.
 *
 * A menu bar popover and a notification. Both are small, and both have one job that is easy to get
 * wrong: not overstating the state of the node behind them. The popover shows the same connection
 * state the app window does, and the notification trigger reports whether the host actually
 * supports notifications rather than assuming a desktop shell does.
 */

import { type ReactElement, useCallback, useState } from "react";

export interface MenuBarPopoverProps {
  nodeLabel: string;
  connection: "connecting" | "ready" | "offline";
  /** Tasks still running, so the popover is worth opening. */
  activeTaskCount: number;
  onOpenApp: () => void;
}

export function MenuBarPopover({
  nodeLabel,
  connection,
  activeTaskCount,
  onOpenApp,
}: MenuBarPopoverProps): ReactElement {
  const stateText = connection === "ready" ? "Ready" : connection === "connecting" ? "Đang kết nối" : "Mất kết nối";
  return (
    <div className="cc-menubar" role="dialog" aria-label={`Trạng thái ${nodeLabel}`} data-connection={connection}>
      <div className="cc-menubar-head">
        {/* The same wording the app window uses. Two surfaces describing one node differently is
            how a user learns not to trust either of them. */}
        <span className="cc-dot" data-state={connection} aria-hidden="true" />
        <span>{stateText}</span>
      </div>
      <p className="cc-freshness" style={{ margin: 0 }} data-menu-task-count={activeTaskCount}>
        {activeTaskCount === 0 ? "Không có việc nào đang chạy." : `${activeTaskCount} việc đang chạy.`}
      </p>
      <button type="button" className="cc-badge" onClick={onOpenApp} style={{ cursor: "pointer", font: "inherit" }}>
        Mở cửa sổ
      </button>
    </div>
  );
}

export interface DesktopNotificationProps {
  title: string;
  body: string;
}

/**
 * Ask the host to raise a notification.
 *
 * `Notification` is absent in Electron's sandboxed renderer unless the host exposes it, so the
 * component reports that it could not rather than silently doing nothing. A notification that
 * never appears and never says why is indistinguishable from a bug in whatever was being
 * notified about.
 */
export function DesktopNotification({ title, body }: DesktopNotificationProps): ReactElement {
  const [outcome, setOutcome] = useState<"idle" | "sent" | "unsupported" | "denied">("idle");

  const send = useCallback(() => {
    const api = globalThis as { Notification?: typeof Notification };
    if (api.Notification === undefined) {
      setOutcome("unsupported");
      return;
    }
    if (api.Notification.permission === "denied") {
      setOutcome("denied");
      return;
    }
    void api.Notification.requestPermission().then((permission) => {
      if (permission !== "granted") {
        setOutcome("denied");
        return;
      }
      new api.Notification!(title, { body });
      setOutcome("sent");
    });
  }, [title, body]);

  return (
    <div className="cc-notification-trigger" data-notification-outcome={outcome}>
      <button type="button" className="cc-badge" onClick={send} style={{ cursor: "pointer", font: "inherit" }}>
        Báo cho tôi khi xong
      </button>
      {outcome === "unsupported" && (
        <span className="cc-freshness" data-notification-unsupported="true">
          Cửa sổ này không có quyền gửi thông báo.
        </span>
      )}
      {outcome === "denied" && (
        <span className="cc-freshness" data-notification-denied="true">
          Bạn đã từ chối quyền thông báo.
        </span>
      )}
      {outcome === "sent" && <span className="cc-freshness">Đã gửi.</span>}
    </div>
  );
}
