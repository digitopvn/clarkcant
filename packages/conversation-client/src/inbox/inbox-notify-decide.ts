import {
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  redactSecrets,
  type InboxNotificationGroup,
  type InboxNotificationsPreference,
  type Notice,
  type WaitingItem,
} from "@clarkcant/contracts";

import type { MessageKey } from "../i18n/messages.ts";
import { waitingKey } from "./inbox-model.ts";

/**
 * Which notice or waiting item earns an OS/web notification, apart from the polling and the delivery API so the
 * node-only suite can hold it.
 *
 * Deciding is pure: everything the outside world could disagree about — the clock, whether the document has
 * focus, which ids already fired — arrives as a parameter, and the caller (`use-inbox-notifications.ts`) is the
 * only place that reads `Date.now()`, `document.hidden` or `Notification`. That split is what makes "tắt một
 * nhóm thì không có thông báo cho nhóm đó" and "nhắc một lần khi việc chờ còn ≤ 1 phút" testable without a DOM.
 */

/** How close to expiry a waiting item has to be before it earns its one reminder. */
const NEAR_EXPIRY_MS = 60_000;

/**
 * Which group a notice belongs to, in the product's own words rather than the wire's.
 *
 * A notice from another paired node, or one this node already tags `originNodeId`, is "other devices" even
 * though the pairing feature it will eventually come from (#170) is not built yet — the toggle exists ahead of
 * its producer on purpose (see `otherDevices` in `packages/contracts/src/preferences.ts`). `update` is its own
 * group because a person who wants to know about approvals but not about package updates is a common split.
 * Everything else — a finished background task, a system alert — is a "background result": the node did
 * something on its own and is reporting back.
 */
export function groupForNotice(notice: Notice): InboxNotificationGroup {
  if (notice.originNodeId !== undefined || notice.category === "message") return "otherDevices";
  if (notice.category === "update") return "updates";
  return "backgroundResults";
}

/** Every waiting item is something the person must decide or answer, so all three kinds share one group. */
const WAITING_GROUP: InboxNotificationGroup = "waitingApprovals";

/** A clock reading such as `"22:00"` into minutes since local midnight. */
export function minutesOfDay(time: string): number {
  const [hoursPart, minutesPart] = time.split(":");
  return Number.parseInt(hoursPart ?? "0", 10) * 60 + Number.parseInt(minutesPart ?? "0", 10);
}

/**
 * Whether `nowMinutes` falls inside a quiet-hours window that may cross midnight, such as 22:00 to 07:00.
 *
 * Equal bounds mean quiet hours cover nothing: a zero-width window is how the settings toggle expresses "off"
 * without a separate `enabled` check leaking into this function too.
 */
export function isWithinQuietHours(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/** Redacts, then bounds — in that order, so a secret that would have been cut off is still caught. */
function boundedText(text: string, max: number): string {
  const redacted = redactSecrets(text);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/**
 * A waiting item's title, reusing the exact words the inbox panel already renders for the same kind — a person
 * who glances at the OS notification and then opens the panel sees the same sentence twice, not two summaries
 * of the same thing that might not agree.
 */
function waitingTitle(item: WaitingItem, t: (key: MessageKey) => string): string {
  switch (item.kind) {
    case "command-approval":
      return t("inbox.command.title");
    case "capability-approval":
      return t("inbox.capability.title").replace("{package}", item.packageId).replace("{capability}", item.ref);
    case "question":
      return t("inbox.question.title");
  }
}

/**
 * A waiting item's body: the description or prompt a person already reads in the panel, never the raw
 * `command` a command-approval carries — that field exists so the card can run what it shows, not so a
 * notification can repeat it outside the app.
 */
function waitingBody(item: WaitingItem): string | undefined {
  const text = item.kind === "question" ? item.prompt : item.description;
  return text.length === 0 ? undefined : boundedText(text, NOTICE_BODY_MAX);
}

/** One thing this poll decided is worth telling the person about outside the app. */
export interface InboxNotifyCandidate {
  /** Stable across polls for the same underlying notice or waiting item — `notice:<id>` or the waiting key. */
  id: string;
  group: InboxNotificationGroup;
  title: string;
  body: string | undefined;
  /** A fresh item, or a waiting item close enough to expiry to earn its one reminder. */
  reason: "new" | "near-expiry";
}

export interface DecideInboxNotificationsInput {
  preference: InboxNotificationsPreference;
  notices: readonly Notice[];
  waiting: readonly WaitingItem[];
  /** Ids already known from an earlier poll — a known id notifies again only for a near-expiry reminder. */
  knownIds: ReadonlySet<string>;
  /** Waiting ids that already received their one near-expiry reminder. */
  remindedNearExpiryIds: ReadonlySet<string>;
  /** The instant this poll read the inbox, for comparing against a waiting item's `expiresAt`. */
  now: string;
  /** Minutes since local midnight at `now`, for quiet hours — kept separate so a test never has to fake a timezone. */
  nowLocalMinutes: number;
  /**
   * Whether the person cannot already see this from the in-app mark: the document is hidden, unfocused, or the
   * window is in orb/compact mode. When this is `false` the in-app mark already covers it and nothing here
   * should duplicate it outside the app.
   */
  documentHidden: boolean;
  t: (key: MessageKey) => string;
}

export interface DecideInboxNotificationsOutput {
  candidates: InboxNotifyCandidate[];
  /** Every id present this poll, notices and waiting items alike — the caller's next `knownIds`. */
  seenIds: Set<string>;
  /** This poll's near-expiry reminders, already pruned to ids still present — the caller's next value, whole. */
  remindedNearExpiryIds: Set<string>;
}

/**
 * Decides which notices and waiting items earn a notification this poll.
 *
 * Membership tracking (`seenIds`) is unconditional: an item is "known" the first time it is seen regardless of
 * whether a group, quiet hours or the channel switches would have allowed a notification for it, so turning a
 * group back on never floods the person with everything that arrived while it was off. Only the *candidates*
 * list is gated by group, quiet hours, the document-hidden signal and having at least one channel enabled.
 */
export function decideInboxNotifications(input: DecideInboxNotificationsInput): DecideInboxNotificationsOutput {
  const { preference, notices, waiting, knownIds, t } = input;
  const seenIds = new Set<string>();
  const candidates: InboxNotifyCandidate[] = [];

  const presentWaitingKeys = new Set(waiting.map(waitingKey));
  const remindedNearExpiryIds = new Set([...input.remindedNearExpiryIds].filter((id) => presentWaitingKeys.has(id)));

  const anyChannelEnabled = preference.os || preference.web;
  const quiet =
    preference.quietHours.enabled &&
    isWithinQuietHours(
      input.nowLocalMinutes,
      minutesOfDay(preference.quietHours.start),
      minutesOfDay(preference.quietHours.end),
    );
  const mayNotify = anyChannelEnabled && !quiet && input.documentHidden;

  for (const notice of notices) {
    const id = `notice:${notice.noticeId}`;
    seenIds.add(id);
    if (knownIds.has(id) || !mayNotify) continue;
    const group = groupForNotice(notice);
    if (!preference.groups[group]) continue;
    candidates.push({
      id,
      group,
      title: boundedText(notice.title, NOTICE_TITLE_MAX),
      body: notice.body === undefined ? undefined : boundedText(notice.body, NOTICE_BODY_MAX),
      reason: "new",
    });
  }

  for (const item of waiting) {
    const id = waitingKey(item);
    seenIds.add(id);
    if (!mayNotify || !preference.groups[WAITING_GROUP]) continue;

    const msLeft = item.expiresAt === undefined ? undefined : Date.parse(item.expiresAt) - Date.parse(input.now);
    const nearExpiry = msLeft !== undefined && msLeft > 0 && msLeft <= NEAR_EXPIRY_MS && !remindedNearExpiryIds.has(id);
    const isNew = !knownIds.has(id);
    if (!isNew && !nearExpiry) continue;

    candidates.push({
      id,
      group: WAITING_GROUP,
      title: waitingTitle(item, t),
      body: waitingBody(item),
      reason: isNew ? "new" : "near-expiry",
    });
    if (nearExpiry) remindedNearExpiryIds.add(id);
  }

  return { candidates, seenIds, remindedNearExpiryIds };
}
