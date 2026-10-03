import type { ReactElement } from "react";

import type { ProfileLimitName, ReachChange } from "@clarkcant/contracts";

import { fillMessage } from "./i18n/fill-message.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * What a new version of a package reaches against the version installed, shown on the update notice and on the install
 * question an update raises, before anything is applied: each origin, key, browser-token scope and account scope or
 * endpoint it adds or drops, and each resource limit that changes with both values.
 *
 * It says what the decision is about and decides nothing: whether the update asks first is the execution mode's call,
 * as for any install. Names and purposes only, never a key's value.
 */

const MIB = 1024 * 1024;

type Translate = (key: MessageKey) => string;

/** One limit's value in the unit a person reads it in. */
export function formatLimit(t: Translate, limit: ProfileLimitName, value: number): string {
  switch (limit) {
    case "memoryMib":
    case "tmpfsMib":
      return fillMessage(t("inbox.reachChange.unit.mib"), { n: value });
    case "artifactMaxBytes":
    case "inputMaxBytes":
      return fillMessage(t("inbox.reachChange.unit.mib"), { n: Math.round((value / MIB) * 10) / 10 });
    case "callDeadlineMs":
    case "jobDeadlineMs":
      return duration(t, value / 1000);
    case "inputMaxMediaSeconds":
      return duration(t, value);
    default:
      return String(value);
  }
}

function duration(t: Translate, seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return fillMessage(t("inbox.reachChange.unit.hours"), { n: seconds / 3600 });
  if (seconds >= 60 && seconds % 60 === 0) return fillMessage(t("inbox.reachChange.unit.minutes"), { n: seconds / 60 });
  return fillMessage(t("inbox.reachChange.unit.seconds"), { n: seconds });
}

export function PackageReachChange({ change }: { change: ReachChange | undefined }): ReactElement | null {
  const t = useT();
  if (change === undefined) return null;
  const lines: ReactElement[] = [];
  for (const entry of change.origins.added) {
    lines.push(
      <li key={`+origin:${entry.origin}`} data-reach-added-origin={entry.origin}>
        {fillMessage(t("inbox.reachChange.addedOrigin"), { origin: entry.origin, purpose: entry.purpose })}
      </li>,
    );
  }
  for (const entry of change.secrets.added) {
    lines.push(
      <li key={`+secret:${entry.name}`} data-reach-added-secret={entry.name}>
        {fillMessage(t("inbox.reachChange.addedSecret"), { name: entry.name, purpose: entry.purpose })}
      </li>,
    );
  }
  for (const entry of change.browserTokens.added) {
    lines.push(
      <li key={`+token:${entry.provider}:${entry.scope}`} data-reach-added-token={`${entry.provider} ${entry.scope}`}>
        {fillMessage(t("inbox.reachChange.addedToken"), { provider: entry.provider, scope: entry.scope })}
      </li>,
    );
  }
  for (const entry of change.connectionScopes.added) {
    lines.push(
      <li key={`+scope:${entry.provider}:${entry.scope}`} data-reach-added-account-scope={`${entry.provider} ${entry.scope}`}>
        {fillMessage(t("inbox.reachChange.addedAccountScope"), { provider: entry.provider, scope: entry.scope })}
      </li>,
    );
  }
  for (const entry of change.connectionEndpoints.added) {
    lines.push(
      <li key={`+endpoint:${entry.provider}:${entry.endpoint}`} data-reach-added-endpoint={`${entry.provider} ${entry.endpoint}`}>
        {fillMessage(t("inbox.reachChange.addedEndpoint"), { provider: entry.provider, endpoint: entry.endpoint })}
      </li>,
    );
  }
  if (change.profile !== undefined) {
    const profile = change.profile;
    lines.push(
      <li key="profile" data-reach-profile={`${profile.from} ${profile.to}`}>
        {fillMessage(t("inbox.reachChange.profile"), { from: profile.from, to: profile.to })}
        <ul style={{ margin: 0, paddingInlineStart: "1.25em" }}>
          {profile.limits.map((entry) => (
            <li key={entry.limit} data-reach-limit={entry.limit} data-reach-limit-direction={entry.to > entry.from ? "up" : "down"}>
              {fillMessage(t("inbox.reachChange.limitLine"), {
                limit: t(`inbox.reachChange.limit.${entry.limit}`),
                from: formatLimit(t, entry.limit, entry.from),
                to: formatLimit(t, entry.limit, entry.to),
              })}
            </li>
          ))}
          {profile.offscreen !== undefined && (
            <li data-reach-offscreen={profile.offscreen.to}>
              {fillMessage(t("inbox.reachChange.offscreen"), {
                from: t(`inbox.reachChange.offscreen.${profile.offscreen.from}`),
                to: t(`inbox.reachChange.offscreen.${profile.offscreen.to}`),
              })}
            </li>
          )}
        </ul>
      </li>,
    );
  }
  for (const entry of change.origins.removed) {
    lines.push(
      <li key={`-origin:${entry.origin}`} data-reach-removed-origin={entry.origin}>
        {fillMessage(t("inbox.reachChange.removedOrigin"), { origin: entry.origin })}
      </li>,
    );
  }
  for (const entry of change.secrets.removed) {
    lines.push(
      <li key={`-secret:${entry.name}`} data-reach-removed-secret={entry.name}>
        {fillMessage(t("inbox.reachChange.removedSecret"), { name: entry.name })}
      </li>,
    );
  }
  for (const entry of change.browserTokens.removed) {
    lines.push(
      <li key={`-token:${entry.provider}:${entry.scope}`} data-reach-removed-token={`${entry.provider} ${entry.scope}`}>
        {fillMessage(t("inbox.reachChange.removedToken"), { provider: entry.provider, scope: entry.scope })}
      </li>,
    );
  }
  for (const entry of change.connectionScopes.removed) {
    lines.push(
      <li key={`-scope:${entry.provider}:${entry.scope}`} data-reach-removed-account-scope={`${entry.provider} ${entry.scope}`}>
        {fillMessage(t("inbox.reachChange.removedAccountScope"), { provider: entry.provider, scope: entry.scope })}
      </li>,
    );
  }
  for (const entry of change.connectionEndpoints.removed) {
    lines.push(
      <li key={`-endpoint:${entry.provider}:${entry.endpoint}`} data-reach-removed-endpoint={`${entry.provider} ${entry.endpoint}`}>
        {fillMessage(t("inbox.reachChange.removedEndpoint"), { provider: entry.provider, endpoint: entry.endpoint })}
      </li>,
    );
  }
  return (
    <div data-reach-change={change.verdict}>
      <span style={{ display: "block" }}>{t(`inbox.reachChange.${change.verdict}`)}</span>
      {lines.length > 0 && (
        <ul className="cc-package-reach" style={{ margin: 0, paddingInlineStart: "1.25em" }}>
          {lines}
        </ul>
      )}
    </div>
  );
}
