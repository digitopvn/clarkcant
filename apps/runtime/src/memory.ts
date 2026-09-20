import {
  MEMORY_BRIEF_MAX_CHARS,
  MEMORY_BRIEF_MAX_ROWS,
  MEMORY_TEXT_MAX_CHARS,
  memoryRecordSchema,
  redactSecrets,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from "@clarkcant/contracts";
import {
  countMemoryRecordsForBrief,
  deleteMemoryRecord,
  insertMemoryRecord,
  listMemoryRecords,
  memoryRecordsForBrief,
  type Database,
} from "@clarkcant/storage";

/**
 * What the node remembers, and what it is willing to put in front of the model.
 *
 * Two rules decide everything here. Nothing is written before it has been redacted, because a secret that reaches
 * this table is a secret in a prompt on every later turn. And the brief is read fresh on each turn rather than
 * cached in the process, so a record somebody deletes stops being sent immediately instead of at the next
 * restart - which is what "see the source, then delete" has to mean to be true.
 */

export interface MemoryDeps {
  db: Database;
  /** The instant a record is written. Injected, so a brief's ordering is testable. */
  now: () => string;
  /** Ids come from the node's own generator, as everywhere else. */
  newId: (prefix: string) => string;
}

export interface RememberInput {
  principalId: string;
  conversationId: string;
  kind: MemoryKind;
  scope: MemoryScope;
  text: string;
  /** Only when the turn that learned this knew its own message id. */
  sourceMessageId?: string | undefined;
}

/** What the model is told when it tries to remember something that cannot be remembered. */
export type RememberOutcome = MemoryRecord | { refused: string };

/**
 * Write one thing down.
 *
 * Refusal is an answer rather than a throw: the caller is a tool the model invoked, and a model told why something
 * could not be remembered can say so, where a thrown error becomes a failed turn.
 */
export function rememberMemory(deps: MemoryDeps, input: RememberInput): RememberOutcome {
  // Redaction happens before the length check, because redacting shortens: a note that is too long only because
  // of a pasted key becomes storable once the key is gone.
  const text = redactSecrets(input.text).trim();
  if (text.length === 0) return { refused: "không có gì để ghi nhớ" };
  if (text.length > MEMORY_TEXT_MAX_CHARS) {
    return { refused: `một điều ghi nhớ tối đa ${MEMORY_TEXT_MAX_CHARS} ký tự` };
  }

  const record = memoryRecordSchema.parse({
    memoryId: deps.newId("mem"),
    kind: input.kind,
    scope: input.scope,
    text,
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    sourceConversationId: input.conversationId,
    at: deps.now(),
  });

  insertMemoryRecord(deps.db, {
    memoryId: record.memoryId,
    principalId: input.principalId,
    conversationId: input.conversationId,
    ...(record.sourceMessageId === undefined ? {} : { sourceMessageId: record.sourceMessageId }),
    kind: record.kind,
    scope: record.scope,
    text: record.text,
    at: record.at,
  });

  return record;
}

/** Everything this person's node remembers, newest first. */
export function listMemories(deps: MemoryDeps, principalId: string): MemoryRecord[] {
  return listMemoryRecords(deps.db, { principalId }).map(toRecord);
}

/** How much is remembered of each kind, so a screen can say so without reading every row. */
export function memoryCounts(deps: MemoryDeps, principalId: string): Record<MemoryKind, number> {
  const all = listMemoryRecords(deps.db, { principalId });
  return {
    preference: all.filter((row) => row.kind === "preference").length,
    "project-fact": all.filter((row) => row.kind === "project-fact").length,
    decision: all.filter((row) => row.kind === "decision").length,
  };
}

/** Remove one, and say whether anything went. */
export function deleteMemory(deps: MemoryDeps, principalId: string, memoryId: string): boolean {
  return deleteMemoryRecord(deps.db, principalId, memoryId);
}

/**
 * What to put in the prompt for one turn, or nothing at all.
 *
 * Read from the database every turn rather than kept in the process: a deletion takes effect on the next turn,
 * which is the difference between a memory the person controls and one that keeps being sent until a restart.
 *
 * The cap is stated in the text rather than swallowed, so a model that needed something left out knows it was
 * left out instead of concluding nothing else was remembered.
 */
export function memoryBrief(deps: MemoryDeps, input: { principalId: string; conversationId: string }): string {
  const rows = memoryRecordsForBrief(deps.db, input.principalId, input.conversationId, MEMORY_BRIEF_MAX_ROWS);
  if (rows.length === 0) return "";

  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `- (${row.kind}) ${row.text}`;
    if (lines.length >= MEMORY_BRIEF_MAX_ROWS) break;
    if (used + line.length > MEMORY_BRIEF_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  // Every line could have been too long to fit, in which case there is nothing to say.
  if (lines.length === 0) return "";

  const total = countMemoryRecordsForBrief(deps.db, input.principalId, input.conversationId);
  const remaining = total - lines.length;
  return [
    "[Điều đã ghi nhớ cho người dùng này]",
    ...lines,
    ...(remaining > 0 ? [`[còn ${remaining} điều đã ghi nhớ khác]`] : []),
  ].join("\n");
}

/** One repository row as the contract's record. */
function toRecord(row: {
  memoryId: string;
  conversationId: string;
  sourceMessageId?: string;
  kind: string;
  scope: string;
  text: string;
  at: string;
}): MemoryRecord {
  return memoryRecordSchema.parse({
    memoryId: row.memoryId,
    kind: row.kind,
    scope: row.scope,
    text: row.text,
    ...(row.sourceMessageId === undefined ? {} : { sourceMessageId: row.sourceMessageId }),
    sourceConversationId: row.conversationId,
    at: row.at,
  });
}
