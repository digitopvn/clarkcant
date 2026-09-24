import { randomBytes } from "node:crypto";

import type { Instant } from "@clarkcant/contracts";
import { type Database, getWorkRun, recordWorkRun, setWorkRunState } from "@clarkcant/storage";

import { machineBootId, readProcStartTime } from "./process-tree.ts";
import type { CommandJournal } from "./run-command.ts";
import type { WorkJournal } from "./work-supervisor.ts";

/**
 * The durable half of the supervisor: `work_runs`, written while work runs, read by the next boot.
 *
 * One journal for the three kinds that outlive a turn — background runs, the commands the model ran, and task
 * workers — because the next boot asks one question of all of them ("what did the process before me leave open?")
 * and should not need three tables to answer it.
 *
 * Every write is best-effort. A database that cannot take the row is a database that will not be able to report the
 * run after a restart either, and failing the run itself because of that would turn a lost report into lost work.
 */
export interface NodeWorkJournal extends WorkJournal, CommandJournal {
  /** The id of this node process. Rows with any other value were left by an earlier process. */
  readonly nodeBootId: string;
  /** A task worker started, with the process that runs it. */
  taskStarted(entry: { workId: string; conversationId: string; title: string; pid?: number }): void;
  taskEnded(workId: string, state: "done" | "failed" | "stopped"): void;
}

export function createWorkJournal(deps: {
  db: Database;
  nodeId: string;
  now?: () => Instant;
  /** Fixed in tests; random per process otherwise. */
  nodeBootId?: string;
  /** Read once; undefined off Linux, where a recorded pid can never be proven and is never acted on. */
  machineBootId?: string | undefined;
  procStartTime?: (pid: number) => string | undefined;
}): NodeWorkJournal {
  const now = deps.now ?? ((): Instant => new Date().toISOString() as Instant);
  const nodeBootId = deps.nodeBootId ?? `boot-${randomBytes(8).toString("hex")}`;
  const bootId = "machineBootId" in deps ? deps.machineBootId : machineBootId();

  const attempt = (write: () => void): void => {
    try {
      write();
    } catch {
      // Best-effort, as above.
    }
  };

  const withProcess = (pid: number | undefined, procStartTime?: string) =>
    pid === undefined
      ? {}
      : {
          pid,
          // Each child is its own group leader (`detached`), so its pid is the group id a later sweep signals.
          pgid: pid,
          ...(procStartTime === undefined ? {} : { procStartTime }),
          ...(bootId === undefined ? {} : { machineBootId: bootId }),
        };

  return {
    nodeBootId,

    opened(entry) {
      attempt(() =>
        recordWorkRun(deps.db, {
          workId: entry.workId,
          nodeId: deps.nodeId,
          kind: entry.kind,
          conversationId: entry.conversationId,
          title: entry.title,
          requestText: entry.requestText,
          nodeBootId,
          state: entry.state,
          effectful: entry.effectful,
          attempt: entry.attempt,
          startedAt: entry.startedAt,
        }),
      );
    },

    moved(workId, state, at) {
      attempt(() => setWorkRunState(deps.db, workId, state, at));
    },

    started(entry) {
      attempt(() =>
        recordWorkRun(deps.db, {
          workId: entry.workId,
          nodeId: deps.nodeId,
          kind: "command",
          ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
          // The command line is what a person would recognise; it is already in the conversation's own record.
          title: entry.command.slice(0, 200),
          ...withProcess(entry.pid, entry.procStartTime ?? procStart(entry.pid)),
          nodeBootId,
          state: "running",
          // A command can change anything the person's account can; it is never re-run by a restart.
          effectful: true,
          attempt: 0,
          startedAt: now(),
        }),
      );
    },

    ended(workId, state) {
      attempt(() => setWorkRunState(deps.db, workId, state, now()));
    },

    taskStarted(entry) {
      attempt(() => {
        const existing = getWorkRun(deps.db, entry.workId);
        recordWorkRun(deps.db, {
          workId: entry.workId,
          nodeId: deps.nodeId,
          kind: "task",
          conversationId: entry.conversationId,
          title: entry.title.slice(0, 200),
          ...withProcess(entry.pid, procStart(entry.pid)),
          nodeBootId,
          state: "running",
          effectful: true,
          attempt: existing?.attempt ?? 0,
          startedAt: now(),
        });
      });
    },

    taskEnded(workId, state) {
      attempt(() => setWorkRunState(deps.db, workId, state, now()));
    },
  };

  function procStart(pid: number | undefined): string | undefined {
    if (pid === undefined) return undefined;
    return (deps.procStartTime ?? ((id: number) => readProcStartTime(id)))(pid);
  }
}
