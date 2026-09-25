import { type ReactElement } from "react";

import { useT } from "../i18n/locale-context.tsx";
import type { HostCardEntry } from "./host-card-entries.ts";

/**
 * The host-owned cards, listed in the library as what they are.
 *
 * Each item is a plain article, not a button: there is nothing to open from here, and a control that looked like it
 * opened a terminal would be a fake one. The illustration is static markup labelled as an illustration, so it can
 * never be read as a live shell, and it is hidden from assistive technology because the description and the
 * caption already say everything it shows.
 */
export function HostCardShowcase({ entries }: { entries: readonly HostCardEntry[] }): ReactElement | null {
  const t = useT();
  if (entries.length === 0) return null;
  return (
    <section className="cc-library-host" data-widget-provenance="host">
      <h3>{t("widgets.hostCards.title")}</h3>
      <p className="cc-library-host-intro">{t("widgets.hostCards.intro")}</p>
      <ul className="cc-widget-grid">
        {entries.map((entry) => (
          <li key={entry.id} className="cc-widget-card">
            <article className="cc-host-card-item" data-host-card-entry={entry.id} aria-labelledby={`cc-host-card-${entry.id}`}>
              <figure className="cc-host-card-figure">
                <HostCardIllustration id={entry.id} />
                <figcaption className="cc-host-card-caption">{t("widgets.hostCards.illustration")}</figcaption>
              </figure>
              <span className="cc-widget-card-meta">
                <span className="cc-widget-card-name" id={`cc-host-card-${entry.id}`}>
                  {t(entry.nameKey)}
                </span>
                <span className="cc-widget-card-desc">{t(entry.descriptionKey)}</span>
                <span className="cc-host-card-open">{t(entry.openHintKey)}</span>
                <span className="cc-widget-card-source">{t("widgets.hostCards.source")}</span>
              </span>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HostCardIllustration({ id }: { id: string }): ReactElement | null {
  if (id !== "terminal-session-card") return null;
  return (
    <pre className="cc-host-card-terminal" aria-hidden="true" data-host-card-illustration={id}>
      <span className="cc-host-card-terminal-prompt">~/project $ </span>pnpm test{"\n"}
      <span className="cc-host-card-terminal-ok">✓</span> 42 passed{"\n"}
      <span className="cc-host-card-terminal-prompt">~/project $ </span>
      <span className="cc-host-card-terminal-cursor">▍</span>
    </pre>
  );
}
