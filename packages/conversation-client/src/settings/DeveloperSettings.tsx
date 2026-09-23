import { useEffect, useState, type ReactElement } from "react";

import { readVar, TokenSpecimens } from "../TokenSpecimens.tsx";
import type { GatewayClient } from "../api.ts";
import { SettingsRow } from "./controls/SettingsRow.tsx";
import { useT } from "../i18n/locale-context.tsx";

/**
 * Developer / Advanced: the internals, behind a disclosure.
 *
 * Everything here was previously spread through the tabs a normal user reads — node ids, raw pi settings,
 * extension file names, capability references, token specimens. AGENTS.md's rule is that this material is
 * progressive disclosure rather than part of the default UI: it is genuinely useful when something is wrong
 * and it is noise the rest of the time, and a node id on a settings screen reads as something the user is
 * expected to understand.
 *
 * The section is honest about what it is. Nothing here is a control that changes behaviour; it is a report.
 */

export interface DeveloperSettingsProps {
  client: GatewayClient;
  facts: { nodeId: string; label: string; createdAt: string } | undefined;
  onOpenWidgetLibrary?: ((mode: "browse" | "develop") => void) | undefined;
}

export function DeveloperSettings({ client, facts, onOpenWidgetLibrary }: DeveloperSettingsProps): ReactElement {
  const t = useT();
  const [settings, setSettings] = useState<{ key: string; value: string }[] | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client
      .piSettings()
      .then((answer) => {
        if (!cancelled) setSettings(answer.settings);
      })
      .catch(() => {
        // Reported as none rather than as a failure, because the person in front of the panel cannot act on a
        // read error either way.
        if (!cancelled) setSettings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  return (
    <>
      {/*
        The Widget Lab entry point.

        Developer mode is where implementation metadata belongs, so the lab lives here rather than in
        the Extensions tab: the same surface, opened with the inspector already showing.
      */}
      <section className="cc-panel-section" data-widget-lab-entry="true">
        <h3>{t("settings.developer.widgetLab.heading")}</h3>
        <p className="cc-panel-note">{t("settings.developer.widgetLab.intro")}</p>
        <SettingsRow
          label={t("settings.developer.widgetLab.label")}
          description={t("settings.developer.widgetLab.description")}
        >
          <button
            type="button"
            className="cc-badge"
            onClick={() => onOpenWidgetLibrary?.("develop")}
            data-widget-library-open="develop"
          >
            {t("settings.developer.widgetLab.open")}
          </button>
        </SettingsRow>
      </section>
      <section className="cc-panel-section" data-developer-node="true">
        <h3>{t("settings.developer.node.heading")}</h3>
        <SettingsRow label={t("settings.developer.node.id.label")} description={t("settings.developer.node.id.description")}>
          <code data-node-id="true">{facts?.nodeId ?? t("settings.developer.node.unread")}</code>
        </SettingsRow>
        <SettingsRow
          label={t("settings.developer.node.label.label")}
          description={t("settings.developer.node.label.description")}
        >
          <code>{facts?.label ?? t("settings.developer.node.unread")}</code>
        </SettingsRow>
        <SettingsRow label={t("settings.developer.node.createdAt.label")}>
          <code>{facts?.createdAt ?? t("settings.developer.node.unread")}</code>
        </SettingsRow>
      </section>

      <section className="cc-panel-section" data-pi-settings="true">
        <h3>{t("settings.developer.piSettings.heading")}</h3>
        <p className="cc-panel-note">{t("settings.developer.piSettings.intro")}</p>
        <div className="cc-panel-row">
          <button
            type="button"
            className="cc-chip"
            aria-expanded={open}
            data-pi-settings-toggle="true"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? t("settings.developer.piSettings.hide") : t("settings.developer.piSettings.read")}
          </button>
        </div>
        {!open ? null : settings === undefined ? (
          <p className="cc-panel-note">{t("settings.common.loading")}</p>
        ) : settings.length === 0 ? (
          <p className="cc-panel-note" data-pi-settings="none">
            {t("settings.developer.piSettings.none")}
          </p>
        ) : (
          // A key and a value per line. Anything whose name sounds like a secret arrives already redacted by the
          // node, because the node is the only thing that can see the file it came from.
          <div className="cc-panel-note">
            {settings.map((line) => (
              <code key={line.key} data-pi-setting={line.key}>
                {line.key}: {line.value}
              </code>
            ))}
          </div>
        )}
      </section>

      <section className="cc-panel-section" data-token-specimens="true">
        <h3>{t("settings.developer.tokens.heading")}</h3>
        <p className="cc-panel-note">{t("settings.developer.tokens.intro")}</p>
        <SettingsRow
          label={t("settings.developer.tokens.accent.label")}
          description={t("settings.developer.tokens.accent.description")}
        >
          <code>{readVar("--cc-accent") ?? t("settings.developer.tokens.unreadable")}</code>
        </SettingsRow>
        <TokenSpecimens />
      </section>
    </>
  );
}
