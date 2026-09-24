import {
  type EffectCategory,
  type InboxResponse,
  type InboxSummary,
  type Instant,
  type MessageRecord,
  type WaitingItem,
} from "@clarkcant/contracts";
import {
  allRows,
  countUnreadNotifications,
  getTask,
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
 * ## Why the scans are bounded
 *
 * Every waiting thing has a deadline. A command approval expires with its row; a question with its card
 * (`QUESTION_TTL_MS`). So only recent messages can hold something still open, and neither scan reads history: both
 * read the newest `RECENT_MESSAGES` rows by `rowid`, the table's own b-tree, so a node with years of history reads
 * the same bounded window as a new one. A filter on `created_at` alone would not do that - the column has no index,
 * so it scans every message the node ever wrote, on a route the header polls every few seconds.
 *
 * The command-approval scan is also not narrowed by the approval's time, because the two clocks are not the same
 * event. A card's message is stamped when its turn wrote it, which is before the approval row
 * it carries is requested — a millisecond before in a fast turn, longer in a slow one. A window starting at the
 * approval's `requested_at` therefore misses the very card it is looking for.
 */
export type InboxServices = Pick<NodeServices, "runtime" | "conductor" | "search">;

/**
 * How many of the newest messages a scan reads, newest first by insertion order.
 *
 * An approval still in time was raised minutes ago, so its card is among the latest messages the node wrote unless
 * thousands were written since; that is the one case where an open approval is left to its card and not repeated
 * here. `rowid` order is the table's own b-tree, so the bound costs what it says whatever the history's size.
 */
const RECENT_MESSAGES = 2000;

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
 * an approval a dispatched task raised (`task_id` set) is read by `pendingTaskApprovals` below, through its own
 * decide route rather than through a card — a worker process never wrote one.
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

  const messages = allRows<{ conversation_id: string; document: string }>(
    services.runtime.db,
    `SELECT conversation_id, document FROM
      (SELECT rowid, conversation_id, document FROM messages ORDER BY rowid DESC LIMIT ?)
      WHERE document LIKE '%"approval-card"%'
      ORDER BY rowid DESC`,
    RECENT_MESSAGES,
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

interface TaskApprovalRow {
  approval_id: string;
  task_id: string;
  operation_digest: string;
  operation_description: string;
  effect_category: string;
  requested_at: string;
  expires_at: string;
}

/**
 * Approvals a dispatched task raised through the execution-policy gate (`task-dispatch.ts`), still undecided and
 * still in time.
 *
 * Unlike a command approval, there is no card: the worker process that needed the capability has no way to write
 * one, and the approval exists only as its row in `approvals`. Decided through `POST
 * /tasks/:taskId/approvals/:approvalId/decide`, which re-checks the digest itself rather than a card's payload.
 *
 * Also read back against the task itself, not only the approval row: `decideTaskApprovalForNode` refuses a
 * decision once the task has left `waiting_approval` (cancelled, already resumed, already settled by expiry), so
 * an approval whose task moved on is not decidable even while its row still reads `pending` - the row alone is
 * a stale echo, not something to offer. A task that no longer exists is left out entirely rather than shown with
 * nowhere to point.
 */
function pendingTaskApprovals(services: InboxServices, now: Instant): WaitingItem[] {
  const rows = allRows<TaskApprovalRow>(
    services.runtime.db,
    `SELECT approval_id, task_id, operation_digest, operation_description, effect_category, requested_at, expires_at
       FROM approvals WHERE task_id IS NOT NULL AND decision = 'pending' AND expires_at > ?
       ORDER BY requested_at`,
    now,
  );
  const items: WaitingItem[] = [];
  for (const row of rows) {
    const task = getTask(services.runtime.db, row.task_id);
    if (task === undefined || task.state !== "waiting_approval") continue;
    items.push({
      kind: "task-approval",
      approvalId: row.approval_id,
      taskId: row.task_id,
      conversationId: task.conversationId,
      description: row.operation_description,
      operationDigest: row.operation_digest,
      effectCategory: row.effect_category as EffectCategory,
      requestedAt: row.requested_at as Instant,
      expiresAt: row.expires_at as Instant,
    });
  }
  return items;
}

/** Questions the agent is waiting on, in conversations that asked one recently enough for it to still be open. */
function pendingQuestions(services: InboxServices, now: Instant): WaitingItem[] {
  const since = new Date(Date.parse(now) - QUESTION_TTL_MS).toISOString();
  const conversations = allRows<{ conversation_id: string }>(
    services.runtime.db,
    `SELECT DISTINCT conversation_id FROM
      (SELECT rowid, conversation_id, created_at, document FROM messages ORDER BY rowid DESC LIMIT ?)
      WHERE created_at >= ? AND document LIKE '%"question-card"%'`,
    RECENT_MESSAGES,
    since,
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

/**
 * Capability approvals an install left open: node-scoped, answered through the same route Settings uses. Read at the
 * inbox's own `now`, like the other two kinds, so all three agree on what is still in time.
 */
function pendingCapabilityApprovals(services: InboxServices, now: Instant): WaitingItem[] {
  return listPendingCapabilityApprovals(services, now).map((approval) => ({
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

/** Everything waiting for the person, oldest request first, so the list reads in the order things were asked. */
export function waitingItems(services: InboxServices, now: Instant): WaitingItem[] {
  return [
    ...pendingCommandApprovals(services, now),
    ...pendingCapabilityApprovals(services, now),
    ...pendingTaskApprovals(services, now),
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
