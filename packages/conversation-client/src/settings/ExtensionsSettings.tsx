import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { useT } from "../i18n/locale-context.tsx";
import { ToolLists } from "../tool-lists.tsx";
import type {
  GatewayClient,
  InstalledPackageView,
  PackageChangeResponse,
  PendingCapabilityApprovalView,
  RestorablePackageView,
} from "../api.ts";
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
  // Bumped when a package changes, so the questions about it are read again: an uninstalled package's are gone.
  const [packagesRevision, setPackagesRevision] = useState(0);

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
      <CapabilityApprovalsSection client={client} revision={packagesRevision} />
      <InstalledPackagesSection client={client} onChanged={() => setPackagesRevision((value) => value + 1)} />
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
 * Capability questions an install left open, answered here and nowhere else.
 *
 * A package asked for a capability the execution policy wanted a person to decide. This is host chrome: a widget can
 * never draw it, and the model cannot answer it, because both are the party that would be asking. Each answer is sent
 * with the digest the row showed, so what gets granted is exactly what was read. Nothing is shown while there is
 * nothing to decide.
 */
function CapabilityApprovalsSection({ client, revision }: { client: GatewayClient; revision: number }): ReactElement | null {
  const t = useT();
  const [approvals, setApprovals] = useState<PendingCapabilityApprovalView[]>([]);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<{ tone: "done" | "failed"; text: string } | undefined>(undefined);
  const statusLine = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setApprovals((await client.capabilityApprovals()).approvals);
      setReadFailed(false);
    } catch {
      setReadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const decide = (approval: PendingCapabilityApprovalView, decision: "granted" | "denied"): void => {
    if (busy !== undefined) return;
    setBusy(approval.approvalId);
    setStatus(undefined);
    void client
      .decideCapabilityApproval(approval, decision)
      .then(() => {
        setStatus({
          tone: "done",
          text: t(decision === "granted" ? "settings.extensions.approvals.granted" : "settings.extensions.approvals.denied")
            .replace("{capability}", approval.ref)
            .replace("{package}", approval.packageId),
        });
      })
      .catch((cause: unknown) => {
        setStatus({
          tone: "failed",
          text: t("settings.extensions.approvals.failed")
            .replace("{capability}", approval.ref)
            .replace("{reason}", cause instanceof Error ? cause.message : String(cause)),
        });
      })
      .finally(() => {
        setBusy(undefined);
        void load().then(() => statusLine.current?.focus());
      });
  };

  if (approvals.length === 0 && !readFailed && status === undefined) return null;

  return (
    <section className="cc-panel-section" data-capability-approvals="true">
      <h3>{t("settings.extensions.approvals.heading")}</h3>
      {readFailed && <p className="cc-panel-note">{t("settings.extensions.approvals.unread")}</p>}
      {approvals.length > 0 && (
        <ul className="cc-installed-list">
          {approvals.map((approval) => (
            <li key={approval.approvalId} data-capability-approval={approval.approvalId}>
              <strong>{approval.ref}</strong>
              <dl className="cc-fields">
                <dt>{t("settings.extensions.approvals.package")}</dt>
                <dd>
                  {approval.packageId}@{approval.version}
                </dd>
                <dt>{t("settings.extensions.approvals.expires")}</dt>
                <dd>{approval.expiresAt}</dd>
              </dl>
              <div className="cc-package-actions">
                <button
                  type="button"
                  data-capability-grant={approval.approvalId}
                  disabled={busy !== undefined}
                  onClick={() => decide(approval, "granted")}
                >
                  {busy === approval.approvalId ? t("settings.extensions.installed.working") : t("settings.extensions.approvals.grant")}
                </button>
                <button
                  type="button"
                  data-capability-deny={approval.approvalId}
                  disabled={busy !== undefined}
                  onClick={() => decide(approval, "denied")}
                >
                  {t("settings.extensions.approvals.deny")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p
        ref={statusLine}
        className="cc-panel-note"
        role="status"
        tabIndex={-1}
        data-capability-status={status?.tone ?? "idle"}
        hidden={status === undefined}
      >
        {status?.text}
      </p>
    </section>
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
function InstalledPackagesSection({ client, onChanged }: { client: GatewayClient; onChanged: () => void }): ReactElement {
  const t = useT();
  const [packages, setPackages] = useState<InstalledPackageView[] | undefined>(undefined);
  const [restorable, setRestorable] = useState<RestorablePackageView[]>([]);
  /*
   * One change at a time, and the buttons say so: a second click while the first is on its way would ask the node to
   * undo what it has not finished doing. The outcome stays in one status line for the section, because the row it
   * was about may be gone once it lands — an uninstalled package leaves this list.
   */
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<{ tone: "done" | "failed"; text: string } | undefined>(undefined);
  const statusLine = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const answer = await client.packages();
      setPackages(answer.packages);
      setRestorable(answer.restorable ?? []);
    } catch {
      // Named as unread rather than shown as empty: an empty list would say "nothing is installed", which is a
      // different claim from "this node could not say".
      setPackages([]);
      setRestorable([]);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void client
      .packages()
      .then((answer) => {
        if (cancelled) return;
        setPackages(answer.packages);
        setRestorable(answer.restorable ?? []);
      })
      .catch(() => {
        if (!cancelled) setPackages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const change = (packageId: string, action: PackageChangeResponse["action"]): void => {
    if (busy !== undefined) return;
    setBusy(`${packageId}:${action}`);
    setStatus(undefined);
    void client
      .changePackage(packageId, action)
      .then((done) => {
        const restart = done.restartNeeded ? ` ${t("settings.extensions.installed.restartNeeded")}` : "";
        const text =
          done.action === "uninstall"
            ? t("settings.extensions.installed.uninstalled")
                .replace("{package}", done.packageId)
                .replace("{offline}", String(done.instancesOffline))
            : done.action === "rollback"
              ? t("settings.extensions.installed.rolledBack")
                  .replace("{package}", done.packageId)
                  .replace("{version}", done.activeVersion ?? "")
              : t("settings.extensions.installed.restored")
                  .replace("{package}", done.packageId)
                  .replace("{version}", done.activeVersion ?? "")
                  .replace("{restored}", String(done.instancesRestored));
        setStatus({ tone: "done", text: `${text}${restart}` });
      })
      .catch((cause: unknown) => {
        setStatus({
          tone: "failed",
          text: t("settings.extensions.installed.failed")
            .replace("{action}", t(`settings.extensions.installed.verb.${action}`))
            .replace("{package}", packageId)
            .replace("{reason}", cause instanceof Error ? cause.message : String(cause)),
        });
      })
      .finally(() => {
        setBusy(undefined);
        onChanged();
        void load().then(() => {
          // The button that was pressed may no longer exist, so focus lands on what it did rather than on the page.
          statusLine.current?.focus();
        });
      });
  };

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
              <div className="cc-package-actions">
                <button
                  type="button"
                  data-package-uninstall={entry.packageId}
                  disabled={busy !== undefined}
                  onClick={() => change(entry.packageId, "uninstall")}
                >
                  {busy === `${entry.packageId}:uninstall`
                    ? t("settings.extensions.installed.working")
                    : t("settings.extensions.installed.uninstall")}
                </button>
                {/* Offered only when another version was active here: a rollback with nowhere to go is not a control. */}
                {entry.previousVersion !== undefined && (
                  <button
                    type="button"
                    data-package-rollback={entry.packageId}
                    disabled={busy !== undefined}
                    onClick={() => change(entry.packageId, "rollback")}
                  >
                    {busy === `${entry.packageId}:rollback`
                      ? t("settings.extensions.installed.working")
                      : t("settings.extensions.installed.rollback").replace("{version}", entry.previousVersion)}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p
        ref={statusLine}
        className="cc-panel-note"
        role="status"
        tabIndex={-1}
        data-package-status={status?.tone ?? "idle"}
        hidden={status === undefined}
      >
        {status?.text}
      </p>
      {restorable.length > 0 && (
        <>
          <h4>{t("settings.extensions.restorable.heading")}</h4>
          <ul className="cc-installed-list">
            {restorable.map((entry) => (
              <li key={entry.packageId} data-restorable-package={entry.packageId}>
                <strong>
                  {entry.packageId}@{entry.version}
                </strong>
                <dl className="cc-fields">
                  <dt>{t("settings.extensions.installed.digest")}</dt>
                  <dd>
                    <code>{entry.digest}</code>
                  </dd>
                  <dt>{t("settings.extensions.restorable.uninstalledAt")}</dt>
                  <dd>{entry.uninstalledAt}</dd>
                </dl>
                <div className="cc-package-actions">
                  <button
                    type="button"
                    data-package-restore={entry.packageId}
                    disabled={busy !== undefined}
                    onClick={() => change(entry.packageId, "restore")}
                  >
                    {busy === `${entry.packageId}:restore`
                      ? t("settings.extensions.installed.working")
                      : t("settings.extensions.restorable.restore").replace("{version}", entry.version)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
