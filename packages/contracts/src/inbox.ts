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
]);
export type NoticeSourceKind = z.infer<typeof noticeSourceKindSchema>;

/** What a notice is about, which is what decides how it is worded and grouped, never how urgent it looks. */
export const noticeCategorySchema = z.enum(["result", "update", "message", "alert"]);
export type NoticeCategory = z.infer<typeof noticeCategorySchema>;

export const noticeSeveritySchema = z.enum(["info", "success", "warning", "error"]);
export type NoticeSeverity = z.infer<typeof noticeSeveritySchema>;

export const NOTICE_TITLE_MAX = 120;
export const NOTICE_BODY_MAX = 500;

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
