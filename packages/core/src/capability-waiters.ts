import type { CapabilityRef } from "@clarkcant/contracts";
import { listTasksWaitingOnCapability } from "@clarkcant/storage";

import { canRunHere, chooseCapability } from "./automation.ts";
import type { ConductorDeps } from "./conductor.ts";
import { advanceResolving, applyTaskEvent } from "./task-service.ts";

export interface ResumedTask {
  taskId: string;
  conversationId: string;
  capabilityRef: string;
  executionNodeId: string;
}

/**
 * Tasks parked on a capability that has since become usable, taken back and run.
 *
 * A task a person asked for parks when nothing on the node can do it yet; most often the project-work pack is still
 * loading after the node started. Nothing else would ever move it again, so once a capability becomes usable this
 * takes each task waiting on it through resolution and dispatch the way the conductor does, and hands it to the same
 * runner.
 *
 * Once per task, however often it is called: a task leaves `waiting_capability` in the same synchronous step that
 * hands it over, so a second call, or a later boot, does not find it waiting. An automation's own task is left to the
 * automation service, which resumes its runs on its tick. A task a paired node handed over goes ahead here too, but
 * only on this node's own capability: it runs here or not at all.
 *
 * `onResume` is called before the runner starts, so what it says reaches the conversation ahead of the run's report.
 * A node with no runner moves nothing: a task dispatched to nobody would sit there claiming to run.
 */
export function resumeCapabilityWaiters(
  deps: ConductorDeps,
  onResume?: (task: ResumedTask) => void,
): ResumedTask[] {
  const runTask = deps.runTask;
  if (runTask === undefined) return [];
  const resumed: ResumedTask[] = [];
  for (const task of listTasksWaitingOnCapability(deps.db, deps.nodeId)) {
    if (task.origin?.kind === "persistent") continue;
    if (task.waitingCapabilityRef === undefined) continue;
    const capabilityRef = task.waitingCapabilityRef as CapabilityRef;
    const chosen =
      task.origin?.kind === "delegated"
        ? canRunHere(deps, capabilityRef)
          ? { executionNodeId: deps.nodeId }
          : undefined
        : chooseCapability(deps, capabilityRef);
    if (chosen === undefined) continue;
    if (!applyTaskEvent(deps, task.taskId, "capability.ready").ok) continue;
    if (!applyTaskEvent(deps, task.taskId, "resolve.start").ok) continue;
    if (!advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: chosen.executionNodeId }).ok) continue;
    if (!applyTaskEvent(deps, task.taskId, "dispatch.acknowledged").ok) continue;
    const entry: ResumedTask = {
      taskId: task.taskId,
      conversationId: task.conversationId,
      capabilityRef,
      executionNodeId: chosen.executionNodeId,
    };
    onResume?.(entry);
    runTask({ taskId: entry.taskId, capabilityRef, executionNodeId: entry.executionNodeId });
    resumed.push(entry);
  }
  return resumed;
}
