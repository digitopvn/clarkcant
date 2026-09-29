import type { Notice, NoticeAction } from "@clarkcant/contracts";
import { type Database, getConversation, getTask } from "@clarkcant/storage";

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
 */
export function noticeActionsFor(db: Database, notice: Notice): NoticeAction[] {
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
  if (!actions.some((action) => action.id === "dismiss")) actions.push({ id: "dismiss", placement: "menu" });
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
