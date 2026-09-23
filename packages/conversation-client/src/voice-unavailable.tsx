import { type ReactElement } from "react";

import { readStoredLocale } from "./i18n/locale.ts";
import { CATALOGS, type MessageKey } from "./i18n/messages.ts";

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
  requires,
  unblockedBy,
}: {
  requires?: string;
  unblockedBy?: string;
}): ReactElement {
  // Read from the cached locale directly rather than `useT()`: this component is deliberately hook-free (see
  // the file's own doc comment) so the package's test suite, which has no DOM renderer, can call it as a plain
  // function. `useContext` throws outside a render, so a hook here would break that.
  const t = (key: MessageKey): string => CATALOGS[readStoredLocale()][key];
  return (
    <section className="cc-card" data-host-card="voice" data-owner="host" data-state="blocked">
      <header className="cc-card-head">
        <span className="cc-card-title">{t("composer.voice")}</span>
        <span className="cc-badge" data-tone="warn">
          {t("voice.unavailableBadge")}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }} data-voice-blocked="true">
          {t("voice.noNodeMessage")}
        </p>
        <dl className="cc-fields">
          <dt>{t("voice.requiresLabel")}</dt>
          <dd>{requires ?? t("voice.defaultRequires")}</dd>
          <dt>{t("voice.unblockedByLabel")}</dt>
          <dd>{unblockedBy ?? t("voice.defaultUnblockedBy")}</dd>
        </dl>
        <p className="cc-freshness" style={{ margin: 0 }}>
          {t("voice.noMicExplain")}
        </p>
      </div>
    </section>
  );
}
