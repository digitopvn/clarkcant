import {
  type Instant,
  type SurfaceCompositionSpec,
  surfaceCompositionSpecSchema,
} from "@clarkcant/contracts";

import { type Database, oneRow, parseJson, toJson } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Composed surfaces
 * ------------------------------------------------------------------ */

/**
 * Record the compiled layout document behind a composed surface.
 *
 * The document is parsed on the way in as well as on the way out. A spec that is only
 * validated when it is read means a corrupt write is discovered by a user looking at a broken
 * surface rather than by the writer that produced it.
 */
export function insertSurfaceComposition(
  db: Database,
  input: {
    composition: SurfaceCompositionSpec;
    ownerPrincipalId: string;
    messageId: string;
    conversationId: string;
    at: Instant;
  },
): void {
  const spec = surfaceCompositionSpecSchema.parse(input.composition);
  db.prepare(
    `INSERT INTO surface_compositions
       (composition_id, instance_id, owner_principal_id, message_id, conversation_id, template_id,
        template_version, catalog_digest, section_count, document, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spec.compositionId,
    spec.instanceId,
    input.ownerPrincipalId,
    input.messageId,
    input.conversationId,
    spec.templateId,
    spec.templateVersion,
    spec.catalogDigest,
    spec.sections.length,
    toJson(spec),
    input.at,
  );
}

/**
 * Read a composition for one principal.
 *
 * The principal is part of the query rather than a check the caller is trusted to make. A
 * composed surface can hold private rows, so a lookup that returns it and leaves authorization
 * to the caller is a lookup that will eventually be called without one.
 */
export function getSurfaceComposition(
  db: Database,
  compositionId: string,
  principalId: string,
): SurfaceCompositionSpec | undefined {
  const row = oneRow<{ document: string }>(
    db,
    "SELECT document FROM surface_compositions WHERE composition_id = ? AND owner_principal_id = ?",
    compositionId,
    principalId,
  );
  return row === undefined
    ? undefined
    : surfaceCompositionSpecSchema.parse(parseJson<unknown>(row.document, "surface_compositions.document"));
}

/** The composition a message produced, if any. The idempotency key for a replayed turn. */
export function findCompositionByMessage(
  db: Database,
  messageId: string,
  principalId: string,
): SurfaceCompositionSpec | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM surface_compositions
      WHERE message_id = ? AND owner_principal_id = ?
      ORDER BY created_at DESC LIMIT 1`,
    messageId,
    principalId,
  );
  return row === undefined
    ? undefined
    : surfaceCompositionSpecSchema.parse(parseJson<unknown>(row.document, "surface_compositions.document"));
}

export function findCompositionByInstance(
  db: Database,
  instanceId: string,
  principalId: string,
): SurfaceCompositionSpec | undefined {
  const row = oneRow<{ document: string }>(
    db,
    `SELECT document FROM surface_compositions
      WHERE instance_id = ? AND owner_principal_id = ?
      ORDER BY created_at DESC LIMIT 1`,
    instanceId,
    principalId,
  );
  return row === undefined
    ? undefined
    : surfaceCompositionSpecSchema.parse(parseJson<unknown>(row.document, "surface_compositions.document"));
}
