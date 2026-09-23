import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Database, openDatabase, oneRow, allRows } from "./db.ts";
import { MIGRATIONS, currentSchemaVersion } from "./migrate.ts";

/**
 * Consistent backup and restore.
 *
 * The blueprint forbids the tempting shortcut of copying `*.sqlite`, `-wal` and
 * `-shm` with a shell script and calling the result a backup: a live WAL database
 * copied while a writer is active can restore to a torn state that opens without
 * complaint and is silently wrong.
 *
 * The correct primitive is SQLite's own `VACUUM INTO`, which takes a read
 * transaction and writes a complete, consistent database file.
 */

export interface BackupManifest {
  createdAt: string;
  schemaVersion: number;
  /** Digest of the backup file, so a restore can be verified before it is used. */
  digest: string;
  bytes: number;
  /** Table row counts, so a restore can be checked rather than assumed. */
  tableCounts: Record<string, number>;
  /** Migration names contained in the backup, for version-drift detection (T69). */
  migrations: string[];
  /** Key material is not in the database and must be backed up separately. */
  vaultKeyBackedUpSeparately: true;
}

function sortedTables(db: Database): string[] {
  const rows = allRows<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

export function tableCounts(db: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of sortedTables(db)) {
    // Identifiers cannot be bound as parameters; the value comes from
    // sqlite_master, not from user input, and is quoted defensively anyway.
    const row = oneRow<{ n: number }>(db, `SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`);
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

export interface CreateBackupOptions {
  /** Live database to snapshot. */
  db: Database;
  /** Directory the backup file and manifest are written into. */
  destination: string;
  /** Injected so the manifest is deterministic in tests. */
  now: () => string;
}

export function createBackup(options: CreateBackupOptions): BackupManifest {
  const { db, destination } = options;
  mkdirSync(destination, { recursive: true });

  const databasePath = join(destination, "backup.sqlite");
  rmSync(databasePath, { force: true });

  // VACUUM INTO takes a consistent read snapshot of the live database.
  // The path is a bound value here, so a directory name with quotes is safe.
  db.prepare("VACUUM INTO ?").run(databasePath);

  const bytes = statSync(databasePath).size;
  const digest = `sha256:${createHash("sha256").update(readFileSync(databasePath)).digest("hex")}`;
  const schemaVersion = currentSchemaVersion(db);

  const manifest: BackupManifest = {
    createdAt: options.now(),
    schemaVersion,
    digest,
    bytes,
    tableCounts: tableCounts(db),
    migrations: MIGRATIONS.filter((migration) => migration.version <= schemaVersion).map(
      (migration) => `${migration.version}:${migration.name}`,
    ),
    vaultKeyBackedUpSeparately: true,
  };

  writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * A backup cannot be verified by opening it and checking that it does not throw:
 * SQLite will happily open a truncated or logically inconsistent file. Integrity
 * has to be asked for explicitly.
 */
export interface BackupVerification {
  ok: boolean;
  problems: string[];
  schemaVersion: number;
  tableCounts: Record<string, number>;
}

export function verifyBackup(destination: string): BackupVerification {
  const problems: string[] = [];
  const databasePath = join(destination, "backup.sqlite");
  const manifestPath = join(destination, "manifest.json");

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      problems: [`backup manifest at ${manifestPath} could not be read or parsed: ${detail}`],
      schemaVersion: 0,
      tableCounts: {},
    };
  }

  /*
   * Hashed inside a try for the same reason the open below is: a backup interrupted between the database write
   * and the manifest write leaves a manifest pointing at nothing, and the operator deciding whether to restore
   * needs that answer rather than a thrown ENOENT.
   */
  let actualDigest: string;
  try {
    actualDigest = `sha256:${createHash("sha256").update(readFileSync(databasePath)).digest("hex")}`;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      problems: [`the backup database at ${databasePath} could not be read: ${detail}`],
      schemaVersion: 0,
      tableCounts: {},
    };
  }
  if (actualDigest !== manifest.digest) {
    problems.push(
      `backup digest mismatch: manifest=${manifest.digest.slice(0, 16)}… actual=${actualDigest.slice(0, 16)}…`,
    );
  }

  /*
   * Opened inside a try, because a copy that cannot even be opened as a database is the most important case for
   * this function to report rather than throw on: the caller is deciding whether to restore from it, and an
   * exception here aborts that decision instead of telling the operator the backup is unusable. One byte corrupted
   * in the middle of a page is enough to reach this — which is what a backup truncated by a full disk looks like.
   */
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase({ path: databasePath });
  } catch (cause) {
    problems.push(
      `the backup could not be opened as a SQLite database: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return { ok: false, problems, schemaVersion: 0, tableCounts: {} };
  }
  try {
    let schemaVersion = 0;
    let counts: Record<string, number> = {};
    try {
      const integrity = oneRow<{ integrity_check: string }>(db, "PRAGMA integrity_check");
      if (integrity?.integrity_check !== "ok") {
        problems.push(`integrity_check reported: ${String(integrity?.integrity_check)}`);
      }
      const foreignKeys = allRows<Record<string, unknown>>(db, "PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) {
        problems.push(`foreign_key_check reported ${foreignKeys.length} violation(s)`);
      }
      schemaVersion = currentSchemaVersion(db);
      counts = tableCounts(db);
    } catch (cause) {
      // A backup that cannot even be read is the most important case for this
      // function to report rather than throw on: the caller is deciding whether to
      // restore from it, and an exception here would abort the restore check
      // instead of telling the operator the backup is unusable.
      problems.push(
        `the backup could not be read as a SQLite database: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return { ok: false, problems, schemaVersion: 0, tableCounts: {} };
    }

    for (const [table, expected] of Object.entries(manifest.tableCounts)) {
      if (counts[table] !== expected) {
        problems.push(`table ${table} restored ${String(counts[table])} rows but the manifest recorded ${expected}`);
      }
    }
    return { ok: problems.length === 0, problems, schemaVersion, tableCounts: counts };
  } finally {
    db.close();
  }
}

/**
 * Version drift between a backup and the binary restoring it.
 *
 * A restore must either migrate forward or be refused. Silently opening an older
 * schema leaves queries failing at random later, which is exactly the "silent
 * corruption" the acceptance test T69 rules out.
 */
export function checkRestoreCompatibility(
  manifest: BackupManifest,
  binarySchemaVersion: number,
): { ok: true; action: "none" | "migrate-forward" } | { ok: false; reason: string } {
  if (manifest.schemaVersion === binarySchemaVersion) return { ok: true, action: "none" };
  if (manifest.schemaVersion < binarySchemaVersion) return { ok: true, action: "migrate-forward" };
  return {
    ok: false,
    reason: `backup was taken at schema version ${manifest.schemaVersion}, which is newer than this binary supports (${binarySchemaVersion}). Restoring would require a downgrade path that does not exist; upgrade the binary instead.`,
  };
}
