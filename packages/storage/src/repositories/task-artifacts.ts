import type { Instant } from "@clarkcant/contracts";

import { type Database, allRows, oneRow } from "../db.ts";

/* ------------------------------------------------------------------ *
 * Task artifacts: files a task handed to a paired node brought back
 * ------------------------------------------------------------------ */

/**
 * `offered` is written by the node that ran the task, for the node that handed it over; `received` by the node that
 * handed it over, for what it was offered.
 */
export type TaskArtifactDirection = "offered" | "received";

/**
 * An offered file stays `offered`. A received one is `accepted` or `refused` when the offer is decided, then `received`
 * once its bytes arrived and matched their digest, or `failed` when they did not.
 */
export type TaskArtifactState = "offered" | "accepted" | "refused" | "received" | "failed";

export interface TaskArtifact {
  taskId: string;
  direction: TaskArtifactDirection;
  /** The id the offering node gave the file. */
  peerArtifactId: string;
  /** The other node: the one offered to, or the one that offered. */
  peerNodeId: string;
  /** The local artifact the bytes became, once received. */
  artifactId?: string;
  /** The file's name, relative to the folder the task wrote it in. */
  name: string;
  digest: string;
  sizeBytes: number;
  mimeType: string;
  state: TaskArtifactState;
  /** Why it was refused or failed. */
  reason?: string;
  createdAt: Instant;
  updatedAt: Instant;
}

interface TaskArtifactRow {
  task_id: string;
  direction: TaskArtifactDirection;
  peer_artifact_id: string;
  peer_node_id: string;
  artifact_id: string | null;
  name: string;
  digest: string;
  size_bytes: number;
  mime_type: string;
  state: TaskArtifactState;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: TaskArtifactRow): TaskArtifact {
  return {
    taskId: row.task_id,
    direction: row.direction,
    peerArtifactId: row.peer_artifact_id,
    peerNodeId: row.peer_node_id,
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
    name: row.name,
    digest: row.digest,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    state: row.state,
    ...(row.reason === null ? {} : { reason: row.reason }),
    createdAt: row.created_at as Instant,
    updatedAt: row.updated_at as Instant,
  };
}

/**
 * Write a task's file the first time it is seen. Answers whether it was written: the same file offered or received
 * again keeps the row it already has, so a repeated offer never changes a decision already made.
 */
export function insertTaskArtifact(
  db: Database,
  input: Omit<TaskArtifact, "createdAt" | "updatedAt" | "artifactId"> & { at: Instant },
): boolean {
  const result = db
    .prepare(
      `INSERT INTO task_artifacts (task_id, direction, peer_artifact_id, peer_node_id, artifact_id, name, digest, size_bytes,
         mime_type, state, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, direction, peer_artifact_id) DO NOTHING`,
    )
    .run(
      input.taskId,
      input.direction,
      input.peerArtifactId,
      input.peerNodeId,
      input.name,
      input.digest,
      input.sizeBytes,
      input.mimeType,
      input.state,
      input.reason ?? null,
      input.at,
      input.at,
    );
  return Number(result.changes) > 0;
}

export function getTaskArtifact(
  db: Database,
  taskId: string,
  direction: TaskArtifactDirection,
  peerArtifactId: string,
): TaskArtifact | undefined {
  const row = oneRow<TaskArtifactRow>(
    db,
    "SELECT * FROM task_artifacts WHERE task_id = ? AND direction = ? AND peer_artifact_id = ?",
    taskId,
    direction,
    peerArtifactId,
  );
  return row === undefined ? undefined : fromRow(row);
}

/** A task's files on one side, in the order they were first seen. */
export function listTaskArtifacts(db: Database, taskId: string, direction: TaskArtifactDirection): TaskArtifact[] {
  return allRows<TaskArtifactRow>(
    db,
    "SELECT * FROM task_artifacts WHERE task_id = ? AND direction = ? ORDER BY created_at, rowid",
    taskId,
    direction,
  ).map(fromRow);
}

/** Received files whose offer was accepted and whose bytes have not arrived yet, oldest first. */
export function listAcceptedTaskArtifacts(db: Database): TaskArtifact[] {
  return allRows<TaskArtifactRow>(
    db,
    "SELECT * FROM task_artifacts WHERE direction = 'received' AND state = 'accepted' ORDER BY created_at, rowid",
  ).map(fromRow);
}

/**
 * Move a received file on from `accepted`: to `received` with the artifact its bytes became, or to `failed` with why.
 * Only from `accepted`, so a file is settled once however many fetches of it finish. Answers whether it moved.
 */
export function settleReceivedTaskArtifact(
  db: Database,
  input: { taskId: string; peerArtifactId: string; at: Instant } & (
    | { state: "received"; artifactId: string }
    | { state: "failed"; reason: string }
  ),
): boolean {
  const result = db
    .prepare(
      `UPDATE task_artifacts SET state = ?, artifact_id = ?, reason = ?, updated_at = ?
        WHERE task_id = ? AND direction = 'received' AND peer_artifact_id = ? AND state = 'accepted'`,
    )
    .run(
      input.state,
      input.state === "received" ? input.artifactId : null,
      input.state === "failed" ? input.reason : null,
      input.at,
      input.taskId,
      input.peerArtifactId,
    );
  return Number(result.changes) > 0;
}

/** Whether this node offered a file with this digest to that peer: the only files that peer may fetch from here. */
export function offeredToPeer(db: Database, peerNodeId: string, digest: string): boolean {
  return (
    oneRow<{ one: number }>(
      db,
      "SELECT 1 AS one FROM task_artifacts WHERE peer_node_id = ? AND digest = ? AND direction = 'offered' LIMIT 1",
      peerNodeId,
      digest,
    ) !== undefined
  );
}
