import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { isWithinRoot } from "./path-roots.ts";
import { type Instant, nowInstant } from "@clarkcant/contracts";
import { redactSessionFile, transcriptSize } from "@clarkcant/pi-adapter";
import {
  type Database,
  type SessionFileRecord,
  getSessionFile,
  listSessionFiles,
  upsertSessionFile,
} from "@clarkcant/storage";

/**
 * The node's view of worker transcripts.
 *
 * The Session Manager in the architecture diagram is a control-extension surface: it lists, resumes
 * and searches sessions, and it has to live in the runtime process rather than inside a worker,
 * because the supervisor swaps workers while this state must survive the swap. So the store is here,
 * beside the database, and a worker only ever learns its own session id.
 *
 * What this file does *not* do is read a transcript's contents. That belongs to the index in Phase 8;
 * keeping the two apart is what stops a listing route from accidentally returning the text of every
 * session on the node.
 */

export interface SessionStoreDeps {
  db: Database;
  nodeId: string;
  dataDir: string;
  now: () => Instant;
}

/** Where transcripts live. Inside the node's own data directory, beside the database. */
export function sessionsDirectory(dataDir: string): string {
  return join(dataDir, "sessions");
}

export function ensureSessionsDirectory(dataDir: string): string {
  const directory = sessionsDirectory(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export interface RegisterSessionInput {
  sessionId: string;
  principalId: string;
  taskId?: string;
  conversationId?: string;
  /** Absolute path the worker wrote. Rejected when it is outside this node's session directory. */
  path: string;
  at?: Instant;
}

export type RegisterSessionResult =
  | { ok: true; record: SessionFileRecord }
  | { ok: false; code: "PATH_OUTSIDE_SESSION_DIR"; message: string };

/**
 * Index a transcript.
 *
 * The path is checked against the node's own session directory. A row that pointed somewhere else
 * would be a read of an arbitrary file dressed up as a session, and the check is cheap enough that
 * there is no reason to trust the caller instead.
 */
export function registerSessionFile(
  deps: SessionStoreDeps,
  input: RegisterSessionInput,
): RegisterSessionResult {
  const root = sessionsDirectory(deps.dataDir);
  // Checked with the platform's own rules rather than by comparing string prefixes: a prefix ending in
  // a slash never matched a Windows path, so every transcript was refused as being outside the session
  // directory it was in.
  if (!isWithinRoot(root, input.path)) {
    return {
      ok: false,
      code: "PATH_OUTSIDE_SESSION_DIR",
      message: `the transcript path is outside this node's session directory (${root})`,
    };
  }

  const at = input.at ?? deps.now();
  const existing = getSessionFile(deps.db, input.sessionId);
  const record: SessionFileRecord = {
    sessionId: input.sessionId,
    nodeId: deps.nodeId,
    principalId: input.principalId,
    taskId: input.taskId ?? existing?.taskId,
    conversationId: input.conversationId ?? existing?.conversationId,
    path: input.path,
    byteSize: transcriptSize(input.path),
    ingestCursor: existing?.ingestCursor ?? 0,
    lastIngestedAt: existing?.lastIngestedAt,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  upsertSessionFile(deps.db, record);
  return { ok: true, record };
}

/**
 * Redact a transcript and record how big it is now.
 *
 * Called at a boundary the adapter chose — the end of a turn, when nothing is appending — so the
 * rewrite cannot race a write. A refusal to redact is reported rather than swallowed: the file is
 * still indexed, and the caller decides whether that is acceptable.
 */
export function redactRegisteredSession(
  deps: SessionStoreDeps,
  sessionId: string,
): { ok: boolean; redacted: number; reason?: string } {
  const record = getSessionFile(deps.db, sessionId);
  if (record === undefined) return { ok: false, redacted: 0, reason: "that session is not indexed on this node" };

  const result = redactSessionFile(record.path);
  if (!result.ok) {
    return { ok: false, redacted: 0, ...(result.reason === undefined ? {} : { reason: result.reason }) };
  }

  upsertSessionFile(deps.db, {
    ...record,
    byteSize: transcriptSize(record.path),
    updatedAt: deps.now(),
  });
  return { ok: true, redacted: result.redacted };
}

export function listSessions(
  deps: SessionStoreDeps,
  filter: { principalId?: string; taskId?: string; conversationId?: string; limit?: number } = {},
): SessionFileRecord[] {
  return listSessionFiles(deps.db, filter);
}

export type ResumeCheck =
  | { ok: true; record: SessionFileRecord }
  | { ok: false; code: "SESSION_UNKNOWN" | "SESSION_FILE_MISSING"; message: string };

/**
 * Whether a session can be resumed.
 *
 * Resuming is `SessionManager.open(path)` in the adapter; this is the check that has to happen
 * first, because a row whose file was deleted would otherwise fail deep inside the SDK with a
 * message about a path nobody recognises.
 */
export function checkResumable(deps: SessionStoreDeps, sessionId: string): ResumeCheck {
  const record = getSessionFile(deps.db, sessionId);
  if (record === undefined) {
    return { ok: false, code: "SESSION_UNKNOWN", message: `session ${sessionId} is not indexed on this node` };
  }
  if (transcriptSize(record.path) === 0) {
    return {
      ok: false,
      code: "SESSION_FILE_MISSING",
      message: `the transcript for ${sessionId} is no longer on disk`,
    };
  }
  return { ok: true, record };
}

/** A summary that carries no transcript text, for a listing route. */
export interface SessionSummary {
  sessionId: string;
  taskId: string | undefined;
  conversationId: string | undefined;
  createdAt: string;
  byteSize: number;
  ingestCursor: number;
  ingested: boolean;
}

export function summariseSessions(deps: SessionStoreDeps, filter: { principalId?: string; limit?: number } = {}): SessionSummary[] {
  return listSessions(deps, filter).map((record) => ({
    sessionId: record.sessionId,
    taskId: record.taskId,
    conversationId: record.conversationId,
    createdAt: record.createdAt,
    byteSize: record.byteSize,
    ingestCursor: record.ingestCursor,
    ingested: record.ingestCursor >= record.byteSize && record.byteSize > 0,
  }));
}

export function sessionStoreDepsFrom(input: {
  db: Database;
  nodeId: string;
  dataDir: string;
  now?: () => Instant;
}): SessionStoreDeps {
  return {
    db: input.db,
    nodeId: input.nodeId,
    dataDir: input.dataDir,
    now: input.now ?? (() => nowInstant() satisfies Instant),
  };
}
