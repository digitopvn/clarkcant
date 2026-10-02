import type { Instant } from "@clarkcant/contracts";

import { type Database, allRows, oneRow, transaction } from "../db.ts";

/**
 * The accounts package services work on, connected by the host (`apps/runtime/src/package-connections.ts`).
 *
 * Two tables on purpose. `package_connections` is the status any surface may be shown: state, granted scopes, when it
 * was connected and why it is not usable. `package_connection_tokens` holds the access and refresh tokens, and only the
 * connection broker reads it: no route lists it, it is not the credential store a person sees in Settings, and deleting
 * a connection deletes its tokens with it.
 */

export type StoredConnectionState = "connected" | "partial" | "expired" | "revoked";

export interface StoredConnection {
  connectionRef: string;
  principalId: string;
  packageId: string;
  provider: string;
  /** A fingerprint of the declaration the account was connected under: where its tokens may go. */
  declarationDigest: string;
  state: StoredConnectionState;
  grantedScopes: string[];
  accessExpiresAt?: Instant;
  reason?: string;
  connectedAt: Instant;
  updatedAt: Instant;
}

interface ConnectionRow {
  connection_ref: string;
  principal_id: string;
  package_id: string;
  provider: string;
  declaration_digest: string;
  state: StoredConnectionState;
  granted_scopes: string;
  access_expires_at: string | null;
  reason: string | null;
  connected_at: string;
  updated_at: string;
}

function fromRow(row: ConnectionRow): StoredConnection {
  const scopes: unknown = JSON.parse(row.granted_scopes);
  return {
    connectionRef: row.connection_ref,
    principalId: row.principal_id,
    packageId: row.package_id,
    provider: row.provider,
    declarationDigest: row.declaration_digest,
    state: row.state,
    grantedScopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [],
    ...(row.access_expires_at === null ? {} : { accessExpiresAt: row.access_expires_at as Instant }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    connectedAt: row.connected_at as Instant,
    updatedAt: row.updated_at as Instant,
  };
}

/** The connection one principal has for one package, if any. */
export function getPackageConnection(db: Database, principalId: string, packageId: string): StoredConnection | undefined {
  const row = oneRow<ConnectionRow>(
    db,
    "SELECT * FROM package_connections WHERE principal_id = ? AND package_id = ?",
    principalId,
    packageId,
  );
  return row === undefined ? undefined : fromRow(row);
}

/** Every connection a principal has, for listings. Status only. */
export function listPackageConnections(db: Database, principalId: string): StoredConnection[] {
  return allRows<ConnectionRow>(db, "SELECT * FROM package_connections WHERE principal_id = ? ORDER BY package_id", principalId).map(
    fromRow,
  );
}

/**
 * Record a connection that just completed, with its tokens, replacing whatever the package had: one account per
 * package, so a reconnect is a new connection and the old tokens go with the old row.
 */
export function savePackageConnection(
  db: Database,
  input: Omit<StoredConnection, "updatedAt"> & { accessToken: string; refreshToken?: string },
): void {
  transaction(db, () => {
    db.prepare("DELETE FROM package_connections WHERE principal_id = ? AND package_id = ?").run(input.principalId, input.packageId);
    db.prepare(
      `INSERT INTO package_connections
         (connection_ref, principal_id, package_id, provider, declaration_digest, state, granted_scopes, access_expires_at, reason, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.connectionRef,
      input.principalId,
      input.packageId,
      input.provider,
      input.declarationDigest,
      input.state,
      JSON.stringify(input.grantedScopes),
      input.accessExpiresAt ?? null,
      input.reason ?? null,
      input.connectedAt,
      input.connectedAt,
    );
    writeTokens(db, input.connectionRef, input.accessToken, input.refreshToken);
  });
}

function writeTokens(db: Database, connectionRef: string, accessToken: string, refreshToken: string | undefined): void {
  const put = db.prepare(
    `INSERT INTO package_connection_tokens (connection_ref, kind, value) VALUES (?, ?, ?)
     ON CONFLICT(connection_ref, kind) DO UPDATE SET value = excluded.value`,
  );
  put.run(connectionRef, "access", accessToken);
  if (refreshToken !== undefined) put.run(connectionRef, "refresh", refreshToken);
}

/**
 * Store a refreshed access token (and the rotated refresh token, when the provider rotated it).
 *
 * Only onto a connection that is still usable: a refresh that was in flight while the person revoked, reconnected or
 * uninstalled must not bring the old connection back. Answers whether the tokens were kept.
 */
export function refreshPackageConnectionTokens(
  db: Database,
  input: {
    connectionRef: string;
    accessToken: string;
    refreshToken?: string;
    accessExpiresAt?: Instant;
    grantedScopes: string[];
    state: StoredConnectionState;
    at: Instant;
  },
): boolean {
  return transaction(db, () => {
    const result = db
      .prepare(
        `UPDATE package_connections SET access_expires_at = ?, granted_scopes = ?, state = ?, reason = NULL, updated_at = ?
         WHERE connection_ref = ? AND state IN ('connected', 'partial')`,
      )
      .run(input.accessExpiresAt ?? null, JSON.stringify(input.grantedScopes), input.state, input.at, input.connectionRef);
    if (Number(result.changes) !== 1) return false;
    writeTokens(db, input.connectionRef, input.accessToken, input.refreshToken);
    return true;
  });
}

/**
 * Mark a connection expired or revoked. Its tokens are deleted in the same step, so nothing can be sent with them
 * after the state says they are gone.
 */
export function endPackageConnection(
  db: Database,
  input: { connectionRef: string; state: "expired" | "revoked"; reason: string; at: Instant },
): void {
  transaction(db, () => {
    db.prepare("UPDATE package_connections SET state = ?, reason = ?, updated_at = ? WHERE connection_ref = ?").run(
      input.state,
      input.reason,
      input.at,
      input.connectionRef,
    );
    db.prepare("DELETE FROM package_connection_tokens WHERE connection_ref = ?").run(input.connectionRef);
  });
}

/** Forget a connection and its tokens: a disconnect, or the package being uninstalled. */
export function deletePackageConnection(db: Database, principalId: string, packageId: string): boolean {
  const result = db.prepare("DELETE FROM package_connections WHERE principal_id = ? AND package_id = ?").run(principalId, packageId);
  return Number(result.changes) > 0;
}

/** A connection's tokens. Read only by the node's connection broker. */
export function packageConnectionTokens(
  db: Database,
  connectionRef: string,
): { accessToken?: string; refreshToken?: string } {
  const rows = allRows<{ kind: "access" | "refresh"; value: string }>(
    db,
    "SELECT kind, value FROM package_connection_tokens WHERE connection_ref = ?",
    connectionRef,
  );
  const access = rows.find((row) => row.kind === "access")?.value;
  const refresh = rows.find((row) => row.kind === "refresh")?.value;
  return { ...(access === undefined ? {} : { accessToken: access }), ...(refresh === undefined ? {} : { refreshToken: refresh }) };
}
