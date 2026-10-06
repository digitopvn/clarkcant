import { useEffect, useState, type ReactElement } from "react";

import type { ChangelogView } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { ChangelogList } from "../changelog-card.tsx";
import { fillMessage } from "../i18n/fill-message.ts";
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
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    client.changelog().then(
      (answer) => {
        if (live) {
          setView(answer);
          setProblem(undefined);
        }
      },
      (cause: unknown) => {
        if (live) setProblem(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <section className="cc-panel-section" data-changelog-settings="true" aria-busy={view === undefined && problem === undefined}>
      <h3>{t("settings.changelog.heading")}</h3>
      <p className="cc-panel-note">{t("settings.changelog.intro")}</p>
      {problem !== undefined ? (
        <p className="cc-panel-note" role="alert" data-changelog-problem="true">
          {fillMessage(t("settings.changelog.failed"), { reason: problem })}
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
