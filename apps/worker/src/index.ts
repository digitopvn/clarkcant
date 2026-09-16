/**
 * @clarkcant/app-worker
 *
 * Worker host: runs one app-managed Pi session per run, reports evidence, and never owns
 * task authority. The distinction matters — a worker going idle is not success, so the
 * worker reports what happened and the home node decides what that means.
 *
 * @implementation-status stub
 * TODO(P2): the worker entry point and the run loop. The adapter it will drive is
 * implemented and tested (`@clarkcant/pi-adapter`, both the real SDK adapter and the
 * deterministic fake used by CI), and the task lifecycle it reports into is implemented
 * in `@clarkcant/core`.
 *
 * The contract this process will satisfy:
 *   - accept a bounded brief, not a whole transcript;
 *   - register only the tools the brief's capabilities permit;
 *   - emit evidence with a verdict, never a bare "done";
 *   - stop on its wall-clock budget rather than running without a limit.
 */

export interface WorkerBriefEnvelope {
  runId: string;
  taskId: string;
  taskRevision: number;
  goal: string;
  projectRoots: string[];
  allowedCapabilityRefs: string[];
  maxWallClockMs?: number;
  maxTokens?: number;
}

/**
 * @implementation-status stub
 * TODO(P2): see above.
 */
export const WORKER_STATUS = "not-implemented";
