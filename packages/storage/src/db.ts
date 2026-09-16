import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Node-local durable storage.
 *
 * SQLite in WAL mode with exactly one writer per database. The blueprint is
 * explicit that a live SQLite file is never shared across machines or mounted on
 * a network filesystem, so this module never offers a remote mode: nodes
 * federate through NodeLink instead.
 *
 * `node:sqlite` is built into Node 22.5+, so there is no native build step. That
 * matters for the supply-chain story: the storage layer adds no compiled
 * dependency to audit.
 */

export type Database = DatabaseSync;

export interface OpenDatabaseOptions {
  /** Absolute path, or `:memory:` for tests. */
  path: string;
  /** Wait this long for a lock before failing, instead of throwing immediately. */
  busyTimeoutMs?: number;
  /** Skip WAL for in-memory databases, which do not support it. */
  enableWal?: boolean;
}

/**
 * Open a database with the pragmas the durability model depends on.
 *
 * - `journal_mode = WAL` gives readers a consistent snapshot while a writer is
 *   active, which is what lets a reconnect snapshot and a task update coexist.
 * - `synchronous = NORMAL` is the documented safe pairing with WAL: a crash can
 *   lose the last transactions but cannot corrupt the file. `FULL` would be
 *   needed only if losing the tail were unacceptable, and the outbox is designed
 *   to be re-sent, so the trade is deliberate.
 * - `foreign_keys = ON` is off by default in SQLite; without it the referential
 *   integrity the schema declares would not actually be enforced.
 */
export function openDatabase(options: OpenDatabaseOptions): Database {
  const isMemory = options.path === ":memory:";
  if (!isMemory) {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const db = new DatabaseSync(options.path);

  if (options.enableWal !== false && !isMemory) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  return db;
}

/**
 * Run a function inside a transaction, rolling back on any throw.
 *
 * Nested calls are rejected rather than silently flattened, because a nested
 * `BEGIN` in SQLite implicitly commits the outer transaction — a silent durability
 * bug that would be very hard to find later. The in-flight set below is what makes
 * that rejection reliable instead of advisory.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  if (inTransaction(db)) {
    throw new Error(
      "nested transaction: SQLite would implicitly commit the outer transaction, breaking durability. Pass the work into the outer transaction instead of starting a new one.",
    );
  }
  db.exec("BEGIN IMMEDIATE");
  inFlight.add(db);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A rollback can fail if the transaction was already aborted by SQLite.
      // The original error is the useful one, so it is rethrown below.
    }
    throw error;
  } finally {
    inFlight.delete(db);
  }
}

/**
 * Databases with a transaction currently open.
 *
 * Tracked here rather than queried from SQLite because `node:sqlite` does not surface
 * `sqlite3_get_autocommit`. Every transaction in the codebase goes through
 * `transaction()`, so this set is authoritative.
 */
const inFlight = new WeakSet<Database>();

export function inTransaction(db: Database): boolean {
  return inFlight.has(db);
}

export function closeDatabase(db: Database): void {
  db.close();
}

/**
 * Convert a `DatabaseSync` row (unknown-typed) into a typed record.
 *
 * Rows come back as `Record<string, SQLOutputValue>`; the cast is confined to
 * this one place so the rest of the codebase does not sprinkle `as` around.
 */
export function rowAs<T>(row: unknown): T {
  return row as T;
}

/** Read every row of a prepared query into an array. */
export function allRows<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  const statement = db.prepare(sql);
  return statement.all(...(params as never[])) as T[];
}

/** Read a single row, or `undefined` when there is no match. */
export function oneRow<T>(db: Database, sql: string, ...params: unknown[]): T | undefined {
  const statement = db.prepare(sql);
  return statement.get(...(params as never[])) as T | undefined;
}

export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Serialise a value into a SQLite column.
 *
 * Booleans are stored as 0/1 because SQLite has no boolean type, and passing a
 * JS boolean directly to `node:sqlite` throws. Centralising the conversion keeps
 * every repository consistent.
 */
export function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

/** Persist a structured value as canonical JSON text. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === undefined) return undefined;
    return inner;
  });
}

/**
 * Parse stored JSON, surfacing the column name when the payload is corrupt.
 *
 * A generic `SyntaxError` from deep inside a query is close to undebuggable, and
 * the blueprint requires that a corrupt row be reported rather than silently
 * treated as absent.
 */
export function parseJson<T>(raw: unknown, column: string): T {
  if (typeof raw !== "string") {
    throw new Error(`column ${column} was expected to hold JSON text but held ${typeof raw}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`column ${column} holds malformed JSON`, { cause });
  }
}
