import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowStep, WorkflowStepReport } from "@clarkcant/contracts";

import type { CapabilityInvokeOutcome } from "../src/application/capability-invoke.ts";
import {
  MIN_STEP_MS,
  applyTransform,
  resolveStepArgs,
  runWorkflow,
  stepProblem,
  testCondition,
  workflowOrder,
} from "../src/application/workflow-executor.ts";

/**
 * The workflow executor on its own: order, the pure transforms and conditions, where a run stops and what it says then.
 *
 * The capability gate is stood in for here; `action-widget.spec.ts` runs the same executor through `invokeCapability`,
 * the policy and the ledger.
 */

const ADD = "com.example.notes.add@1";

function invokeStep(stepId: string, dependsOn: string[] = [], args: Record<string, unknown> = {}): WorkflowStep {
  return { stepId, kind: "invoke", capabilityRef: ADD, args, dependsOn } as WorkflowStep;
}

function done(output: string): CapabilityInvokeOutcome {
  return { kind: "done", ref: ADD, effectCategory: "local-write", output, description: "Add a note" } as CapabilityInvokeOutcome;
}

interface Harness {
  sent: { stepId: string; args: Record<string, unknown>; timeoutMs: number }[];
  audited: WorkflowStepReport[];
}

/**
 * The executor's caller stood in for: `recorded` is what a ledger that can be written makes of the call — held as
 * unknown when it was sent, is not a read, and came back without an answer — unless `ledger` says it could not be.
 */
function harness(
  answer: (step: WorkflowStep, signal: AbortSignal) => Promise<CapabilityInvokeOutcome>,
  options: { ledger?: boolean; nowMs?: () => number } = {},
) {
  const seen: Harness = { sent: [], audited: [] };
  return {
    seen,
    deps: {
      invoke: async (step: WorkflowStep, args: Record<string, unknown>, call: { signal: AbortSignal; timeoutMs: number }) => {
        seen.sent.push({ stepId: step.stepId, args, timeoutMs: call.timeoutMs });
        const outcome = await answer(step, call.signal);
        const unknown = outcome.kind === "refused" && outcome.sent && outcome.effectCategory !== "read";
        return { outcome, recorded: unknown && options.ledger !== false };
      },
      audit: (_step: WorkflowStep, report: WorkflowStepReport) => {
        seen.audited.push(report);
      },
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    },
  };
}

/** A call that answers only when withdrawn, as the service host reports it then. */
function waitForAbort(signal: AbortSignal, effectCategory: "local-write" | "read" = "local-write"): Promise<CapabilityInvokeOutcome> {
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve({ kind: "refused", status: 409, code: "SERVICE_CANCELLED", message: "withdrawn", sent: true, effectCategory }),
      { once: true },
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the order steps run in", () => {
  it("puts every step after what it depends on, and otherwise keeps the order they were written in", () => {
    const steps = [invokeStep("c", ["b"]), invokeStep("a"), invokeStep("b", ["a"]), invokeStep("d")];
    expect(workflowOrder(steps).map((step) => step.stepId)).toEqual(["a", "b", "c", "d"]);
  });

  it("runs nothing when the steps cannot be ordered", () => {
    expect(() => workflowOrder([invokeStep("a", ["b"]), invokeStep("b", ["a"])])).toThrow("missing or circular");
  });
});

describe("transforms and conditions", () => {
  const notes = [
    { id: "n1", text: "mua sữa", tag: "chợ", size: 3 },
    { id: "n2", text: "gọi mẹ", tag: "nhà", size: 7 },
    { id: "n3", text: "mua trứng", tag: "chợ", size: 5 },
  ];
  const transform = (name: string, args: Record<string, unknown> = {}) =>
    ({ stepId: "t", kind: "transform", transform: name, args, dependsOn: [] }) as unknown as WorkflowStep;
  const condition = (field: string, operator: string, value?: unknown) =>
    ({ stepId: "c", kind: "condition", condition: { field, operator, ...(value === undefined ? {} : { value }) }, dependsOn: [] }) as unknown as WorkflowStep;

  it("reshape a value with five pure functions, and leave the value they read as it was", () => {
    const before = JSON.stringify(notes);
    expect(applyTransform(transform("filter-equals", { field: "tag", value: "chợ" }), notes)).toEqual({ ok: true, value: [notes[0], notes[2]] });
    expect(applyTransform(transform("map-field", { field: "text" }), notes)).toEqual({ ok: true, value: ["mua sữa", "gọi mẹ", "mua trứng"] });
    expect(applyTransform(transform("take", { count: 2 }), notes)).toEqual({ ok: true, value: [notes[0], notes[1]] });
    expect(applyTransform(transform("count"), notes)).toEqual({ ok: true, value: 3 });
    expect(applyTransform(transform("select-field", { field: "1.text" }), notes)).toEqual({ ok: true, value: "gọi mẹ" });
    expect(JSON.stringify(notes)).toBe(before);
  });

  it("say why a value is not one they can reshape", () => {
    expect(applyTransform(transform("count"), "not a list")).toEqual({ ok: false, message: "count needs a list" });
    expect(applyTransform(transform("select-field", { field: "missing" }), { a: 1 })).toEqual({ ok: false, message: "the value has no field missing" });
  });

  it("test a field with each operator", () => {
    expect(testCondition(condition("0.tag", "equals", "chợ"), notes)).toBe(true);
    expect(testCondition(condition("0.tag", "not-equals", "chợ"), notes)).toBe(false);
    expect(testCondition(condition("1.size", "greater-than", 5), notes)).toBe(true);
    expect(testCondition(condition("1.size", "less-than", 5), notes)).toBe(false);
    expect(testCondition(condition("9.id", "exists"), notes)).toBe(false);
    // A number compared with text is not a match either way.
    expect(testCondition(condition("0.text", "greater-than", 1), notes)).toBe(false);
  });

  it("are checked when a binding is compiled, so an incomplete one is never stored", () => {
    expect(stepProblem(transform("take", { count: 5_000 }), [])).toContain("take needs args.count");
    expect(stepProblem(transform("filter-equals", { field: "tag" }), [])).toContain("needs args.value");
    expect(stepProblem(invokeStep("b", [], { text: { $step: "a" } }), [])).toContain("does not depend on");
    expect(stepProblem(invokeStep("b", [], { text: { $input: "note" } }), ["itemId"])).toContain("not sent");
    expect(stepProblem(invokeStep("b", ["a"], { text: { $step: "a", field: "text" } }), [])).toBeUndefined();
  });

  it("resolve a step's arguments from earlier outputs and the press, and nothing else", () => {
    const step = invokeStep("b", ["a"], { text: { $step: "a", field: "text" }, id: { $input: "itemId" }, literal: { kept: true } });
    expect(resolveStepArgs(step, new Map([["a", notes[1]]]), { itemId: "t1" })).toEqual({ text: "gọi mẹ", id: "t1", literal: { kept: true } });
  });
});

describe("a run", () => {
  it("runs each step once in order and passes outputs on", async () => {
    const { seen, deps } = harness(async (step) => done(step.stepId === "add" ? JSON.stringify({ id: "n1", text: "mua sữa" }) : "[]"));
    const result = await runWorkflow(deps, {
      steps: [invokeStep("again", ["add"], { text: { $step: "add", field: "id" } }), invokeStep("add", [], { text: "mua sữa" })],
      input: {},
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.report).toMatchObject({ completed: true, message: "Ran 2 of 2 steps." });
    expect(seen.sent.map((call) => [call.stepId, call.args])).toEqual([
      ["add", { text: "mua sữa" }],
      ["again", { text: "n1" }],
    ]);
    expect(seen.audited.map((report) => report.status)).toEqual(["done", "done"]);
  });

  it("stops at the first refusal, names it, and claims no rollback for what ran before it", async () => {
    const { seen, deps } = harness(async (step) =>
      step.stepId === "second" ? { kind: "refused", status: 403, code: "POLICY_REFUSED", message: "your policy refuses local writes", sent: false } : done("ok"),
    );
    const result = await runWorkflow(deps, {
      steps: [invokeStep("first"), invokeStep("second", ["first"]), invokeStep("third", ["second"])],
      input: {},
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.report).toMatchObject({ completed: false, stoppedAt: "second", code: "POLICY_REFUSED" });
    expect(result.report.message).toBe(
      'Stopped at step "second": your policy refuses local writes. "first" ran and stay done — a workflow undoes nothing. "third" did not run.',
    );
    expect(seen.sent.map((call) => call.stepId)).toEqual(["first", "second"]);
    expect(seen.audited.map((report) => [report.stepId, report.status])).toEqual([
      ["first", "done"],
      ["second", "refused"],
    ]);
  });

  it("says nothing changed when it stops before any step that calls a service ran", async () => {
    const { deps } = harness(async () => done("ok"));
    const result = await runWorkflow(deps, {
      steps: [
        { stepId: "count", kind: "transform", transform: "count", dependsOn: [] } as unknown as WorkflowStep,
        invokeStep("add", ["count"]),
      ],
      input: { itemId: "t1" },
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.report.message).toBe('Stopped at step "count": count needs a list. No step that calls a service had run, so nothing changed. "add" did not run.');
  });

  it("ends a step still running at the total deadline as uncertain, with the arguments it was sent", async () => {
    const { seen, deps } = harness((step, signal) => (step.stepId === "slow" ? waitForAbort(signal) : Promise.resolve(done("ok"))));
    const result = await runWorkflow(deps, {
      steps: [invokeStep("fast"), invokeStep("slow", ["fast"], { text: "chậm" }), invokeStep("never", ["slow"])],
      input: {},
      deadlineMs: 600,
      signal: new AbortController().signal,
    });
    expect(result.report).toMatchObject({ completed: false, stoppedAt: "slow", code: "WORKFLOW_DEADLINE" });
    expect(result.report.message).toContain("whether it took effect is unknown. It was not retried; the inbox asks you");
    expect(result.report.steps.find((step) => step.stepId === "slow")).toMatchObject({ status: "uncertain", recorded: true });
    expect(seen.sent.map((call) => [call.stepId, call.args])).toEqual([
      ["fast", {}],
      ["slow", { text: "chậm" }],
    ]);
    // Each step is given what is left of the run's time, never more.
    expect(seen.sent[1]?.timeoutMs).toBeLessThanOrEqual(600);
  });

  it("does not send the next step once a person stopped the run, and leaves nothing uncertain", async () => {
    const stop = new AbortController();
    const { seen, deps } = harness(async (step) => {
      if (step.stepId === "first") stop.abort();
      return done("ok");
    });
    const result = await runWorkflow(deps, {
      steps: [invokeStep("first"), invokeStep("second", ["first"])],
      input: {},
      deadlineMs: 5_000,
      signal: stop.signal,
    });
    expect(result.report).toMatchObject({ completed: false, stoppedAt: "second", code: "WORKFLOW_STOPPED" });
    expect(result.report.message).toContain("a person stopped the workflow before this step ran");
    expect(seen.sent.map((call) => call.stepId)).toEqual(["first"]);
    expect(result.report.steps.map((step) => step.status)).toEqual(["done", "not-run"]);
  });

  it("promises no inbox question when the ledger could not hold the call", async () => {
    const { deps } = harness((step, signal) => waitForAbort(signal), { ledger: false });
    const result = await runWorkflow(deps, { steps: [invokeStep("slow")], input: {}, deadlineMs: 400, signal: new AbortController().signal });
    expect(result.report.steps[0]).toMatchObject({ status: "uncertain", recorded: false });
    expect(result.report.message).toContain("say in the conversation whether it did before running it again");
    expect(result.report.message).not.toContain("inbox");
  });

  it("says a read that did not finish changed nothing, and asks nobody about it", async () => {
    const { deps } = harness((_step, signal) => waitForAbort(signal, "read"));
    const result = await runWorkflow(deps, { steps: [invokeStep("look")], input: {}, deadlineMs: 400, signal: new AbortController().signal });
    expect(result.report).toMatchObject({ completed: false, stoppedAt: "look", code: "WORKFLOW_DEADLINE" });
    expect(result.report.steps[0]).toMatchObject({ status: "failed", readOnly: true });
    expect(result.report.message).toContain("It only reads, so nothing changed.");
    expect(result.report.message).not.toContain("unknown");
  });

  it("reports a step the service never received as refused, not as one that may have run", async () => {
    const { deps } = harness(async () => ({
      kind: "refused",
      status: 503,
      code: "SERVICE_NOT_RUNNING",
      message: "the notes service is not running",
      sent: false,
      effectCategory: "local-write",
    }));
    const result = await runWorkflow(deps, { steps: [invokeStep("add")], input: {}, deadlineMs: 5_000, signal: new AbortController().signal });
    expect(result.report.steps[0]).toMatchObject({ status: "refused" });
    expect(result.report.message).toContain("No step that calls a service had run, so nothing changed.");
  });

  it("does not send a step with less time left than a call needs, and leaves nothing uncertain", async () => {
    let clock = 0;
    const { seen, deps } = harness(
      async () => {
        clock = 5_000 - (MIN_STEP_MS - 1);
        return done("ok");
      },
      { nowMs: () => clock },
    );
    const result = await runWorkflow(deps, {
      steps: [invokeStep("first"), invokeStep("second", ["first"])],
      input: {},
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(seen.sent.map((call) => call.stepId)).toEqual(["first"]);
    expect(result.report).toMatchObject({ completed: false, stoppedAt: "second", code: "WORKFLOW_DEADLINE" });
    expect(result.report.steps.map((step) => step.status)).toEqual(["done", "not-run"]);
  });

  it("leaves no deadline timer behind when a step throws", async () => {
    vi.useFakeTimers();
    const { deps } = harness(async () => {
      throw new Error("the node could not reach its own database");
    });
    await expect(
      runWorkflow(deps, { steps: [invokeStep("add")], input: {}, deadlineMs: 300_000, signal: new AbortController().signal }),
    ).rejects.toThrow("database");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands an approval the policy asked for back to the caller and runs nothing after it", async () => {
    const card = { type: "approval-card", approvalId: "appr_1" };
    const { seen, deps } = harness(async (step) =>
      step.stepId === "ask"
        ? ({ kind: "approval-required", approval: { approvalId: "appr_1" }, card } as unknown as CapabilityInvokeOutcome)
        : done("ok"),
    );
    const result = await runWorkflow(deps, {
      steps: [invokeStep("ask"), invokeStep("after", ["ask"])],
      input: {},
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.approvalCard).toBe(card);
    expect(result.report).toMatchObject({ stoppedAt: "ask", code: "APPROVAL_REQUIRED" });
    expect(result.report.steps.map((step) => step.status)).toEqual(["awaiting-approval", "not-run"]);
    expect(seen.sent).toHaveLength(1);
  });
});

