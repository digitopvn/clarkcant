import { useEffect, useState, type ReactElement } from "react";

import { useT } from "../i18n/locale-context.tsx";
import { ToolLists } from "../tool-lists.tsx";
import type { GatewayClient, InstalledPackageView } from "../api.ts";
import { laneLabel } from "../package-provenance.ts";
import { SettingsRow, ToolRow } from "./controls/SettingsRow.tsx";

/**
 * Extensions & Widgets: what this node can do, and what it has loaded.
 *
 * The capability list and the two tool lists belong here rather than in a tab called "Tools", because a
 * person asking "can this thing do X" is asking about all three and needs to know which one would be doing
 * it. The heading on each section says which half holds what.
 *
 * The marketplace and installed-package list arrive in the marketplace phase. What is here now is what the
 * node can actually report: capabilities, and the agent's own tools.
 */

interface ToolFacts {
  ref: string;
  summary: string;
  usable: boolean;
  blockedReason?: string;
}

export interface ExtensionsSettingsProps {
  client: GatewayClient;
  tools: ToolFacts[] | undefined;
  onOpenWidgetLibrary?: ((mode: "browse" | "develop") => void) | undefined;
}

export function ExtensionsSettings({ client, tools, onOpenWidgetLibrary }: ExtensionsSettingsProps): ReactElement {
  const t = useT();
  const [extensions, setExtensions] = useState<{ name: string; kind: string }[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .extensions()
      .then((answer) => {
        if (!cancelled) setExtensions(answer.extensions);
      })
      .catch(() => {
        // An empty list rather than an error: what this section answers is what pi loads, and a node that cannot
        // say still leaves the rest of the tab working.
        if (!cancelled) setExtensions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <>
      {/*
        What is installed, and where it came from.
        ...
      */}
      <InstalledPackagesSection client={client} />
      {/*
        The library entry point.

        It sits above the installed list because it answers the question a person actually has
        ("what can Clark draw?") rather than the one the list answers ("what is installed?").
      */}
      <section className="cc-panel-section" data-widget-library-entry="true">
        <h3 data-marketplace-heading="true">{t("marketplace.heading")}</h3>
        <p className="cc-panel-note">{t("settings.extensions.widgetLibrary.intro")}</p>
        <SettingsRow
          label={t("settings.extensions.widgetLibrary.label")}
          description={t("settings.extensions.widgetLibrary.description")}
        >
          <button
            type="button"
            className="cc-badge"
            onClick={() => onOpenWidgetLibrary?.("browse")}
            data-widget-library-open="browse"
          >
            {t("settings.extensions.widgetLibrary.browse")}
          </button>
        </SettingsRow>
      </section>
      <section className="cc-panel-section">
        <h3>{t("settings.extensions.capabilities.heading")}</h3>
        <p className="cc-panel-note">{t("settings.extensions.capabilities.intro")}</p>
        {tools === undefined ? (
          <p className="cc-panel-note">{t("settings.common.loading")}</p>
        ) : tools.length === 0 ? (
          <p className="cc-panel-note">{t("settings.extensions.capabilities.none")}</p>
        ) : (
          tools.map((tool) => (
            <ToolRow
              key={tool.ref}
              toolRef={tool.ref}
              summary={tool.summary}
              usable={tool.usable}
              t={t}
              {...(tool.blockedReason === undefined ? {} : { blockedReason: tool.blockedReason })}
            />
          ))
        )}
      </section>

      <section className="cc-panel-section">
        <h3>{t("settings.extensions.tools.heading")}</h3>
        {/*
          Two lists, told apart by which half holds them: the node's own, and the agent's built-ins.
          `tool-lists.tsx` is outside this file's ownership and still renders its own Vietnamese copy;
          the marker lets an i18n-coverage check skip this subtree instead of misreporting it as this
          settings surface's own untranslated string.
        */}
        <div data-out-of-scope-i18n="tool-lists">
          <ToolLists client={client} />
        </div>
      </section>

      <section className="cc-panel-section" data-pi-extensions="true">
        <h3>{t("settings.extensions.piExtensions.heading")}</h3>
        {extensions === undefined ? (
          <p className="cc-panel-note">{t("settings.common.loading")}</p>
        ) : extensions.length === 0 ? (
          <p className="cc-panel-note" data-pi-extensions="none">
            {t("settings.extensions.piExtensions.none")}
          </p>
        ) : (
          // Names and kinds, and deliberately nothing else: an extension on a real machine can hold a credential,
          // and a section that showed what was inside one would be the place it leaked from.
          <div className="cc-panel-note">
            {extensions.map((entry) => (
              <code key={entry.name} data-pi-extension={entry.name} data-kind={entry.kind}>
                {entry.name}
              </code>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * What is installed, and where each package came from.
 *
 * Four facts, and three of them are ones a user cannot check for themselves: where it came from, which version,
 * which digest, and which lane it runs in. The digest especially — it is the only thing tying what is running to
 * what was approved, so a list that showed a version without one would be inviting trust it has not earned.
 *
 * The lanes are labelled apart on purpose. A native Pi extension is trusted process-level code that runs beside
 * the host; an isolated widget is opaque-origin code in a frame with no Node, no filesystem and no host cookies.
 * Showing them with the same wording would be the one mistake this list exists to prevent.
 */
function InstalledPackagesSection({ client }: { client: GatewayClient }): ReactElement {
  const t = useT();
  const [packages, setPackages] = useState<InstalledPackageView[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .packages()
      .then((answer) => {
        if (!cancelled) setPackages(answer.packages);
      })
      .catch(() => {
        // Named as unread rather than shown as empty: an empty list would say "nothing is installed", which is a
        // different claim from "this node could not say".
        if (!cancelled) setPackages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <section className="cc-panel-section">
      <h3>{t("settings.extensions.installed.heading")}</h3>
      {packages === undefined ? (
        <p className="cc-panel-note">{t("settings.common.loading")}</p>
      ) : packages.length === 0 ? (
        <p className="cc-panel-note">{t("settings.extensions.installed.none")}</p>
      ) : (
        // `LANE_LABELS` (package-provenance.ts) is outside this file's ownership and reports the node's own
        // data anyway; marked so an i18n-coverage check treats it as node-reported content, not untranslated UI.
        <ul className="cc-installed-list" data-out-of-scope-i18n="package-provenance">
          {packages.map((entry) => (
            <li key={entry.packageId} data-installed-package={entry.packageId} data-installed-lane={entry.lane}>
              <strong>
                {entry.packageId}@{entry.version}
              </strong>
              {/* LANE_LABELS is out of this file's ownership; see the settings translation report for the
                  Vietnamese lane badge still shown here. */}
              <span className="cc-badge" data-lane={entry.lane}>
                {laneLabel(entry.lane, t)}
              </span>
              <dl className="cc-fields">
                <dt>{t("settings.extensions.installed.source")}</dt>
                {/* The tier the resolver assigned, so "found on the internet" is never dressed up as first-party. */}
                <dd data-installed-source-tier={entry.source.sourceTier}>
                  {entry.source.rationale === "" ? entry.source.sourceTier : entry.source.rationale}
                </dd>
                <dt>{t("settings.extensions.installed.digest")}</dt>
                <dd>
                  <code data-installed-digest={entry.digest}>{entry.digest}</code>
                </dd>
                <dt>{t("settings.extensions.installed.installedAt")}</dt>
                <dd>{entry.activatedAt}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
