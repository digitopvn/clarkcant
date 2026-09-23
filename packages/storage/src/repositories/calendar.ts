import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Local calendar
 * ------------------------------------------------------------------ */

export interface CalendarEventRecord {
  eventId: string;
  ownerPrincipalId: string;
  nodeId: string;
  title: string;
  /** Instants are stored in UTC; `timezone` is what makes them displayable. */
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** The local calendar day the event starts on, so a day query is an index hit. */
  localDate: string;
  createdAt: string;
  updatedAt: string;
}

export function insertCalendarEvent(db: Database, input: CalendarEventRecord): void {
  db.prepare(
    `INSERT INTO calendar_events
       (event_id, owner_principal_id, node_id, title, starts_at, ends_at, timezone, local_date,
        document, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.ownerPrincipalId,
    input.nodeId,
    input.title,
    input.startsAt,
    input.endsAt,
    input.timezone,
    input.localDate,
    toJson(input),
    input.createdAt,
    input.updatedAt,
  );
}

export function updateCalendarEvent(
  db: Database,
  input: CalendarEventRecord,
): boolean {
  const result = db
    .prepare(
      `UPDATE calendar_events
          SET title = ?, starts_at = ?, ends_at = ?, timezone = ?, local_date = ?, document = ?, updated_at = ?
        WHERE event_id = ? AND owner_principal_id = ? AND deleted_at IS NULL`,
    )
    .run(
      input.title,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.localDate,
      toJson(input),
      input.updatedAt,
      input.eventId,
      input.ownerPrincipalId,
    );
  return Number(result.changes) > 0;
}

export function getCalendarEvent(
  db: Database,
  eventId: string,
  principalId: string,
): CalendarEventRecord | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM calendar_events WHERE event_id = ? AND owner_principal_id = ? AND deleted_at IS NULL",
    eventId,
    principalId,
  );
  return row === undefined ? undefined : parseJson<CalendarEventRecord>(row.document, "calendar_events.document");
}

/**
 * List events overlapping a window.
 *
 * Overlap rather than containment: an event that started yesterday and ends tomorrow belongs in
 * today's view, and a query written as `starts_at BETWEEN` would hide it.
 */
export function listCalendarEvents(
  db: Database,
  input: { principalId: string; from?: string; to?: string; limit?: number },
): CalendarEventRecord[] {
  const clauses = ["owner_principal_id = ?", "deleted_at IS NULL"];
  const params: unknown[] = [input.principalId];
  if (input.to !== undefined) {
    clauses.push("starts_at <= ?");
    params.push(input.to);
  }
  if (input.from !== undefined) {
    clauses.push("ends_at >= ?");
    params.push(input.from);
  }
  const rows = allRows<{ document: string }>(
    db,
    `SELECT document FROM calendar_events WHERE ${clauses.join(" AND ")} ORDER BY starts_at ASC LIMIT ?`,
    ...params,
    input.limit ?? 200,
  );
  return rows.map((row) => parseJson<CalendarEventRecord>(row.document, "calendar_events.document"));
}

/** Soft delete: an event the user removed must not silently vanish from a snapshot's provenance. */
export function deleteCalendarEvent(db: Database, eventId: string, principalId: string, at: Instant): boolean {
  const result = db
    .prepare("UPDATE calendar_events SET deleted_at = ?, updated_at = ? WHERE event_id = ? AND owner_principal_id = ? AND deleted_at IS NULL")
    .run(at, at, eventId, principalId);
  return Number(result.changes) > 0;
}
