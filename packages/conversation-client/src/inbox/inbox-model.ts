import type {
  ComposerReference,
  EffectCategory,
  InboxSummary,
  Notice,
  NoticeAction,
  NoticeSeverity,
  NoticeSourceKind,
  NoticeSuppression,
  WaitingItem,
} from "@clarkcant/contracts";

import type { MessageKey } from "../i18n/messages.ts";

/** The server's own cap on how many notices one `GET /inbox` returns (`apps/runtime/src/inbox.ts`'s `limit`). */
export const NOTICE_LIST_LIMIT = 50;

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
    case "automation":
      return "inbox.source.automation";
  }
}

/**
 * Every effect category's label, in the taxonomy's own words rather than the wire's `EffectCategory` slug.
 *
 * A closed list, matching `effectCategorySchema` — shared by Settings' rule editor, the panel's task-approval
 * title and its notification twin (`inbox-notify-decide.ts`), so AGENTS.md's "no capability refs in the
 * default UI" rule is satisfied in one place instead of three copies that could drift apart.
 */
export function effectCategoryLabels(t: (key: MessageKey) => string): Record<EffectCategory, string> {
  return {
    read: t("settings.control.category.read"),
    "local-write": t("settings.control.category.localWrite"),
    "external-write": t("settings.control.category.externalWrite"),
    destructive: t("settings.control.category.destructive"),
    financial: t("settings.control.category.financial"),
    communication: t("settings.control.category.communication"),
    "media-capture": t("settings.control.category.mediaCapture"),
  };
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

/**
 * Whether the notices list looks like the server's cap rather than a coincidentally round number under it.
 *
 * The response carries no total count (S: `InboxResponse` has `waiting`/`notices`/`unread`/`readAt` and nothing
 * else), so this cannot say for certain that more exist — only that the list is exactly as long as the server would
 * ever return, which is the one case a truthful "showing the newest N" line is worth drawing.
 */
export function noticesMayBeCapped(notices: readonly Notice[], limit: number = NOTICE_LIST_LIMIT): boolean {
  return notices.length >= limit;
}

/** The gateway's own error code, when `cause` carries one — the only part of a refusal the client should trust as fact. */
function gatewayErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A reason fit for a person to read, or `undefined` when the cause is not something to show as-is.
 *
 * `GatewayError.message` is `"${code}: ${message}"`; the code belongs in a log, not in a sentence a person reads,
 * so it is stripped. A schema failure (`ZodError`) stringifies to the whole list of issues — the caller falls back
 * to a fixed sentence and logs the original for whoever reads the console.
 */
export function sanitizeReason(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  if (cause.name === "ZodError") return undefined;
  const code = gatewayErrorCode(cause);
  const prefix = code === undefined ? undefined : `${code}: `;
  if (prefix !== undefined && cause.message.startsWith(prefix)) return cause.message.slice(prefix.length);
  return cause.message;
}

/**
 * Why a decide call failed, from the one fact the client can trust: the gateway's own error code.
 *
 * `expired` and `alreadyDecided` are certain — `decideApproval` (`packages/core/src/coordination.ts`) returns
 * those codes before writing anything, or (for `alreadyDecided`) because somebody else's decision already landed.
 * `taskNotWaiting` and `taskNotFound` are the same kind of certain for a task approval specifically: the gateway
 * refuses with `TASK_NOT_WAITING` (the task was cancelled, or resumed some other way, before this decision
 * arrived) or `TASK_NOT_FOUND` *before* writing any decision, so neither one is the "decision written, outcome
 * unclear" case the generic `ambiguous`/`notRun` copy describes — showing that copy for these two codes would be
 * unreachable-in-practice-but-still-wrong: a task-specific sentence exists precisely because nothing was written.
 * Every other code is `ambiguous` on purpose: a granted decision can fail *after* being recorded (the payload is
 * missing, the run itself refuses), and the client cannot tell a not-yet-recorded refusal from a recorded one that
 * could not run by the code alone. Resolving "ambiguous" is `decideFailureMessageKey`'s job, once a fresh read says
 * whether the item is still waiting.
 */
export type DecideFailureCategory = "expired" | "alreadyDecided" | "taskNotWaiting" | "taskNotFound" | "ambiguous";

export function decideFailureCategory(cause: unknown): DecideFailureCategory {
  const code = gatewayErrorCode(cause);
  if (code === "APPROVAL_EXPIRED") return "expired";
  if (code === "APPROVAL_ALREADY_DECIDED") return "alreadyDecided";
  if (code === "TASK_NOT_WAITING") return "taskNotWaiting";
  if (code === "TASK_NOT_FOUND") return "taskNotFound";
  return "ambiguous";
}

/**
 * The message key for a decide failure, once "ambiguous" has been resolved by re-reading the inbox.
 *
 * `stillWaitingAfterRead` is `undefined` when the re-read itself could not be trusted (it failed, or never ran):
 * the safe default there is the same sentence a not-yet-recorded refusal gets, because that is what the surface
 * already showed before this failure and nothing has disproved it.
 */
export function decideFailureMessageKey(category: DecideFailureCategory, stillWaitingAfterRead: boolean | undefined): MessageKey {
  if (category === "expired") return "inbox.decideFailed.expired";
  if (category === "alreadyDecided") return "inbox.decideFailed.alreadyDecided";
  if (category === "taskNotWaiting") return "inbox.decideFailed.taskNotWaiting";
  if (category === "taskNotFound") return "inbox.decideFailed.taskNotFound";
  if (stillWaitingAfterRead === false) return "inbox.decideFailed.notRun";
  return "inbox.decideFailed.stillWaiting";
}

/**
 * Where focus goes after a notice is dismissed and the list is re-read: the notice that took its place, the one
 * before it if the dismissed notice was last, or `undefined` when none are left — the caller falls back to a
 * stable landmark (the section heading) rather than `<body>`.
 */
export function nextNoticeFocusTarget(noticeIdsBeforeDismiss: readonly string[], dismissedId: string): string | undefined {
  const index = noticeIdsBeforeDismiss.indexOf(dismissedId);
  if (index === -1) return undefined;
  const remaining = noticeIdsBeforeDismiss.filter((id) => id !== dismissedId);
  return remaining.length === 0 ? undefined : remaining[Math.min(index, remaining.length - 1)];
}

/**
 * Whether "Open conversation" for a conversation other than the one on screen is safe to offer.
 *
 * Only asked about *another* conversation: opening the one already on screen is just closing the panel, and never
 * discards anything. Switching away from this one, through the host's `key`-remount, does — a running turn's
 * stream, an open voice session, an unsent draft or an attachment all disappear silently, so the button is
 * disabled rather than pretending the switch is free (AGENTS.md: disable with a visible reason instead of a
 * control that looks usable before it safely is).
 */
export function canOpenOtherConversation(state: {
  busy: boolean;
  voiceOpen: boolean;
  draftNonEmpty: boolean;
  hasAttachments: boolean;
}): boolean {
  return !state.busy && !state.voiceOpen && !state.draftNonEmpty && !state.hasAttachments;
}

/**
 * The conversation "Open" leads to: the one the notice's subject names, else the one the notice was written for. The
 * node has already said whether that conversation still exists (an `open` action marked `conversation-gone`), so this
 * only answers where, never whether.
 */
export function noticeConversationTarget(notice: Notice): string | undefined {
  const subject = notice.subject;
  if (subject !== undefined && "conversationId" in subject && subject.conversationId !== undefined) return subject.conversationId;
  return notice.conversationId;
}

/** Longest label a reference carries (`composer-references.ts`); a longer title is cut at a word where it can be. */
const REFERENCE_LABEL_MAX = 120;

/**
 * The reference "Ask Clark" and "Add to context" put on a message: a `notice` composer reference, checked and stored
 * like the ones chosen after `@`, labelled with the notice's title so the chip reads as what it points at.
 */
export function noticeReference(notice: Notice): { key: string; ref: Extract<ComposerReference, { kind: "notice" }> } {
  const title = notice.title.replace(/\s+/g, " ").trim();
  let label = title;
  if (label.length > REFERENCE_LABEL_MAX) {
    const cut = label.slice(0, REFERENCE_LABEL_MAX - 1);
    const space = cut.lastIndexOf(" ");
    label = `${(space > REFERENCE_LABEL_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return { key: `notice:${notice.noticeId}`, ref: { kind: "notice", noticeId: notice.noticeId, label: label === "" ? notice.noticeId : label } };
}

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

/** "This evening" and "tomorrow morning", as local clock hours. */
const EVENING_HOUR = 18;
const MORNING_HOUR = 8;

/**
 * The times a notice can be snoozed to, worked out from the person's own clock and time zone: the node stores an instant
 * and has no idea when "this evening" is for somebody.
 *
 *   - `hour`: an hour from now.
 *   - `evening`: 18:00 today, offered only until 17:00, so it is never less than an hour away and never already past.
 *   - `tomorrow`: 08:00 tomorrow.
 *   - `next-week`: 08:00 on the next Monday — a week away when today is Monday.
 *
 * Local-time arithmetic through `Date`'s own setters, so a daylight-saving change in between still lands on the wall
 * clock hour the label promises.
 */
export function snoozePresets(now: Date): Array<{ id: SnoozePresetId; until: Date }> {
  const at = (days: number, hour: number): Date => {
    const date = new Date(now.getTime());
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const presets: Array<{ id: SnoozePresetId; until: Date }> = [{ id: "hour", until: new Date(now.getTime() + 60 * 60_000) }];
  if (now.getHours() < EVENING_HOUR - 1) presets.push({ id: "evening", until: at(0, EVENING_HOUR) });
  presets.push({ id: "tomorrow", until: at(1, MORNING_HOUR) });
  // getDay(): 0 is Sunday, 1 is Monday. Days until the next Monday, never zero.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  presets.push({ id: "next-week", until: at(toMonday, MORNING_HOUR) });
  return presets;
}

/**
 * When a preset ends if it is chosen at `now`. The surface asks this at the moment of the press, not when the menu was
 * drawn, so a menu left open past 18:00 cannot snooze a notice to an evening that has already gone. Undefined when the
 * preset is no longer offered at `now`.
 */
export function snoozeUntil(id: SnoozePresetId, now: Date): Date | undefined {
  return snoozePresets(now).find((preset) => preset.id === id)?.until;
}

export function snoozePresetKey(id: SnoozePresetId): MessageKey {
  switch (id) {
    case "hour":
      return "inbox.snooze.hour";
    case "evening":
      return "inbox.snooze.evening";
    case "tomorrow":
      return "inbox.snooze.tomorrow";
    case "next-week":
      return "inbox.snooze.nextWeek";
  }
}

/**
 * What a quieted kind covers, in parts the surface words: which thing it is limited to (an automation, a signal
 * source, a package, the Pi SDK, a node — or a whole source when it has no scope) and which level. One example title
 * alone would not say whether quieting it also quiets anything else; this does.
 */
export function suppressionDescription(suppression: NoticeSuppression): { scopeKey: MessageKey; label: string; levelKey: MessageKey } {
  const levelKey = suppressionLevelKey(suppression.severity);
  const scope = suppression.scope;
  if (scope === undefined) return { scopeKey: "inbox.suppressions.scope.all", label: "", levelKey };
  const colon = scope.indexOf(":");
  const prefix = colon === -1 ? scope : scope.slice(0, colon);
  const label = suppression.scopeLabel ?? (colon === -1 ? scope : scope.slice(colon + 1));
  switch (prefix) {
    case "automation":
      return { scopeKey: "inbox.suppressions.scope.automation", label, levelKey };
    case "source":
      return { scopeKey: "inbox.suppressions.scope.source", label, levelKey };
    case "package":
      return { scopeKey: "inbox.suppressions.scope.package", label, levelKey };
    case "pi":
      return { scopeKey: "inbox.suppressions.scope.pi", label, levelKey };
    default:
      return { scopeKey: "inbox.suppressions.scope.peer", label, levelKey };
  }
}

function suppressionLevelKey(severity: NoticeSeverity): MessageKey {
  switch (severity) {
    case "info":
      return "inbox.suppressions.level.info";
    case "success":
      return "inbox.suppressions.level.success";
    case "warning":
      return "inbox.suppressions.level.warning";
    case "error":
      return "inbox.suppressions.level.error";
  }
}

/**
 * Whether the node says this notice's kind is quieted: it offers "notify about this kind again" only then. Read from the
 * actions it worked out, so the surface never keeps its own copy of the suppression list to disagree with.
 */
export function noticeKindQuieted(notice: Notice): boolean {
  return notice.actions?.some((action) => action.id === "unsuppress") === true;
}

/**
 * A notice's actions split the way the row draws them: at most two buttons, and the rest behind "More". A notice read
 * from a node that does not work out actions yet keeps the two it always had, "Open" and "Dismiss".
 */
export function noticeActionGroups(notice: Notice): { buttons: NoticeAction[]; menu: NoticeAction[] } {
  const list: readonly NoticeAction[] = notice.actions ?? [
    ...(notice.conversationId === undefined ? [] : [{ id: "open", placement: "secondary" } as const]),
    { id: "dismiss", placement: "secondary" } as const,
  ];
  const order = (placement: NoticeAction["placement"]) => list.filter((action) => action.placement === placement);
  return { buttons: [...order("primary"), ...order("secondary")].slice(0, 2), menu: order("menu") };
}