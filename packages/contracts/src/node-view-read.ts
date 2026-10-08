import type { z } from "zod";

import { UNREAD_FIELD_PATH_PATTERN, unreadListingFields, type UnreadEntryFields, type UnreadListingFields } from "./directory.ts";

/**
 * Read a view a node answered with the way a client reads it: tolerant of top-level fields it does not know, strict
 * about every field it does.
 *
 * A desktop app may talk to a node on another machine, and the two are updated separately. A view gains optional fields
 * over time (the widget dev session view gained `stopCode`), and refusing the whole answer for a field this client has
 * never heard of made an older client lose the view altogether, not just the field. So a top-level field outside the
 * schema is dropped and reported in `unreadFields`; it is never passed on, so nothing downstream carries a value nobody
 * validated. Every known field is still checked against the schema with all its bounds (a value it does not know, such as
 * a new enum member, still refuses the view), and every object inside a known field stays as strict as the schema says:
 * such objects may carry approval, reach and activation state, which a client must not act on with part of it left out.
 * A newer field inside one of them still refuses the view. So binding state is never added as a new top-level field,
 * which an older client would drop with only the generic note.
 *
 * `unreadFields` exists so what was dropped is said rather than hidden, the same rule a directory entry follows
 * (`readDirectoryEntry`). Requests a client sends, and what a node writes and stores, keep their strict schemas.
 *
 * Only a view whose top level binds nothing is read this way. A view that carries an approval, a confirmation or what
 * something may reach at its top level (an inbox approval, an app intent decision, a folder-forget answer) stays strict:
 * dropping one of its fields could change what the person approves or what they are told Clark can still reach.
 * `docs/open-interfaces.md` ("Reading a node's answers") lists each read and which way it goes.
 */
export function readNodeView<Schema extends z.ZodObject>(
  schema: Schema,
  candidate: unknown,
): { success: true; data: z.infer<Schema>; unreadFields: UnreadListingFields | undefined } | { success: false; error: z.ZodError } {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    const result = schema.safeParse(candidate);
    return result.success ? { success: true, data: result.data, unreadFields: undefined } : { success: false, error: result.error };
  }
  const known: Record<string, unknown> = {};
  const unread: UnreadEntryFields = { names: [], unnamed: 0 };
  for (const [key, field] of Object.entries(candidate)) {
    if (Object.hasOwn(schema.shape, key)) known[key] = field;
    // A key is the node's text; one that is not a plain identifier is counted without being named.
    else if (!key.includes(".") && UNREAD_FIELD_PATH_PATTERN.test(key)) unread.names.push(key);
    else unread.unnamed += 1;
  }
  const result = schema.safeParse(known);
  return result.success ? { success: true, data: result.data, unreadFields: unreadListingFields(unread) } : { success: false, error: result.error };
}

/**
 * Read every item of a list a node answered with, each the way `readNodeView` reads one view. One item that does not
 * read refuses the list, as a strict read would: what is left out is a field, never a row. What the items left out is
 * reported once for the list (`unreadFieldsAcross`).
 */
export function readNodeViewList<Schema extends z.ZodObject>(
  schema: Schema,
  candidates: unknown,
): { success: true; data: z.infer<Schema>[]; unreadFields: UnreadListingFields | undefined } | { success: false; error: z.ZodError } {
  if (!Array.isArray(candidates)) {
    const result = schema.array().safeParse(candidates);
    return result.success ? { success: true, data: result.data, unreadFields: undefined } : { success: false, error: result.error };
  }
  const data: z.infer<Schema>[] = [];
  const unread: (UnreadListingFields | undefined)[] = [];
  for (const candidate of candidates) {
    const read = readNodeView(schema, candidate);
    if (!read.success) return read;
    data.push(read.data);
    unread.push(read.unreadFields);
  }
  return { success: true, data, unreadFields: unreadFieldsAcross(unread) };
}

/**
 * What several views read from one answer left out, together: each named field once however many items carried it,
 * and every field that was counted without a name. Undefined when none of them left anything out.
 */
export function unreadFieldsAcross(reads: readonly (UnreadListingFields | undefined)[]): UnreadListingFields | undefined {
  const names: string[] = [];
  let unnamed = 0;
  for (const read of reads) {
    if (read === undefined) continue;
    for (const name of read.names) if (!names.includes(name)) names.push(name);
    unnamed += read.count - read.names.length;
  }
  return unreadListingFields({ names, unnamed });
}
