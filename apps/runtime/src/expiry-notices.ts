import { type Instant, type MessageRecord } from "@clarkcant/contracts";
import { allRows, getTask, parseJson } from "@clarkcant/storage";

import { QUESTION_TTL_MS, expireQuestions, interactionFromBlock } from "./interactions.ts";
import { interactionDepsFor } from "./routes/conversations.ts";
import { tryRecordNodeNotice } from "./notices.ts";
import type { NodeServices } from "./services.ts";

/**
 * A notice for what nobody answered.
 *
 * A waiting item is derived and drops off the inbox the moment its deadline passes — silently, by design, so a
 * stale "waiting" is never shown. That silence is right for the list, and wrong on its own: a person who never
 * looked never learns that a command they might have wanted to run never ran, or that a question the agent
 * asked went unanswered and the turn it was blocking never continued. This sweep is the one place that says so,
 * once, pointing at the conversation the thing belonged to.
 *
 * It does not invent a new "expired" state. An approval already becomes `expired` the moment anything tries to
 * decide it past its deadline (`decideApprovalWithinTransaction`); this sweep only reads rows still sitting
 * `pending` past `expires_at` — nobody tried, so nobody wrote that — and reports them the same way. A question's
 * own `expireQuestions` already exists for exactly this (a tool-activity block recording `decision: "expired"`)
 * and is reused here rather than duplicated; it is idempotent, so a sweep that runs twice on the same question
 * writes that block once.
 */
export type ExpiryNoticeServices = Pick<NodeServices, "runtime" | "conductor" | "search">;

/**
 * How far back the sweep looks for something that expired without anybody answering it.
 *
 * Bounded for the reason every inbox scan is: a node with years of history must not re-read all of it on every
 * tick. Wide enough that a sweep which missed a tick — the node was off, or this is the first one since start —
 * still catches what expired since the last time one actually ran.
 */
const EXPIRY_SCAN_WINDOW_MS = 24 * 60 * 60_000;

/** How many of the newest messages a scan reads. Matches the inbox's own bound, for the same reason. */
const RECENT_MESSAGES = 2000;

interface ExpiredApprovalRow {
  approval_id: string;
  task_id: string | null;
  operation_description: string;
  expires_at: string;
}

/**
 * Approvals still `pending` whose deadline has passed, each reported once.
 *
 * A task approval's conversation is its task's; a command approval's is wherever its card was written, found the
 * same way the inbox finds it for the still-open case. A capability approval (an install's `ask`, `task_id` and
 * card both absent) has no conversation to point at, so it is left out — the same reason the inbox never offers
 * one without a card: a pointer to nowhere is not a notice, it is noise.
 */
function sweepExpiredApprovals(services: ExpiryNoticeServices, now: Instant): void {
  const since = new Date(Date.parse(now) - EXPIRY_SCAN_WINDOW_MS).toISOString();
  const rows = allRows<ExpiredApprovalRow>(
    services.runtime.db,
    `SELECT approval_id, task_id, operation_description, expires_at FROM approvals
       WHERE decision = 'pending' AND expires_at <= ? AND expires_at >= ?
       ORDER BY expires_at`,
    now,
    since,
  );
  if (rows.length === 0) return;

  const cardConversations = findCardConversations(
    services,
    rows.filter((row) => row.task_id === null).map((row) => row.approval_id),
  );

  for (const row of rows) {
    const conversationId =
      row.task_id === null ? cardConversations.get(row.approval_id) : getTask(services.runtime.db, row.task_id)?.conversationId;
    if (conversationId === undefined) continue;
    tryRecordNodeNotice(services, {
      sourceKind: "system",
      category: "alert",
      severity: "warning",
      title: "Yêu cầu duyệt đã hết hạn, không có gì được chạy",
      body: row.operation_description,
      conversationId,
      dedupKey: `expired:${row.approval_id}`,
      at: now,
    });
  }
}

/** The conversation each of these approval-card ids was written into, read from the newest messages. */
function findCardConversations(services: ExpiryNoticeServices, approvalIds: string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (approvalIds.length === 0) return found;
  const wanted = new Set(approvalIds);
  const messages = allRows<{ conversation_id: string; document: string }>(
    services.runtime.db,
    `SELECT conversation_id, document FROM
      (SELECT rowid, conversation_id, document FROM messages ORDER BY rowid DESC LIMIT ?)
      WHERE document LIKE '%"approval-card"%'`,
    RECENT_MESSAGES,
  );
  for (const message of messages) {
    if (found.size === wanted.size) break;
    const record = parseJson<MessageRecord>(message.document, "messages.document");
    // SAFETY: as in inbox.ts's own card scan - a stored message is the node's own write, and only `type` and
    // `approvalId` are read here after `type` is checked.
    for (const block of record.blocks as unknown as Record<string, unknown>[]) {
      if (block.type !== "approval-card" || typeof block.approvalId !== "string") continue;
      if (!wanted.has(block.approvalId) || found.has(block.approvalId)) continue;
      found.set(block.approvalId, message.conversation_id);
    }
  }
  return found;
}

/**
 * Questions still waiting whose deadline has passed, each closed (via `expireQuestions`) and reported once.
 *
 * Closing is not a side effect this sweep invents: a question left `waiting` past its `expiresAt` already reads
 * as closed everywhere else (`isWaiting` says so), and `expireQuestions` is the existing, idempotent way to make
 * the transcript agree by recording that nobody answered. This sweep is what makes that fact reach the person
 * instead of sitting silent in the conversation nobody is looking at.
 */
function sweepExpiredQuestions(services: ExpiryNoticeServices, now: Instant): void {
  const since = new Date(Date.parse(now) - QUESTION_TTL_MS - EXPIRY_SCAN_WINDOW_MS).toISOString();
  const messages = allRows<{ conversation_id: string; created_at: string; document: string }>(
    services.runtime.db,
    `SELECT conversation_id, created_at, document FROM
      (SELECT rowid, conversation_id, created_at, document FROM messages ORDER BY rowid DESC LIMIT ?)
      WHERE created_at >= ? AND document LIKE '%"question-card"%'`,
    RECENT_MESSAGES,
    since,
  );

  // The prompt has to be read from the card itself, before expiry closes it: `expireQuestions` reports only
  // which ids it closed, not what they asked.
  const promptById = new Map<string, string>();
  const conversationByQuestionId = new Map<string, string>();
  for (const message of messages) {
    const record = parseJson<MessageRecord>(message.document, "messages.document");
    for (const block of record.blocks) {
      const interaction = interactionFromBlock(block, message.conversation_id);
      if (interaction === undefined || promptById.has(interaction.questionId)) continue;
      promptById.set(interaction.questionId, interaction.prompt);
      conversationByQuestionId.set(interaction.questionId, message.conversation_id);
    }
  }

  for (const conversationId of new Set(conversationByQuestionId.values())) {
    const deps = { ...interactionDepsFor(services, conversationId), now: () => now };
    for (const questionId of expireQuestions(deps)) {
      const prompt = promptById.get(questionId);
      tryRecordNodeNotice(services, {
        sourceKind: "system",
        category: "alert",
        severity: "warning",
        title: "Câu hỏi đã hết hạn, không có ai trả lời",
        ...(prompt === undefined ? {} : { body: prompt }),
        conversationId,
        dedupKey: `expired:${questionId}`,
        at: now,
      });
    }
  }
}

/** One tick of the sweep: everything that expired unanswered, each reported once. Never throws. */
export function sweepExpired(services: ExpiryNoticeServices, now: Instant): void {
  sweepExpiredApprovals(services, now);
  sweepExpiredQuestions(services, now);
}

/**
 * Start the periodic sweep. Unref'd, so it never keeps the process alive on its own, and stopped the same way
 * every other background interval on this node is: by the caller, when the node closes.
 */
export function startExpiryNoticeSweep(
  services: ExpiryNoticeServices,
  options: { intervalMs?: number; now?: () => Instant } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const timer = setInterval(() => {
    try {
      sweepExpired(services, now());
    } catch (cause) {
      process.stderr.write(
        `expiry sweep: could not run (${cause instanceof Error ? cause.message : String(cause)})\n`,
      );
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
