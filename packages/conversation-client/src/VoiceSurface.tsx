/**
 * The voice surface.
 *
 * Live voice is blocked behind an external gate — a provider account with realtime access — and
 * this surface says exactly that rather than offering a microphone button that does nothing.
 *
 * The distinction matters: a disabled control with no explanation reads as a bug, and a control
 * that appears to work and silently records nothing is worse. What the user needs here is what is
 * missing and what would fix it.
 */

import { type ReactElement } from "react";

export interface VoiceSurfaceProps {
  /** Provider and capability the node would need, so the gap is concrete. */
  requires: string;
  /** What an operator has to do. Written for whoever can act on it. */
  unblockedBy: string;
  /** Present when a credential exists but the provider has not been reached yet. */
  state?: "blocked" | "needs-sign-in" | "connecting";
}

export function VoiceSurface({ requires, unblockedBy, state = "blocked" }: VoiceSurfaceProps): ReactElement {
  return (
    <section className="cc-card" data-host-card="voice" data-owner="host" data-state={state}>
      <header className="cc-card-head">
        <span className="cc-card-title">Nói bằng giọng nói</span>
        <span className="cc-badge" data-tone={state === "blocked" ? "warn" : ""}>
          {state === "blocked" ? "chưa dùng được" : state === "connecting" ? "đang kết nối" : "cần đăng nhập"}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }} data-voice-blocked="true">
          Node này chưa gọi được model giọng nói thời gian thực.
        </p>
        <dl className="cc-fields">
          <dt>Cần</dt>
          <dd>{requires}</dd>
          <dt>Điều kiện mở</dt>
          <dd>{unblockedBy}</dd>
        </dl>
        {/* No microphone control. Offering one here would be a control that cannot work, and the
            honest report is the missing thing rather than an inert button. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          Không có nút ghi âm ở đây vì nó sẽ không làm gì được.
        </p>
      </div>
    </section>
  );
}
