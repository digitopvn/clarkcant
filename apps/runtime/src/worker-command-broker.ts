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
import { effectsForTask, transaction, upsertEffect } from "@clarkcant/storage";

import { COMMAND_STOPPED_ON_REQUEST } from "./effect-notices.ts";
import { decideGuardrailForCommand, type CommandToolDeps } from "./node-tools.ts";
import { changesSomethingOutside, commandSegmentCount, ownedResources, preflightCommand } from "./preflight.ts";
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
 * A command that changes something outside the node — that `git push` — is also written into the task's effect ledger
 * before it starts and settled on what it reported, so one that was stopped, timed out or outlived by its node reads as
 * `unknown` rather than as done or as never having happened. Once a task has one of those, nothing else it asks for
 * that reaches outside is run: however it is worded, a second attempt could do the same thing twice.
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
 * The category a command is written into the ledger under, or nothing when the ledger does not follow it.
 *
 * Only a command that changes something outside the node (`changesSomethingOutside`): its outcome is on the other
 * side, where nothing on this node can read it back. Everything else — a read, a build, a commit, or deleting a folder
 * on this machine — leaves its outcome on disk here or changes nothing, so there is nothing to reconcile, and a timeout
 * on it (`gh pr checks --watch` running out of time) must not turn the whole task uncertain. `git push --force` is both
 * destructive and outside, and keeps the destructive reading.
 */
function ledgerCategory(command: string, classified: EffectCategory): EffectCategory | undefined {
  if (!changesSomethingOutside(command)) return undefined;
  return classified === "destructive" ? "destructive" : "external-write";
}

/** Where a task's commands are written into the effect ledger, and the run they belong to. */
export interface CommandLedger {
  deps: TaskServiceDeps;
  runId?: string;
}

/**
 * Write the effect down as handed off, before the command starts.
 *
 * Prepared and submitted in one transaction, because nothing stands between the two for a command: the decision is
 * already made, and a `prepared` row left alone by a failed second write would read as work nobody handed off. What
 * matters is that the row exists before the process does, so a node that dies while the command runs leaves a
 * `submitted` row the next boot can call unknown, rather than no trace of an effect that may have landed.
 */
function openCommandEffect(
  ledger: CommandLedger,
  input: { taskId: string; category: EffectCategory; command: string; cwd: string; operationDigest: string },
): EffectRecord {
  return transaction(ledger.deps.db, () => {
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
  });
}

/**
 * Why a ledgered command must not run now, or nothing when it may.
 *
 * An earlier effect of this task whose outcome is not known stops every later one, not only the same line again:
 * `git push -u origin feat` and `git push origin HEAD:refs/heads/feat` are the same push in other words, and no digest
 * tells them apart. The task cannot succeed with an unknown effect anyway, so nothing is lost by stopping here, and
 * the refusal says what to put in the result instead — the way a refusal for want of an approval does. An earlier run
 * of this exact line still waiting on its own answer is refused for the same reason.
 */
function ledgerRefusal(effects: readonly EffectRecord[], operationDigest: string): string | undefined {
  const unknown = effects.find((earlier) => earlier.state === "unknown");
  if (unknown !== undefined) {
    const earlier = unknown.intent.split(" — ")[0] ?? unknown.intent;
    return (
      `not run: an earlier command of this task ("${earlier}") may or may not have taken effect, and nothing on this ` +
      `node can tell which; anything else that reaches outside could do the same thing twice. Say in the result that ` +
      `"${earlier}" may or may not have landed and what you observed, rather than trying this or another way`
    );
  }
  const pending = effects.find((earlier) => earlier.state === "submitted" && earlier.operationDigest === operationDigest);
  if (pending !== undefined) {
    return "not run: this exact command already ran for this task and has not reported back yet; running it again could do it twice";
  }
  return undefined;
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
  if (outcome.stopped === true) return COMMAND_STOPPED_ON_REQUEST;
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

/**
 * The broker: answer one request, and `idle()` to wait for every request still being answered.
 *
 * `idle` is for whoever settles the task. A worker that was stopped or crashed is gone while a command it asked for may
 * still be ending on the host, and that command's ledger row is only settled when it does; a task settled before then
 * is reported without the one fact that matters most — that an effect of it may or may not have landed.
 */
export type WorkerCommandBroker = ((request: WorkerCommandRequest) => Promise<WorkerCommandReply>) & {
  idle: () => Promise<void>;
};

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
}): WorkerCommandBroker {
  const deps = input.command;
  const refuse = (text: string): WorkerCommandReply => {
    deps.audit?.({ summary: text, outcome: "refused", ref: input.taskId });
    return { kind: "refused", text };
  };

  const answering = new Set<Promise<WorkerCommandReply>>();
  const broker = (request: WorkerCommandRequest): Promise<WorkerCommandReply> => {
    const answer = answerRequest(request);
    answering.add(answer);
    const done = (): void => {
      answering.delete(answer);
    };
    answer.then(done, done);
    return answer;
  };
  const idle = async (): Promise<void> => {
    await Promise.allSettled([...answering]);
  };

  async function answerRequest(request: WorkerCommandRequest): Promise<WorkerCommandReply> {
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
    const category = input.ledger === undefined ? undefined : ledgerCategory(guarded.command, guarded.effectCategory);
    const ledger = category === undefined ? undefined : input.ledger;
    let effect: EffectRecord | undefined;
    if (ledger !== undefined && category !== undefined) {
      // A command that would not start must not be written down as handed off: that row would read as an effect nobody
      // can say landed, for something that never ran.
      if (refusingNewCommands()) return refuse("refused: this node is shutting down; nothing was run");
      // One exit status for several commands says nothing certain about the one that reached outside: `git push && gh
      // pr create` failing may be a push that landed and a pull request that did not. Run on its own, the status is its own.
      if (commandSegmentCount(guarded.command) > 1) {
        return refuse(
          "not run: this line joins a command that reaches outside the node to other commands, so its exit status would " +
            "not say whether that part took effect; run the part that reaches outside as a command of its own",
        );
      }
      const refusal = ledgerRefusal(effectsForTask(ledger.deps.db, input.taskId), operationDigest);
      if (refusal !== undefined) return refuse(refusal);
      try {
        effect = openCommandEffect(ledger, {
          taskId: input.taskId,
          category,
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
        // The owner's language, as on the guarded path, so the row, the receipt and the audit line read the same.
        ...(deps.language === undefined ? {} : { language: deps.language() }),
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
  }

  return Object.assign(broker, { idle });
}
