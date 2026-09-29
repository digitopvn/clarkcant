import { type CapabilityDescriptor, type Instant, type Signal, instantSchema, nodeIdSchema } from "@clarkcant/contracts";
import { getSignalDelivery, getTask, migrate, openDatabase, recentIntentRuns } from "@clarkcant/storage";
import { beforeEach, describe, expect, it } from "vitest";

import {
  SIGNAL_MAX_ATTEMPTS,
  applyTaskEvent,
  conditionHolds,
  createTask,
  createAutomation,
  fireDueTimers,
  ingestSignal,
  listAutomations,
  matchDueSignals,
  matchIntent,
  nextTimerSlot,
  pendingRuns,
  prepareIntentRun,
  readSignalPath,
  registerCapability,
  updateAutomation,
} from "../src/index.ts";

/**
 * Standing requests, from the signal that arrives to the task it starts.
 *
 * What is under test is the promise a person relies on when they say "from now on": the same fact delivered twice
 * does one thing, a node that stops anywhere in between neither loses the fact nor does the thing twice, and what an
 * automation matches is decided by reading its conditions, not by anything that could decide differently next time.
 */

const NODE = nodeIdSchema.parse("node_a");
const PRINCIPAL = "prin_owner";
let clock = Date.parse("2026-09-29T08:00:00.000Z");
let counter = 0;

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  const at = instantSchema.parse(new Date(clock).toISOString());
  db.prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)").run(
    "conv_1",
    NODE,
    at,
    at,
  );
  return {
    db,
    nodeId: NODE,
    now: () => new Date(clock).toISOString() as Instant,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  clock = Date.parse("2026-09-29T08:00:00.000Z");
  deps = makeDeps();
});

function capability(ref: string, effectCategory: CapabilityDescriptor["effectCategory"]): CapabilityDescriptor {
  return {
    ref: ref as CapabilityDescriptor["ref"],
    executionNodeId: NODE,
    summary: ref,
    resourceKinds: ["workspace"],
    effectCategory,
    supportsCancellation: true,
    requiresConnection: false,
    readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
    uiAffordances: [],
  };
}

function labeled(label: string, dedupeKey = `issue-7:${label}`, extra: Record<string, unknown> = {}) {
  return {
    source: { kind: "external", provider: "github", sourceId: "github:owner/repo" },
    topic: "github.issue.labeled",
    subject: { type: "issue", id: "7", refs: { repository: "owner/repo" } },
    payload: { label, labels: ["bug", label], number: 7 },
    occurredAt: new Date(clock).toISOString(),
    dedupeKey,
    ...extra,
  };
}

function signalOf(input: ReturnType<typeof labeled>): Signal {
  return { ...input, provenance: {}, signalId: "sig_x", receivedAt: new Date(clock).toISOString() } as unknown as Signal;
}

type AutomationExtra = Omit<Partial<Parameters<typeof createAutomation>[1]>, "topic"> & { topic?: string | undefined };

function automation(extra: AutomationExtra = {}) {
  const input = {
    principalId: PRINCIPAL,
    conversationId: "conv_1",
    summary: "Khi issue được gắn nhãn ai-handle thì sửa nó",
    topic: "github.issue.labeled",
    match: [{ path: "payload.label", op: "equals", value: "ai-handle" }],
    do: {
      kind: "task",
      goal: "Fix the labelled issue",
      resources: [{ kind: "folder", path: "D:/work/repo", access: "write" }],
      allowedCategories: ["read", "local-write"],
    },
    ...extra,
  };
  // A timer answers its own topic, so "no topic" is said by leaving it out rather than by an undefined one.
  const { topic, ...rest } = input;
  const created = createAutomation(deps, (topic === undefined ? rest : { ...rest, topic }) as Parameters<typeof createAutomation>[1]);
  if (!created.ok) throw new Error(created.message);
  return created.intent;
}

describe("what an automation matches is read from its conditions", () => {
  it("reads a signal by path, and nothing that is not its own", () => {
    const signal = signalOf(labeled("ai-handle"));
    expect(readSignalPath(signal, "payload.label")).toBe("ai-handle");
    expect(readSignalPath(signal, "payload.labels.1")).toBe("ai-handle");
    expect(readSignalPath(signal, "subject.refs.repository")).toBe("owner/repo");
    expect(readSignalPath(signal, "payload.missing.deeper")).toBeUndefined();
    expect(readSignalPath(signal, "payload.constructor")).toBeUndefined();
    expect(readSignalPath(signal, "payload.__proto__")).toBeUndefined();
  });

  it("holds each of the four operators to what it says", () => {
    const signal = signalOf(labeled("ai-handle"));
    expect(conditionHolds({ path: "payload.number", op: "equals", value: 7 }, signal)).toBe(true);
    expect(conditionHolds({ path: "payload.number", op: "equals", value: "7" }, signal)).toBe(false);
    expect(conditionHolds({ path: "payload.label", op: "in", value: ["x", "ai-handle"] }, signal)).toBe(true);
    expect(conditionHolds({ path: "payload.labels", op: "contains", value: "bug" }, signal)).toBe(true);
    expect(conditionHolds({ path: "payload.label", op: "contains", value: "handle" }, signal)).toBe(true);
    expect(conditionHolds({ path: "payload.label", op: "contains", value: 7 }, signal)).toBe(false);
    expect(conditionHolds({ path: "subject.id", op: "exists" }, signal)).toBe(true);
    expect(conditionHolds({ path: "payload.nothing", op: "exists" }, signal)).toBe(false);
  });

  it("matches only an active intent on the topic whose every condition holds", () => {
    const intent = automation();
    expect(matchIntent(intent, signalOf(labeled("ai-handle")))).toBe(true);
    expect(matchIntent(intent, signalOf(labeled("wontfix")))).toBe(false);
    expect(matchIntent(intent, { ...signalOf(labeled("ai-handle")), topic: "github.issue.opened" })).toBe(false);
    expect(matchIntent({ ...intent, state: "paused" }, signalOf(labeled("ai-handle")))).toBe(false);
  });

  it("does not answer its own effects unless it was set up to", () => {
    const intent = automation();
    const own = { ...signalOf(labeled("ai-handle")), provenance: { selfGenerated: true } };
    expect(matchIntent(intent, own)).toBe(false);
    expect(matchIntent({ ...intent, allowSelfTriggered: true }, own)).toBe(true);
  });
});

describe("a signal is recorded once and matched once", () => {
  it("records the same fact delivered twice as one signal", () => {
    const first = ingestSignal(deps, labeled("ai-handle"));
    const second = ingestSignal(deps, labeled("ai-handle"));
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) return;
    expect(second.signalId).toBe(first.signalId);
  });

  it("refuses a signal it cannot read, and one too large to keep", () => {
    expect(ingestSignal(deps, { topic: "Not A Topic" })).toMatchObject({ ok: false, code: "SIGNAL_INVALID" });
    const big = labeled("ai-handle", "big", {});
    expect(ingestSignal(deps, { ...big, payload: { blob: "x".repeat(70_000) } })).toMatchObject({
      ok: false,
      code: "SIGNAL_TOO_LARGE",
    });
  });

  it("turns a match into one run that names its task before the task exists", () => {
    const intent = automation();
    automation({ match: [{ path: "payload.label", op: "equals", value: "other" }] });
    ingestSignal(deps, labeled("ai-handle"));
    const matched = matchDueSignals(deps);
    expect(matched.processed).toBe(1);
    expect(matched.runs).toHaveLength(1);
    const [run] = matched.runs;
    expect(run?.intentId).toBe(intent.intentId);
    expect(run?.state).toBe("pending");
    expect(getTask(deps.db, run?.taskId ?? "")).toBeUndefined();

    // Matching again finds nothing new: the signal is settled and its run already recorded.
    expect(matchDueSignals(deps)).toMatchObject({ processed: 0, runs: [] });
    expect(pendingRuns(deps)).toHaveLength(1);
  });

  it("starts one task for a run however many times the start is repeated", () => {
    registerCapability(deps, capability("project.code.change@1", "local-write"));
    automation();
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");

    const first = prepareIntentRun(deps, run, { sourceRef: "issue #7 in owner/repo" });
    expect(first.kind).toBe("dispatch");
    if (first.kind !== "dispatch") return;
    expect(first.capabilityRef).toBe("project.code.change@1");
    const task = getTask(deps.db, run.taskId);
    expect(task?.state).toBe("running");
    expect(task?.origin).toMatchObject({
      kind: "persistent",
      intentId: run.intentId,
      triggerSignalId: run.signalId,
      allowedCategories: ["read", "local-write"],
      sourceRef: "issue #7 in owner/repo",
    });
    expect(task?.resources).toEqual([{ kind: "folder", path: "D:/work/repo", access: "write" }]);
    // Started and acknowledged in one write: nothing is left pending to start again.
    expect(pendingRuns(deps)).toEqual([]);

    // A second start of the same run — a node that stopped before it noticed — creates nothing and dispatches nothing.
    const again = prepareIntentRun(deps, run);
    expect(again.kind).toBe("already-started");
    const tasks = deps.db.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number };
    expect(tasks.n).toBe(1);
  });

  it("gives the task the goal the person wrote, then what started it, kept apart", () => {
    registerCapability(deps, capability("project.code.change@1", "local-write"));
    const intent = automation();
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");

    prepareIntentRun(deps, run, { trigger: "What started this task: github.issue.labeled\nissue: 7" });
    const goal = getTask(deps.db, run.taskId)?.goal;
    expect(goal?.startsWith(intent.do.kind === "task" ? intent.do.goal : "")).toBe(true);
    expect(goal).toContain("\n\nWhat started this task: github.issue.labeled\nissue: 7");
  });

  it("resumes a run whose task was created before the node stopped, without a second task", () => {
    registerCapability(deps, capability("project.code.change@1", "local-write"));
    automation();
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");
    // The task exists and is resolving, as a crash right after creating and starting to resolve it would leave it.
    createTask(deps, {
      taskId: run.taskId as never,
      conversationId: "conv_1" as never,
      goal: "Fix the labelled issue",
      principal: { principalId: PRINCIPAL as never, kind: "user", nodeId: NODE },
      origin: { kind: "persistent", principalId: PRINCIPAL, intentId: run.intentId, triggerSignalId: run.signalId, allowedCategories: ["read", "local-write"] },
      resources: [{ kind: "folder", path: "D:/work/repo", access: "write" }],
    });
    applyTaskEvent(deps, run.taskId, "resolve.start");
    const partial = prepareIntentRun(deps, run);
    expect(partial.kind).toBe("dispatch");
    expect(getTask(deps.db, run.taskId)?.state).toBe("running");
    const count = deps.db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id = ?").get(run.taskId) as { n: number };
    expect(count.n).toBe(1);
  });

  it("parks the task honestly when nothing can run it", () => {
    automation();
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");
    const prepared = prepareIntentRun(deps, run);
    expect(prepared.kind).toBe("parked");
    expect(getTask(deps.db, run.taskId)?.state).toBe("waiting_capability");
  });

  it("reads rather than writes when the automation was only given folders to read", () => {
    registerCapability(deps, capability("project.file.read@1", "read"));
    automation({
      do: {
        kind: "task",
        goal: "Summarise the new issue",
        resources: [{ kind: "folder", path: "D:/work/repo", access: "read" }],
        allowedCategories: ["read"],
      },
    });
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");
    const prepared = prepareIntentRun(deps, run);
    expect(prepared.kind === "dispatch" && prepared.capabilityRef).toBe("project.file.read@1");
  });

  it("skips a run whose automation was paused before it started", () => {
    const intent = automation();
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");
    updateAutomation(deps, { intentId: intent.intentId, principalId: PRINCIPAL, change: { state: "paused" } });
    const prepared = prepareIntentRun(deps, run);
    expect(prepared).toMatchObject({ kind: "skipped", reason: expect.stringContaining("paused") });
    expect(getTask(deps.db, run.taskId)).toBeUndefined();
  });

  it("gives a reminder's words without making a task", () => {
    automation({ do: { kind: "remind", message: "Xem issue mới" } });
    ingestSignal(deps, labeled("ai-handle"));
    const [run] = matchDueSignals(deps).runs;
    if (run === undefined) throw new Error("no run");
    expect(prepareIntentRun(deps, run)).toMatchObject({ kind: "remind", message: "Xem issue mới" });
    expect(getTask(deps.db, run.taskId)).toBeUndefined();
  });
});

describe("a signal that cannot be matched is tried again, then set aside", () => {
  it("backs off, and after the last attempt is dead with its reason", () => {
    automation();
    const ingested = ingestSignal(deps, labeled("ai-handle"));
    if (!ingested.ok) throw new Error("not ingested");
    const failing = () => {
      throw new Error("the matcher broke");
    };
    for (let attempt = 1; attempt < SIGNAL_MAX_ATTEMPTS; attempt += 1) {
      const result = matchDueSignals(deps, { match: failing });
      expect(result.deferred).toBe(1);
      // Not due again until its back-off has passed.
      expect(matchDueSignals(deps, { match: failing }).deferred).toBe(0);
      clock += 60 * 60_000;
    }
    const last = matchDueSignals(deps, { match: failing });
    expect(last.dead).toEqual([{ signalId: ingested.signalId, topic: "github.issue.labeled", error: "the matcher broke" }]);
    expect(getSignalDelivery(deps.db, ingested.signalId)).toMatchObject({ state: "dead", lastError: "the matcher broke" });
  });
});

describe("timers fire once for each slot", () => {
  it("fires a due timer once, and moves on to the next slot ahead", () => {
    const intent = automation({ topic: undefined, match: [], schedule: { everyMinutes: 60 }, do: { kind: "remind", message: "Uống nước" } });
    expect(intent.when.topic).toBe("timer.fired");
    expect(intent.nextFireAt).toBe("2026-09-29T09:00:00.000Z");

    expect(fireDueTimers(deps).fired).toEqual([]);
    clock = Date.parse("2026-09-29T09:00:30.000Z");
    expect(fireDueTimers(deps).fired).toEqual([intent.intentId]);
    expect(fireDueTimers(deps).fired).toEqual([]);

    const matched = matchDueSignals(deps);
    expect(matched.runs.map((run) => run.intentId)).toEqual([intent.intentId]);
    const [stored] = listAutomations(deps, PRINCIPAL);
    expect(stored?.intent.nextFireAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("fires a timer missed while the node was off once, not once per missed slot", () => {
    const intent = automation({ topic: undefined, match: [], schedule: { everyMinutes: 60 }, do: { kind: "remind", message: "x" } });
    clock = Date.parse("2026-09-30T08:30:00.000Z");
    expect(fireDueTimers(deps).fired).toEqual([intent.intentId]);
    expect(fireDueTimers(deps).fired).toEqual([]);
    expect(matchDueSignals(deps).runs).toHaveLength(1);
    expect(nextTimerSlot({ everyMinutes: 60 }, "2026-09-29T09:00:00.000Z" as Instant, "2026-09-30T08:30:00.000Z" as Instant)).toBe(
      "2026-09-30T09:00:00.000Z",
    );
  });

  it("answers only its own timer, and a one-off timer fires once", () => {
    const once = automation({ topic: undefined, match: [], schedule: { at: "2026-09-29T08:30:00.000Z" as Instant }, do: { kind: "remind", message: "x" } });
    const other = automation({ topic: undefined, match: [], schedule: { everyMinutes: 600 }, do: { kind: "remind", message: "y" } });
    clock = Date.parse("2026-09-29T08:31:00.000Z");
    expect(fireDueTimers(deps).fired).toEqual([once.intentId]);
    const runs = matchDueSignals(deps).runs;
    expect(runs.map((run) => run.intentId)).toEqual([once.intentId]);
    expect(runs.some((run) => run.intentId === other.intentId)).toBe(false);
    clock = Date.parse("2026-09-29T12:00:00.000Z");
    expect(fireDueTimers(deps).fired).not.toContain(once.intentId);
  });

  it("refuses a one-off time that has already passed", () => {
    const result = createAutomation(deps, {
      principalId: PRINCIPAL,
      conversationId: "conv_1",
      summary: "x",
      schedule: { at: "2026-09-29T07:00:00.000Z" as Instant },
      do: { kind: "remind", message: "x" },
    });
    expect(result).toMatchObject({ ok: false, code: "AUTOMATION_INVALID" });
  });
});

describe("a person pauses, edits and removes what they set up", () => {
  it("pauses, resumes and removes, keeping the record and counting each change", () => {
    const intent = automation();
    const paused = updateAutomation(deps, { intentId: intent.intentId, principalId: PRINCIPAL, change: { state: "paused" } });
    expect(paused).toMatchObject({ ok: true, intent: { state: "paused", revision: 1 } });
    const edited = updateAutomation(deps, {
      intentId: intent.intentId,
      principalId: PRINCIPAL,
      change: { state: "active", match: [{ path: "payload.label", op: "in", value: ["ai-handle", "urgent"] }] },
    });
    expect(edited).toMatchObject({ ok: true, intent: { state: "active", revision: 2 } });
    const removed = updateAutomation(deps, { intentId: intent.intentId, principalId: PRINCIPAL, change: { state: "removed" } });
    expect(removed).toMatchObject({ ok: true, intent: { state: "removed" } });
    expect(listAutomations(deps, PRINCIPAL)).toEqual([]);
    // A removed automation is not changed again, and someone else's is not found at all.
    expect(updateAutomation(deps, { intentId: intent.intentId, principalId: PRINCIPAL, change: { state: "active" } }).ok).toBe(false);
    const theirs = automation();
    expect(updateAutomation(deps, { intentId: theirs.intentId, principalId: "prin_other", change: { state: "paused" } })).toMatchObject({
      ok: false,
      code: "AUTOMATION_NOT_FOUND",
    });
  });

  it("does not store a condition a matcher could not read the same way every time", () => {
    const result = createAutomation(deps, {
      principalId: PRINCIPAL,
      conversationId: "conv_1",
      summary: "x",
      topic: "github.issue.labeled",
      match: [{ path: "payload.label", op: "regex", value: ".*" } as never],
      do: { kind: "remind", message: "x" },
    });
    expect(result).toMatchObject({ ok: false, code: "AUTOMATION_INVALID" });
  });

  it("lists what each automation did lately", () => {
    const intent = automation({ do: { kind: "remind", message: "x" } });
    ingestSignal(deps, labeled("ai-handle"));
    matchDueSignals(deps);
    const [listed] = listAutomations(deps, PRINCIPAL);
    expect(listed?.recentRuns).toHaveLength(1);
    expect(recentIntentRuns(deps.db, intent.intentId)).toHaveLength(1);
  });
});
