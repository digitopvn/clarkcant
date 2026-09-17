import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTranscriptFrom, redactSessionFile, transcriptSize } from "../src/session-file.ts";

/**
 * Transcript durability (Phase 7).
 *
 * The transcript is the only record of what a worker actually did — tool calls, reasoning,
 * summaries — and it is a file rather than a row, so two things have to hold: a secret that reached
 * it must not stay there, and a reader must never advance past a line it did not understand.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-session-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Values are assembled from parts so this file itself contains no credential-shaped literal. */
const TOKEN = `sk${"-live-"}${"a".repeat(20)}`;
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join(".");

function transcriptPath(name = "session.jsonl"): string {
  return join(dir, name);
}

describe("redaction", () => {
  it("rewrites the secret and leaves every line parseable", () => {
    const path = transcriptPath();
    const lines = [
      JSON.stringify({ type: "message", role: "user", text: `dùng key ${TOKEN} nhé` }),
      JSON.stringify({ type: "tool_call", name: "bash", input: { command: `curl -H "Authorization: Bearer ${JWT}" https://example.test` } }),
      JSON.stringify({ type: "message", role: "assistant", text: "không có gì nhạy cảm ở đây" }),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);

    const result = redactSessionFile(path);
    expect(result.ok).toBe(true);
    expect(result.redacted).toBe(2);

    const after = readFileSync(path, "utf8").trim().split("\n");
    expect(after).toHaveLength(3);
    // The lines still parse, and the surrounding text survives: this is a redactor, not a
    // replacement of the transcript.
    for (const line of after) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
    expect(readFileSync(path, "utf8")).not.toContain(JWT);
    expect(after[2]).toContain("không có gì nhạy cảm");
  });

  it("does nothing when there is nothing to redact, and does not rewrite the file", () => {
    const path = transcriptPath();
    writeFileSync(path, `${JSON.stringify({ type: "message", text: "xin chào" })}\n`);
    const before = readFileSync(path, "utf8");

    const result = redactSessionFile(path);
    expect(result.ok).toBe(true);
    expect(result.redacted).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses to rewrite a transcript it cannot parse, rather than corrupting it", () => {
    const path = transcriptPath();
    const good = JSON.stringify({ type: "message", text: `key ${TOKEN}` });
    writeFileSync(path, `${good}\nhalf a line that is not json\n`);

    const result = redactSessionFile(path);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not JSON");
    // The file is untouched: a partially redacted transcript would be worse than an unredacted one,
    // because the next reader would silently lose the tail.
    expect(readFileSync(path, "utf8")).toContain(TOKEN);
  });

  it("reports a missing file instead of throwing", () => {
    const result = redactSessionFile(join(dir, "absent.jsonl"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("could not read");
  });
});

describe("reading from an offset", () => {
  it("reads only what is new, and leaves an unterminated tail for the next pass", () => {
    const path = transcriptPath();
    const first = `${JSON.stringify({ type: "a" })}\n${JSON.stringify({ type: "b" })}\n`;
    writeFileSync(path, first);

    const initial = readTranscriptFrom(path, 0);
    expect(initial.entries).toHaveLength(2);
    expect(initial.nextOffset).toBe(Buffer.byteLength(first));
    expect(initial.partialTail).toBe(false);

    // A writer mid-line: the tail is skipped and the cursor does not move past it.
    writeFileSync(path, `${first}${JSON.stringify({ type: "c" })}`);
    const partial = readTranscriptFrom(path, initial.nextOffset);
    expect(partial.entries).toHaveLength(0);
    expect(partial.partialTail).toBe(true);
    expect(partial.nextOffset).toBe(Buffer.byteLength(first));

    // Once the line is terminated the next pass picks it up.
    writeFileSync(path, `${first}${JSON.stringify({ type: "c" })}\n`);
    const completed = readTranscriptFrom(path, partial.nextOffset);
    expect(completed.entries).toHaveLength(1);
    expect(completed.partialTail).toBe(false);
    expect(completed.nextOffset).toBe(transcriptSize(path));
  });

  it("stops at a limit so a long session is ingested in bounded batches", () => {
    const path = transcriptPath();
    const lines = Array.from({ length: 10 }, (_unused, index) => JSON.stringify({ index }));
    writeFileSync(path, `${lines.join("\n")}\n`);

    const batch = readTranscriptFrom(path, 0, 4);
    expect(batch.entries).toHaveLength(4);
    expect((batch.entries[3]?.parsed as { index: number }).index).toBe(3);

    const rest = readTranscriptFrom(path, batch.nextOffset, 100);
    expect(rest.entries).toHaveLength(6);
    expect(rest.nextOffset).toBe(transcriptSize(path));
  });

  it("throws on a malformed line rather than skipping content nobody indexed", () => {
    const path = transcriptPath();
    writeFileSync(path, `${JSON.stringify({ ok: true })}\n{ not json }\n${JSON.stringify({ ok: true })}\n`);
    expect(() => readTranscriptFrom(path, 0)).toThrow(/malformed line/);
  });

  it("keeps a transcript readable across a restart", () => {
    const path = transcriptPath();
    writeFileSync(path, `${JSON.stringify({ type: "message", text: "trước khi restart" })}\n`);
    // Nothing in memory is needed to read it back: the file is the record.
    const reopened = readTranscriptFrom(path, 0);
    expect((reopened.entries[0]?.parsed as { text: string }).text).toBe("trước khi restart");
    expect(transcriptSize(path)).toBeGreaterThan(0);
  });
});
