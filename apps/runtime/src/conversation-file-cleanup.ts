import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Database, blobStillReferenced, inTransaction } from "@clarkcant/storage";
import { removeBlob, removeStagedBlob, stagingDir } from "./blobs.ts";

/** Durable post-commit cleanup. Failed unlinks stay queued for the next sweep or start. */
export function sweepConversationFileCleanup(deps: {db: Database; dataDir: string}): {pending: number} {
  if (inTransaction(deps.db)) throw new Error("file cleanup must wait for commit");
  const rows = deps.db.prepare("SELECT kind,path FROM conversation_file_cleanup").all() as {kind: "blob" | "staging"; path: string}[];
  for (const row of rows) {
    const shared = row.kind === "blob" && blobStillReferenced(deps.db, row.path);
    const path = row.kind === "blob" ? row.path : join(stagingDir(deps.dataDir), row.path);
    const removed = shared || !existsSync(path) || (row.kind === "blob"
      ? removeBlob({...deps, blobPath: row.path}) : removeStagedBlob({...deps, stagingRef: row.path}));
    if (removed) deps.db.prepare("DELETE FROM conversation_file_cleanup WHERE kind = ? AND path = ?").run(row.kind, row.path);
  }
  return {pending: Number((deps.db.prepare("SELECT count(*) AS n FROM conversation_file_cleanup").get() as {n: number}).n)};
}
