import type { ArtifactGrantView, ArtifactKind, ArtifactState, Instant } from "@clarkcant/contracts";

import { type Database, allRows, oneRow, transaction } from "../db.ts";

/*
 * Artifacts a widget holds by reference, and the grants that let it use them.
 *
 * The rows live in the `artifacts` table from migration 5, extended by migration 38, so a widget's file and a peer's
 * received file are one store read through one repository. A row written before migration 38 — or written by the peer
 * path, which leaves `kind` NULL — is not a broker artifact, and every read here filters on `kind IS NOT NULL` so a
 * peer's artifact can never be reached through a widget's ref.
 *
 * `blobPath` and `stagingRef` stay in this module and the runtime's broker: no route returns them and no ref carries
 * them. They are where the bytes are, which is exactly what a widget must not learn.
 */

export interface BrokerArtifactRecord {
  artifactId: string;
  ownerPrincipalId: string;
  kind: ArtifactKind;
  state: ArtifactState;
  conversationId: string;
  instanceId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Absent until the bytes are fixed. */
  digest: string | undefined;
  /** Absolute path of the sealed bytes on this node. Absent while writable. */
  blobPath: string | undefined;
  /** File name of the staged bytes inside the blob store's staging directory. Present only while writable. */
  stagingRef: string | undefined;
  createdAt: Instant;
  /** Absent means the artifact follows its conversation rather than expiring on its own. */
  expiresAt: Instant | undefined;
}

type ArtifactRow = {
  artifact_id: string;
  owner_principal_id: string;
  kind: string;
  state: string;
  conversation_id: string;
  instance_id: string;
  display_name: string;
  mime_type: string;
  size_bytes: number;
  digest: string;
  blob_path: string | null;
  staging_ref: string | null;
  created_at: string;
  expires_at: string | null;
};

const COLUMNS = `artifact_id, owner_principal_id, kind, state, conversation_id, instance_id, display_name, mime_type,
  size_bytes, digest, blob_path, staging_ref, created_at, expires_at`;

function mapRow(row: ArtifactRow): BrokerArtifactRecord {
  return {
    artifactId: row.artifact_id,
    ownerPrincipalId: row.owner_principal_id,
    kind: row.kind as ArtifactKind,
    state: row.state as ArtifactState,
    conversationId: row.conversation_id,
    instanceId: row.instance_id,
    name: row.display_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    digest: row.digest === "" ? undefined : row.digest,
    blobPath: row.blob_path ?? undefined,
    stagingRef: row.staging_ref ?? undefined,
    createdAt: row.created_at as Instant,
    expiresAt: (row.expires_at ?? undefined) as Instant | undefined,
  };
}

export function insertBrokerArtifact(
  db: Database,
  input: BrokerArtifactRecord & { originNodeId: string },
): void {
  db.prepare(
    `INSERT INTO artifacts (artifact_id, digest, size_bytes, mime_type, classification, origin_node_id, blob_path,
       created_at, expires_at, owner_principal_id, kind, state, conversation_id, instance_id, display_name, staging_ref)
     VALUES (?, ?, ?, ?, 'widget-artifact', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.artifactId,
    input.digest ?? "",
    input.sizeBytes,
    input.mimeType,
    input.originNodeId,
    input.blobPath ?? null,
    input.createdAt,
    input.expiresAt ?? null,
    input.ownerPrincipalId,
    input.kind,
    input.state,
    input.conversationId,
    input.instanceId,
    input.name,
    input.stagingRef ?? null,
  );
}

/** A broker artifact by id, whoever owns it: the caller decides access with `decideArtifactAccess`. */
export function getBrokerArtifact(db: Database, artifactId: string): BrokerArtifactRecord | undefined {
  const row = oneRow<ArtifactRow>(db, `SELECT ${COLUMNS} FROM artifacts WHERE artifact_id = ? AND kind IS NOT NULL`, artifactId);
  return row === undefined ? undefined : mapRow(row);
}

/** Record a write to a working artifact: its new size and how long it now lives. */
export function recordWorkingArtifactWrite(
  db: Database,
  input: { artifactId: string; sizeBytes: number; expiresAt: Instant },
): void {
  db.prepare(
    "UPDATE artifacts SET size_bytes = ?, expires_at = ? WHERE artifact_id = ? AND kind = 'working' AND state = 'writable'",
  ).run(input.sizeBytes, input.expiresAt, input.artifactId);
}

/** Fix a working artifact's bytes. From here it has a digest, no expiry of its own, and cannot be written again. */
export function sealWorkingArtifact(
  db: Database,
  input: { artifactId: string; digest: string; blobPath: string; sizeBytes: number; mimeType: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE artifacts SET kind = 'finalized', state = 'sealed', digest = ?, blob_path = ?, size_bytes = ?, mime_type = ?,
         staging_ref = NULL, expires_at = NULL
       WHERE artifact_id = ? AND kind = 'working' AND state = 'writable'`,
    )
    .run(input.digest, input.blobPath, input.sizeBytes, input.mimeType, input.artifactId);
  return Number(result.changes) === 1;
}

/** Give one widget instance access to one artifact. A second grant replaces the first, and clears a revocation. */
export function putArtifactGrant(
  db: Database,
  input: { artifactId: string; instanceId: string; principalId: string; access: "read" | "write"; createdAt: Instant; expiresAt: Instant },
): void {
  db.prepare(
    `INSERT INTO artifact_grants (artifact_id, instance_id, principal_id, access, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (artifact_id, instance_id) DO UPDATE SET
       principal_id = excluded.principal_id,
       access = excluded.access,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at,
       revoked_at = NULL`,
  ).run(input.artifactId, input.instanceId, input.principalId, input.access, input.createdAt, input.expiresAt);
}

export function getArtifactGrant(db: Database, artifactId: string, instanceId: string): ArtifactGrantView | undefined {
  const row = oneRow<{
    instance_id: string;
    principal_id: string;
    access: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    db,
    "SELECT instance_id, principal_id, access, expires_at, revoked_at FROM artifact_grants WHERE artifact_id = ? AND instance_id = ?",
    artifactId,
    instanceId,
  );
  if (row === undefined) return undefined;
  return {
    instanceId: row.instance_id,
    principalId: row.principal_id,
    access: row.access === "write" ? "write" : "read",
    expiresAt: row.expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

/** Move a live grant's expiry. A revoked grant stays revoked. */
export function extendArtifactGrant(db: Database, input: { artifactId: string; instanceId: string; expiresAt: Instant }): void {
  db.prepare(
    "UPDATE artifact_grants SET expires_at = ? WHERE artifact_id = ? AND instance_id = ? AND revoked_at IS NULL",
  ).run(input.expiresAt, input.artifactId, input.instanceId);
}

/** Take an instance's access away. Returns whether there was a live grant to revoke. */
export function revokeArtifactGrant(db: Database, input: { artifactId: string; instanceId: string; at: Instant }): boolean {
  const result = db
    .prepare("UPDATE artifact_grants SET revoked_at = ? WHERE artifact_id = ? AND instance_id = ? AND revoked_at IS NULL")
    .run(input.at, input.artifactId, input.instanceId);
  return Number(result.changes) > 0;
}

/** Bytes a principal holds in broker artifacts. Added to attachment usage, so both count against one quota. */
export function artifactUsageForPrincipal(db: Database, principalId: string): number {
  const row = oneRow<{ used: number | null }>(
    db,
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM artifacts WHERE owner_principal_id = ? AND kind IS NOT NULL",
    principalId,
  );
  return Number(row?.used ?? 0);
}

/**
 * Bytes one widget instance holds in the files it created.
 *
 * Read against `ARTIFACT_LIMITS.instanceQuotaBytes`, inside the principal's quota, so one widget cannot fill the quota
 * the composer's attachments share. A file the person picked for the widget (`external`) is not counted: choosing it
 * was the person's act, the widget cannot discard it, and counting it would let the person's own choices lock the widget
 * out. It still counts in the principal's quota.
 */
export function artifactUsageForInstance(db: Database, instanceId: string): number {
  const row = oneRow<{ used: number | null }>(
    db,
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM artifacts WHERE instance_id = ? AND kind IN ('working', 'finalized')",
    instanceId,
  );
  return Number(row?.used ?? 0);
}

/** The staging file names a writable artifact still points at: every other file in the staging directory is an orphan. */
export function liveStagingRefs(db: Database): Set<string> {
  return new Set(
    allRows<{ staging_ref: string }>(
      db,
      "SELECT staging_ref FROM artifacts WHERE kind IS NOT NULL AND staging_ref IS NOT NULL",
    ).map((row) => row.staging_ref),
  );
}

/** Working artifacts whose time ran out before they were finalized. */
export function listExpiredWorkingArtifacts(db: Database, now: Instant, limit = 200): BrokerArtifactRecord[] {
  return allRows<ArtifactRow>(
    db,
    `SELECT ${COLUMNS} FROM artifacts
      WHERE kind = 'working' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`,
    now,
    limit,
  ).map(mapRow);
}

export function listArtifactsForConversation(db: Database, conversationId: string): BrokerArtifactRecord[] {
  return allRows<ArtifactRow>(
    db,
    `SELECT ${COLUMNS} FROM artifacts WHERE conversation_id = ? AND kind IS NOT NULL ORDER BY created_at`,
    conversationId,
  ).map(mapRow);
}

/** Remove one artifact row and its grants. The caller removes the bytes afterwards. */
export function deleteBrokerArtifact(db: Database, artifactId: string): boolean {
  return transaction(db, () => {
    db.prepare("DELETE FROM artifact_grants WHERE artifact_id = ?").run(artifactId);
    const result = db.prepare("DELETE FROM artifacts WHERE artifact_id = ? AND kind IS NOT NULL").run(artifactId);
    return Number(result.changes) > 0;
  });
}

/**
 * Remove a conversation's artifact rows and report where their bytes were.
 *
 * Rows first, bytes after, for the same reason as attachments: a row whose bytes are gone is a missing file the
 * interface can explain, and bytes whose row is gone are garbage nobody can find.
 */
export function deleteArtifactsForConversation(
  db: Database,
  conversationId: string,
): { removed: number; blobPaths: string[]; stagingRefs: string[] } {
  return transaction(db, () => {
    const rows = listArtifactsForConversation(db, conversationId);
    if (rows.length === 0) return { removed: 0, blobPaths: [], stagingRefs: [] };
    db.prepare(
      "DELETE FROM artifact_grants WHERE artifact_id IN (SELECT artifact_id FROM artifacts WHERE conversation_id = ? AND kind IS NOT NULL)",
    ).run(conversationId);
    const result = db.prepare("DELETE FROM artifacts WHERE conversation_id = ? AND kind IS NOT NULL").run(conversationId);
    return {
      removed: Number(result.changes),
      blobPaths: rows.flatMap((row) => (row.blobPath === undefined ? [] : [row.blobPath])),
      stagingRefs: rows.flatMap((row) => (row.stagingRef === undefined ? [] : [row.stagingRef])),
    };
  });
}

/**
 * Whether anything this node keeps still points at a blob file.
 *
 * The blob store is content-addressed, so one file can be an attachment, a finalized artifact, a peer's received
 * artifact, an imported image, a file a delegated task offered back, and a captured session frame at once. Removing it
 * because one of those went away would take the bytes out from under the others. So every writer of the store is asked
 * here, in the two ways its rows can name a blob:
 *
 * - **by path** (`attachments`, `artifacts`, `local_images`), compared by the file name rather than the full path,
 *   because the name is the content address and a path written by an older build may differ in separators;
 * - **by digest** — the file name's 32 hex characters are the start of the SHA-256 — anywhere in every column that records one
 *   (`attachments.sha256`, `artifacts.digest`, `local_images.digest`, `task_artifacts.digest` for a file a task offered,
 *   `evidence.digest`) and in `messages.document`, which is where a session card keeps the digest of its captured frame.
 *
 * The digest match is deliberately generous: the same bytes stored under another extension keep this file too. Keeping
 * bytes nobody needs costs space; removing bytes somebody needs loses a file.
 *
 * `messages.document` is the one place that is not a column of digests but whole transcripts, so it is read only when
 * it can matter, and as narrowly as it can be:
 *
 * - only for a **picture** — a captured frame is only ever stored as one (`storeSessionPreview` refuses anything else,
 *   and a blob's extension is the one its sniffed bytes have);
 * - with `messagesOf`, only that **conversation's** messages, through its index. A widget discarding its own file
 *   passes its conversation: the widget can only have bytes it made or was handed, and a file it was handed is still
 *   an `external` row the path match finds. Releasing a whole conversation — the person's act, and rare — reads every
 *   conversation.
 */
export const BLOB_IN_CONVERSATION_MESSAGES_SQL =
  "SELECT 1 AS present FROM messages WHERE conversation_id = ? AND instr(document, ?) > 0 LIMIT 1";

const FRAME_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export function blobStillReferenced(db: Database, blobPath: string, scope: { messagesOf?: string } = {}): boolean {
  const name = blobPath.split(/[/\\]/).at(-1) ?? "";
  if (name === "") return false;
  const suffixMatch = (table: string): boolean =>
    oneRow<{ present: number }>(
      db,
      `SELECT 1 AS present FROM ${table} WHERE blob_path IS NOT NULL AND (blob_path = ? OR substr(blob_path, -?) IN (?, ?)) LIMIT 1`,
      blobPath,
      name.length + 1,
      `/${name}`,
      `\\${name}`,
    ) !== undefined;
  if (suffixMatch("attachments") || suffixMatch("artifacts") || suffixMatch("local_images")) return true;

  const matched = /^([0-9a-f]{32})\.([a-z0-9]+)$/u.exec(name);
  const address = matched?.[1];
  if (address === undefined) return false;
  const couldBeFrame = FRAME_EXTENSIONS.has(matched?.[2] ?? "");
  const digestMatch = (table: string, column: string): boolean =>
    oneRow<{ present: number }>(
      db,
      `SELECT 1 AS present FROM ${table} WHERE ${column} IS NOT NULL AND instr(${column}, ?) > 0 LIMIT 1`,
      // The bare hex, so a digest written with or without its `sha256:` prefix is found either way.
      address,
    ) !== undefined;
  return (
    digestMatch("attachments", "sha256") ||
    digestMatch("artifacts", "digest") ||
    digestMatch("local_images", "digest") ||
    digestMatch("task_artifacts", "digest") ||
    digestMatch("evidence", "digest") ||
    (couldBeFrame &&
      (scope.messagesOf === undefined
        ? digestMatch("messages", "document")
        : oneRow<{ present: number }>(db, BLOB_IN_CONVERSATION_MESSAGES_SQL, scope.messagesOf, address) !== undefined))
  );
}
