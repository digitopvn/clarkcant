import { createHash, randomUUID } from "node:crypto";
import type {
  AppIntent,
  AppIntentDecision,
  AppIntentLocale,
  ConfirmationToken,
  ConversationDeletionResult,
  Instant,
} from "@clarkcant/contracts";
import { describeAppIntent } from "@clarkcant/contracts";
import { decideExecution, readExecutionPolicy } from "@clarkcant/core";
import { type Database, appendAuditEvent, conversationHasUnsettledWork, deleteConversationRows, getConversation, listArtifactsForConversation, queueConversationFileCleanup, spendConversationDeletePermit, transaction } from "@clarkcant/storage";
import { releaseConversationAttachments } from "../attachments.ts";
import { releaseConversationArtifacts } from "../artifact-broker.ts";
import { sweepConversationFileCleanup } from "../conversation-file-cleanup.ts";
import { conversationActionRunning } from "./action-runs.ts";

export interface ConversationDeletionDeps {
  db: Database;
  nodeId: string;
  principalId: string;
  now: () => Instant;
  runningConversations?: () => readonly string[];
}

export function deletionRefusal(locale: AppIntentLocale, reason: "missing" | "busy" | "denied" | "permit" | "failed"): string {
  const messages = {
    missing: ["Hội thoại không có trên node này. Không xoá dữ liệu nào; hãy mở hội thoại trên node gốc.", "This conversation is not on this node. Nothing was removed; open it on its home node."],
    busy: ["Hội thoại còn công việc chưa kết thúc hoặc kết quả chưa xác định. Mọi dữ liệu được giữ lại; hãy hoàn tất, huỷ hoặc đối soát công việc đó rồi thử lại.", "This conversation has unfinished work or an uncertain outcome. All data is kept; finish, cancel or reconcile that work, then try again."],
    denied: ["Policy từ chối xoá hội thoại. Mọi dữ liệu được giữ lại; kiểm tra Settings → Control nếu muốn thay đổi policy.", "The policy refuses conversation deletion. All data is kept; review Settings → Control if you want to change the policy."],
    permit: ["Quyền xoá không đúng hội thoại, đã dùng hoặc quá hạn. Mọi dữ liệu được giữ lại; hãy yêu cầu xoá lại.", "The deletion permission is for another conversation, spent or expired. All data is kept; ask to delete again."],
    failed: ["Không xoá được hội thoại. Transaction đã giữ nguyên dữ liệu và tệp; hãy thử lại.", "The conversation could not be deleted. The transaction preserved its data and files; try again."],
  } as const;
  return messages[reason][locale === "vi" ? 0 : 1];
}

/** Shared by typed/voice intent resolution and REST; current policy is also checked at execution. */
export function decideConversationDeletion(deps: ConversationDeletionDeps, id: string, locale: AppIntentLocale) {
  const conversation = getConversation(deps.db, id);
  if (conversation === undefined || conversation.homeNodeId !== deps.nodeId) return {kind: "refused" as const, say: deletionRefusal(locale, "missing")};
  const busy = conversationHasUnsettledWork(deps.db, id)
    || conversationActionRunning(id)
    || deps.runningConversations?.().includes(id);
  if (busy) return {kind: "refused" as const, say: deletionRefusal(locale, "busy")};
  const policy = readExecutionPolicy({db: deps.db, now: deps.now}, deps.principalId);
  const operationDigest = createHash("sha256").update(`conversation-delete:${id}`).digest("hex");
  const decision = decideExecution({policy, action: {kind: "effect", category: "destructive", operationDigest: operationDigest as never}, intent: {kind: "interactive"}});
  return decision.kind === "deny" ? {kind: "refused" as const, say: deletionRefusal(locale, "denied")} : decision;
}

/** Called only after the existing person-owned app-intent confirmation was granted. */
export function grantConversationDeletion(deps: ConversationDeletionDeps, intent: AppIntent, locale: AppIntentLocale): AppIntentDecision {
  const id = intent.conversationId;
  if (id === undefined) return {kind: "refused", say: deletionRefusal(locale, "missing")};
  const current = decideConversationDeletion(deps, id, locale);
  if (current.kind === "refused") return current;
  const permitId = randomUUID();
  deps.db.prepare("INSERT INTO conversation_delete_permissions(permit_id,principal_id,conversation_id,expires_at) VALUES (?,?,?,?)")
    .run(permitId, deps.principalId, id, new Date(Date.parse(deps.now()) + 120_000).toISOString());
  return {kind: "intent", intent: {...intent, deletionPermit: permitId}, requiresConfirmation: false, readBack: describeAppIntent(intent, locale)};
}

/** No awaits: activity/policy check, permit spend and all database deletion are one synchronous writer operation. */
export function deleteConversation(deps: ConversationDeletionDeps & {dataDir: string}, input: {conversationId: string; deletionPermit?: string; locale: AppIntentLocale; mint: (intent: AppIntent) => ConfirmationToken}): ConversationDeletionResult {
  const {conversationId: id, locale} = input;
  const current = decideConversationDeletion(deps, id, locale);
  if (current.kind === "refused") return {deleted: false, decision: current};
  const intent: AppIntent = {kind: "conversation.delete", conversationId: id};
  if (current.kind === "ask" && input.deletionPermit === undefined) {
    return {deleted: false, decision: {kind: "needs-confirmation", intent, confirmationToken: input.mint(intent), readBack: describeAppIntent(intent, locale)}};
  }
  let attachments = 0;
  let artifacts = 0;
  try {
    transaction(deps.db, () => {
      if (input.deletionPermit !== undefined && !spendConversationDeletePermit(deps.db, {permitId: input.deletionPermit, principalId: deps.principalId, conversationId: id, now: deps.now()})) throw new Error("DELETE_PERMISSION_INVALID");
      const releaseDeps = {
        ...deps,
        conversationId: id,
        deferFiles: (paths: readonly string[], refs: readonly string[]) => queueConversationFileCleanup(deps.db, id, paths, refs),
      };
      const artifactInstances = listArtifactsForConversation(deps.db, id).map((record) => record.instanceId);
      attachments = releaseConversationAttachments(releaseDeps).removed;
      artifacts = releaseConversationArtifacts(releaseDeps).removed;
      deleteConversationRows(deps.db, id, artifactInstances);
      appendAuditEvent(deps.db, {auditId: `audit_${randomUUID()}`, principalId: deps.principalId, nodeId: deps.nodeId, kind: "interaction", summary: "Deleted conversation and released its attachments and widget files", outcome: "done", at: deps.now(), ref: id});
    });
  } catch (error) {
    return {deleted: false, decision: {kind: "refused", say: deletionRefusal(locale, error instanceof Error && error.message === "DELETE_PERMISSION_INVALID" ? "permit" : "failed")}};
  }
  // A file lock must never turn a committed deletion into a claim that all rows were restored.
  try { sweepConversationFileCleanup(deps); } catch { /* Durable rows are retried by the artifact sweep. */ }
  const pendingFiles = Number((deps.db.prepare("SELECT count(*) AS n FROM conversation_file_cleanup WHERE conversation_id = ?").get(id) as {n: number}).n);
  const kept = locale === "vi"
    ? "Bộ nhớ đã lưu, tài nguyên dùng chung, nhật ký phiên và lịch sử kiểm toán được giữ lại. Bạn có thể bắt đầu hội thoại mới."
    : "Saved memory, shared resources, session logs and audit history are kept. You can start a new conversation.";
  const pendingNotice = pendingFiles > 0
    ? locale === "vi"
      ? `${pendingFiles} tệp đang chờ dọn lại khi hết khoá. `
      : `${pendingFiles} ${pendingFiles === 1 ? "file is" : "files are"} queued for cleanup after their locks clear. `
    : "";
  const readBack = locale === "vi"
    ? `Đã xoá hội thoại, ${attachments} tệp đính kèm và ${artifacts} tệp widget. ${pendingNotice}${kept}`
    : `Deleted the conversation, ${attachments} ${attachments === 1 ? "attachment" : "attachments"} and ${artifacts} widget ${artifacts === 1 ? "file" : "files"}. ${pendingNotice}${kept}`;
  return {deleted: true, conversationId: id, attachments, artifacts, pendingFiles, readBack};
}
