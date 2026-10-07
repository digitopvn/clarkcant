import {
  type FeedbackDraft,
  type FeedbackPublication,
  type FeedbackStatus,
  type Instant,
  feedbackDraftSchema,
  feedbackPublicationSchema,
  feedbackStatusSchema,
} from "@clarkcant/contracts";

import { type Database, allRows } from "../db.ts";

/**
 * Product reports filed from the conversation (#510), kept until GitHub is known to hold them.
 *
 * The draft is stored as the redacted issue it will be published as, never the request it was prepared from: what this
 * table holds is exactly what may leave the machine. Rows are read back through the contract, so a row this build cannot
 * read is reported as missing rather than half-trusted.
 */
export interface FeedbackReportRecord {
  reportId: string;
  principalId: string;
  conversationId?: string;
  status: FeedbackStatus;
  draft: FeedbackDraft;
  publication?: FeedbackPublication;
  /** The ledger row of the GitHub write in flight, or of the last one made. */
  effectId?: string;
  /**
   * The GitHub login the token belonged to when that write was sent, so it is looked for among that account's issues
   * whoever the token belongs to now. Absent when GitHub would not say. Kept on this node only; never sent or shown.
   */
  attemptLogin?: string;
  createdAt: Instant;
  updatedAt: Instant;
}

export function insertFeedbackReport(db: Database, record: FeedbackReportRecord): void {
  db.prepare(
    `INSERT INTO feedback_reports
       (report_id, principal_id, conversation_id, kind, source, status, repository, draft, publication, effect_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.reportId,
    record.principalId,
    record.conversationId ?? null,
    record.draft.kind,
    record.draft.source,
    record.status,
    record.draft.repository,
    JSON.stringify(record.draft),
    record.publication === undefined ? null : JSON.stringify(record.publication),
    record.effectId ?? null,
    record.createdAt,
    record.updatedAt,
  );
}

/**
 * Move a report on. Only the fields that change after it was prepared; the draft itself is never rewritten. A report
 * GitHub was read back holding stays published: a slower, concurrent check that found nothing yet cannot undo it.
 * Answers whether the row moved.
 *
 * `attempt` names a new write: its ledger row and the login it was sent as, which replace the previous attempt's both,
 * so a later attempt that could not learn its login is never looked for among an earlier attempt's account.
 */
export function updateFeedbackReport(
  db: Database,
  input: {
    reportId: string;
    status: FeedbackStatus;
    publication?: FeedbackPublication;
    attempt?: { effectId: string; login?: string };
    at: Instant;
  },
): boolean {
  const result = db.prepare(
    `UPDATE feedback_reports
        SET status = ?, publication = ?, effect_id = COALESCE(?, effect_id),
            attempt_login = CASE WHEN ? THEN ? ELSE attempt_login END, updated_at = ?
      WHERE report_id = ? AND status <> 'published'`,
  ).run(
    input.status,
    input.publication === undefined ? null : JSON.stringify(input.publication),
    input.attempt?.effectId ?? null,
    input.attempt === undefined ? 0 : 1,
    input.attempt?.login ?? null,
    input.at,
    input.reportId,
  );
  return Number(result.changes) > 0;
}

export function getFeedbackReport(db: Database, reportId: string): FeedbackReportRecord | undefined {
  const [row] = allRows<Record<string, unknown>>(db, "SELECT * FROM feedback_reports WHERE report_id = ?", reportId);
  return row === undefined ? undefined : feedbackReportFromRow(row);
}

/** Reports a publish was handed off for and that GitHub has not yet been seen to hold, oldest first. */
export function unsettledFeedbackReports(db: Database, limit = 50): FeedbackReportRecord[] {
  return allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM feedback_reports WHERE status IN ('publishing', 'unknown') ORDER BY updated_at LIMIT ?",
    limit,
  ).flatMap((row) => {
    const record = feedbackReportFromRow(row);
    return record === undefined ? [] : [record];
  });
}

function feedbackReportFromRow(row: Record<string, unknown>): FeedbackReportRecord | undefined {
  const status = feedbackStatusSchema.safeParse(row.status);
  let draftJson: unknown;
  let publicationJson: unknown;
  try {
    draftJson = JSON.parse(String(row.draft));
    publicationJson = row.publication === null ? undefined : JSON.parse(String(row.publication));
  } catch {
    return undefined;
  }
  const draft = feedbackDraftSchema.safeParse(draftJson);
  const publication = publicationJson === undefined ? undefined : feedbackPublicationSchema.safeParse(publicationJson);
  if (!status.success || !draft.success || (publication !== undefined && !publication.success)) return undefined;
  return {
    reportId: String(row.report_id),
    principalId: String(row.principal_id),
    ...(row.conversation_id === null ? {} : { conversationId: String(row.conversation_id) }),
    status: status.data,
    draft: draft.data,
    ...(publication?.success === true ? { publication: publication.data } : {}),
    ...(row.effect_id === null ? {} : { effectId: String(row.effect_id) }),
    ...(typeof row.attempt_login === "string" ? { attemptLogin: row.attempt_login } : {}),
    createdAt: String(row.created_at) as Instant,
    updatedAt: String(row.updated_at) as Instant,
  };
}

/**
 * The goals of this node's unfinished tasks that name issue `#number`: work Clark already has under way on it, which
 * another hand-off must not start beside.
 */
export function activeTaskGoalsMentioningIssue(db: Database, issueNumber: number): string[] {
  const mention = new RegExp(`#${String(issueNumber)}(?!\\d)`, "u");
  return allRows<{ goal: string }>(
    db,
    `SELECT goal FROM tasks
      WHERE state NOT IN ('succeeded', 'failed', 'cancelled') AND goal LIKE ?
      ORDER BY updated_at DESC LIMIT 20`,
    `%#${String(issueNumber)}%`,
  )
    .map((row) => row.goal)
    .filter((goal) => mention.test(goal));
}
