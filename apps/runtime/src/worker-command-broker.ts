import { advanceEffect, type CapabilityRef, type EffectCategory, type EffectRecord } from "@clarkcant/contracts";
import {
  type ExecutionIntent,
  type TaskServiceDeps,
  decideExecution,
  guardrailCovers,
  markEffectUnknown,
  prepareEffect,
  recordEffectExecution,
} from "@clarkcant/core";
import { effectsForTask, upsertEffect } from "@clarkcant/storage";

import { decideGuardrailForCommand, type CommandToolDeps } from "./node-tools.ts";
import { ownedResources, preflightCommand } from "./preflight.ts";
import { commandDigest, refusingNewCommands, runGuardedCommand, type CommandOutcome } from "./run-command.ts";

/**
 * Commands a task's worker asks the host to run.
 *
 * A worker is a separate process with no database, no policy and no secrets, and it is where the model's tool calls
 * land during a background task. Giving it a shell would give the model a path around everything the conversation's
 * `run_command` goes through. So the worker's `run_command` is a request, sent to the node over the worker's IPC
 * channel, and this is what answers it: the same preflight, the same policy decision, the same judgment layer, the same
 * secret injection and the same two records, with two differences that follow from who is asking.
 *
 *   - The folders are the task's own, not the node's. A command runs inside one of the roots the dispatcher gave this
 *     task (its folder, or the worktree it made of a repository) or is refused before anything is decided about it.
 *   - Nobody is holding a turn to be asked. Where the conversation's tool would put a card in front of a person, this
 *     refuses and says why, and the task reports that it could not finish; it never waits on a question no one sees.
 *
 * The intent is the task's: a person asking in the conversation, an automation acting for the effects it was given, or
 * the node's own work. That is what lets Autonomous run `git push` for an automation set up to open pull requests and
 * still ask before one that was never given external writes.
 *
 * A command that reaches outside the node — that `git push` — is also written into the task's effect ledger before it
 * starts and settled on what it reported, so one that was stopped, timed out or outlived by its node reads as `unknown`
 * rather than as done or as never having happened, and is not run a second time on its own.
 */

export interface WorkerCommandRequest {
  command: string;
  /** A directory inside one of the task's roots. Absent means the first of them. */
  cwd?: string;
  why?: string;
  /** A secret this one command needs, injected into its environment by the broker. Never returned. */
  secretRef?: string;
  secretEnvVar?: string;
}

export type WorkerCommandReply =
  | { kind: "ran"; text: string; exitCode: number | null }
  | { kind: "refused"; text: string };

const MAX_COMMAND_CHARS = 4000;
const MAX_FIELD_CHARS = 1000;

/**
 * Read a request that arrived from another process.
 *
 * The worker is this repository's own code, but what it sends is what a model asked for, so the shape is checked here
 * rather than trusted: a field of the wrong type or length is a refusal, never a command.
 */
export function parseWorkerCommandRequest(value: unknown): WorkerCommandRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const text = (key: string, max: number): string | undefined | null => {
    const field = source[key];
    if (field === undefined) return undefined;
    if (typeof field !== "string" || field.length > max) return null;
    return field;
  };
  const command = text("command", MAX_COMMAND_CHARS);
  if (typeof command !== "string" || command.trim() === "") return undefined;
  const optional = ["cwd", "why", "secretRef", "secretEnvVar"] as const;
  const request: WorkerCommandRequest = { command: command.trim() };
  for (const key of optional) {
    const field = text(key, MAX_FIELD_CHARS);
    if (field === null) return undefined;
    if (field !== undefined && field.trim() !== "") request[key] = field.trim();
  }
  return request;
}

/** The capability a brokered command is carried out under, which is how the effect ledger names it. */
const COMMAND_CAPABILITY = "project.command.run@1" as CapabilityRef;

/**
 * The commands whose outcome the effect ledger follows.
 *
 * The ones that reach past what the node can read back in place: a push, a message sent, a payment, or a deletion that
 * cannot be taken back. A change inside the task's own folder is not here, because its outcome is on disk in that
 * folder (a worktree with uncommitted changes is kept, and the person told where), so there is nothing to reconcile
 * against. A read changes nothing.
 */
const LEDGERED_CATEGORIES: ReadonlySet<EffectCategory> = new Set<EffectCategory>([
  "external-write",
  "destructive",
  "financial",
  "communication",
]);

/** Where a task's commands are written into the effect ledger, and the run they belong to. */
export interface CommandLedger {
  deps: TaskServiceDeps;
  runId?: string;
}

/**
 * Write the effect down as handed off, before the command starts.
 *
 * Prepared and submitted in the same breath, because nothing stands between the two for a command: the decision is
 * already made. What matters is that the row exists before the process does, so a node that dies while the command
 * runs leaves a `submitted` row the next boot can call unknown, rather than no trace of an effect that may have landed.
 */
function openCommandEffect(
  ledger: CommandLedger,
  input: { taskId: string; category: EffectCategory; command: string; cwd: string; operationDigest: string },
): EffectRecord {
  const prepared = prepareEffect(ledger.deps, {
    taskId: input.taskId,
    ...(ledger.runId === undefined ? {} : { runId: ledger.runId }),
    executorNodeId: ledger.deps.nodeId,
    category: input.category,
    capabilityRef: COMMAND_CAPABILITY,
    intent: `${input.command} — ${input.cwd}`.slice(0, 2000),
    operationDigest: input.operationDigest,
    externalSupportsDedup: false,
  });
  const submitted = advanceEffect(prepared, { to: "submitted", at: ledger.deps.now() });
  if (!submitted.ok) throw new Error(submitted.message);
  upsertEffect(ledger.deps.db, submitted.effect);
  return submitted.effect;
}

/**
 * Why a finished command's effect cannot be called either way, or nothing when its exit status says.
 *
 * A command stopped, timed out or killed never reported, so whether a push or a send got through is not known — which
 * is the ledger's `unknown`, not a failure. An exit status is the command's own report: zero confirms it, anything else
 * says it did not do what it was asked.
 */
export function unknownCommandOutcome(outcome: CommandOutcome | undefined): string | undefined {
  if (outcome === undefined) return "the command runner failed before it reported an outcome";
  if (outcome.stopped === true) return "the command was stopped before it finished";
  if (outcome.timedOut) return `the command ran out of time after ${String(outcome.durationMs)} ms and was stopped`;
  if (outcome.exitCode === null) return "the command ended without an exit status";
  return undefined;
}

/**
 * Settle the effect on what the command reported.
 *
 * Unknown moves the task to `uncertain` in the same write, through the task machine, so the task cannot read as
 * progressing while one of its effects is undetermined. When the task can no longer take that event (it is already
 * uncertain from an earlier effect), the row is still moved: the ledger must never keep saying `submitted` for a command
 * that has ended. A write that fails is reported and left: the row stays `submitted`, and the next boot calls it unknown.
 */
function settleCommandEffect(ledger: CommandLedger, effect: EffectRecord, outcome: CommandOutcome | undefined): void {
  try {
    const at = ledger.deps.now();
    const reason = unknownCommandOutcome(outcome);
    if (reason !== undefined) {
      if (markEffectUnknown(ledger.deps, effect.effectId, reason).ok) return;
      const moved = advanceEffect(effect, { to: "unknown", at, reason });
      if (moved.ok) upsertEffect(ledger.deps.db, moved.effect);
      return;
    }
    const exitCode = outcome?.exitCode ?? null;
    const moved = advanceEffect(
      effect,
      exitCode === 0
        ? { to: "confirmed", at, evidence: "the command exited with status 0" }
        : { to: "failed", at, evidence: `the command exited with status ${String(exitCode)}` },
    );
    if (moved.ok) upsertEffect(ledger.deps.db, moved.effect);
  } catch (cause) {
    process.stderr.write(
      `effect ledger: could not settle ${effect.effectId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

export function createWorkerCommandBroker(input: {
  command: CommandToolDeps;
  taskId: string;
  conversationId: string;
  /** The folders this task may run commands in. Never the node's other roots. */
  roots: readonly string[];
  intent: ExecutionIntent;
  /**
   * Where a command that reaches outside the node is written into the effect ledger. Absent means nothing is written,
   * which is only right for a caller with no task row to write against.
   */
  ledger?: CommandLedger;
}): (request: WorkerCommandRequest) => Promise<WorkerCommandReply> {
  const deps = input.command;
  const refuse = (text: string): WorkerCommandReply => {
    deps.audit?.({ summary: text, outcome: "refused", ref: input.taskId });
    return { kind: "refused", text };
  };

  return async (request) => {
    const first = input.roots[0];
    if (first === undefined) return refuse("refused: this task has no folder it may run commands in");

    const preflight = preflightCommand({
      command: request.command,
      cwd: request.cwd,
      resources: ownedResources(input.roots),
      fallbackCwd: first,
    });
    if (!preflight.ok) return refuse(`refused: ${preflight.message}`);
    if (preflight.envelope.kind !== "command") return refuse("refused: only a shell command can be run here");
    const envelope = preflight.envelope;
    const why = request.why ?? "";

    const policy = deps.autonomy();
    const decision = decideExecution({
      policy,
      action: {
        kind: "effect",
        category: envelope.effectCategory,
        operationDigest: commandDigest(envelope.command, envelope.cwd),
      },
      intent: input.intent,
    });
    if (decision.kind === "deny") return refuse(`refused: ${decision.reason}; nothing was run`);

    let guarded = envelope;
    if (guardrailCovers(policy, envelope)) {
      const judgment = await decideGuardrailForCommand(deps, { policy, envelope, why });
      if (judgment.kind === "refuse") return refuse(judgment.text);
      if (judgment.kind === "ask") {
        return refuse(
          `not run: the guardrail needs a person to say what this command is aimed at ("${judgment.question}"), and a background task has nobody to ask`,
        );
      }
      guarded = judgment.envelope;
    }

    if (decision.kind === "ask") {
      return refuse(
        `not run: ${decision.approvalSpec.because}, so it needs a person's approval, and a background task does not ` +
          `wait on a card nobody is looking at; say so in the result rather than trying another way`,
      );
    }

    let env: Record<string, string> | undefined;
    if (request.secretRef !== undefined) {
      if (deps.broker === undefined) return refuse("refused: this node has no secret broker, so the secret was not injected");
      const executable = guarded.command.split(/\s+/)[0] ?? "";
      const built = deps.broker.environmentFor(
        { name: request.secretRef, consumer: `command:${executable}` },
        request.secretEnvVar ?? request.secretRef.toUpperCase(),
      );
      if (!built.ok) return refuse(`refused: ${built.message}`);
      env = built.env;
    }

    const operationDigest = commandDigest(guarded.command, guarded.cwd);
    const ledger = input.ledger !== undefined && LEDGERED_CATEGORIES.has(guarded.effectCategory) ? input.ledger : undefined;
    let effect: EffectRecord | undefined;
    if (ledger !== undefined) {
      // A command that would not start must not be written down as handed off: that row would read as an effect nobody
      // can say landed, for something that never ran.
      if (refusingNewCommands()) return refuse("refused: this node is shutting down; nothing was run");
      // The same command, in the same folder, still waiting on an outcome: running it again is how a push or a send
      // happens twice. Someone has to look first.
      const pending = effectsForTask(ledger.deps.db, input.taskId).find(
        (earlier) => earlier.operationDigest === operationDigest && (earlier.state === "submitted" || earlier.state === "unknown"),
      );
      if (pending !== undefined) {
        return refuse(
          `not run: this exact command already ran for this task and ${pending.state === "unknown" ? "whether it took effect is not known" : "has not reported back yet"}; ` +
            `running it again could do it twice, so check whether it took effect first`,
        );
      }
      try {
        effect = openCommandEffect(ledger, {
          taskId: input.taskId,
          category: guarded.effectCategory,
          command: guarded.command,
          cwd: guarded.cwd,
          operationDigest,
        });
      } catch (cause) {
        return refuse(
          `refused: the command could not be written down before it ran (${cause instanceof Error ? cause.message : String(cause)}); nothing was run`,
        );
      }
    }

    const effectAudit = deps.effectAudit?.();
    if (effectAudit !== undefined) {
      recordEffectExecution(effectAudit.deps, {
        principalId: effectAudit.principalId,
        mode: policy.mode,
        decision,
        category: guarded.effectCategory,
        operationDigest,
        conversationId: input.conversationId,
        description: `${guarded.command} — ${guarded.cwd} (task ${input.taskId})`,
      });
    }

    const operationId = deps.newId();
    let ran: Awaited<ReturnType<typeof runGuardedCommand>>;
    try {
      ran = await runGuardedCommand({
        operationId,
        envelope: guarded,
        ...(why === "" ? {} : { why }),
        ...(env === undefined ? {} : { env }),
        conversationId: input.conversationId,
        taskId: input.taskId,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.run === undefined ? {} : { run: deps.run }),
      });
    } catch (cause) {
      if (ledger !== undefined && effect !== undefined) settleCommandEffect(ledger, effect, undefined);
      throw cause;
    }
    if (ledger !== undefined && effect !== undefined) settleCommandEffect(ledger, effect, ran.outcome);
    deps.audit?.({
      summary: `${ran.description} (task ${input.taskId})`,
      outcome:
        ran.outcome.stopped === true ? "stopped" : ran.outcome.exitCode === 0 && !ran.outcome.timedOut ? "done" : "failed",
      ref: operationId,
    });
    return { kind: "ran", text: `${ran.description}\n\n${ran.receipt}`, exitCode: ran.outcome.exitCode };
  };
}
