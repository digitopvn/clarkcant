import type { Instant } from "@clarkcant/contracts";

import { type Database, allRows, oneRow } from "../db.ts";

/**
 * The durable record of work a node started on the person's behalf.
 *
 * Not the list a person reads — that is held in memory by the runtime, because what is running now belongs to the
 * process running it. This is what survives the process: enough to tell the next boot that a request was left
 * unfinished and in which conversation, and enough to find and prove the identity of a process group an earlier
 * process left behind.
 */
export type WorkRunKind = "background" | "command" | "task";
export type WorkRunState = "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

export interface WorkRunRecord {
  workId: string;
  nodeId: string;
  kind: WorkRunKind;
  conversationId?: string;
  title: string;
  /** What a re-run would ask again. Background work only; a command is never re-run from here. */
  requestText?: string;
  pid?: number;
  pgid?: number;
  /** The kernel's start time for `pid`, which is what makes the pid safe to act on later. */
  procStartTime?: string;
  /** The machine boot the pid belongs to. A pid from another boot names nothing. */
  machineBootId?: string;
  /** The node process that wrote the row, so a boot can tell its own rows from an earlier process's. */
  nodeBootId: string;
  state: WorkRunState;
  /** Whether the work could have changed anything outside this node. Only effect-free work is ever re-run. */
  effectful: boolean;
  /** How many times this work has been re-run after a restart. */
  attempt: number;
  startedAt: Instant;
  endedAt?: Instant;
}

interface WorkRunRow {
  work_id: string;
  node_id: string;
  kind: string;
  conversation_id: string | null;
  title: string;
  request_text: string | null;
  pid: number | null;
  pgid: number | null;
  proc_start_time: string | null;
  machine_boot_id: string | null;
  node_boot_id: string;
  state: string;
  effectful: number;
  attempt: number;
  started_at: string;
  ended_at: string | null;
}

function fromRow(row: WorkRunRow): WorkRunRecord {
  return {
    workId: row.work_id,
    nodeId: row.node_id,
    kind: row.kind as WorkRunKind,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    title: row.title,
    ...(row.request_text === null ? {} : { requestText: row.request_text }),
    ...(row.pid === null ? {} : { pid: Number(row.pid) }),
    ...(row.pgid === null ? {} : { pgid: Number(row.pgid) }),
    ...(row.proc_start_time === null ? {} : { procStartTime: row.proc_start_time }),
    ...(row.machine_boot_id === null ? {} : { machineBootId: row.machine_boot_id }),
    nodeBootId: row.node_boot_id,
    state: row.state as WorkRunState,
    effectful: Number(row.effectful) === 1,
    attempt: Number(row.attempt),
    startedAt: row.started_at as Instant,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at as Instant }),
  };
}

/** Write a run as it is now, replacing what an earlier write said about the same work id. */
export function recordWorkRun(db: Database, run: WorkRunRecord): void {
  db.prepare(
    `INSERT INTO work_runs (work_id, node_id, kind, conversation_id, title, request_text, pid, pgid, proc_start_time,
       machine_boot_id, node_boot_id, state, effectful, attempt, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_id) DO UPDATE SET
       conversation_id = excluded.conversation_id, title = excluded.title, request_text = excluded.request_text,
       pid = excluded.pid, pgid = excluded.pgid, proc_start_time = excluded.proc_start_time,
       machine_boot_id = excluded.machine_boot_id, node_boot_id = excluded.node_boot_id, state = excluded.state,
       effectful = excluded.effectful, attempt = excluded.attempt, started_at = excluded.started_at,
       ended_at = excluded.ended_at`,
  ).run(
    run.workId,
    run.nodeId,
    run.kind,
    run.conversationId ?? null,
    run.title,
    run.requestText ?? null,
    run.pid ?? null,
    run.pgid ?? null,
    run.procStartTime ?? null,
    run.machineBootId ?? null,
    run.nodeBootId,
    run.state,
    run.effectful ? 1 : 0,
    run.attempt,
    run.startedAt,
    run.endedAt ?? null,
  );
}

/** Move a run to a new state. Ending states carry the time they ended; `running` clears it. */
export function setWorkRunState(db: Database, workId: string, state: WorkRunState, at: Instant): void {
  const ended = state === "queued" || state === "running" ? null : at;
  db.prepare("UPDATE work_runs SET state = ?, ended_at = ? WHERE work_id = ?").run(state, ended, workId);
}

export function getWorkRun(db: Database, workId: string): WorkRunRecord | undefined {
  const row = oneRow<WorkRunRow>(db, "SELECT * FROM work_runs WHERE work_id = ?", workId);
  return row === undefined ? undefined : fromRow(row);
}

/**
 * Work an earlier process of this node left queued or running.
 *
 * Oldest first, so what the next boot reports into a conversation reads in the order it was asked for.
 */
export function unfinishedWorkRuns(db: Database, nodeId: string, currentNodeBootId: string): WorkRunRecord[] {
  return allRows<WorkRunRow>(
    db,
    `SELECT * FROM work_runs WHERE node_id = ? AND node_boot_id <> ? AND state IN ('queued','running')
     ORDER BY started_at ASC`,
    nodeId,
    currentNodeBootId,
  ).map(fromRow);
}

/**
 * Drop ended runs older than a cutoff, answering how many.
 *
 * The outcome of a run is a message in its conversation; this table only has to remember long enough for the next
 * boot to report what was left unfinished, so ended rows are not kept for ever.
 */
export function pruneWorkRuns(db: Database, endedBefore: Instant): number {
  const result = db.prepare("DELETE FROM work_runs WHERE ended_at IS NOT NULL AND ended_at < ?").run(endedBefore);
  return Number(result.changes);
}
