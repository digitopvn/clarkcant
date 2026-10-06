import type { ReactElement } from "react";

import { RELEASE_NOTE_KINDS, type ChangelogCard, type ChangelogView, type ReleaseNoteKind } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * What this version of Clark changed: the host-owned card `/changelog` and `show_changelog` answer with, and the same
 * list inside Settings.
 *
 * Pure and hook-free. It draws the record the node read from the release notes embedded with its build: the installed
 * version and channel, then one disclosure per release (the newest open), its entries grouped by kind, and a link to the
 * canonical notes. The entries are drawn as recorded and never reworded. There is no Update button, update status or
 * channel choice: nothing in this build could act on one, and a control that cannot act is a fake control.
 */

type Translate = (key: MessageKey) => string;

const GROUP_KEY: Record<ReleaseNoteKind, MessageKey> = {
  breaking: "changelog.group.breaking",
  feature: "changelog.group.feature",
  fix: "changelog.group.fix",
  other: "changelog.group.other",
};

export function ChangelogCardBlock({ block, t }: { block: ChangelogCard; t: Translate }): ReactElement | null {
  if (block.owner !== "host") return null;
  return (
    <section className="cc-card" data-owner="host" data-changelog="true" aria-label={t("changelog.title")}>
      <header className="cc-card-head">
        <h3 className="cc-card-title">{t("changelog.title")}</h3>
      </header>
      <div className="cc-card-body">
        <ChangelogList view={block} t={t} />
      </div>
    </section>
  );
}

/** The view itself, shared by the card and the Settings section so the two cannot draw the same notes differently. */
export function ChangelogList({ view, t }: { view: ChangelogView; t: Translate }): ReactElement {
  const installed =
    view.installed.channel === "source"
      ? fillMessage(t("changelog.installed.source"), { version: view.installed.version })
      : fillMessage(t("changelog.installed.release"), {
          version: view.installed.version,
          channel: t(view.installed.channel === "beta" ? "changelog.channel.beta" : "changelog.channel.stable"),
        });
  return (
    <div className="cc-card-stack" data-installed-version={view.installed.version} data-installed-channel={view.installed.channel}>
      <p className="cc-list-title">{installed}</p>
      {view.notesCover === undefined ? null : (
        <p className="cc-list-subtitle" data-changelog-covers={view.notesCover.commit}>
          {fillMessage(t("changelog.sourceCoverage"), { commit: view.notesCover.commit.slice(0, 7), date: view.notesCover.date })}
        </p>
      )}
      {view.since === undefined ? null : (
        <p className="cc-list-subtitle" data-changelog-since={view.since}>
          {fillMessage(t("changelog.since"), { version: view.since })}
        </p>
      )}
      {view.releases.length === 0 ? (
        <p className="cc-list-subtitle" data-changelog-empty="true">
          {view.since === undefined ? t("changelog.empty") : fillMessage(t("changelog.emptySince"), { version: view.since })}
        </p>
      ) : (
        view.releases.map((release, index) => <Release key={release.version} release={release} open={index === 0} t={t} />)
      )}
      <p className="cc-list-subtitle">
        <a href={view.source} target="_blank" rel="noopener noreferrer" data-changelog-source="true">
          {t("changelog.source")}
        </a>
      </p>
    </div>
  );
}

function Release({ release, open, t }: { release: ChangelogView["releases"][number]; open: boolean; t: Translate }): ReactElement {
  const groups = RELEASE_NOTE_KINDS.map((kind) => ({ kind, entries: release.entries.filter((entry) => entry.kind === kind) })).filter(
    (group) => group.entries.length > 0,
  );
  return (
    <details className="cc-changelog-release" data-release-version={release.version} data-release-kind={release.kind} open={open}>
      <summary>
        <strong>{release.version}</strong>
        <span className="cc-list-meta">{release.date}</span>
        {release.channel === "beta" ? (
          <span className="cc-badge" data-tone="info">
            {t("changelog.channel.beta")}
          </span>
        ) : null}
        {release.kind === "baseline" ? (
          <span className="cc-list-subtitle">{t("changelog.baseline")}</span>
        ) : release.previousVersion === null ? null : (
          <span className="cc-list-subtitle">{fillMessage(t("changelog.release.after"), { version: release.previousVersion })}</span>
        )}
      </summary>
      {groups.length === 0 ? <p className="cc-list-subtitle">{t("changelog.noEntries")}</p> : null}
      {groups.map((group) => (
        <div key={group.kind} data-entry-group={group.kind}>
          <h4 className="cc-changelog-group">{t(GROUP_KEY[group.kind])}</h4>
          <ul className="cc-list">
            {group.entries.map((entry) => (
              <li key={`${entry.commit}-${entry.summary}`} className="cc-list-item" data-entry-commit={entry.commit}>
                <span className="cc-list-title">
                  {entry.scope === undefined ? null : <strong>{entry.scope}: </strong>}
                  {entry.summary}
                </span>
                <code className="cc-changelog-commit">{entry.commit.slice(0, 7)}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {release.omittedEntries > 0 ? (
        <p className="cc-list-subtitle" data-changelog-omitted={release.omittedEntries}>
          {fillMessage(t("changelog.omitted"), { count: release.omittedEntries })}
        </p>
      ) : null}
    </details>
  );
}
