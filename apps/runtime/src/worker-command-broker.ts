import { type ExecutionIntent, decideExecution, guardrailCovers, recordEffectExecution } from "@clarkcant/core";

import { decideGuardrailForCommand, type CommandToolDeps } from "./node-tools.ts";
import { ownedResources, preflightCommand } from "./preflight.ts";
import { commandDigest, runGuardedCommand } from "./run-command.ts";

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

export function createWorkerCommandBroker(input: {
  command: CommandToolDeps;
  taskId: string;
  conversationId: string;
  /** The folders this task may run commands in. Never the node's other roots. */
  roots: readonly string[];
  intent: ExecutionIntent;
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

    const effectAudit = deps.effectAudit?.();
    if (effectAudit !== undefined) {
      recordEffectExecution(effectAudit.deps, {
        principalId: effectAudit.principalId,
        mode: policy.mode,
        decision,
        category: guarded.effectCategory,
        operationDigest: commandDigest(guarded.command, guarded.cwd),
        conversationId: input.conversationId,
        description: `${guarded.command} — ${guarded.cwd} (task ${input.taskId})`,
      });
    }

    const operationId = deps.newId();
    const ran = await runGuardedCommand({
      operationId,
      envelope: guarded,
      ...(why === "" ? {} : { why }),
      ...(env === undefined ? {} : { env }),
      conversationId: input.conversationId,
      taskId: input.taskId,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.run === undefined ? {} : { run: deps.run }),
    });
    deps.audit?.({
      summary: `${ran.description} (task ${input.taskId})`,
      outcome:
        ran.outcome.stopped === true ? "stopped" : ran.outcome.exitCode === 0 && !ran.outcome.timedOut ? "done" : "failed",
      ref: operationId,
    });
    return { kind: "ran", text: `${ran.description}\n\n${ran.receipt}`, exitCode: ran.outcome.exitCode };
  };
}
