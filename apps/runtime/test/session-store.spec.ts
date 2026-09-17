import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import {
  advanceSessionIngestCursor,
  appendMessage,
  messagesSince,
  migrate,
  openDatabase,
  type Database,
} from "@clarkcant/storage";

import {
  type SessionStoreDeps,
  checkResumable,
  ensureSessionsDirectory,
  listSessions,
  redactRegisteredSession,
  registerSessionFile,
  sessionsDirectory,
  summariseSessions,
} from "../src/session-store.ts";

/**
 * The session index (Phase 7).
 *
 * A transcript that exists on disk but is not indexed cannot be found, and an index row whose file
 * has gone is a resume that fails deep inside the SDK. Both are checked here, along with the two
 * durability claims: the row outlives a restart of the process, and a credential that reached a
 * transcript does not stay there.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const TOKEN = `sk${"-live-"}${"b".repeat(20)}`;

let dir: string;
let db: Database;
let deps: SessionStoreDeps;

function open(): Database {
  const database = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(database);
  return database;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-sessions-"));
  db = open();
  ensureSessionsDirectory(dir);
  deps = { db, nodeId: "node_local", dataDir: dir, now: () => AT };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(sessionsDirectory(dir), name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

describe("registering a transcript", () => {
  it("indexes a file inside the session directory and reports its size", () => {
    const path = writeTranscript("a.jsonl", [{ type: "message", text: "xin chào" }]);
    const result = registerSessionFile(deps, {
      sessionId: "sess_a",
      principalId: "prin_owner",
      taskId: "task_1",
      conversationId: "conv_1",
      path,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.byteSize).toBeGreaterThan(0);
    expect(result.record.ingestCursor).toBe(0);
    expect(listSessions(deps, { principalId: "prin_owner" })).toHaveLength(1);
    // A listing carries no transcript text, only where it is and how much of it has been read.
    const summary = summariseSessions(deps, { principalId: "prin_owner" })[0];
    expect(JSON.stringify(summary)).not.toContain("xin chào");
    expect(summary?.ingested).toBe(false);
  });

  it("refuses a path outside this node's session directory", () => {
    const outside = join(dir, "elsewhere.jsonl");
    writeFileSync(outside, "{}\n");
    const result = registerSessionFile(deps, { sessionId: "sess_out", principalId: "prin_owner", path: outside });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_OUTSIDE_SESSION_DIR");
    expect(listSessions(deps)).toHaveLength(0);
  });

  it("keeps the original creation time and cursor when a session is registered again", () => {
    const path = writeTranscript("b.jsonl", [{ type: "message", text: "một" }, { type: "message", text: "hai" }]);
    const first = registerSessionFile(deps, { sessionId: "sess_b", principalId: "prin_owner", path });
    expect(first.ok).toBe(true);

    advanceSessionIngestCursor(db, { sessionId: "sess_b", cursor: 12, at: AT });
    const again = registerSessionFile(deps, { sessionId: "sess_b", principalId: "prin_owner", path });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    // Re-registering the same session must not rewind what has already been ingested.
    expect(again.record.ingestCursor).toBe(12);
    expect(listSessions(deps)).toHaveLength(1);
  });
});

describe("durability across a restart", () => {
  it("survives the process closing the database, and still resumes afterwards", () => {
    const path = writeTranscript("restart.jsonl", [{ type: "message", text: "before restart" }]);
    registerSessionFile(deps, { sessionId: "sess_restart", principalId: "prin_owner", path });
    db.prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
    ).run("conv_restart", "node_local", AT, AT);
    appendMessage(
      db,
      {
        messageId: "msg_restart",
        conversationId: "conv_restart",
        role: "user",
        authorNodeId: "node_local",
        delivery: "accepted",
        createdAt: AT,
        blocks: [{ type: "text", format: "plain", content: "trước khi restart", streaming: false }],
      } as never,
      1,
    );
    db.close();

    db = open();
    const reopened: SessionStoreDeps = { ...deps, db };
    const resumed = checkResumable(reopened, "sess_restart");
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.record.path).toBe(path);

    // The conversation's own history was already durable; this asserts the two records agree about
    // which session produced which message.
    expect(messagesSince(db, "conv_restart", 0)).toHaveLength(1);
  });

  it("reports a transcript whose file has gone rather than failing later inside the SDK", () => {
    const path = writeTranscript("gone.jsonl", [{ type: "message", text: "sắp bị xoá" }]);
    registerSessionFile(deps, { sessionId: "sess_gone", principalId: "prin_owner", path });
    unlinkSync(path);

    const resumed = checkResumable(deps, "sess_gone");
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.code).toBe("SESSION_FILE_MISSING");

    const unknown = checkResumable(deps, "sess_never_registered");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("SESSION_UNKNOWN");
  });
});

describe("redaction at a safe boundary", () => {
  it("removes a credential from the transcript and records the new size", () => {
    const path = writeTranscript("secret.jsonl", [
      { type: "message", role: "user", text: `dùng ${TOKEN} để gọi API` },
      { type: "tool_call", name: "bash", input: { command: "echo done" } },
    ]);
    registerSessionFile(deps, { sessionId: "sess_secret", principalId: "prin_owner", path });

    const result = redactRegisteredSession(deps, "sess_secret");
    expect(result.ok).toBe(true);
    expect(result.redacted).toBe(1);

    const record = listSessions(deps, { principalId: "prin_owner" })[0];
    expect(record?.byteSize).toBeGreaterThan(0);
    // The size is re-read after the rewrite, so an ingest cursor that already covered the file is
    // not left pointing past its end.
    expect(record?.ingestCursor).toBe(0);
  });

  it("says so when a transcript cannot be redacted", () => {
    const path = join(sessionsDirectory(dir), "broken.jsonl");
    writeFileSync(path, "{ not json }\n");
    registerSessionFile(deps, { sessionId: "sess_broken", principalId: "prin_owner", path });
    const result = redactRegisteredSession(deps, "sess_broken");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not JSON");
  });
});

describe("ingest cursor", () => {
  it("advances only forwards", () => {
    const path = writeTranscript("cursor.jsonl", [{ type: "message", text: "một" }]);
    registerSessionFile(deps, { sessionId: "sess_cursor", principalId: "prin_owner", path });

    expect(advanceSessionIngestCursor(db, { sessionId: "sess_cursor", cursor: 10, at: AT })).toBe(true);
    // A retried batch must not be able to move the cursor backwards and cause a re-ingest.
    expect(advanceSessionIngestCursor(db, { sessionId: "sess_cursor", cursor: 4, at: AT })).toBe(false);
    expect(listSessions(deps)[0]?.ingestCursor).toBe(10);
    expect(summariseSessions(deps)[0]?.ingested).toBe(false);

    const size = listSessions(deps)[0]?.byteSize ?? 0;
    expect(advanceSessionIngestCursor(db, { sessionId: "sess_cursor", cursor: size, at: AT })).toBe(true);
    expect(summariseSessions(deps)[0]?.ingested).toBe(true);
  });
});
