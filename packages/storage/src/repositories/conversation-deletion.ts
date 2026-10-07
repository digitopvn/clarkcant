import { type Database, inTransaction } from "../db.ts";

/** A stopped turn is not enough: queued, parked and uncertain tasks can still resume. */
export function conversationHasUnsettledWork(db: Database, id: string): boolean {
  return db.prepare("SELECT 1 FROM tasks WHERE conversation_id = ? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(id) !== undefined
    || db.prepare("SELECT 1 FROM effects WHERE task_id IN (SELECT task_id FROM tasks WHERE conversation_id = ?) AND state IN ('prepared','submitted','uncertain') LIMIT 1").get(id) !== undefined
    || db.prepare("SELECT 1 FROM work_runs WHERE conversation_id = ? AND ended_at IS NULL LIMIT 1").get(id) !== undefined
    || db.prepare("SELECT 1 FROM jobs WHERE conversation_id = ? AND status IN ('queued','running','waiting') LIMIT 1").get(id) !== undefined;
}

function requireTransaction(db: Database): void {
  if (!inTransaction(db)) throw new Error("conversation deletion must be atomic");
}

/** The caller owns the transaction, including the attachment and artifact releases. Foreign keys stay enabled. */
export function deleteConversationRows(db: Database, id: string, artifactInstances: readonly string[] = []): void {
  requireTransaction(db);
  if (conversationHasUnsettledWork(db, id)) throw new Error("conversation still has unsettled work");
  const instances = db.prepare(`SELECT instance_id FROM pins WHERE conversation_id = ?
    UNION SELECT instance_id FROM surface_compositions WHERE conversation_id = ?
    UNION SELECT instance_id FROM widget_semantic_state WHERE conversation_id = ?`).all(id, id, id) as {instance_id: string}[];
  const tasks = "SELECT task_id FROM tasks WHERE conversation_id = ?";
  const runs = `SELECT run_id FROM runs WHERE task_id IN (${tasks})`;
  for (const sql of [
    `DELETE FROM approvals WHERE task_id IN (${tasks})`,
    `DELETE FROM evidence WHERE run_id IN (${runs})`,
    `DELETE FROM task_artifacts WHERE task_id IN (${tasks})`,
    `DELETE FROM leases WHERE holder_task_id IN (${tasks})`,
    `DELETE FROM effects WHERE task_id IN (${tasks})`,
    `DELETE FROM runs WHERE task_id IN (${tasks})`,
    `DELETE FROM intent_runs WHERE task_id IN (${tasks})`,
    "DELETE FROM intent_runs WHERE intent_id IN (SELECT intent_id FROM persistent_intents WHERE conversation_id = ?)",
    "DELETE FROM persistent_intents WHERE conversation_id = ?",
    "DELETE FROM presentation_bundles WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)",
    "DELETE FROM widget_snapshots WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)",
    // A channel bound to this conversation is unbound with it; its messages' provider links and receipts go too.
    "DELETE FROM channel_inputs WHERE binding_id IN (SELECT binding_id FROM external_channel_bindings WHERE conversation_id = ?)",
  ]) db.prepare(sql).run(id);
  // Saved memories are independent user resources; remove only conversation-scoped memory.
  db.prepare("DELETE FROM memory_records WHERE conversation_id = ? AND scope = 'conversation'").run(id);
  for (const table of ["tasks", "pins", "messages", "conversation_authority", "surface_compositions", "widget_semantic_state", "session_files", "history_fts", "work_runs", "jobs", "notifications", "peer_allowances", "commands", "external_message_links", "channel_delivery_receipts", "external_channel_bindings"]) {
    db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(id);
  }
  // Events are the append-only audit/replication sequence, not the conversation's mutable storage.
  // Their provenance remains available; deleting the tail could make the next event reuse a peer's sequence.
  for (const instanceId of new Set([...instances.map((row) => row.instance_id), ...artifactInstances])) {
    const kept = db.prepare("SELECT 1 FROM pins WHERE instance_id = ? UNION SELECT 1 FROM surface_compositions WHERE instance_id = ? UNION SELECT 1 FROM widget_snapshots WHERE instance_id = ? LIMIT 1").get(instanceId, instanceId, instanceId);
    if (kept !== undefined || db.prepare("SELECT 1 FROM messages WHERE instr(document, ?) > 0 LIMIT 1").get(instanceId) !== undefined) continue;
    for (const table of ["action_invocations", "action_bindings", "widget_live_owners", "widget_state", "package_uninstall_lifecycles", "widget_instances"]) {
      db.prepare(`DELETE FROM ${table} WHERE instance_id = ?`).run(instanceId);
    }
  }
  db.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(id);
}

export function queueConversationFileCleanup(db: Database, id: string, blobPaths: readonly string[], stagingRefs: readonly string[]): void {
  requireTransaction(db);
  const insert = db.prepare("INSERT OR IGNORE INTO conversation_file_cleanup(kind,path,conversation_id) VALUES (?,?,?)");
  for (const path of blobPaths) insert.run("blob", path, id);
  for (const path of stagingRefs) insert.run("staging", path, id);
}

export function spendConversationDeletePermit(db: Database, input: {permitId: string; principalId: string; conversationId: string; now: string}): boolean {
  requireTransaction(db);
  return Number(db.prepare(`UPDATE conversation_delete_permissions SET consumed_at = ?
    WHERE permit_id = ? AND principal_id = ? AND conversation_id = ? AND consumed_at IS NULL AND expires_at > ?`)
    .run(input.now, input.permitId, input.principalId, input.conversationId, input.now).changes) === 1;
}
