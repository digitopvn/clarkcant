import {
  type AutomationSchedule,
  type CapabilityRef,
  type Instant,
  type IntentAction,
  type IntentRun,
  type MatchCondition,
  type PersistentIntent,
  type Principal,
  type Signal,
  type TaskRecord,
  SIGNAL_PAYLOAD_MAX_BYTES,
  automationScheduleSchema,
  intentActionSchema,
  matchConditionSchema,
  persistentIntentSchema,
  signalInputSchema,
  signalSchema,
  signalTopicSchema,
} from "@clarkcant/contracts";
import {
  activeIntentsForTopic,
  deferSignalDelivery,
  dueSignalDeliveries,
  dueTimerIntents,
  getPersistentIntent,
  getTask,
  listPersistentIntents,
  pendingIntentRuns,
  putPersistentIntent,
  recentIntentRuns,
  recordIntentRun,
  recordRun,
  recordSignalDelivery,
  setIntentRunState,
  settleSignalDelivery,
  transaction,
} from "@clarkcant/storage";

import { listCapabilitySummaries } from "./capability-registry.ts";
import { advanceResolving, applyTaskEvent, createTask, type TaskServiceDeps } from "./task-service.ts";

/**
 * Persistent intents: "from now on, when X happens, do Y".
 *
 * Three steps, each written down before the next one starts, so a node that stops anywhere picks up where it was:
 *
 * 1. A signal is recorded once, whatever its source delivered twice.
 * 2. A recorded signal is matched against the active intents on its topic, and every match becomes a run that already
 *    names the task it will create. Recording the runs and settling the signal happen together.
 * 3. A run is started: a reminder is said, or a task is created with the automation's own folders and effects and
 *    handed to the same dispatch path a task from the conversation takes.
 *
 * Matching is deterministic data, read the same way every time. No model reads a signal to decide whether it counts.
 */

export const TIMER_TOPIC = "timer.fired";
/** How many standing requests one person keeps before being asked to remove one. */
export const MAX_AUTOMATIONS = 100;
/** How many times a signal that could not be matched is tried again before it is set aside and the person told. */
export const SIGNAL_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 30 * 60_000;

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/**
 * The value at a dotted path of a signal: `payload.label`, `subject.refs.repository`, `payload.labels.0`.
 *
 * Only a signal's own fields are readable, and only through plain keys — a path never reaches a prototype.
 */
export function readSignalPath(signal: Signal, path: string): unknown {
  let current: unknown = signal;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined;
      current = current[Number(key)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function conditionHolds(condition: MatchCondition, signal: Signal): boolean {
  const value = readSignalPath(signal, condition.path);
  switch (condition.op) {
    case "exists":
      return value !== undefined && value !== null;
    case "equals":
      return sameValue(value, condition.value);
    case "in":
      return condition.value.some((candidate) => sameValue(value, candidate));
    case "contains":
      if (typeof value === "string") return typeof condition.value === "string" && value.includes(condition.value);
      if (Array.isArray(value)) return value.some((element) => sameValue(element, condition.value));
      return false;
  }
}

/**
 * Whether an intent answers a signal.
 *
 * A timer intent answers only its own timer; anything else answers a signal on its topic whose every condition holds.
 * A signal Clark's own work caused starts nothing unless the intent was set up to react to its own effects, which is
 * what keeps "when an issue is labelled, label it" from feeding itself.
 */
export function matchIntent(intent: PersistentIntent, signal: Signal): boolean {
  if (intent.state !== "active") return false;
  if (intent.when.topic !== signal.topic) return false;
  if (signal.provenance.selfGenerated === true && !intent.allowSelfTriggered) return false;
  if (intent.schedule !== undefined) {
    if (signal.source.kind !== "timer" || signal.subject?.id !== intent.intentId) return false;
  } else if (signal.source.kind === "timer") {
    // A timer belongs to the intent that set it; another intent on the same topic never answers it.
    return false;
  }
  return intent.match.every((condition) => conditionHolds(condition, signal));
}

/* ------------------------------------------------------------------ *
 * Recording a signal
 * ------------------------------------------------------------------ */

export type IngestResult =
  | { ok: true; created: boolean; signalId: string }
  | { ok: false; code: "SIGNAL_INVALID" | "SIGNAL_TOO_LARGE"; message: string };

/**
 * Record a signal once. Nothing is decided here: the signal is written down, and matching happens after.
 *
 * Returning before the signal is matched is what lets a source be answered at once and the work happen durably
 * afterwards, with a node that stops in between finding the signal still waiting.
 */
export function ingestSignal(deps: TaskServiceDeps, raw: unknown): IngestResult {
  const parsed = signalInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "SIGNAL_INVALID", message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  }
  const size = Buffer.byteLength(JSON.stringify(parsed.data.payload), "utf8");
  if (size > SIGNAL_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      code: "SIGNAL_TOO_LARGE",
      message: `the payload is ${String(size)} bytes, over the ${String(SIGNAL_PAYLOAD_MAX_BYTES)} a signal may carry; send a reference instead`,
    };
  }
  const signal = signalSchema.parse({ ...parsed.data, signalId: deps.newId("sig"), receivedAt: deps.now() });
  const recorded = recordSignalDelivery(deps.db, signal);
  return { ok: true, created: recorded.created, signalId: recorded.signalId };
}

/* ------------------------------------------------------------------ *
 * Matching recorded signals into runs
 * ------------------------------------------------------------------ */

export interface MatchedSignals {
  /** Signals whose runs were recorded. */
  processed: number;
  /** Signals tried again later. */
  deferred: number;
  /** Signals set aside after their last attempt, with why, for the person to be told. */
  dead: { signalId: string; topic: string; error: string }[];
  /** Runs recorded now, and not before. */
  runs: IntentRun[];
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Match every signal whose turn has come.
 *
 * A signal's runs and its settlement are one transaction: either every intent it answers has a run naming its task,
 * or the signal is still pending and will be matched again, finding the same runs by (intent, signal).
 */
export function matchDueSignals(
  deps: TaskServiceDeps,
  options: { limit?: number; match?: (intent: PersistentIntent, signal: Signal) => boolean } = {},
): MatchedSignals {
  const now = deps.now();
  const matches = options.match ?? matchIntent;
  const result: MatchedSignals = { processed: 0, deferred: 0, dead: [], runs: [] };
  for (const delivery of dueSignalDeliveries(deps.db, now, options.limit)) {
    const signal = delivery.signal;
    try {
      const created = transaction(deps.db, () => {
        const runs: IntentRun[] = [];
        for (const intent of activeIntentsForTopic(deps.db, signal.topic)) {
          if (!matches(intent, signal)) continue;
          const recorded = recordIntentRun(deps.db, {
            runId: deps.newId("irun"),
            intentId: intent.intentId,
            signalId: signal.signalId,
            taskId: deps.newId("task"),
            state: "pending",
            createdAt: now,
            updatedAt: now,
          });
          if (recorded.created) runs.push(recorded.run);
        }
        settleSignalDelivery(deps.db, signal.signalId, "processed", now);
        return runs;
      });
      result.processed += 1;
      result.runs.push(...created);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const attempts = delivery.attempts + 1;
      if (attempts >= SIGNAL_MAX_ATTEMPTS) {
        settleSignalDelivery(deps.db, signal.signalId, "dead", now, error);
        result.dead.push({ signalId: signal.signalId, topic: signal.topic, error });
      } else {
        const nextAttemptAt = new Date(Date.parse(now) + retryDelayMs(attempts)).toISOString() as Instant;
        deferSignalDelivery(deps.db, signal.signalId, { attempts, nextAttemptAt, error });
        result.deferred += 1;
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Timers
 * ------------------------------------------------------------------ */

/**
 * The slot after `scheduledAt` that is still ahead of `now`.
 *
 * A node that was off for a day fires a missed timer once, for the slot it missed, and then waits for the next real
 * one — never a burst of every slot it slept through.
 */
export function nextTimerSlot(schedule: AutomationSchedule, scheduledAt: Instant, now: Instant): Instant | undefined {
  if (!("everyMinutes" in schedule)) return undefined;
  const step = schedule.everyMinutes * 60_000;
  const from = Date.parse(scheduledAt);
  const current = Date.parse(now);
  const skipped = Math.max(1, Math.floor((current - from) / step) + 1);
  return new Date(from + skipped * step).toISOString() as Instant;
}

/**
 * Turn every timer that has come due into a signal.
 *
 * The signal is keyed by the slot it fires for, so a node that fires a timer and stops before moving it on fires the
 * same signal again, which is recorded once.
 */
export function fireDueTimers(deps: TaskServiceDeps): { fired: string[] } {
  const now = deps.now();
  const fired: string[] = [];
  for (const intent of dueTimerIntents(deps.db, now)) {
    const scheduledAt = intent.nextFireAt;
    if (scheduledAt === undefined || intent.schedule === undefined) continue;
    const signal: Signal = signalSchema.parse({
      source: { kind: "timer", sourceId: `timer:${intent.intentId}` },
      topic: TIMER_TOPIC,
      subject: { type: "automation", id: intent.intentId },
      payload: { scheduledAt },
      occurredAt: scheduledAt,
      dedupeKey: `timer:${intent.intentId}:${scheduledAt}`,
      provenance: { via: "node timer" },
      signalId: deps.newId("sig"),
      receivedAt: now,
    });
    const next = nextTimerSlot(intent.schedule, scheduledAt, now);
    transaction(deps.db, () => {
      recordSignalDelivery(deps.db, signal);
      const { nextFireAt: _fired, ...rest } = intent;
      putPersistentIntent(deps.db, { ...rest, ...(next === undefined ? {} : { nextFireAt: next }) });
    });
    fired.push(intent.intentId);
  }
  return { fired };
}

/* ------------------------------------------------------------------ *
 * Starting a run
 * ------------------------------------------------------------------ */

export type PreparedRun =
  | { kind: "remind"; run: IntentRun; intent: PersistentIntent; message: string }
  | { kind: "dispatch"; run: IntentRun; intent: PersistentIntent; taskId: string; capabilityRef: CapabilityRef; executionNodeId: string }
  /**
   * Waiting for something to run it. The run stays pending and is looked at again on every tick, so the task goes on
   * by itself once the capability becomes usable; `newlyParked` is true only on the call that parked it, so the person
   * is told once.
   */
  | { kind: "parked"; run: IntentRun; intent: PersistentIntent; taskId: string; reason: string; newlyParked: boolean }
  /** The task already moved past dispatch before a crash; there is nothing left to start. */
  | { kind: "already-started"; run: IntentRun; intent: PersistentIntent; taskId: string }
  | { kind: "skipped"; run: IntentRun; reason: string };

/** The capability a task needs: changing something needs the code-change worker; only reading needs the reader. */
export function automationCapabilityFor(action: Extract<IntentAction, { kind: "task" }>): CapabilityRef {
  const writes = action.resources.some((resource) => resource.kind === "repository" || resource.access === "write");
  return (writes ? "project.code.change@1" : "project.file.read@1") as CapabilityRef;
}

/** A usable node for the capability, this node first. */
function chooseCapability(deps: TaskServiceDeps, capabilityRef: CapabilityRef): { executionNodeId: string } | undefined {
  const usable = listCapabilitySummaries(deps, { usableOnly: true, taskRunnersOnly: true }).filter(
    (summary) => summary.ref === capabilityRef,
  );
  return usable.find((summary) => summary.executionNodeId === deps.nodeId) ?? usable[0];
}

/**
 * Take a task just created on this node to dispatched and acknowledged, run by this node's own capability.
 *
 * For work a paired node handed over: it runs here or not at all, so a capability that is not usable here now is a
 * refusal the sender hears, never a park nothing would come back to. The task fails in resolution, so it is not left
 * queued.
 */
export function startTaskHere(
  deps: TaskServiceDeps,
  taskId: string,
  capabilityRef: CapabilityRef,
): { ok: true } | { ok: false; reason: string } {
  const usable = listCapabilitySummaries(deps, { usableOnly: true, taskRunnersOnly: true }).some(
    (summary) => summary.ref === capabilityRef && summary.executionNodeId === deps.nodeId,
  );
  const started = applyTaskEvent(deps, taskId, "resolve.start");
  if (!started.ok) return { ok: false, reason: started.message };
  if (!usable) {
    const reason = `this node cannot run ${capabilityRef} right now`;
    applyTaskEvent(deps, taskId, "resolve.failed");
    return { ok: false, reason };
  }
  const ready = advanceResolving(deps, taskId, { kind: "ready", executionNodeId: deps.nodeId });
  if (!ready.ok) return { ok: false, reason: ready.message };
  const acknowledged = applyTaskEvent(deps, taskId, "dispatch.acknowledged");
  return acknowledged.ok ? { ok: true } : { ok: false, reason: acknowledged.message };
}

function taskOrigin(intent: PersistentIntent, run: IntentRun, action: Extract<IntentAction, { kind: "task" }>, sourceRef?: string): TaskRecord["origin"] {
  return {
    kind: "persistent",
    principalId: intent.principalId,
    intentId: intent.intentId,
    triggerSignalId: run.signalId,
    allowedCategories: action.allowedCategories,
    ...(sourceRef === undefined ? {} : { sourceRef: sourceRef.slice(0, 300) }),
  };
}

/**
 * Take a run as far as it goes without a process: a reminder's words, or a task created and resolved to dispatch.
 *
 * Safe to call again for the same run. The task is created under the id the run recorded, so a second call finds it
 * and continues from its state instead of making another.
 *
 * A task with an executor is resolved to that peer rather than to a capability here; `onAcknowledged` is how the caller
 * hands it over, and it runs inside the write that marks the run started, so the hand-over is recorded exactly when the
 * run is and never without it.
 */
export function prepareIntentRun(
  deps: TaskServiceDeps,
  run: IntentRun,
  context: { sourceRef?: string; trigger?: string; onAcknowledged?: (task: TaskRecord) => void } = {},
): PreparedRun {
  const intent = getPersistentIntent(deps.db, run.intentId);
  if (intent === undefined) return { kind: "skipped", run, reason: "the automation no longer exists" };
  if (intent.state !== "active") {
    return {
      kind: "skipped",
      run,
      reason: intent.state === "paused" ? "the automation was paused before this run started" : "the automation was removed before this run started",
    };
  }
  const action = intent.do;
  if (action.kind === "remind") return { kind: "remind", run, intent, message: action.message };

  let task = getTask(deps.db, run.taskId);
  if (task === undefined) {
    const principal: Principal = { principalId: intent.principalId, kind: "user", nodeId: deps.nodeId };
    task = createTask(deps, {
      taskId: run.taskId as TaskRecord["taskId"],
      conversationId: intent.conversationId as TaskRecord["conversationId"],
      // The worker is told what it is answering, not only what to do: "fix the labelled issue" needs the issue.
      goal: (context.trigger === undefined ? action.goal : `${action.goal}\n\n${context.trigger}`).slice(0, 4000),
      principal,
      origin: taskOrigin(intent, run, action, context.sourceRef),
      resources: action.resources,
    });
  }

  const capabilityRef = automationCapabilityFor(action);
  // The peer that runs it, or a usable capability here: a peer's capabilities are that peer's to resolve.
  const choose = (): { executionNodeId: string } | undefined =>
    action.executor === undefined ? chooseCapability(deps, capabilityRef) : { executionNodeId: action.executor };
  // Parked on a capability that has since become usable — a worker that finished loading after the node started, most
  // often — goes back to be resolved again, rather than waiting for something that already happened.
  if (task.state === "waiting_capability" && choose() !== undefined) {
    const ready = applyTaskEvent(deps, task.taskId, "capability.ready");
    if (ready.ok) task = ready.task;
  }

  if (task.state === "queued") {
    const started = applyTaskEvent(deps, task.taskId, "resolve.start");
    if (started.ok) task = started.task;
  }

  if (task.state === "resolving") {
    const chosen = choose();
    if (chosen === undefined) {
      const parked = advanceResolving(deps, task.taskId, { kind: "needs-capability", capabilityRef });
      return {
        kind: "parked",
        run,
        intent,
        taskId: task.taskId,
        reason: parked.ok ? `waiting for capability ${capabilityRef}` : parked.message,
        newlyParked: parked.ok,
      };
    }
    const ready = advanceResolving(deps, task.taskId, { kind: "ready", executionNodeId: chosen.executionNodeId });
    if (ready.ok) task = ready.task;
  }

  if (task.state === "dispatched" && task.executionNodeId !== undefined) {
    // Acknowledged the way the conductor does, and the run marked started in the same write: from here the task is the
    // dispatcher's, and a node that stops before handing it over finds a running task the boot calls uncertain, never
    // a pending run that would start it a second time.
    const dispatched = task;
    // Work on a peer is held by the peer's run, which is what makes a stop here reach it rather than end only here.
    const holding = action.executor === undefined ? {} : { activeRunId: run.runId as TaskRecord["activeRunId"] };
    const acknowledged = applyTaskEvent(deps, task.taskId, "dispatch.acknowledged", holding, () => {
      const at = deps.now();
      setIntentRunState(deps.db, run.runId, "started", at);
      // The peer's run, recorded as one here: it is what the task's evidence and a stop name.
      if (action.executor !== undefined) {
        recordRun(deps.db, {
          runId: run.runId,
          taskId: dispatched.taskId,
          taskRevision: dispatched.revision,
          executionNodeId: action.executor,
          leaseEpoch: 0,
          startedAt: at,
          evidence: [],
        });
      }
      context.onAcknowledged?.(dispatched);
    });
    if (acknowledged.ok) {
      return {
        kind: "dispatch",
        run: { ...run, state: "started" },
        intent,
        taskId: task.taskId,
        capabilityRef,
        executionNodeId: task.executionNodeId,
      };
    }
  }
  if (task.state === "waiting_capability") {
    return {
      kind: "parked",
      run,
      intent,
      taskId: task.taskId,
      reason: task.parkedReason ?? `waiting for capability ${capabilityRef}`,
      newlyParked: false,
    };
  }
  return { kind: "already-started", run, intent, taskId: task.taskId };
}

/** Runs recorded and not yet started, oldest first: what a node resumes after it stopped between the two. */
export function pendingRuns(deps: Pick<TaskServiceDeps, "db">): IntentRun[] {
  return pendingIntentRuns(deps.db);
}

export function settleIntentRun(
  deps: TaskServiceDeps,
  runId: string,
  state: "started" | "reminded" | "failed",
  reason?: string,
): void {
  setIntentRunState(deps.db, runId, state, deps.now(), reason);
}

/* ------------------------------------------------------------------ *
 * Setting one up, changing it, reading it back
 * ------------------------------------------------------------------ */

export interface AutomationInput {
  summary: string;
  /** The topic to answer. Absent for a timer, which answers its own. */
  topic?: string;
  match?: MatchCondition[];
  do: IntentAction;
  schedule?: AutomationSchedule;
  allowSelfTriggered?: boolean;
}

export type AutomationResult = { ok: true; intent: PersistentIntent } | { ok: false; code: string; message: string };

function firstFire(schedule: AutomationSchedule, now: Instant): { ok: true; at: Instant } | { ok: false; message: string } {
  if ("at" in schedule) {
    if (Date.parse(schedule.at) <= Date.parse(now)) return { ok: false, message: `${schedule.at} has already passed` };
    return { ok: true, at: schedule.at };
  }
  return { ok: true, at: new Date(Date.parse(now) + schedule.everyMinutes * 60_000).toISOString() as Instant };
}

/**
 * Write down a standing request.
 *
 * Everything is checked here, whoever asked — the conversation's tool, a route, a test — so an intent that cannot be
 * matched deterministically is never stored.
 */
export function createAutomation(
  deps: TaskServiceDeps,
  input: AutomationInput & { principalId: string; conversationId: string },
): AutomationResult {
  if (listPersistentIntents(deps.db, input.principalId).length >= MAX_AUTOMATIONS) {
    return {
      ok: false,
      code: "AUTOMATION_LIMIT",
      message: `there are already ${String(MAX_AUTOMATIONS)} automations; remove one you no longer need first`,
    };
  }
  const now = deps.now();
  let nextFireAt: Instant | undefined;
  if (input.schedule !== undefined) {
    const schedule = automationScheduleSchema.safeParse(input.schedule);
    if (!schedule.success) return { ok: false, code: "AUTOMATION_INVALID", message: schedule.error.issues[0]?.message ?? "the schedule is not valid" };
    const first = firstFire(schedule.data, now);
    if (!first.ok) return { ok: false, code: "AUTOMATION_INVALID", message: first.message };
    nextFireAt = first.at;
  } else if (input.topic === undefined) {
    return { ok: false, code: "AUTOMATION_INVALID", message: "an automation needs either a topic to answer or a schedule" };
  }
  const candidate = {
    intentId: deps.newId("intent"),
    principalId: input.principalId,
    conversationId: input.conversationId,
    summary: input.summary,
    when: { topic: input.schedule === undefined ? input.topic : TIMER_TOPIC },
    match: input.match ?? [],
    do: input.do,
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    state: "active",
    allowSelfTriggered: input.allowSelfTriggered ?? false,
    revision: 0,
    ...(nextFireAt === undefined ? {} : { nextFireAt }),
    createdAt: now,
    updatedAt: now,
  };
  const parsed = persistentIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "AUTOMATION_INVALID",
      message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  putPersistentIntent(deps.db, parsed.data);
  return { ok: true, intent: parsed.data };
}

export interface AutomationChange {
  state?: "active" | "paused" | "removed";
  summary?: string;
  topic?: string;
  match?: MatchCondition[];
  do?: IntentAction;
  schedule?: AutomationSchedule;
  allowSelfTriggered?: boolean;
}

/**
 * Change a standing request: pause it, resume it, edit it, or remove it.
 *
 * Removal keeps the record, marked removed, so what it did stays explainable. A run already recorded before a pause
 * is skipped when it comes to start, never started for an automation the person has since stopped.
 */
export function updateAutomation(
  deps: TaskServiceDeps,
  input: { intentId: string; principalId: string; change: AutomationChange },
): AutomationResult {
  const existing = getPersistentIntent(deps.db, input.intentId);
  if (existing === undefined || existing.principalId !== input.principalId || existing.state === "removed") {
    return { ok: false, code: "AUTOMATION_NOT_FOUND", message: `there is no automation ${input.intentId}` };
  }
  const now = deps.now();
  const change = input.change;
  if (change.match !== undefined) {
    for (const condition of change.match) {
      if (!matchConditionSchema.safeParse(condition).success) return { ok: false, code: "AUTOMATION_INVALID", message: "a condition is not valid" };
    }
  }
  if (change.do !== undefined && !intentActionSchema.safeParse(change.do).success) {
    return { ok: false, code: "AUTOMATION_INVALID", message: "what the automation does is not valid" };
  }
  if (change.topic !== undefined && !signalTopicSchema.safeParse(change.topic).success) {
    return { ok: false, code: "AUTOMATION_INVALID", message: "a topic is dotted lower-case words, such as github.issue.labeled" };
  }
  const schedule = change.schedule ?? existing.schedule;
  const state = change.state ?? existing.state;
  let nextFireAt = existing.nextFireAt;
  if (schedule !== undefined && state === "active") {
    const rescheduled = change.schedule !== undefined;
    const resumed = existing.state !== "active";
    const stale = nextFireAt !== undefined && Date.parse(nextFireAt) <= Date.parse(now);
    if (rescheduled || (resumed && (nextFireAt === undefined || stale))) {
      const first = firstFire(schedule, now);
      if (!first.ok) return { ok: false, code: "AUTOMATION_INVALID", message: first.message };
      nextFireAt = first.at;
    }
  }
  const { nextFireAt: _previous, schedule: _schedule, ...rest } = existing;
  const candidate: PersistentIntent = {
    ...rest,
    ...(change.summary === undefined ? {} : { summary: change.summary }),
    when: { topic: schedule !== undefined ? TIMER_TOPIC : (change.topic ?? existing.when.topic) },
    ...(change.match === undefined ? {} : { match: change.match }),
    ...(change.do === undefined ? {} : { do: change.do }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(change.allowSelfTriggered === undefined ? {} : { allowSelfTriggered: change.allowSelfTriggered }),
    state,
    revision: existing.revision + 1,
    ...(nextFireAt === undefined || state === "removed" ? {} : { nextFireAt }),
    updatedAt: now,
  };
  const parsed = persistentIntentSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: "AUTOMATION_INVALID",
      message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  putPersistentIntent(deps.db, parsed.data);
  return { ok: true, intent: parsed.data };
}

export function listAutomations(
  deps: Pick<TaskServiceDeps, "db">,
  principalId: string,
  options: { recentRuns?: number } = {},
): { intent: PersistentIntent; recentRuns: IntentRun[] }[] {
  return listPersistentIntents(deps.db, principalId).map((intent) => ({
    intent,
    recentRuns: recentIntentRuns(deps.db, intent.intentId, options.recentRuns ?? 3),
  }));
}
