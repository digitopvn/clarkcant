import {
  type InboxResponse,
  type InboxSummary,
  type Instant,
  type MessageRecord,
  type WaitingItem,
} from "@clarkcant/contracts";
import {
  allRows,
  countUnreadNotifications,
  listNotifications,
  parseJson,
} from "@clarkcant/storage";

import { listPendingCapabilityApprovals } from "./application/package-install.ts";
import { QUESTION_TTL_MS, pendingForConversation } from "./interactions.ts";
import { interactionDepsFor } from "./routes/conversations.ts";
import type { NodeServices } from "./services.ts";

/**
 * What the inbox reads: what is waiting for the person, and the notices they have not dismissed.
 *
 * ## Waiting items are derived, every time
 *
 * Nothing here stores "this approval is pending". An approval's state is its row in `approvals`; the operation it
 * would run is the card in its transcript; a question's state is its card and the answer record that may follow
 * it. The inbox reads those back on each request, which costs a few bounded queries and buys the one property that
 * matters: it can never show an approval as open after it was decided on the card, or hide one the card still
 * shows. The alternative — a status row updated from every decision path — is a second copy of the truth, and the
 * copy is what drifts.
 *
 * ## Why the scan is bounded by time, not by count
 *
 * Every waiting thing has a deadline. A command approval expires with its row; a question with its card
 * (`QUESTION_TTL_MS`). So the only messages that can hold something still open are the ones written after the
 * oldest deadline that has not passed, and the scan reads exactly those. A node with years of history reads the
 * last quarter of an hour.
 */
export type InboxServices = Pick<NodeServices, "runtime" | "conductor" | "search">;

/** The cap on how many messages the scan reads. Far above a quarter hour of real traffic; a guard, not a limit. */
const SCAN_LIMIT = 500;

interface ApprovalRow {
  approval_id: string;
  operation_digest: string;
  operation_description: string;
  requested_at: string;
  expires_at: string;
}

/**
 * Command approvals the agent asked for in any conversation, still undecided and still in time.
 *
 * Found through their card rather than through the row alone: the card is where the operation's payload lives, and
 * `decideApprovalForNode` refuses an approval whose card it cannot find. A row with no card would be a button that
 * can only fail, so it is not offered. A capability approval from an install has no card and is read below instead;
 * an approval a dispatched task raised (`task_id` set) has no decision route yet and is not offered at all.
 */
function pendingCommandApprovals(services: InboxServices, now: Instant): WaitingItem[] {
  const rows = allRows<ApprovalRow>(
    services.runtime.db,
    `SELECT approval_id, operation_digest, operation_description, requested_at, expires_at FROM approvals
      WHERE task_id IS NULL AND decision = 'pending' AND expires_at > ?
      ORDER BY requested_at`,
    now,
  );
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((row) => [row.approval_id, row]));
  const oldest = rows[0]?.requested_at ?? now;

  const messages = allRows<{ conversation_id: string; document: string }>(
    services.runtime.db,
    `SELECT conversation_id, document FROM messages
      WHERE created_at >= ? AND document LIKE '%"approval-card"%'
      ORDER BY created_at DESC LIMIT ?`,
    oldest,
    SCAN_LIMIT,
  );

  const items: WaitingItem[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const record = parseJson<MessageRecord>(message.document, "messages.document");
    // SAFETY: a stored message's blocks are the node's own writes; only the fields read below are trusted, and each
    // is checked for its type before it is used.
    for (const block of record.blocks as unknown as Record<string, unknown>[]) {
      if (block.type !== "approval-card" || typeof block.approvalId !== "string") continue;
      const row = byId.get(block.approvalId);
      if (row === undefined || seen.has(row.approval_id)) continue;
      seen.add(row.approval_id);
      const command = commandOf(block.payload);
      items.push({
        kind: "command-approval",
        approvalId: row.approval_id,
        conversationId: message.conversation_id,
        description: row.operation_description,
        ...(command === undefined ? {} : { command }),
        operationDigest: row.operation_digest,
        requestedAt: row.requested_at as Instant,
        expiresAt: row.expires_at as Instant,
      });
    }
  }
  return items;
}

/** The command line a card will run, read from its payload, so the decision is made on the words themselves. */
function commandOf(payload: unknown): string | undefined {
  if (typeof payload !== "string") return undefined;
  try {
    const parsed = JSON.parse(payload) as { command?: unknown };
    return typeof parsed.command === "string" && parsed.command !== "" ? parsed.command.slice(0, 2000) : undefined;
  } catch {
    return undefined;
  }
}

/** Questions the agent is waiting on, in conversations that asked one recently enough for it to still be open. */
function pendingQuestions(services: InboxServices, now: Instant): WaitingItem[] {
  const since = new Date(Date.parse(now) - QUESTION_TTL_MS).toISOString();
  const conversations = allRows<{ conversation_id: string }>(
    services.runtime.db,
    `SELECT DISTINCT conversation_id FROM messages
      WHERE created_at >= ? AND document LIKE '%"question-card"%'
      LIMIT ?`,
    since,
    SCAN_LIMIT,
  ).map((row) => row.conversation_id);

  return conversations.flatMap((conversationId) =>
    pendingForConversation({ ...interactionDepsFor(services, conversationId), now: () => now }).map(
      (question): WaitingItem => ({
        kind: "question",
        questionId: question.questionId,
        conversationId,
        prompt: question.prompt,
        requestedAt: question.createdAt,
        ...(question.expiresAt === undefined ? {} : { expiresAt: question.expiresAt }),
      }),
    ),
  );
}

/** Capability approvals an install left open: node-scoped, answered through the same route Settings uses. */
function pendingCapabilityApprovals(services: InboxServices): WaitingItem[] {
  return listPendingCapabilityApprovals(services).map((approval) => ({
    kind: "capability-approval",
    approvalId: approval.approvalId,
    packageId: approval.packageId,
    version: approval.version,
    ref: approval.ref,
    description: approval.description,
    operationDigest: approval.operationDigest,
    requestedAt: approval.requestedAt as Instant,
    expiresAt: approval.expiresAt as Instant,
  }));
}

/** Everything waiting for the person, oldest first: the one that expires soonest is the one to see first. */
export function waitingItems(services: InboxServices, now: Instant): WaitingItem[] {
  return [
    ...pendingCommandApprovals(services, now),
    ...pendingCapabilityApprovals(services),
    ...pendingQuestions(services, now),
  ].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function readInbox(services: InboxServices, now: Instant, limit = 50): InboxResponse {
  const principalId = services.runtime.identity.ownerPrincipalId;
  return {
    waiting: waitingItems(services, now),
    notices: listNotifications(services.runtime.db, principalId, limit),
    unread: countUnreadNotifications(services.runtime.db, principalId),
    readAt: now,
  };
}

export function inboxSummary(services: InboxServices, now: Instant): InboxSummary {
  return {
    waiting: waitingItems(services, now).length,
    unread: countUnreadNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId),
  };
}
