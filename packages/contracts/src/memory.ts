import { z } from "zod";

import { instantSchema, memoryIdSchema } from "./primitives.ts";

/**
 * One thing that was remembered, and where it came from.
 *
 * A record says which conversation it was learned in, so a person reading the list can tell what it was for and
 * therefore whether it is still true. `sourceMessageId` is filled only when the turn that learned it knew its own
 * message id; it is not required, because a record nobody can trace to a message is still better than one that
 * claims a message it never came from.
 *
 * The scope is what separates "this person's node" from "this conversation": a preference is usually about the
 * person, and a decision is usually about the conversation it was taken in, and the brief reads both differently.
 */

export const memoryKindSchema = z.enum(["preference", "project-fact", "decision"]);
export const memoryScopeSchema = z.enum(["node", "conversation"]);

/** How much may be remembered in one record. Longer than this is a document, not a memory. */
export const MEMORY_TEXT_MAX_CHARS = 2000;

/**
 * How much may be put in front of the model on one turn.
 *
 * Both caps matter: rows keep the brief readable, and characters keep one enormous record from crowding out the
 * conversation. The brief was unbounded before, which is the sort of thing that only shows up as a slow turn.
 */
export const MEMORY_BRIEF_MAX_ROWS = 12;
export const MEMORY_BRIEF_MAX_CHARS = 4000;

export const memoryRecordSchema = z.strictObject({
  memoryId: memoryIdSchema,
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  text: z.string().min(1).max(MEMORY_TEXT_MAX_CHARS),
  sourceMessageId: z.string().min(1).max(200).optional(),
  sourceConversationId: z.string().min(1).max(200),
  at: instantSchema,
});

/** What the node answers when asked what it remembers, with a count per kind so the UI can say how much there is. */
export const memoryListSchema = z.strictObject({
  items: z.array(memoryRecordSchema),
  counts: z.strictObject({
    preference: z.number().int().min(0),
    "project-fact": z.number().int().min(0),
    decision: z.number().int().min(0),
  }),
});

export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryList = z.infer<typeof memoryListSchema>;
