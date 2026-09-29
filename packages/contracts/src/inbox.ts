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
 */
export const noticeActionIdSchema = z.enum(["open", "ask-clark", "add-to-context", "mark-read", "mark-unread", "dismiss"]);
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
export const noticeActionSchema = z.strictObject({
  id: noticeActionIdSchema,
  placement: z.enum(["primary", "secondary", "menu"]),
  unavailable: z.enum(["conversation-gone"]).optional(),
});
export type NoticeAction = z.infer<typeof noticeActionSchema>;

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
  /** What can be done with it now, worked out by the node when it was read. Absent where nothing resolved them. */
  actions: z.array(noticeActionSchema).max(8).optional(),
});
export type Notice = z.infer<typeof noticeSchema>;

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
