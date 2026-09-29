import type { MessageBlock, WorkflowRunReport, WorkflowStep, WorkflowStepReport } from "@clarkcant/contracts";

import { WorkAbort } from "../work-supervisor.ts";
import { answerNeverCame, type CapabilityInvokeOutcome } from "./capability-invoke.ts";

/**
 * Running a workflow binding: a bounded sequence of steps over capabilities this node already runs.
 *
 * The vocabulary is closed and has no code in it. A step is one of three things:
 *
 *   - `invoke` calls a package service capability through `invokeCapability`, the same gate a button and a sentence
 *     reach — its own registry check, schema check, policy decision and, when the policy asks, its own approval card;
 *   - `transform` reshapes the output of the step it depends on with one of five pure functions;
 *   - `condition` tests that output, and the steps that depend on a false condition are skipped.
 *
 * Steps run one at a time in `dependsOn` order, inside one deadline for the whole run. The run stops at the first step
 * that does not complete — a refusal, a failure, an approval to wait for, an answer that never came, a person's Stop —
 * and says which step that was. What the steps before it did stays done: a workflow has no rollback, and the report
 * never claims one.
 *
 * An argument of an `invoke` step may take a value from earlier in the run instead of a literal: `{"$step": "<id>"}`
 * is a step's output (the step must be one this step depends on), `{"$step": "<id>", "field": "<path>"}` one field of
 * it, and `{"$input": "<key>"}` a value the person sent with the press. Nothing else is interpreted.
 */

/** How many items a `take` may keep, and how long a report's output may be. */
const TAKE_MAX = 1_000;
const OUTPUT_CHARS = 2_000;
const DETAIL_CHARS = 200;

type Value = unknown;

/** The order steps run in: every step after the steps it depends on, and otherwise in the order they were written. */
export function workflowOrder(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const done = new Set<string>();
  const ordered: WorkflowStep[] = [];
  const pending = [...steps];
  while (pending.length > 0) {
    const index = pending.findIndex((step) => step.dependsOn.every((dependency) => done.has(dependency)));
    // Compilation refuses a cycle and an unknown dependency; a binding that still has one runs nothing.
    if (index < 0) throw new Error("the workflow's steps cannot be ordered: a dependency is missing or circular");
    const [next] = pending.splice(index, 1);
    if (next === undefined) break;
    ordered.push(next);
    done.add(next.stepId);
  }
  return ordered;
}

function readPath(value: Value, path: string): Value {
  if (path === ".") return value;
  let current: Value = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else {
      current = Object.hasOwn(current, part) ? (current as Record<string, unknown>)[part] : undefined;
    }
  }
  return current;
}

function sameValue(left: Value, right: Value): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

/** What a step needs besides its kind, checked when the binding is compiled; `undefined` when the step is complete. */
export function stepProblem(step: WorkflowStep, inputKeys: readonly string[]): string | undefined {
  const args = step.args ?? {};
  const field = args.field;
  switch (step.kind) {
    case "invoke": {
      for (const [name, value] of Object.entries(args)) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const reference = value as Record<string, unknown>;
        if (Object.hasOwn(reference, "$step")) {
          const from = reference.$step;
          if (typeof from !== "string" || !step.dependsOn.includes(from)) {
            return `step ${step.stepId}: ${name} takes the output of ${String(from)}, which this step does not depend on`;
          }
          if (reference.field !== undefined && typeof reference.field !== "string") {
            return `step ${step.stepId}: ${name}.field must be a field path`;
          }
        } else if (Object.hasOwn(reference, "$input")) {
          if (typeof reference.$input !== "string" || !inputKeys.includes(reference.$input)) {
            return `step ${step.stepId}: ${name} takes ${String(reference.$input)}, which this action is not sent`;
          }
        }
      }
      return undefined;
    }
    case "transform": {
      if (step.transform === "select-field" || step.transform === "map-field" || step.transform === "filter-equals") {
        if (typeof field !== "string" || field === "") return `step ${step.stepId}: ${step.transform} needs args.field`;
      }
      if (step.transform === "filter-equals" && !Object.hasOwn(args, "value")) {
        return `step ${step.stepId}: filter-equals needs args.value`;
      }
      if (step.transform === "take") {
        const count = args.count;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > TAKE_MAX) {
          return `step ${step.stepId}: take needs args.count, a whole number from 0 to ${String(TAKE_MAX)}`;
        }
      }
      return undefined;
    }
    case "condition":
      return step.condition === undefined ? `step ${step.stepId}: a condition step needs condition` : undefined;
  }
}

/** Apply one transform. Pure: the same value and step give the same answer, and nothing outside is read or written. */
export function applyTransform(step: WorkflowStep, value: Value): { ok: true; value: Value } | { ok: false; message: string } {
  const args = step.args ?? {};
  const field = typeof args.field === "string" ? args.field : ".";
  const list = (): Value[] | undefined => (Array.isArray(value) ? value : undefined);
  switch (step.transform) {
    case "select-field": {
      const selected = readPath(value, field);
      return selected === undefined ? { ok: false, message: `the value has no field ${field}` } : { ok: true, value: selected };
    }
    case "filter-equals": {
      const items = list();
      if (items === undefined) return { ok: false, message: "filter-equals needs a list" };
      return { ok: true, value: items.filter((item) => sameValue(readPath(item, field), args.value)) };
    }
    case "map-field": {
      const items = list();
      if (items === undefined) return { ok: false, message: "map-field needs a list" };
      return { ok: true, value: items.map((item) => readPath(item, field) ?? null) };
    }
    case "take": {
      const items = list();
      if (items === undefined) return { ok: false, message: "take needs a list" };
      const count = typeof args.count === "number" ? Math.max(0, Math.min(TAKE_MAX, Math.floor(args.count))) : 0;
      return { ok: true, value: items.slice(0, count) };
    }
    case "count": {
      const items = list();
      return items === undefined ? { ok: false, message: "count needs a list" } : { ok: true, value: items.length };
    }
    case undefined:
      return { ok: false, message: "the step names no transform" };
  }
}

/** Test one condition against a value. Pure, like a transform. */
export function testCondition(step: WorkflowStep, value: Value): boolean {
  const condition = step.condition;
  if (condition === undefined) return false;
  const actual = readPath(value, condition.field);
  switch (condition.operator) {
    case "equals":
      return sameValue(actual, condition.value);
    case "not-equals":
      return !sameValue(actual, condition.value);
    case "exists":
      return actual !== undefined && actual !== null;
    case "greater-than":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "less-than":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
  }
}

/** A service's answer as a value: JSON when it is JSON, the text otherwise. */
export function outputValue(output: string): Value {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as Value;
    } catch {
      return output;
    }
  }
  return output;
}

/** The arguments an `invoke` step is called with: its literals, with each reference replaced by what it names. */
export function resolveStepArgs(
  step: WorkflowStep,
  outputs: ReadonlyMap<string, Value>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(step.args ?? {})) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const reference = value as Record<string, unknown>;
      if (typeof reference.$step === "string") {
        const from = outputs.get(reference.$step);
        resolved[name] = typeof reference.field === "string" ? readPath(from, reference.field) : from;
        continue;
      }
      if (typeof reference.$input === "string") {
        resolved[name] = input[reference.$input];
        continue;
      }
    }
    resolved[name] = value;
  }
  return resolved;
}

function textOf(value: Value): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function named(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

export interface WorkflowRunDeps {
  /** Call one `invoke` step's capability through the shared gate. */
  invoke: (
    step: WorkflowStep,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<CapabilityInvokeOutcome>;
  /** One audit row per step, whatever it came to. */
  audit: (step: WorkflowStep, report: WorkflowStepReport) => void;
  /**
   * A step was sent and its answer never came back. The caller writes it into the effect ledger so a person can say
   * later whether it took effect; nothing here retries it.
   */
  uncertain: (step: WorkflowStep, reason: { code: string; message: string; stopped: boolean; args: Record<string, unknown> }) => void;
  nowMs?: () => number;
}

export interface WorkflowRunResult {
  report: WorkflowRunReport;
  /** The approval card a step asked for, for the caller to place in the conversation. */
  approvalCard?: Extract<MessageBlock, { type: "approval-card" }>;
}

/**
 * Run a workflow's steps, stopping at the first that does not complete.
 *
 * `signal` is the person's Stop; the deadline is the run's own, and both reach a service call in flight. A stop or the
 * deadline between steps stops the run before the next step is sent, which leaves nothing uncertain; during a call it
 * withdraws the call, and that step is reported as uncertain rather than as not done.
 */
export async function runWorkflow(
  deps: WorkflowRunDeps,
  input: { steps: readonly WorkflowStep[]; input: Record<string, unknown>; deadlineMs: number; signal: AbortSignal },
): Promise<WorkflowRunResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const started = nowMs();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new WorkAbort("deadline", `the workflow ran past its ${String(Math.ceil(input.deadlineMs / 1000))} s`)),
    input.deadlineMs,
  );
  const signal = AbortSignal.any([input.signal, deadline.signal]);

  const ordered = workflowOrder(input.steps);
  const reports = new Map<string, WorkflowStepReport>(
    ordered.map((step) => [step.stepId, { stepId: step.stepId, kind: step.kind, status: "not-run" }]),
  );
  const outputs = new Map<string, Value>();
  const skipped = new Set<string>();
  let approvalCard: WorkflowRunResult["approvalCard"];
  let lastOutput: Value;

  const finish = (stop?: { step: WorkflowStep; code: string; message: string }): WorkflowRunResult => {
    clearTimeout(timer);
    const steps = ordered.map((step) => reports.get(step.stepId) ?? { stepId: step.stepId, kind: step.kind, status: "not-run" as const });
    const ran = steps.filter((step) => step.status === "done" && step.kind === "invoke").map((step) => step.stepId);
    const notRun = steps.filter((step) => step.status === "not-run").map((step) => step.stepId);
    const output = lastOutput === undefined ? undefined : clip(textOf(lastOutput), OUTPUT_CHARS);
    if (stop === undefined) {
      const skippedNote = skipped.size === 0 ? "" : ` ${named([...skipped])} skipped because a condition was not met.`;
      return {
        report: {
          completed: true,
          steps,
          message: `Ran ${String(steps.filter((step) => step.status === "done").length)} of ${String(steps.length)} steps.${skippedNote}`,
          ...(output === undefined ? {} : { output }),
        },
      };
    }
    const stoppedStatus = reports.get(stop.step.stepId)?.status;
    const reachedService = stoppedStatus === "failed" && stop.step.kind === "invoke";
    const kept =
      ran.length > 0
        ? `${named(ran)} ran and stay done — a workflow undoes nothing.`
        : reachedService || stoppedStatus === "uncertain"
          ? "No step before it had called a service."
          : "No step that calls a service had run, so nothing changed.";
    const rest = notRun.length === 0 ? "" : ` ${named(notRun)} did not run.`;
    return {
      report: {
        completed: false,
        steps,
        stoppedAt: stop.step.stepId,
        code: stop.code,
        message: `Stopped at step "${stop.step.stepId}": ${stop.message} ${kept}${rest}`,
        ...(output === undefined ? {} : { output }),
      },
      ...(approvalCard === undefined ? {} : { approvalCard }),
    };
  };

  const settle = (step: WorkflowStep, report: WorkflowStepReport): void => {
    reports.set(step.stepId, report);
    deps.audit(step, report);
  };

  for (const step of ordered) {
    if (step.dependsOn.some((dependency) => skipped.has(dependency))) {
      skipped.add(step.stepId);
      settle(step, { stepId: step.stepId, kind: step.kind, status: "skipped", detail: "a condition it depends on was not met" });
      continue;
    }
    if (signal.aborted) {
      const byPerson = input.signal.aborted;
      return finish({
        step,
        code: byPerson ? "WORKFLOW_STOPPED" : "WORKFLOW_DEADLINE",
        message: byPerson
          ? "a person stopped the workflow before this step ran."
          : `the workflow ran out of its ${String(Math.ceil(input.deadlineMs / 1000))} s before this step ran.`,
      });
    }
    const from = step.dependsOn[0];
    const value: Value = from === undefined ? input.input : outputs.get(from);

    if (step.kind === "transform") {
      const applied = applyTransform(step, value);
      if (!applied.ok) {
        settle(step, { stepId: step.stepId, kind: step.kind, status: "failed", detail: applied.message });
        return finish({ step, code: "WORKFLOW_STEP_FAILED", message: `${applied.message}.` });
      }
      outputs.set(step.stepId, applied.value);
      lastOutput = applied.value;
      settle(step, { stepId: step.stepId, kind: step.kind, status: "done", detail: clip(textOf(applied.value), DETAIL_CHARS) });
      continue;
    }

    if (step.kind === "condition") {
      const met = testCondition(step, value);
      outputs.set(step.stepId, value);
      if (!met) skipped.add(step.stepId);
      settle(step, {
        stepId: step.stepId,
        kind: step.kind,
        status: met ? "done" : "skipped",
        detail: met ? "the condition was met" : "the condition was not met",
      });
      continue;
    }

    const remaining = input.deadlineMs - (nowMs() - started);
    const args = resolveStepArgs(step, outputs, input.input);
    const outcome = await deps.invoke(step, args, {
      signal,
      timeoutMs: Math.max(1, remaining),
    });
    if (outcome.kind === "done") {
      const produced = outputValue(outcome.output);
      outputs.set(step.stepId, produced);
      lastOutput = produced;
      settle(step, { stepId: step.stepId, kind: step.kind, status: "done", detail: clip(outcome.output, DETAIL_CHARS) });
      continue;
    }
    if (outcome.kind === "approval-required") {
      approvalCard = outcome.card;
      settle(step, { stepId: step.stepId, kind: step.kind, status: "awaiting-approval", detail: outcome.approval.approvalId });
      return finish({
        step,
        code: "APPROVAL_REQUIRED",
        message:
          "it needs your approval, and the card is in the conversation. Approving it runs that step on its own; the steps after it are not run by the approval.",
      });
    }
    if (answerNeverCame(outcome.code)) {
      // The deadline and a person's Stop both reach the call as the same signal; which one it was decides the words.
      const stopped = input.signal.aborted;
      const why = stopped ? "a person stopped it while it ran" : `the workflow's ${String(Math.ceil(input.deadlineMs / 1000))} s ran out while it ran`;
      deps.uncertain(step, { code: outcome.code, message: outcome.message, stopped, args });
      settle(step, { stepId: step.stepId, kind: step.kind, status: "uncertain", detail: why });
      return finish({
        step,
        code: stopped ? "WORKFLOW_STOPPED" : "WORKFLOW_DEADLINE",
        message: `it was sent, but ${why}, so whether it took effect is unknown. It was not retried; the inbox asks you to say whether it did.`,
      });
    }
    const status = outcome.code === "SERVICE_TOOL_FAILED" || outcome.code === "SERVICE_UNREACHABLE" ? "failed" : "refused";
    settle(step, { stepId: step.stepId, kind: step.kind, status, detail: clip(outcome.message, DETAIL_CHARS) });
    return finish({
      step,
      code: outcome.code,
      message:
        status === "failed"
          ? `${outcome.message} — the request reached the service, so it may have done part of it.`
          : `${outcome.message}.`,
    });
  }
  return finish();
}
