import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { GatewayClient, InstalledPackageView } from "../api.ts";
import { useT } from "../i18n/locale-context.tsx";
import { provenanceRows } from "../package-provenance.ts";

/**
 * What this node has installed, shown beside the built-in catalog rather than mixed into it.
 *
 * This list is deliberately *not* part of the gallery. An installed package is not a catalog entry:
 * no route exposes its widget definitions, its fixtures or its renderer, so presenting it in the grid
 * would mean inventing the fields that make a grid cell work. What the node can honestly report is
 * provenance - which package, which version, from where, which digest, which trust lane - so that is
 * what this shows, and it says so.
 *
 * The three failure states are kept apart on purpose. "Could not read" is not "nothing is installed",
 * and neither is "still reading": an empty list would claim the node has no packages, which is a
 * different statement from the node being unable to say.
 */

type Read =
  | { status: "loading" }
  | { status: "unread" }
  | { status: "read"; packages: readonly InstalledPackageView[] };

export function InstalledProvenance({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRead({ status: "loading" });
    void client
      .packages()
      .then((answer) => {
        if (!cancelled) setRead({ status: "read", packages: answer.packages });
      })
      .catch(() => {
        if (!cancelled) setRead({ status: "unread" });
      });
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const rows = read.status === "read" ? provenanceRows(read.packages, t) : [];

  return (
    <section className="cc-library-provenance" data-widget-provenance="installed">
      <h3>{t("widgets.provenance.title")}</h3>

      {read.status === "loading" ? (
        <p className="cc-panel-note" data-provenance-state="loading">
          {t("widgets.provenance.loading")}
        </p>
      ) : read.status === "unread" ? (
        <div className="cc-provenance-retry" data-provenance-state="unread">
          <p className="cc-panel-note">{t("widgets.provenance.unread")}</p>
          <button type="button" onClick={retry}>
            {t("widgets.provenance.retry")}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="cc-panel-note" data-provenance-state="empty">
          {t("widgets.provenance.empty")}
        </p>
      ) : (
        <ul className="cc-installed-list">
          {rows.map((row) => (
            <li
              key={row.packageId}
              data-installed-package={row.packageId}
              data-installed-lane={row.lane}
              data-provenance-kind={row.kind}
            >
              <strong>
                {row.packageId}@{row.version}
              </strong>
              <span className="cc-badge" data-lane={row.lane}>
                {row.laneLabel}
              </span>
              <dl className="cc-fields">
                <dt>{t("widgets.provenance.kindLabel")}</dt>
                <dd>{row.kind === "local" ? t("widgets.provenance.kindLocal") : t("widgets.provenance.kindInstalled")}</dd>
                <dt>{t("widgets.provenance.sourceLabel")}</dt>
                <dd>{row.sourceTier}</dd>
                <dt>{t("widgets.provenance.digestLabel")}</dt>
                {/* The full digest stays available on hover rather than being truncated away. */}
                <dd title={row.fullDigest}>{row.digest}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
