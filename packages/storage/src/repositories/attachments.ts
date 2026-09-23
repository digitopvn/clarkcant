import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, transaction } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/**
 * A file someone attached to a message.
 *
 * `blobPath` is an absolute path on this node. It is stored because the bytes
 * have to be found again, and it never leaves the node: no route returns it and
 * no prompt carries it. Readers check it against the blob root before opening
 * it, because a row edited by hand must not become an arbitrary file read.
 */
export interface AttachmentRecord {
  attachmentId: string;
  principalId: string;
  conversationId: string;
  filename: string;
  mime: string;
  kind: string;
  sizeBytes: number;
  sha256: string;
  blobPath: string;
  createdAt: string;
}

export function insertAttachment(db: Database, input: AttachmentRecord): void {
  db.prepare(
    `INSERT INTO attachments
       (attachment_id, principal_id, conversation_id, filename, mime, kind, size_bytes, sha256,
        blob_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.attachmentId,
    input.principalId,
    input.conversationId,
    input.filename,
    input.mime,
    input.kind,
    input.sizeBytes,
    input.sha256,
    input.blobPath,
    input.createdAt,
  );
}

/** Scoped to the principal, so one person's id is not another person's read. */
export function getAttachment(
  db: Database,
  attachmentId: string,
  principalId: string,
): AttachmentRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM attachments WHERE attachment_id = ? AND principal_id = ?",
    attachmentId,
    principalId,
  );
  return row === undefined ? undefined : mapAttachment(row);
}

export function listAttachmentsForConversation(
  db: Database,
  conversationId: string,
): AttachmentRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at",
    conversationId,
  );
  return rows.map(mapAttachment);
}

/**
 * Remove a conversation's attachment rows and report where their bytes were.
 *
 * The caller deletes the files, and it does so after this returns: a row that
 * outlives its bytes is a missing file the UI can explain, while bytes that
 * outlive their row are garbage nobody can find.
 */
export function deleteAttachmentsForConversation(
  db: Database,
  conversationId: string,
): { removed: number; blobPaths: string[] } {
  return transaction(db, () => {
    const rows = listAttachmentsForConversation(db, conversationId);
    if (rows.length === 0) return { removed: 0, blobPaths: [] };
    const result = db.prepare("DELETE FROM attachments WHERE conversation_id = ?").run(conversationId);
    return { removed: Number(result.changes), blobPaths: rows.map((row) => row.blobPath) };
  });
}

/** Total stored bytes for one principal. The single source the quota is read from. */
export function attachmentUsageForPrincipal(db: Database, principalId: string): number {
  const row = oneRow<{ used: number | null }>(
    db,
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM attachments WHERE principal_id = ?",
    principalId,
  );
  return Number(row?.used ?? 0);
}

function mapAttachment(row: Record<string, unknown>): AttachmentRecord {
  return {
    attachmentId: String(row.attachment_id),
    principalId: String(row.principal_id),
    conversationId: String(row.conversation_id),
    filename: String(row.filename),
    mime: String(row.mime),
    kind: String(row.kind),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    blobPath: String(row.blob_path),
    createdAt: String(row.created_at),
  };
}

/**
 * Secrets a person typed into the host.
 *
 * The rule these functions keep is one-sided: a value goes in, and nothing hands it back out except the single
 * function the host calls when it needs to use it. There is no listing that includes values and no count of
 * characters, because a mistyped key must not turn up printed in a card, and a log line or an error message is
 * where a secret leaks by accident.
 */
export function putCredential(
  db: Database,
  input: { principalId: string; name: string; value: string; at: Instant },
): void {
  db.prepare(
    `INSERT INTO credentials (principal_id, name, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (principal_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(input.principalId, input.name, input.value, input.at);
}

/** Whether a name has been set. This is what a status line reports, and it reports only this. */
export function hasCredential(db: Database, principalId: string, name: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM credentials WHERE principal_id = ? AND name = ?").get(principalId, name);
  return row !== undefined;
}

/** The names that have been set, never the values: a list is what an interface may show. */
export function credentialNames(db: Database, principalId: string): string[] {
  const rows = db
    .prepare("SELECT name FROM credentials WHERE principal_id = ? ORDER BY name")
    .all(principalId) as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * The value itself, for the host and nothing else.
 *
 * Named to read like the thing it is: reading a credential is the operation that has to be justified at every
 * call site, so it is not called `getCredential` and it is not reachable from a route.
 */
export function readCredential(db: Database, principalId: string, name: string): string | undefined {
  const row = db.prepare("SELECT value FROM credentials WHERE principal_id = ? AND name = ?").get(principalId, name) as
    | { value: string }
    | undefined;
  return row?.value;
}

/*
 * Preferences: a choice somebody made, written down with what it replaced.
 *
 * `previous_value` and `revision` are kept because a stored choice is a decision, and "what was it before" is the first
 * question asked when a node starts behaving differently than expected. `scope` is part of the key, so the same setting
 * can differ per conversation without one silently overwriting the other.
 */
export function putPreference(
  db: Database,
  input: { principalId: string; key: string; value: string; scope: string; source: string; at: Instant },
): void {
  const existing = db
    .prepare("SELECT value, revision FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
    .get(input.principalId, input.key, input.scope) as { value: string; revision: number } | undefined;
  db.prepare(
    `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (principal_id, key, scope) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       revision = excluded.revision,
       previous_value = excluded.previous_value`,
  ).run(
    input.principalId,
    input.key,
    input.value,
    input.scope,
    input.source,
    (existing?.revision ?? 0) + 1,
    existing?.value ?? null,
    input.at,
  );
}

/** What a stored preference says, or undefined when nobody has chosen yet. */
export function readPreference(
  db: Database,
  principalId: string,
  key: string,
  scope: string,
): string | undefined {
  const row = db
    .prepare("SELECT value FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
    .get(principalId, key, scope) as { value: string } | undefined;
  return row?.value;
}

/** Forgets a name. Returns whether there was one to forget. */
export function deleteCredential(db: Database, principalId: string, name: string): boolean {
  const result = db.prepare("DELETE FROM credentials WHERE principal_id = ? AND name = ?").run(principalId, name);
  return Number(result.changes) > 0;
}
