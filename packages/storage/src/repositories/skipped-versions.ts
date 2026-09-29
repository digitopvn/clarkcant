import type { Instant } from "@clarkcant/contracts";

import { type Database, allRows } from "../db.ts";

/**
 * The versions a person said not to be told about, from an update notice's "Skip this version".
 *
 * Per principal, and per thing that is updated: a package by its id, the Pi SDK by its npm name. The update check reads
 * this before it writes a notice (`update-checks.ts`) and reports nothing at or below a skipped version; a newer one is
 * still reported, because skipping 1.1.0 is not the same as never wanting 2.0.0.
 */
export type SkippedVersionKind = "package" | "pi";

export interface SkippedVersionKey {
  principalId: string;
  subjectKind: SkippedVersionKind;
  name: string;
  version: string;
}

/** Remember a skip. Skipping the same version twice keeps the first time it was skipped. */
export function skipVersion(db: Database, input: SkippedVersionKey & { at: Instant }): void {
  db.prepare(
    `INSERT INTO skipped_versions (principal_id, subject_kind, name, version, skipped_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(principal_id, subject_kind, name, version) DO NOTHING`,
  ).run(input.principalId, input.subjectKind, input.name, input.version, input.at);
}

/** Take a skip back, answering whether there was one. */
export function unskipVersion(db: Database, input: SkippedVersionKey): boolean {
  const result = db
    .prepare("DELETE FROM skipped_versions WHERE principal_id = ? AND subject_kind = ? AND name = ? AND version = ?")
    .run(input.principalId, input.subjectKind, input.name, input.version);
  return Number(result.changes) > 0;
}

/** Every version of one package (or of the Pi SDK) this principal skipped, in no particular order. */
export function skippedVersionsOf(
  db: Database,
  principalId: string,
  subjectKind: SkippedVersionKind,
  name: string,
): string[] {
  return allRows<{ version: string }>(
    db,
    "SELECT version FROM skipped_versions WHERE principal_id = ? AND subject_kind = ? AND name = ?",
    principalId,
    subjectKind,
    name,
  ).map((row) => row.version);
}
