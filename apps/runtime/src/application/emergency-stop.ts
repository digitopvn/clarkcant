import { nowInstant } from "@clarkcant/contracts";
import { appendAuditEvent } from "@clarkcant/storage";
import type { Database } from "@clarkcant/storage";

import { stopRunningCommands } from "../run-command.ts";

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
}

export interface EmergencyStopReport {
  commands: number;
  turns: number;
  background: number;
}

export async function performEmergencyStop(deps: EmergencyStopDeps): Promise<EmergencyStopReport> {
  const commands = stopRunningCommands();
  const control = deps.turnControl;
  let turns = 0;
  let background = 0;
  if (control !== undefined) {
    for (const runningIn of control.running()) {
      if (control.interrupt(runningIn)) turns += 1;
    }
    // SAFETY: the stop is optional on the control object because a node can be built without background workers at
    // all; reading it through a narrow shape keeps every other caller of `control` typed as it was.
    const stopBackground = (control as { stopBackgroundSessions?: () => Promise<number> }).stopBackgroundSessions;
    background = stopBackground === undefined ? 0 : await stopBackground.call(control);
  }

  const stopped = commands + turns + background;
  if (stopped > 0) {
    // Written down whether or not anybody was watching: a stop is the event most likely to need explaining later.
    appendAuditEvent(deps.db, {
      auditId: deps.newId("audit"),
      principalId: deps.ownerPrincipalId,
      nodeId: deps.nodeId,
      kind: "stop",
      summary: `dừng khẩn cấp: ${commands} lệnh, ${turns} lượt, ${background} việc nền`,
      outcome: "stopped",
      at: nowInstant(),
    });
  }
  return { commands, turns, background };
}
