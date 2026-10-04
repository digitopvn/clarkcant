import {
  type Instant,
  type MessageBlock,
  type Notice,
  type NoticeAction,
  type NoticeActionId,
  noticeKindQuietable,
  noticeSuppressionKey,
} from "@clarkcant/contracts";
import { answerableUnknownEffect } from "@clarkcant/core";
import {
  type Database,
  type WorkRunRecord,
  findNoticeSuppression,
  getConversation,
  getTask,
  getWorkRun,
  latestMessagesContaining,
  oneRow,
} from "@clarkcant/storage";

import { askAgainState } from "./interactions.ts";
import { isNewerVersion } from "./update-checks.ts";

/** What the resolver needs to know about the node besides its database: whose packages, and what time it is. */
export interface NoticeActionContext {
  nodeId: string;
  now: Instant;
}

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
 * leads. One exception outranks both: a notice about a task with an effect whose outcome is unknown is waiting for the
 * person to say whether it landed, so "It took effect" and "It did not" lead, for as long as that effect is unknown. At
 * most two actions are drawn as buttons; the rest go behind "More". An action on the thing itself — try the work again,
 * install the update, ask the expired question again — is what the notice is for when it can be taken, so it leads
 * ahead of Open and Ask Clark (`subjectOperations`).
 *
 * Snoozing and quieting a kind are always behind "More": they change when the person hears about things, not what the
 * notice is about. Which of "stop notifying about this kind" and "notify again" is offered is read from this principal's
 * suppressions now, so the menu cannot offer to quiet a kind that is already quiet; a kind too wide to quiet
 * (`noticeKindQuietable`: a reminder, a notice tied to no automation, source, package or node) offers neither. A notice
 * that is snoozed is not in the list at all; the one thing to do with it is bring it back.
 *
 * "Copy details" is behind "More" on every notice in the list, after the rest: it only puts the notice's own words on
 * the person's clipboard, which only their screen can do, so the route refuses it like "Open" (`SURFACE_ACTION`).
 */
export function noticeActionsFor(
  db: Database,
  principalId: string,
  notice: Notice,
  context: NoticeActionContext,
): NoticeAction[] {
  if (notice.snoozedUntil !== undefined) return [{ id: "unsnooze", placement: "primary" }];
  const target = conversationOf(db, notice);
  const conversationExists = target !== undefined && getConversation(db, target) !== undefined;
  const open: NoticeAction | undefined =
    target === undefined
      ? undefined
      : conversationExists
        ? { id: "open", placement: "secondary" }
        : { id: "open", placement: "menu", unavailable: "conversation-gone" };
  const canOpen = open !== undefined && open.unavailable === undefined;
  const look = canOpen && (notice.severity === "success" || notice.severity === "info");
  const unknownEffect = reconcilableEffect(db, principalId, context.nodeId, notice);
  const operations = subjectOperations(db, notice, context, conversationExists);

  const actions: NoticeAction[] = [];
  if (unknownEffect !== undefined) {
    // The one thing the notice is waiting for is the person's answer, so the two answers are the buttons, and going
    // to the conversation or asking Clark about it moves behind "More".
    actions.push(
      { id: "reconcile-confirmed", placement: "primary", effectId: unknownEffect },
      { id: "reconcile-failed", placement: "secondary", effectId: unknownEffect },
      { id: "ask-clark", placement: "menu" },
    );
    if (canOpen) actions.push({ id: "open", placement: "menu" });
  } else {
    // Lead with what can be done about the thing, then the usual pair; the first two are buttons, the rest go to "More".
    // "Dismiss" stands in for "Open" only as a button: pushed into "More" by an operation, it keeps its usual place
    // there, after "Add to context" and the rest.
    // A notice that asks nothing leads with going to look or putting it away, then its own operations; asking Clark
    // about it is still there, behind "More".
    const leading: NoticeActionId[] = (operations.askable === false
      ? [canOpen ? "open" as const : "dismiss" as const, ...operations.lead]
      : [...operations.lead, ...(look ? (["open", "ask-clark"] as const) : (["ask-clark", canOpen ? "open" : "dismiss"] as const))]
    ).filter((id, index) => index < 2 || id !== "dismiss");
    for (const [index, id] of leading.entries()) {
      actions.push({ id, placement: index === 0 ? "primary" : index === 1 ? "secondary" : "menu" });
    }
    if (operations.askable === false) actions.push({ id: "ask-clark", placement: "menu" });
  }
  actions.push({ id: "add-to-context", placement: "menu" });
  actions.push({ id: notice.readAt === undefined ? "mark-read" : "mark-unread", placement: "menu" });
  actions.push({ id: "snooze", placement: "menu" });
  for (const id of operations.menu) actions.push({ id, placement: "menu" });
  if (!actions.some((action) => action.id === "dismiss")) actions.push({ id: "dismiss", placement: "menu" });
  if (findNoticeSuppression(db, principalId, noticeSuppressionKey(notice)) !== undefined) {
    actions.push({ id: "unsuppress", placement: "menu" });
  } else if (noticeKindQuietable(notice)) {
    actions.push({ id: "suppress", placement: "menu" });
  }
  // A low-priority action, for reporting a notice somewhere else: always last among what can be taken.
  actions.push({ id: "copy-details", placement: "menu" });
  if (open !== undefined && !canOpen) actions.push(open);
  actions.push(...operations.unavailable);
  return actions;
}

interface SubjectOperations {
  /** Offered ahead of Open and Ask Clark, in this order. */
  lead: NoticeActionId[];
  /** Offered behind "More". */
  menu: NoticeActionId[];
  /** Listed with why they cannot be taken now, at the end of "More". */
  unavailable: NoticeAction[];
  /**
   * `false` when the notice asks nothing of the person, so "Ask Clark" is not one of its buttons. It stays behind
   * "More": a button that sends the person to a conversation about something that needs no decision — and that only
   * works while a model answers — is the wrong first thing to offer.
   */
  askable?: false;
}

const NONE: SubjectOperations = { lead: [], menu: [], unavailable: [] };

/** A background run that ended in one of these can be run again; one that finished or is still going cannot. */
const RETRYABLE_STATES: ReadonlySet<string> = new Set(["failed", "stopped", "interrupted"]);

/**
 * Whether a run is background work that ended without a result and kept the words it was asked with: what "Try again"
 * needs, both to be offered here and to be carried out (`retryBackgroundWork`). Whether it was already tried again is
 * asked separately, because the two answers are worded differently.
 */
export function retryableBackgroundRun(run: WorkRunRecord): boolean {
  return run.kind === "background" && RETRYABLE_STATES.has(run.state) && run.requestText !== undefined;
}

/**
 * The actions on what the notice is about, each derived from that thing's state now.
 *
 *   - Background work: "Try again" while its run is kept, ended without a result, carries the words it was asked with,
 *     was not already tried again, and its conversation is still there. A run no longer kept says so, unless the
 *     notice said it went well, where there is nothing to try again.
 *   - A package update: "Update" and "Review" while the package is installed at an older version than the notice
 *     names, and "Skip this version" with them; only "Review" for a version from a local folder, which cannot be
 *     installed by id and version alone. A package no longer installed, or already at that version, says which.
 *   - A Pi SDK update: "Dismiss" and "Skip this version", and not "Ask Clark" as a button. Updating the SDK is updating
 *     ClarkCant itself, which is not done from here, so the notice asks nothing of the person.
 *   - An expired question: "Ask again" while nobody has answered, dropped or re-asked it and its conversation is there.
 */
function subjectOperations(
  db: Database,
  notice: Notice,
  context: NoticeActionContext,
  conversationExists: boolean,
): SubjectOperations {
  const subject = notice.subject;
  switch (subject?.kind) {
    case "background-work": {
      const run = getWorkRun(db, subject.workId);
      if (run === undefined) {
        return notice.severity === "success"
          ? NONE
          : { lead: [], menu: [], unavailable: [{ id: "retry", placement: "menu", unavailable: "work-gone" }] };
      }
      const retryable = retryableBackgroundRun(run) && run.retriedAs === undefined && conversationExists;
      return retryable ? { lead: ["retry"], menu: [], unavailable: [] } : NONE;
    }
    case "package": {
      if (notice.category !== "update" || subject.version === undefined) return NONE;
      const installed = installedVersion(db, context.nodeId, subject.packageId);
      if (installed === undefined) {
        return { lead: [], menu: [], unavailable: [{ id: "update", placement: "menu", unavailable: "package-gone" }] };
      }
      if (!isNewerVersion(subject.version, installed)) {
        return { lead: [], menu: [], unavailable: [{ id: "update", placement: "menu", unavailable: "already-current" }] };
      }
      // A version from a folder on this machine has no published digest to install it by, so it is reviewed instead.
      if (subject.source === "local") return { lead: ["review-update"], menu: ["skip-version"], unavailable: [] };
      return { lead: ["update", "review-update"], menu: ["skip-version"], unavailable: [] };
    }
    case "pi-update":
      // Nothing to decide: the SDK arrives with the next ClarkCant release. "Dismiss" leads, "Skip this version" is the
      // button beside it.
      return { lead: ["skip-version"], menu: [], unavailable: [], askable: false };
    case "question": {
      if (!conversationExists) return NONE;
      const state = askAgainState(questionBlocks(db, subject.conversationId, subject.questionId), subject.questionId, context.now);
      return state === "expired" ? { lead: ["ask-again"], menu: [], unavailable: [] } : NONE;
    }
    case "task":
    case "peer":
    case "automation":
    case "signal-source":
    case "conversation":
    case undefined:
      return NONE;
    default: {
      // A notice kind added later has to decide here what can be done about it, rather than silently offering nothing.
      const unhandled: never = subject;
      return unhandled;
    }
  }
}

/** The version of a package this node runs now, when it runs one. */
export function installedVersion(db: Database, nodeId: string, packageId: string): string | undefined {
  return oneRow<{ version: string }>(
    db,
    "SELECT version FROM package_generations WHERE package_id = ? AND node_id = ? AND superseded_at IS NULL",
    packageId,
    nodeId,
  )?.version;
}

/**
 * How far back a question is looked for: the same window a conversation's own question routes read
 * (`OPEN_ITEM_MESSAGES`), so the inbox never offers "Ask again" for a question the route that does it cannot find.
 */
const QUESTION_WINDOW_MESSAGES = 2000;

/**
 * The blocks of the messages in that window that name this question: its card and every record of what became of it,
 * which is all `askAgainState` reads. Each carries the id as `"questionId":"…"` in its stored document (the card as its
 * own field, a record in its arguments), so only those messages are parsed — an inbox read with several expired
 * questions does not parse a whole long transcript for each.
 */
function questionBlocks(db: Database, conversationId: string, questionId: string): MessageBlock[] {
  const needle = `"questionId":${JSON.stringify(questionId)}`;
  return latestMessagesContaining(db, conversationId, needle, QUESTION_WINDOW_MESSAGES).flatMap((message) => message.blocks);
}

/**
 * The effect a notice can be answered for from the inbox: the oldest still-`unknown` effect of the task it is about,
 * that this node carried out and this person may answer for. Recomputed on each read, so once it is answered — from the
 * button, a sentence, or another screen — the two actions are simply not offered any more. A notice another node sent
 * is never answered here: the effect is that node's to reconcile.
 */
function reconcilableEffect(db: Database, principalId: string, nodeId: string, notice: Notice): string | undefined {
  if (notice.originNodeId !== undefined || notice.subject?.kind !== "task") return undefined;
  return answerableUnknownEffect({ db, nodeId, principalId }, notice.subject.taskId)?.effectId;
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
    case "question":
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
