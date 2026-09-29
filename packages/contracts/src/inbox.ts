import { z } from "zod";

import { effectCategorySchema, instantSchema } from "./primitives.ts";

/**
 * The inbox: what is waiting for the person, and what happened while they were somewhere else.
 *
 * Two different kinds of thing share one list, and the difference between them is the whole design:
 *
 *   - A **waiting item** is derived. An approval lives in the `approvals` table and on the card in its
 *     transcript; a question lives in its transcript. The inbox reads them back on every request and stores
 *     nothing of its own, so it cannot disagree with the conversation about whether something is still open.
 *     A waiting item cannot be dismissed — only answered, or left to expire — because hiding a question is
 *     not answering it.
 *   - A **notice** is a record. Work that finished in the background, and (later) an update that became
 *     available or a message another node sent, has no card anyone is looking at, so it is written down once,
 *     with a dedup key the producer chooses, and can be read and dismissed.
 *
 * Nothing here is a navigation concept. `conversationId` is a pointer to where the thing happened, so the
 * person can go and look; it is not a list of sessions to pick from.
 */

/** Who produced a notice. Every one of these is something the person can recognise without knowing the internals. */
export const noticeSourceKindSchema = z.enum([
  /** Work the person sent to the background from this conversation. */
  "background",
  /** A dispatched task a worker ran. */
  "worker",
  /** A package, extension or widget — install, update, removal. */
  "package",
  /** The Pi runtime itself. */
  "pi",
  /** Another ClarkCant node this one is paired with. */
  "peer",
  /** This node: storage, credentials, the runtime. */
  "system",
  /** Something the person set up earlier to happen on its own: "when X happens, do Y". */
  "automation",
]);
export type NoticeSourceKind = z.infer<typeof noticeSourceKindSchema>;

/** What a notice is about, which is what decides how it is worded and grouped, never how urgent it looks. */
export const noticeCategorySchema = z.enum(["result", "update", "message", "alert"]);
export type NoticeCategory = z.infer<typeof noticeCategorySchema>;

export const noticeSeveritySchema = z.enum(["info", "success", "warning", "error"]);
export type NoticeSeverity = z.infer<typeof noticeSeveritySchema>;

export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 500;

const subjectIdSchema = z.string().min(1).max(200);

/**
 * What a notice is about, as a typed pointer to state the node already holds.
 *
 * A producer names the thing; it never names what can be done about it. What the inbox offers for a notice is worked
 * out by the host from this pointer and the thing's current state (`noticeActionsFor` in the runtime), so a producer —
 * a peer above all — cannot put a button in front of the person, and an action whose thing is gone is shown as
 * unavailable with the reason rather than as a button that fails.
 *
 * Optional: a notice written before subjects existed, or by a producer with nothing more specific than its
 * conversation, is read as being about that conversation.
 */
export const noticeSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation"), conversationId: subjectIdSchema }),
  z.strictObject({ kind: z.literal("background-work"), workId: subjectIdSchema, conversationId: subjectIdSchema }),
  z.strictObject({ kind: z.literal("task"), taskId: subjectIdSchema, conversationId: subjectIdSchema.optional() }),
  z.strictObject({ kind: z.literal("package"), packageId: subjectIdSchema, version: z.string().min(1).max(100).optional() }),
  z.strictObject({ kind: z.literal("pi-update"), packageName: subjectIdSchema, version: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal("peer"), nodeId: subjectIdSchema }),
  /**
   * A standing request the person set up ("when X happens, do Y"), named by its intent id, with its summary in the
   * person's words as `label` so a list of quieted kinds can say which one it is. `taskId` is the task this run
   * started, when it started one: "Open" leads to wherever that task now belongs, as it would for a `task` subject.
   */
  z.strictObject({
    kind: z.literal("automation"),
    intentId: subjectIdSchema,
    label: z.string().min(1).max(NOTICE_TITLE_MAX),
    taskId: subjectIdSchema.optional(),
    conversationId: subjectIdSchema.optional(),
  }),
  /** One source of signals this node polls or listens to, such as one GitHub repository; `label` names it for a person. */
  z.strictObject({
    kind: z.literal("signal-source"),
    sourceKey: subjectIdSchema,
    label: z.string().min(1).max(NOTICE_TITLE_MAX),
    conversationId: subjectIdSchema.optional(),
  }),
]);
export type NoticeSubject = z.infer<typeof noticeSubjectSchema>;

/**
 * The things a person can do with a notice. A closed list the host implements: none of them is a callback, a URL or a
 * command a producer supplied.
 *
 *   - `open`: go to the conversation the notice points at.
 *   - `ask-clark`: send Clark a message carrying the notice as a typed reference, so the turn reads what the notice
 *     is about rather than a pasted copy of its text.
 *   - `add-to-context`: put the same reference in the composer without sending.
 *   - `mark-read` / `mark-unread`: attention state only; neither hides the notice.
 *   - `dismiss`: take it out of the list, undoable for a short while.
 *   - `snooze` / `unsnooze`: take this one notice out of the list and the unread count until a chosen time, when it
 *     comes back unread; or bring a snoozed one back now.
 *   - `suppress` / `unsuppress`: stop notifying about notices of this kind (`noticeSuppressionKey`) from now on, or
 *     start again. Future matching notices are still listed, but arrive read, so they raise no count and no
 *     notification outside the app. Nothing already in the list changes.
 *   - `reconcile-confirmed` / `reconcile-failed`: record what the person saw on the other side of an effect whose
 *     outcome nobody observed — it took effect, or it did not (`POST /effects/:effectId/reconcile`). Offered only while
 *     that effect is still `unknown`, and each carries the `effectId` it answers for.
 */
export const noticeActionIdSchema = z.enum([
  "open",
  "ask-clark",
  "add-to-context",
  "mark-read",
  "mark-unread",
  "dismiss",
  "snooze",
  "unsnooze",
  "suppress",
  "unsuppress",
  "reconcile-confirmed",
  "reconcile-failed",
]);
export type NoticeActionId = z.infer<typeof noticeActionIdSchema>;

/**
 * One action, where it goes and whether it can be taken now.
 *
 * At most one `primary` and one `secondary` per notice, drawn as buttons; the rest go behind "More". An action that
 * cannot be taken is still listed, with why, because a control that silently disappears reads as a bug and one that
 * looks usable but fails is worse. `unavailable` is a code rather than a sentence so the surface words it in the
 * person's language; what only the surface knows (a reply being written, a draft that switching would drop) it adds
 * itself.
 */
export const noticeActionSchema = z
  .strictObject({
    id: noticeActionIdSchema,
    placement: z.enum(["primary", "secondary", "menu"]),
    unavailable: z.enum(["conversation-gone"]).optional(),
    /** The effect a `reconcile-*` action answers for; present on those two and on nothing else. */
    effectId: z.string().min(1).max(128).optional(),
  })
  .refine((action) => (action.effectId !== undefined) === isReconcileAction(action.id), {
    message: "effectId is carried by the reconcile actions, and only by them",
    path: ["effectId"],
  });
export type NoticeAction = z.infer<typeof noticeActionSchema>;

/** Whether an action records what the person saw of an effect whose outcome is unknown. */
export function isReconcileAction(id: NoticeActionId): id is "reconcile-confirmed" | "reconcile-failed" {
  return id === "reconcile-confirmed" || id === "reconcile-failed";
}

/**
 * What a person records about an effect whose outcome nobody observed (`POST /effects/:effectId/reconcile`).
 *
 * `outcome` is what they saw on the other side. `source` is a label the page supplies for where they said it (a press,
 * typed, spoken) and is stored as given: it is not provenance, and nothing may decide anything from it. What the record
 * can be trusted for is who and when: the principal is the authenticated caller, never something the body claims, and
 * the route is person-only, so no machine surface reaches it at all.
 */
export const effectReconcileRequestSchema = z.strictObject({
  outcome: z.enum(["confirmed", "failed"]),
  source: z.enum(["click", "chat", "voice"]).optional(),
});
export type EffectReconcileRequest = z.infer<typeof effectReconcileRequestSchema>;

/**
 * What recording it did: the effect's new state, the state its task is in now, how the task settled when this answer
 * was the last thing it was uncertain about, and how many of its effects are still unknown.
 */
export const effectReconcileResponseSchema = z.strictObject({
  effectId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  outcome: z.enum(["confirmed", "failed"]),
  taskState: z.string().min(1).max(40),
  settled: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  remainingUnknown: z.int().nonnegative(),
});
export type EffectReconcileResponse = z.infer<typeof effectReconcileResponseSchema>;

export const noticeSchema = z.strictObject({
  noticeId: z.string().min(1).max(128),
  sourceKind: noticeSourceKindSchema,
  category: noticeCategorySchema,
  severity: noticeSeveritySchema,
  title: z.string().min(1).max(NOTICE_TITLE_MAX),
  body: z.string().max(NOTICE_BODY_MAX).optional(),
  /** Where it happened, when it happened in a conversation. A pointer, not an invitation to browse. */
  conversationId: z.string().min(1).max(128).optional(),
  /** The node that sent it, when it was not this one. Absent means this node. */
  originNodeId: z.string().min(1).max(128).optional(),
  createdAt: instantSchema,
  readAt: instantSchema.optional(),
  /** What the notice is about, when its producer said. */
  subject: noticeSubjectSchema.optional(),
  /** When a snoozed notice comes back. Present only while that is still ahead, which is only in `snoozed`. */
  snoozedUntil: instantSchema.optional(),
  /** What can be done with it now, worked out by the node when it was read. Absent where nothing resolved them. */
  actions: z.array(noticeActionSchema).max(10).optional(),
});
export type Notice = z.infer<typeof noticeSchema>;

/**
 * The longest a notice can be snoozed. A week covers "next week"; beyond a month a snooze is a dismissal that has not
 * admitted it yet, and the notice would outlive the work it points at.
 */
export const NOTICE_SNOOZE_MAX_MS = 30 * 24 * 60 * 60_000;

/**
 * What "notices of this kind" means for a suppression: the narrowest key the stored data supports.
 *
 *   - `sourceKind`, `category` and `severity` together, so quieting "background work finished" never quiets "background
 *     work failed": a failure is a different kind of notice, and the one a person would least want to lose by accident.
 *   - `scope`, only where the subject names something that keeps producing notices of its own: one standing request
 *     (`automation:<intentId>`), one signal source such as one GitHub repository (`source:<sourceKey>`), one package's
 *     updates (`package:<packageId>`, not the version, which changes with every update), the Pi SDK
 *     (`pi:<packageName>`), one paired node (`peer:<nodeId>`, from the subject, or the notice's origin unless it is an
 *     automation notice, which only its automation or source scopes). A task, a piece
 *     of background work or a conversation produces one notice and is done, so scoping to it would quiet nothing that
 *     could still come.
 *
 * Not every notice can be quieted (`noticeKindQuietable`). Without a scope, a key is only as narrow as its source, and
 * for most sources that is far too wide: every automation notice is `automation`, so quieting "an automation started"
 * with no scope would also quiet the reminders the person asked for and every other automation's warnings. Unscoped
 * keys are allowed only for `background` and `worker`, whose every notice is the person's own work reporting back, so
 * "stop telling me when my background work goes well" means exactly that. A reminder is never quietable: it has no
 * scope, and its source is `automation`.
 *
 * Not the dedup key: producers choose it for their own idempotency (`worker:<taskId>`, `automation:<runId>`), its shape is
 * not a contract, and a prefix of it would silently change meaning the day a producer renames it.
 */
export interface NoticeSuppressionKey {
  sourceKind: NoticeSourceKind;
  category: NoticeCategory;
  severity: NoticeSeverity;
  scope?: string;
}

type SuppressionInput = Pick<Notice, "sourceKind" | "category" | "severity" | "subject" | "originNodeId">;

export function noticeSuppressionKey(notice: SuppressionInput): NoticeSuppressionKey {
  const scope = suppressionScope(notice);
  return {
    sourceKind: notice.sourceKind,
    category: notice.category,
    severity: notice.severity,
    ...(scope === undefined ? {} : { scope: scope.scope }),
  };
}

/** Whether "stop notifying me about this kind" is narrow enough to offer for this notice. See `NoticeSuppressionKey`. */
export function noticeKindQuietable(notice: SuppressionInput): boolean {
  return suppressionScope(notice) !== undefined || notice.sourceKind === "background" || notice.sourceKind === "worker";
}

/** The words that name a notice's scope for a person — which automation, repository, package or node — if it has one. */
export function noticeSuppressionScopeLabel(notice: SuppressionInput): string | undefined {
  return suppressionScope(notice)?.label;
}

function suppressionScope(notice: Pick<Notice, "sourceKind" | "subject" | "originNodeId">): { scope: string; label: string } | undefined {
  const subject = notice.subject;
  // An automation notice from another node is scoped by its automation or source, never by the node alone: "this node's
  // automation messages" would take in the reminders set there along with everything else it runs.
  const originScope =
    notice.originNodeId === undefined || notice.sourceKind === "automation"
      ? undefined
      : { scope: `peer:${notice.originNodeId}`, label: notice.originNodeId };
  switch (subject?.kind) {
    case "automation":
      return { scope: `automation:${subject.intentId}`, label: subject.label };
    case "signal-source":
      return { scope: `source:${subject.sourceKey}`, label: subject.label };
    case "package":
      return { scope: `package:${subject.packageId}`, label: subject.packageId };
    case "pi-update":
      return { scope: `pi:${subject.packageName}`, label: subject.packageName };
    case "peer":
      return { scope: `peer:${subject.nodeId}`, label: subject.nodeId };
    case "task":
    case "background-work":
    case "conversation":
    case undefined:
      return originScope;
  }
}

/**
 * One "stop notifying me about this kind", as the person set it. Belongs to one principal and is removed by deleting it;
 * nothing else expires it. The list says what it quiets in words, not as a key: `scopeLabel` names which automation,
 * repository, package or node it is limited to (absent when it covers a whole source), and `example` is the title of
 * the notice it was made from.
 */
export const noticeSuppressionSchema = z.strictObject({
  suppressionId: z.string().min(1).max(128),
  sourceKind: noticeSourceKindSchema,
  category: noticeCategorySchema,
  severity: noticeSeveritySchema,
  scope: z.string().min(1).max(260).optional(),
  scopeLabel: z.string().min(1).max(NOTICE_TITLE_MAX).optional(),
  example: z.string().min(1).max(NOTICE_TITLE_MAX),
  createdAt: instantSchema,
});
export type NoticeSuppression = z.infer<typeof noticeSuppressionSchema>;

/**
 * Something that is waiting for the person to decide or answer.
 *
 * The approval members carry the digest because deciding needs it: the node compares it against the operation it
 * is about to run, so a decision is bound to exactly what was shown. The surface sends it back and never displays
 * it — a hash is not something a person can approve.
 */
export const waitingItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command-approval"),
    approvalId: z.string().min(1),
    conversationId: z.string().min(1),
    description: z.string(),
    /** The command line the card will run, so the decision is made on the words and not on a summary. */
    command: z.string().optional(),
    operationDigest: z.string().min(1),
    requestedAt: instantSchema,
    expiresAt: instantSchema,
  }),
  z.strictObject({
    kind: z.literal("capability-approval"),
    approvalId: z.string().min(1),
    packageId: z.string().min(1),
    version: z.string().min(1),
    ref: z.string().min(1),
    description: z.string(),
    operationDigest: z.string().min(1),
    requestedAt: instantSchema,
    expiresAt: instantSchema,
  }),
  z.strictObject({
    kind: z.literal("question"),
    questionId: z.string().min(1),
    conversationId: z.string().min(1),
    prompt: z.string(),
    requestedAt: instantSchema,
    expiresAt: instantSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("task-approval"),
    approvalId: z.string().min(1),
    taskId: z.string().min(1),
    /** Absent when the task itself is gone by the time the inbox is read; the approval can still be decided. */
    conversationId: z.string().min(1).optional(),
    description: z.string(),
    operationDigest: z.string().min(1),
    effectCategory: effectCategorySchema,
    requestedAt: instantSchema,
    expiresAt: instantSchema,
  }),
]);
export type WaitingItem = z.infer<typeof waitingItemSchema>;

/**
 * `GET /inbox`.
 *
 * `readAt` is when the node assembled this answer. The surface shows it, because this is a snapshot the person is
 * reading, and a list that looked live when it was five seconds old would be claiming more than it knows.
 */
export const inboxResponseSchema = z.strictObject({
  waiting: z.array(waitingItemSchema),
  notices: z.array(noticeSchema),
  unread: z.number().int().nonnegative(),
  /**
   * Notices snoozed until a time still ahead, soonest back first. Neither in `notices` nor in `unread`. Defaults to
   * empty, like `suppressions`, so a client reading a node from before snoozing still parses the rest of the inbox.
   */
  snoozed: z.array(noticeSchema).default([]),
  /** The kinds of notice this principal asked not to be notified about, newest first. */
  suppressions: z.array(noticeSuppressionSchema).default([]),
  readAt: instantSchema,
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

/** `GET /inbox/summary`: the two numbers the header mark needs, and nothing it would have to throw away. */
export const inboxSummarySchema = z.strictObject({
  waiting: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export type InboxSummary = z.infer<typeof inboxSummarySchema>;

/** `POST /inbox/read`. No ids means every notice; the surface sends the ids it actually showed. */
export const inboxReadRequestSchema = z.strictObject({
  noticeIds: z.array(z.string().min(1).max(128)).max(500).optional(),
});
export type InboxReadRequest = z.infer<typeof inboxReadRequestSchema>;

/** `POST /inbox/unread`. Always with ids: nobody means "mark everything I have read unread again". */
export const inboxUnreadRequestSchema = z.strictObject({
  noticeIds: z.array(z.string().min(1).max(128)).min(1).max(500),
});
export type InboxUnreadRequest = z.infer<typeof inboxUnreadRequestSchema>;

/** `POST /inbox/notices/:id/snooze`. The surface works out "this evening" in the person's own time zone; the node only
 * checks that the moment is ahead of it and within `NOTICE_SNOOZE_MAX_MS`. */
export const inboxSnoozeRequestSchema = z.strictObject({ until: instantSchema });
export type InboxSnoozeRequest = z.infer<typeof inboxSnoozeRequestSchema>;
