import { nowInstant } from "@clarkcant/contracts";
import { appendAuditEvent } from "@clarkcant/storage";
import type { Database } from "@clarkcant/storage";

import { stopRunningCommands } from "../run-command.ts";
import { nodeWork } from "../work-supervisor.ts";

/**
 * The emergency stop.
 *
 * It kills rather than asks, because the point of a stop is that it works on something that is not listening. The
 * order is the order of reach: a child process is the one thing that outlives this node's turn, then the turns
 * themselves, then the background workers nobody is awaiting.
 *
 * A flow rather than parsing, which is why it lives here: it reaches into three different owners of running work
 * and writes the audit row itself. The route only turns the report into a status.
 */
export interface EmergencyStopDeps {
  db: Database;
  ownerPrincipalId: string;
  nodeId: string;
  newId: (prefix: string) => string;
  /** Absent on a node with no turns to control, which is a report of zero rather than an error. */
  turnControl?:
    | {
        running(): string[];
        interrupt(conversationId: string): boolean;
        stopBackgroundSessions?: () => Promise<number>;
      }
    | undefined;
  /** Absent on a fixture node, which spawns no workers to kill. */
  taskDispatch?: { stopAll(): number } | undefined;
  /** The terminals opened in the conversation. A shell is running work too, and a stop that left it running would not be one. */
  terminals?: { stopAll(): number } | undefined;
  /** The background lane. Defaults to the node's supervisor; a test passes its own. */
  work?: { cancelBackground(reason?: "stopped" | "shutdown"): number };
  /**
   * Why everything is being stopped. A person's stop is `stopped`, and each background run says so in its conversation;
   * a shutdown is `shutdown`, which leaves the report of what was interrupted to the next boot.
   */
  reason?: "stop" | "shutdown";
}

export interface EmergencyStopReport {
  commands: number;
  turns: number;
  background: number;
  tasks: number;
  terminals: number;
}

export async function performEmergencyStop(deps: EmergencyStopDeps): Promise<EmergencyStopReport> {
  const shutdown = deps.reason === "shutdown";
  const commands = stopRunningCommands();
  // The supervisor first: it owns the queue, and a queued request left behind would start the moment a place freed.
  let background = (deps.work ?? nodeWork()).cancelBackground(shutdown ? "shutdown" : "stopped");
  const control = deps.turnControl;
  let turns = 0;
  if (control !== undefined) {
    for (const runningIn of control.running()) {
      if (control.interrupt(runningIn)) turns += 1;
    }
    // SAFETY: the stop is optional on the control object because a node can be built without background workers at
    // all; reading it through a narrow shape keeps every other caller of `control` typed as it was.
    // The supervisor's abort already reaches each worker; this is the backstop for one that was started around it, and
    // the count is whichever saw more so a worker is not counted twice.
    const stopBackground = (control as { stopBackgroundSessions?: () => Promise<number> }).stopBackgroundSessions;
    const reached = stopBackground === undefined ? 0 : await stopBackground.call(control);
    background = Math.max(background, reached);
  }
  // Dispatched task workers are their own child processes, outside `stopRunningCommands`'s registry
  // (which only tracks the guarded-command path) and outside the turn control (which only tracks model
  // turns). A stop that reached everything else and left a worker running would not be an emergency stop.
  const tasks = deps.taskDispatch?.stopAll() ?? 0;
  const terminals = deps.terminals?.stopAll() ?? 0;

  const stopped = commands + turns + background + tasks + terminals;
  if (stopped > 0) {
    // Written down whether or not anybody was watching: a stop is the event most likely to need explaining later.
    appendAuditEvent(deps.db, {
      auditId: deps.newId("audit"),
      principalId: deps.ownerPrincipalId,
      nodeId: deps.nodeId,
      kind: "stop",
      summary: `${shutdown ? "tắt node" : "dừng khẩn cấp"}: ${commands} lệnh, ${turns} lượt, ${background} việc nền, ${tasks} worker task, ${terminals} terminal`,
      outcome: "stopped",
      at: nowInstant(),
    });
  }
  return { commands, turns, background, tasks, terminals };
}
