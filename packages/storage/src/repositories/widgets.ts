import {
  type Instant,
  type Pin,
  type WidgetInstance,
  type WidgetSnapshot,
  widgetSnapshotSchema,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Widgets and pins
 * ------------------------------------------------------------------ */

export function upsertWidgetInstance(db: Database, instance: WidgetInstance, updatedAt: Instant): void {
  db.prepare(
    `INSERT INTO widget_instances
       (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
        revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance_id) DO UPDATE SET
       revision = excluded.revision,
       presentation_revision = excluded.presentation_revision,
       data_revision = excluded.data_revision,
       action_binding_revision = excluded.action_binding_revision,
       lifecycle = excluded.lifecycle,
       document = excluded.document,
       updated_at = excluded.updated_at`,
  ).run(
    instance.instanceId,
    instance.definitionRef.id,
    instance.definitionRef.version,
    instance.definitionRef.packageDigest,
    instance.ownerNodeId,
    instance.ownerPrincipalId,
    instance.revision,
    instance.presentationRevision,
    instance.dataRevision,
    instance.actionBindingRevision,
    instance.lifecycle,
    toJson(instance),
    updatedAt,
  );
}

export function getWidgetInstance(db: Database, instanceId: string): WidgetInstance | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM widget_instances WHERE instance_id = ?",
    instanceId,
  );
  return row === undefined ? undefined : parseJson<WidgetInstance>(row.document, "widget_instances.document");
}

export function createPin(db: Database, pin: Pin): void {
  db.prepare(
    `INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, background_grant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pin.pinId,
    pin.conversationId,
    pin.instanceId,
    pin.displayMode,
    pin.position,
    pin.refreshPolicy,
    pin.backgroundGrantId ?? null,
    pin.createdAt,
  );
}

export function listPins(db: Database, conversationId: string): Pin[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM pins WHERE conversation_id = ? ORDER BY position",
    conversationId,
  );
  return rows.map((row) => ({
    pinId: String(row.pin_id) as Pin["pinId"],
    conversationId: String(row.conversation_id) as Pin["conversationId"],
    instanceId: String(row.instance_id) as Pin["instanceId"],
    displayMode: String(row.display_mode) as Pin["displayMode"],
    position: Number(row.position),
    refreshPolicy: String(row.refresh_policy) as Pin["refreshPolicy"],
    ...(row.background_grant_id === null
      ? {}
      : { backgroundGrantId: String(row.background_grant_id) }),
    createdAt: String(row.created_at) as Pin["createdAt"],
  }));
}

export function deletePin(db: Database, pinId: string): boolean {
  const result = db.prepare("DELETE FROM pins WHERE pin_id = ?").run(pinId);
  return Number(result.changes) > 0;
}

/**
 * The snapshots a message captured, oldest first.
 *
 * History is read from these rather than from the instance's current props: a snapshot is what the
 * user saw, and re-deriving it from the live row is how a transcript silently rewrites itself.
 */
export function listSnapshotsForMessage(db: Database, messageId: string): WidgetSnapshot[] {
  const rows = allRows<{ document: string; stale: number }>(
    db,
    "SELECT document, stale FROM widget_snapshots WHERE message_id = ? ORDER BY captured_at ASC",
    messageId,
  );
  return rows.map((row) => {
    const parsed = widgetSnapshotSchema.parse(parseJson<unknown>(row.document, "widget_snapshots.document"));
    // The column wins over the stored document. Staleness is the one field that changes after a
    // snapshot is written, and a reader that trusted the document would report history as current
    // for as long as nothing rewrote the whole row.
    return { ...parsed, stale: Number(row.stale) === 1 };
  });
}
