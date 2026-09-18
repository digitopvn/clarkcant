import { type ReactElement } from "react";

/**
 * What a voice surface says when there is no node to record into.
 *
 * Kept separate from the interactive screen, and deliberately hook-free: it is the honest-gap
 * presentation rather than a state of a session, and being free of hooks means the package's tests can
 * call it as a plain function, since they have no DOM renderer. The interactive half lives in
 * `VoiceOverlay.tsx` and is verified in a browser.
 *
 * There is no microphone control here on purpose. A control that appears to work while recording
 * nothing is worse than a control that is absent, and the two lines below are what the reader needs
 * instead: what is missing and what would fix it.
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
        <p className="cc-freshness" style={{ margin: 0 }}>
          Không có nút ghi âm ở đây vì màn hình này không có kết nối để gửi audio tới.
        </p>
      </div>
    </section>
  );
}
