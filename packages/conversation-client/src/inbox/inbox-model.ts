import type { InboxSummary, Notice, NoticeSeverity, NoticeSourceKind, WaitingItem } from "@clarkcant/contracts";

import type { MessageKey } from "../i18n/messages.ts";

/**
 * The decisions behind the inbox surface, apart from React so the node-only suite can hold them.
 *
 * Nothing here fetches or renders. What it decides is what the surface would otherwise decide inline and get subtly
 * wrong in one of its three places: whether the mark is drawn at all, which notices opening the panel may mark read,
 * and how old a thing is in words a person reads at a glance.
 */

/** Whether the header mark is drawn. Absent at zero, like the background mark: a permanent "0" is noise. */
export function inboxMarkVisible(summary: InboxSummary | undefined): boolean {
  return summary !== undefined && summary.waiting + summary.unread > 0;
}

/**
 * The mark's own words, waiting first.
 *
 * Waiting outranks unread because it is the one that costs something to ignore: an approval that expires unanswered
 * is work that did not happen, while an unread notice is only a result nobody has looked at yet.
 */
export function inboxMarkText(summary: InboxSummary, t: (key: MessageKey) => string): string {
  const parts: string[] = [];
  if (summary.waiting > 0) parts.push(t("inbox.mark.waiting").replace("{count}", String(summary.waiting)));
  if (summary.unread > 0) parts.push(t("inbox.mark.unread").replace("{count}", String(summary.unread)));
  return parts.join(" · ");
}

/** The mark's state, for the stylesheet and the browser suite: whether something is waiting on the person. */
export function inboxMarkState(summary: InboxSummary): "waiting" | "unread" {
  return summary.waiting > 0 ? "waiting" : "unread";
}

/**
 * The notices opening the panel marks read: exactly the unread ones it drew.
 *
 * Not "everything": a notice that lands between the read that filled the panel and the call that marks it would be
 * marked read without ever having been on screen, and the one property of "unread" worth keeping is that it is true.
 */
export function noticeIdsToMarkRead(notices: readonly Notice[]): string[] {
  return notices.filter((notice) => notice.readAt === undefined).map((notice) => notice.noticeId);
}

/** A notice's badge tone, in the badge vocabulary the rest of the surface already uses. */
export function noticeTone(severity: NoticeSeverity): "ok" | "warn" | "danger" | undefined {
  switch (severity) {
    case "success":
      return "ok";
    case "warning":
      return "warn";
    case "error":
      return "danger";
    case "info":
      return undefined;
  }
}

/** Where a notice came from, in the person's words rather than the node's. */
export function noticeSourceKey(sourceKind: NoticeSourceKind): MessageKey {
  switch (sourceKind) {
    case "background":
      return "inbox.source.background";
    case "worker":
      return "inbox.source.worker";
    case "package":
      return "inbox.source.package";
    case "pi":
      return "inbox.source.pi";
    case "peer":
      return "inbox.source.peer";
    case "system":
      return "inbox.source.system";
  }
}

/** A stable key for a waiting item, for React and for the busy state of its buttons. */
export function waitingKey(item: WaitingItem): string {
  return item.kind === "question" ? `question:${item.questionId}` : `${item.kind}:${item.approvalId}`;
}

/**
 * How long ago something happened, as a person says it.
 *
 * Coarse on purpose: "3 minutes ago" is what a glance needs, and a precise timestamp is one hover away in the
 * element's `title`. A clock that disagrees with the node's by a few seconds reads as "just now" rather than as a
 * time in the future.
 */
export function relativeAge(then: string, now: string, t: (key: MessageKey) => string): string {
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(then));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return t("inbox.age.now");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return t("inbox.age.minutes").replace("{count}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("inbox.age.hours").replace("{count}", String(hours));
  return t("inbox.age.days").replace("{count}", String(Math.floor(hours / 24)));
}

/**
 * How long a waiting item has left, or that it has none.
 *
 * Measured against the time the node read the inbox rather than the browser's clock, so a machine whose clock is off
 * does not tell somebody they have an hour when the node will refuse the decision in a minute.
 */
export function timeLeft(expiresAt: string | undefined, readAt: string, t: (key: MessageKey) => string): string | undefined {
  if (expiresAt === undefined) return undefined;
  const left = Date.parse(expiresAt) - Date.parse(readAt);
  if (!Number.isFinite(left)) return undefined;
  if (left <= 60_000) return t("inbox.expires.soon");
  return t("inbox.expires.minutes").replace("{count}", String(Math.floor(left / 60_000)));
}
