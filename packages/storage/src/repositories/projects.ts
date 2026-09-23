import {
  type Instant,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson, transaction } from "../db.ts";
import { toMatchExpression } from "./history.ts";

/* ------------------------------------------------------------------ *
 * Project index
 * ------------------------------------------------------------------ */

export type ProjectKind = "code" | "docs" | "media" | "generic";

export interface ProjectRecord {
  projectId: string;
  nodeId: string;
  /** Absolute path. The only place an absolute path is stored; it never leaves the node. */
  path: string;
  name: string;
  aliases: string[];
  gitRemote: string | undefined;
  markers: string[];
  kind: ProjectKind;
  mtime: number;
  lastUsedAt: string | undefined;
  indexedAt: string;
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  const parsed = (value: unknown, column: string): string[] => parseJson<string[]>(value, column);
  return {
    projectId: String(row.project_id),
    nodeId: String(row.node_id),
    path: String(row.path),
    name: String(row.name),
    aliases: parsed(row.aliases, "project_index.aliases"),
    gitRemote: row.git_remote === null ? undefined : String(row.git_remote),
    markers: parsed(row.markers, "project_index.markers"),
    kind: String(row.kind) as ProjectKind,
    mtime: Number(row.mtime),
    lastUsedAt: row.last_used_at === null ? undefined : String(row.last_used_at),
    indexedAt: String(row.indexed_at),
  };
}

/**
 * Insert or update one indexed directory.
 *
 * `last_used_at` is preserved on conflict: a refresh is not a use, and resetting it would erase the
 * one signal that says which of two similarly named projects the user actually works in.
 */
export function upsertProject(db: Database, project: ProjectRecord): void {
  transaction(db, () => {
    db.prepare(
      `INSERT INTO project_index
         (project_id, node_id, path, name, aliases, git_remote, markers, kind, mtime, last_used_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         name = excluded.name,
         aliases = excluded.aliases,
         git_remote = excluded.git_remote,
         markers = excluded.markers,
         kind = excluded.kind,
         mtime = excluded.mtime,
         indexed_at = excluded.indexed_at`,
    ).run(
      project.projectId,
      project.nodeId,
      project.path,
      project.name,
      toJson(project.aliases),
      project.gitRemote ?? null,
      toJson(project.markers),
      project.kind,
      project.mtime,
      project.lastUsedAt ?? null,
      project.indexedAt,
    );

    // The FTS row is replaced rather than updated, because a renamed project must stop matching its
    // old name; leaving the old row behind would return a directory that no longer exists.
    db.prepare("DELETE FROM project_fts WHERE project_id = ?").run(project.projectId);
    db.prepare(
      `INSERT INTO project_fts (name, aliases, path, kind, project_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(project.name, project.aliases.join(" "), project.path, project.kind, project.projectId);
  });
}

export function getProject(db: Database, projectId: string): ProjectRecord | undefined {
  const row = oneRow<Record<string, unknown>>(db, "SELECT * FROM project_index WHERE project_id = ?", projectId);
  return row === undefined ? undefined : mapProject(row);
}

export function findProjectByPath(db: Database, nodeId: string, path: string): ProjectRecord | undefined {
  const row = oneRow<Record<string, unknown>>(
    db,
    "SELECT * FROM project_index WHERE node_id = ? AND path = ?",
    nodeId,
    path,
  );
  return row === undefined ? undefined : mapProject(row);
}

export function listProjects(db: Database, nodeId: string, limit = 500): ProjectRecord[] {
  const rows = allRows<Record<string, unknown>>(
    db,
    "SELECT * FROM project_index WHERE node_id = ? ORDER BY last_used_at DESC NULLS LAST, name LIMIT ?",
    nodeId,
    limit,
  );
  return rows.map(mapProject);
}

export interface ProjectMatch {
  project: ProjectRecord;
  /** BM25, lower is better. Undefined for a match that came from an exact alias. */
  score: number | undefined;
  how: "alias" | "search";
}

/**
 * Find projects by name, path or alias.
 *
 * FTS5 for the words and an exact alias match first, because "agentkit" is a name somebody used, not
 * a word to be ranked against every other name that contains the letters.
 */
export function searchProjects(db: Database, nodeId: string, text: string, limit = 8): ProjectMatch[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  const matches: ProjectMatch[] = [];
  const seen = new Set<string>();

  const aliasRows = allRows<Record<string, unknown>>(
    db,
    `SELECT * FROM project_index
      WHERE node_id = ?
        AND (name = ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM json_each(project_index.aliases) WHERE json_each.value = ? COLLATE NOCASE))
      LIMIT ?`,
    nodeId,
    trimmed,
    trimmed,
    limit,
  );
  for (const row of aliasRows) {
    const project = mapProject(row);
    matches.push({ project, score: undefined, how: "alias" });
    seen.add(project.projectId);
  }

  const match = toMatchExpression(trimmed);
  if (match === "") return matches;

  // Joined against project_index in one query rather than one getProject() call per FTS
  // hit: a text search over a large index would otherwise cost N+1 round trips.
  const searchRows = allRows<Record<string, unknown> & { score: number }>(
    db,
    `SELECT project_index.*, bm25(project_fts) AS score
       FROM project_fts
       JOIN project_index ON project_index.project_id = project_fts.project_id
      WHERE project_fts MATCH ?
        AND project_index.node_id = ?
      ORDER BY score
      LIMIT ?`,
    match,
    nodeId,
    limit * 2,
  );
  for (const row of searchRows) {
    const project = mapProject(row);
    if (seen.has(project.projectId)) continue;
    matches.push({ project, score: Number(row.score), how: "search" });
    seen.add(project.projectId);
  }

  return matches.slice(0, limit);
}

/** Record that a project was used, which is what breaks a tie between similar names. */
export function touchProjectUse(db: Database, projectId: string, at: Instant): boolean {
  const result = db.prepare("UPDATE project_index SET last_used_at = ? WHERE project_id = ?").run(at, projectId);
  return Number(result.changes) > 0;
}

/**
 * Remove indexed projects that are no longer on disk.
 *
 * Takes the paths that survived a scan rather than a cutoff time: a directory can be scanned and
 * removed in the same pass, and a time-based prune would keep whichever answer came last.
 */
export function pruneProjects(db: Database, nodeId: string, survivingPaths: readonly string[]): number {
  return transaction(db, () => {
    const existing = listProjects(db, nodeId, 10_000);
    const keep = new Set(survivingPaths);
    let removed = 0;
    for (const project of existing) {
      if (keep.has(project.path)) continue;
      db.prepare("DELETE FROM project_fts WHERE project_id = ?").run(project.projectId);
      db.prepare("DELETE FROM project_index WHERE project_id = ?").run(project.projectId);
      removed += 1;
    }
    return removed;
  });
}

export function projectIndexStats(db: Database, nodeId: string): { total: number; kinds: Record<string, number> } {
  const rows = allRows<{ kind: string; n: number }>(
    db,
    "SELECT kind, COUNT(*) AS n FROM project_index WHERE node_id = ? GROUP BY kind",
    nodeId,
  );
  const kinds: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    kinds[row.kind] = Number(row.n);
    total += Number(row.n);
  }
  return { total, kinds };
}
