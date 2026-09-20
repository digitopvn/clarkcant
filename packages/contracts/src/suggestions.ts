import { z } from "zod";

import { instantSchema, suggestionIdSchema } from "./primitives.ts";

/**
 * What the app offers to do next, and where each offer came from.
 *
 * Two things make this safe to put in front of somebody: every suggestion carries a source and a label for it,
 * so nothing appears without saying why it is there; and `text` is the sentence pressing it will send, not a
 * title for something else. A chip whose text is not what gets sent is a chip that lies about what it does.
 *
 * `ref` is opaque - a conversation or task id - and never a path. What the suggestion is drawn from is the
 * node's own records, which the client can already read with its token; a suggestion is a pointer into those,
 * not a second copy of them.
 */

/** Where a suggestion came from. Every one of these is something the person can go and look at. */
export const suggestionSourceSchema = z.enum(["conversation", "task", "pin", "project", "memory"]);

export const suggestionSchema = z.strictObject({
  suggestionId: suggestionIdSchema,
  /** What the chip says. Short, because it is a chip. */
  label: z.string().min(1).max(60),
  /** What pressing it sends. Not a paraphrase of the label: the sentence itself. */
  text: z.string().min(1).max(500),
  source: suggestionSourceSchema,
  /** Why it is being offered, in words - "từ phiên hôm qua", "việc còn dang dở". */
  sourceLabel: z.string().min(1).max(80),
  at: instantSchema,
  ref: z.string().min(1).max(200).optional(),
});

/** The list the node returns, empty rather than absent when it has nothing to suggest. */
export const suggestionsResponseSchema = z.strictObject({
  items: z.array(suggestionSchema),
});

export type Suggestion = z.infer<typeof suggestionSchema>;
export type SuggestionSource = z.infer<typeof suggestionSourceSchema>;
export type SuggestionsResponse = z.infer<typeof suggestionsResponseSchema>;
