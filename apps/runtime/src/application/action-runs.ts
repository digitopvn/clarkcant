import { WorkAbort } from "../work-supervisor.ts";

/**
 * The widget actions running on this node right now, and the one way to stop them.
 *
 * A press that calls a service or runs a workflow can take a while, and a person who pressed it has to be able to stop
 * it the way they stop anything else in the conversation: Stop, Escape, or "dừng lại". Those all reach the
 * conversation's stop (`stop-turn.ts`), which asks here as well as stopping the reply, so there is still one answer to
 * "what does stopping do". Each run holds an `AbortController`; stopping aborts it with a `WorkAbort("stopped")`, and
 * the executor reports what that means for the effect — never that nothing happened, once a request was sent.
 *
 * The invocation id is also the in-flight guard: a second request with the same id while the first is running would
 * otherwise run it twice, because the outcome that makes it a duplicate is recorded only when the run ends.
 */

interface ActionRun {
  invocationId: string;
  conversationId: string;
  controller: AbortController;
  /**
   * Whether Stop reaches this run through its controller. A foreground `agent` press is a turn in the conversation,
   * which the same Stop already ends as a reply; it is tracked only as the in-flight guard, so a stop is not counted
   * twice for one thing.
   */
  stoppable: boolean;
}

const runs = new Map<string, ActionRun>();

/** Whether a run with this invocation id has started and not yet ended. */
export function actionRunning(invocationId: string): boolean {
  return runs.has(invocationId);
}

/** Aborted actions remain busy until their finally block finishes; they may still be settling an effect. */
export function conversationActionRunning(conversationId: string): boolean {
  return [...runs.values()].some((run) => run.conversationId === conversationId);
}

/**
 * Start tracking a run, answering its controller, or `undefined` when one with this id is already running.
 *
 * The caller must call `endActionRun` in a `finally`, whatever the run came to.
 */
export function beginActionRun(input: { invocationId: string; conversationId: string; stoppable?: boolean }): AbortController | undefined {
  if (runs.has(input.invocationId)) return undefined;
  const controller = new AbortController();
  runs.set(input.invocationId, {
    invocationId: input.invocationId,
    conversationId: input.conversationId,
    controller,
    stoppable: input.stoppable ?? true,
  });
  return controller;
}

export function endActionRun(invocationId: string): void {
  runs.delete(invocationId);
}

/** Stop every action running in one conversation, answering how many there were. */
export function cancelActionRuns(conversationId: string): number {
  let stopped = 0;
  for (const run of runs.values()) {
    if (run.conversationId !== conversationId || !run.stoppable || run.controller.signal.aborted) continue;
    run.controller.abort(new WorkAbort("stopped", "a person stopped this action"));
    stopped += 1;
  }
  return stopped;
}

/** Stop every action running on this node, for the emergency stop. */
export function cancelAllActionRuns(): number {
  let stopped = 0;
  for (const run of runs.values()) {
    if (!run.stoppable || run.controller.signal.aborted) continue;
    run.controller.abort(new WorkAbort("stopped", "the node was stopped"));
    stopped += 1;
  }
  return stopped;
}
