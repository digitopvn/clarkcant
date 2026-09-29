import { type Notice, type NoticeAction, noticeKindQuietable, noticeSuppressionKey } from "@clarkcant/contracts";
import { type Database, findNoticeSuppression, getConversation, getTask } from "@clarkcant/storage";

/**
 * What the inbox offers for a notice, worked out by the host from what the notice is about and how that thing is now.
 *
 * The one place this is decided, so the panel, the header's OS notification and a spoken "ask Clark about the latest
 * notice" cannot disagree about it. A producer never contributes an action: the list below is closed, and every id in
 * it is implemented by the host. Nothing is stored — the answer is recomputed on each read, so a notice whose
 * conversation was deleted since it was written shows "Open" as unavailable instead of as a button that fails.
 *
 * Placement follows one rule: a notice that says something went well is mostly something to go and look at, so
 * "Open" leads; one that says something went wrong or needs attention is mostly something to act on, so "Ask Clark"
 * leads. At most two actions are drawn as buttons; the rest go behind "More".
 *
 * Snoozing and quieting a kind are always behind "More": they change when the person hears about things, not what the
 * notice is about. Which of "stop notifying about this kind" and "notify again" is offered is read from this principal's
 * suppressions now, so the menu cannot offer to quiet a kind that is already quiet; a kind too wide to quiet
 * (`noticeKindQuietable`: a reminder, a notice tied to no automation, source, package or node) offers neither. A notice
 * that is snoozed is not in the list at all; the one thing to do with it is bring it back.
 */
export function noticeActionsFor(db: Database, principalId: string, notice: Notice): NoticeAction[] {
  if (notice.snoozedUntil !== undefined) return [{ id: "unsnooze", placement: "primary" }];
  const target = conversationOf(db, notice);
  const open: NoticeAction | undefined =
    target === undefined
      ? undefined
      : getConversation(db, target) === undefined
        ? { id: "open", placement: "menu", unavailable: "conversation-gone" }
        : { id: "open", placement: "secondary" };
  const canOpen = open !== undefined && open.unavailable === undefined;
  const look = canOpen && (notice.severity === "success" || notice.severity === "info");

  const actions: NoticeAction[] = [];
  if (look) {
    actions.push({ id: "open", placement: "primary" }, { id: "ask-clark", placement: "secondary" });
  } else {
    actions.push({ id: "ask-clark", placement: "primary" });
    if (canOpen) actions.push({ id: "open", placement: "secondary" });
    else actions.push({ id: "dismiss", placement: "secondary" });
  }
  actions.push({ id: "add-to-context", placement: "menu" });
  actions.push({ id: notice.readAt === undefined ? "mark-read" : "mark-unread", placement: "menu" });
  actions.push({ id: "snooze", placement: "menu" });
  if (!actions.some((action) => action.id === "dismiss")) actions.push({ id: "dismiss", placement: "menu" });
  if (findNoticeSuppression(db, principalId, noticeSuppressionKey(notice)) !== undefined) {
    actions.push({ id: "unsuppress", placement: "menu" });
  } else if (noticeKindQuietable(notice)) {
    actions.push({ id: "suppress", placement: "menu" });
  }
  if (open !== undefined && !canOpen) actions.push(open);
  return actions;
}

/**
 * The conversation a notice leads back to: the one its task now belongs to when it is about a task, else the one its
 * subject or the notice itself names. A notice about a package or the Pi SDK belongs to no conversation.
 */
export function conversationOf(db: Database, notice: Notice): string | undefined {
  const subject = notice.subject;
  switch (subject?.kind) {
    case "task":
      return getTask(db, subject.taskId)?.conversationId ?? subject.conversationId ?? notice.conversationId;
    case "automation":
      // A run that started a task leads where that task now belongs, exactly as a `task` subject would.
      return (
        (subject.taskId === undefined ? undefined : getTask(db, subject.taskId)?.conversationId) ??
        subject.conversationId ??
        notice.conversationId
      );
    case "signal-source":
      return subject.conversationId ?? notice.conversationId;
    case "background-work":
    case "conversation":
      return subject.conversationId;
    case "package":
    case "pi-update":
    case "peer":
      return notice.conversationId;
    case undefined:
      return notice.conversationId;
  }
}
