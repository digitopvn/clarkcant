import { readFileSync, statSync, writeFileSync } from "node:fs";

import { redactSecrets } from "@clarkcant/contracts";

/**
 * Transcript files.
 *
 * A worker's session is a JSONL file: one JSON document per line, written by the SDK. Two
 * operations are needed on it, and both are here rather than in the runtime because this package is
 * the only one that knows the file's format.
 *
 * 1. **Redaction.** A transcript can contain whatever a tool printed, including a credential. The
 *    pass rewrites the file in place, and refuses to rewrite at all if any line stops parsing: a
 *    redactor that corrupts a transcript is worse than one that declines to run.
 * 2. **Reading from an offset.** The history index ingests the file in bounded batches and remembers
 *    a byte offset, so a long session is not re-read from the start on every turn.
 */

export interface RedactionResult {
  ok: boolean;
  path: string;
  /** Lines examined. */
  lines: number;
  /** Lines actually rewritten. */
  redacted: number;
  reason?: string;
}

/**
 * Replace secret-shaped runs in a transcript, line by line.
 *
 * The parse check runs before any write. Each line must parse both before and after the replacement:
 * a token can appear inside a JSON *string* where removing its quotes would change the document's
 * meaning, and a line that no longer parses is a line the next reader would throw on.
 */
export function redactSessionFile(path: string): RedactionResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    return { ok: false, path, lines: 0, redacted: 0, reason: `could not read the transcript: ${describe(cause)}` };
  }

  const lines = raw.split("\n");
  const rewritten: string[] = [];
  let redacted = 0;
  let examined = 0;

  for (const line of lines) {
    if (line.trim() === "") {
      rewritten.push(line);
      continue;
    }
    examined += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      return { ok: false, path, lines: examined, redacted: 0, reason: `line ${examined} is not JSON: ${describe(cause)}` };
    }
    const cleaned = redactSecrets(line);
    if (cleaned === line) {
      rewritten.push(line);
      continue;
    }
    try {
      JSON.parse(cleaned);
    } catch (cause) {
      return {
        ok: false,
        path,
        lines: examined,
        redacted: 0,
        reason: `redacting line ${examined} would have produced invalid JSON: ${describe(cause)}`,
      };
    }
    void parsed;
    rewritten.push(cleaned);
    redacted += 1;
  }

  if (redacted === 0) return { ok: true, path, lines: examined, redacted: 0 };

  try {
    // Rewritten whole rather than patched: a partial write would leave a transcript with half a
    // line, and the reader refuses an incomplete tail by design.
    writeFileSync(path, rewritten.join("\n"));
  } catch (cause) {
    return { ok: false, path, lines: examined, redacted: 0, reason: `could not rewrite the transcript: ${describe(cause)}` };
  }

  return { ok: true, path, lines: examined, redacted };
}

export interface TranscriptEntry {
  /** Byte offset of the line's first character, for the ingest cursor. */
  offset: number;
  parsed: unknown;
}

export interface TranscriptRead {
  entries: TranscriptEntry[];
  /** Offset to store once these entries are accepted. */
  nextOffset: number;
  /**
   * A trailing line that is not complete yet.
   *
   * A writer can be mid-line when this runs, so the tail is skipped rather than parsed and the
   * cursor does not advance past it.
   */
  partialTail: boolean;
}

/**
 * Read a transcript from a byte offset, line by line.
 *
 * An unparseable line stops the read instead of being skipped: silently dropping a line would move
 * the cursor past content nobody indexed, and the caller cannot tell the difference between "the
 * file is short" and "half of it was ignored".
 */
export function readTranscriptFrom(path: string, fromByte: number, limit = 500): TranscriptRead {
  const raw = readFileSync(path, "utf8");
  const entries: TranscriptEntry[] = [];
  let offset = 0;
  let nextOffset = fromByte;
  let partialTail = false;

  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset);
    if (newline === -1) {
      // No terminator yet: the writer is still appending this line.
      partialTail = true;
      break;
    }
    const lineEnd = newline + 1;
    if (offset >= fromByte && lineEnd > fromByte) {
      const text = raw.slice(offset, newline);
      if (text.trim() !== "") {
        try {
          entries.push({ offset, parsed: JSON.parse(text) as unknown });
        } catch (cause) {
          throw new Error(`transcript ${path} has a malformed line at byte ${offset}: ${describe(cause)}`, { cause });
        }
      }
      nextOffset = lineEnd;
      if (entries.length >= limit) break;
    }
    offset = lineEnd;
  }

  return { entries, nextOffset, partialTail };
}

/** Size on disk, or 0 when the file is not there. Used to record how much there is to read. */
export function transcriptSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
