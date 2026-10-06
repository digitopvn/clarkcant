import { useEffect, useState, type ReactElement } from "react";

import type { ChangelogView } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { ChangelogList } from "../changelog-card.tsx";
import { useT } from "../i18n/locale-context.tsx";

/**
 * "Version & what's new", in host-owned Settings.
 *
 * The same view `/changelog` and Clark's `show_changelog` answer with, read from the node (`GET /changelog`) and drawn
 * by the same list the card uses. It shows the installed version and channel and the notes that came with the build —
 * no Update button, update status or channel choice, because nothing in this build can act on them.
 */
export function ChangelogSettings({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [view, setView] = useState<ChangelogView | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.changelog().then(
      (answer) => {
        if (live) {
          setView(answer);
          setFailed(false);
        }
      },
      () => {
        // The cause (a status code, a contract mismatch) is nothing a person can act on; the sentence says what failed,
        // what is untouched and where else the notes can be read.
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <section className="cc-panel-section" data-changelog-settings="true" aria-busy={view === undefined && !failed}>
      <h3>{t("settings.changelog.heading")}</h3>
      <p className="cc-panel-note">{t("settings.changelog.intro")}</p>
      {failed ? (
        <p className="cc-panel-note" role="alert" data-changelog-problem="true">
          {t("settings.changelog.failed")}
        </p>
      ) : view === undefined ? (
        <p className="cc-panel-note" role="status">
          {t("settings.changelog.loading")}
        </p>
      ) : (
        <ChangelogList view={view} t={t} />
      )}
    </section>
  );
}
