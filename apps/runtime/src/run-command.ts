import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

import type { Instant, MessageBlock } from "@clarkcant/contracts";

import { preflightCommand, type CommandEnvelope, type OwnedResources } from "./preflight.ts";

/**
 * Running one command, in the directory it was asked for, once a person has approved it.
 *
 * This is the module the design deliberately did not have: a conversation turn had no way to touch the
 * machine at all, so an agent asked to clone a repository could only explain, accurately, that it had
 * no shell. What makes it safe to add is not the command itself but the two things around it — the
 * directory is confined to an approved root, and nothing runs until a user approves the exact text that
 * will run (see `commandDigest`).
 *
 * Four limits, and each exists for a failure that actually happens:
 *
 *   - **Containment.** `cwd` must resolve inside an approved root, so the command runs where the user
 *     allowed work to happen rather than wherever the process happens to be.
 *   - **A deadline.** A command that hangs — a prompt waiting for input, a network fetch that never
 *     returns — is killed rather than holding a turn open.
 *   - **Output ceilings.** A command that prints a megabyte is not evidence, it is a transcript flood.
 *   - **A length ceiling on the command.** A command long enough to be a script belongs in a file, where
 *     the user can read it before approving.
 */

export const COMMAND_LIMITS = {
  /** Long enough for a real one-liner, short enough that the user can read it in the card. */
  maxCommandLength: 2_000,
  /** Two minutes: a clone or a test run fits; a hang does not survive. */
  timeoutMs: 120_000,
  /** Per stream. The output is quoted back into the conversation, which is not a log viewer. */
  maxOutputBytes: 8_000,
} as const;

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * Killed because somebody stopped this node's work, rather than because it ran out of time.
   *
   * A distinct fact on purpose: a timeout is the command's own failure and a stop is a person's decision, and an
   * audit trail that could not tell them apart would be a trail that misleads the next reader.
   */
  stopped?: boolean;
}

/**
 * Every command this process is running.
 *
 * Kept here rather than on the command's caller because a stop has to reach a child process nobody is holding a
 * reference to: the promise is what the caller awaits, and killing it needs the process, not the promise.
 */
const liveCommands = new Map<ChildProcess, RunningCommand>();
const stoppedByRequest = new Set<ChildProcess>();

/**
 * Kill everything running, and say how many there were.
 *
 * The emergency stop's command half. It kills rather than asks: the point of a stop is that it works on a command
 * that is not listening, and a well-behaved shutdown is what a deadline is for.
 */
export function stopRunningCommands(): number {
  const running = [...liveCommands.keys()];
  for (const child of running) {
    stoppedByRequest.add(child);
    killTree(child);
  }
  return running.length;
}

/** How many commands are running right now, for a status line or a test. */
export function runningCommandCount(): number {
  return liveCommands.size;
}

/** One command this process is running, as the process view shows it: what, where and since when. */
export interface RunningCommand {
  command: string;
  cwd: string;
  startedAt: string;
  pid?: number;
}

/**
 * What is running right now, oldest first.
 *
 * A copy, and only the facts a person already saw in the command's card: no environment, because a secret injected
 * into one child's environment must not reappear in a list.
 */
export function listRunningCommands(): RunningCommand[] {
  return [...liveCommands.values()].map((entry) => ({ ...entry }));
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Injected so a test can drive the promise without a real child process. */
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

/**
 * Kill the command, not just the shell it was started through.
 *
 * `shell: true` means the child is a shell and the command is its child, so killing the shell alone
 * leaves the command running: a test on this machine showed a `setTimeout` process still alive four
 * seconds after its deadline, with the promise unable to settle because the grandchild held the pipes.
 * Windows needs `taskkill /T` for the tree; everywhere else the child is put in its own process group so
 * one signal reaches all of it.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // Falls through to the plain signal: a machine without taskkill still gets the shell killed.
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Run it, and report what happened rather than throwing.
 *
 * A command that exits non-zero is a result: the exit code, what it printed and whether it was killed
 * are the evidence, and turning that into an exception would lose all three at the only moment they
 * matter.
 *
 * The credentials question was settled by the operator as "let Pi handle it": the child inherits this
 * process's environment, so `git` resolves credentials exactly as it would in a shell on this machine —
 * a credential helper, an agent key, or a token in the environment. Nothing is stripped and nothing is
 * injected here.
 */
export async function runCommand(
  input: { command: string; cwd: string },
  options: RunCommandOptions = {},
): Promise<CommandOutcome> {
  const timeoutMs = options.timeoutMs ?? COMMAND_LIMITS.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? COMMAND_LIMITS.maxOutputBytes;
  const startedAt = Date.now();

  return new Promise<CommandOutcome>((resolve) => {
    const child = (options.spawnImpl ?? spawn)(input.command, {
      cwd: input.cwd,
      shell: true,
      // Its own process group on POSIX, so killing the group reaches a shell's children. Windows uses
      // taskkill /T instead; see `killTree`.
      detached: process.platform !== "win32",
      // `windowsHide` so a command run from a conversation does not flash a console window on the
      // operator's desktop, which is how a headless node stops being headless.
      windowsHide: true,
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    let stdout = "";
    let stderr = "";
    let recorded = 0;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer | string, into: "stdout" | "stderr"): void => {
      const text = chunk.toString();
      // Truncation is recorded in the output itself: a silent cut reads as a command that printed
      // nothing more, which is a different claim.
      if (recorded >= maxOutputBytes) return;
      const room = maxOutputBytes - recorded;
      const piece = text.length <= room ? text : `${text.slice(0, room)}\n… (đã cắt bớt)`;
      recorded += piece.length;
      if (into === "stdout") stdout += piece;
      else stderr += piece;
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    // Registered before anything can finish, so a stop issued while the command is starting still reaches it.
    liveCommands.set(child, {
      command: input.command,
      cwd: input.cwd,
      startedAt: new Date(startedAt).toISOString(),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveCommands.delete(child);
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        ...(stoppedByRequest.delete(child) ? { stopped: true } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A command that survived the kill can hold the pipes open for ever, and the outcome is already
      // known: the promise settles rather than waiting on something that may never close.
      setTimeout(() => finish(null), 1_500);
    }, timeoutMs);

    child.on("error", (cause: Error) => {
      stderr += `${stderr === "" ? "" : "\n"}không chạy được lệnh: ${cause.message}`;
      finish(null);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

/**
 * What the conversation says about a finished command.
 *
 * The verdict only. The output itself belongs in the block's result, which the interface draws as a code
 * block, and saying it in both places is what made a receipt print its own output twice.
 */
export function describeCommandOutcome(command: string, outcome: CommandOutcome): string {
  const verdict = outcome.stopped === true
    ? `bị dừng theo yêu cầu sau ${outcome.durationMs} ms`
    : outcome.timedOut
      ? `hết thời gian sau ${outcome.durationMs} ms và bị dừng`
      : `thoát với mã ${outcome.exitCode ?? "không rõ"} sau ${outcome.durationMs} ms`;
  return `\`${command}\` ${verdict}.`;
}

/**
 * What the command printed, as the result a reader can copy.
 *
 * Labelled by stream, because which of the two a line came from is often the whole question, and "Không có
 * output." rather than an empty block, because a command that printed nothing is a fact worth stating.
 */
export function commandOutput(outcome: CommandOutcome): string {
  const parts: string[] = [];
  if (outcome.stdout.trim() !== "") parts.push(`stdout:\n${outcome.stdout.trimEnd()}`);
  if (outcome.stderr.trim() !== "") parts.push(`stderr:\n${outcome.stderr.trimEnd()}`);
  return parts.length === 0 ? "Không có output." : parts.join("\n\n");
}

/**
 * Run an operation the host has already cleared, and report what happened.
 *
 * This is the guarded path: no card, no digest, no person in the loop. What replaced the approval is not
 * nothing — it is the preflight that produced this envelope (ownership, existence, budget, capability)
 * and the guardrail that may have narrowed it. Both ran before this function was called, which is why it
 * can be short: by the time a command gets here the only question left is what it printed.
 *
 * The blocks are the same shape the approved path records, so a command reads the same in the transcript
 * whichever policy let it run. The receipt is returned as text as well as a block because the model is
 * still holding the turn: unlike the approved path there is no second turn to hand the output to.
 */
export async function runGuardedCommand(input: {
  operationId: string;
  /** The envelope the preflight produced, already narrowed by the guardrail if it asked for that. */
  envelope: CommandEnvelope;
  /** Where the folder came from, in the finder's words. Shown to the person. */
  reason?: string;
  /** The model's own one-liner for why this is being run. */
  why?: string;
  /**
   * The environment this one command runs with, when a secret was injected for it.
   *
   * Passed in rather than built here: the broker is what knows which secret a command may use and under which
   * consumer, and a command runner that resolved secrets itself would be a second place that could read one.
   */
  env?: Record<string, string>;
  now?: () => Instant;
  /** Injected so the whole path can be tested without spawning anything. */
  run?: (request: {
    command: string;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    /** The environment for this one child process, when a secret was injected for it. */
    env?: Record<string, string>;
  }) => Promise<CommandOutcome>;
}): Promise<{ blocks: MessageBlock[]; outcome: CommandOutcome; description: string; receipt: string }> {
  const at = input.now ?? (() => new Date().toISOString() as Instant);
  const startedAt = at();
  const { command, cwd } = input.envelope;

  const outcome = await (
    input.run ??
    ((request) =>
      runCommand(
        { command: request.command, cwd: request.cwd },
        {
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          // The environment is passed whole, so an injected variable exists for this child process and nowhere else:
          // not in the parent, not in a file, and not in anything this module returns.
          ...(request.env === undefined ? {} : { env: { ...process.env, ...request.env } }),
        },
      ))
  )({
    command,
    cwd,
    timeoutMs: input.envelope.budget.timeoutMs,
    maxOutputBytes: input.envelope.budget.maxOutputBytes,
    ...(input.env === undefined ? {} : { env: input.env }),
  });

  const description = describeCommandOutcome(command, outcome);
  const succeeded = outcome.exitCode === 0 && !outcome.timedOut;
  const because = input.reason ?? "";
  const why = input.why ?? "";

  const blocks: MessageBlock[] = [
    {
      type: "tool-activity",
      toolCallId: `run-${input.operationId}`,
      name: "run_command",
      label: `Chạy lệnh trong ${cwd}` + (because === "" ? "" : ` (${because})`) + (why === "" ? "" : `: ${why}`),
      status: succeeded ? "done" : "failed",
      args: { command, cwd, decision: "guarded", effect: input.envelope.classification.commandClass },
      result: commandOutput(outcome),
      path: cwd,
      startedAt,
      endedAt: at(),
    },
    {
      type: "evidence",
      kind: "exit-status",
      summary: outcome.timedOut
        ? `Lệnh bị dừng sau ${outcome.durationMs} ms vì vượt thời gian cho phép.`
        : `Lệnh thoát với mã ${outcome.exitCode ?? "không rõ"} sau ${outcome.durationMs} ms.`,
      // Non-zero is not "unverified": it is a result, and it contradicts success.
      verdict: succeeded ? "verified" : "contradicted",
      ref: input.operationId,
    },
  ];

  // The model gets the output rather than a promise of it: it is still holding the turn, and a receipt
  // that only says "it exited 0" is the bug the approved path already had to fix once.
  return { blocks, outcome, description, receipt: receiptForModel(blocks) };
}

/**
 * The digest the user approves.
 *
 * It covers the command *and* the directory, so approving "clone this here" cannot become running it
 * somewhere else: the stored digest is compared against a digest recomputed from what will actually
 * run, and a mismatch is refused rather than executed. That is the whole point of showing it.
 */
export function commandDigest(command: string, cwd: string): string {
  // Canonical form, so the same request always hashes the same way regardless of key order or spacing.
  const canonical = JSON.stringify({ command: command.trim(), cwd });
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 40)}`;
}

/**
 *
 * The digest is recomputed from the payload that will actually run and compared with the digest the
 * decision was bound to, so a payload that changed between display and approval is refused instead of
 * executed. The directory is guarded a second time here rather than trusted from the proposal: the
 * approved roots can change between the two moments, and this is the moment it matters.
 *
 * Returns the blocks the transcript keeps: what ran, whether it worked, and the evidence for that. A
 * refused operation returns no block — a message describing something that did not happen is how a
 * transcript starts lying.
 */
/**
 * The receipt a model is given after a command it proposed has run.
 *
 * Not the searchable text of the message, and that distinction is the bug this exists to fix. The text walk collects a
 * block's *summary*, and for a tool record the summary is the verdict - so the model was told a command had exited 0
 * while the output it actually needed sat in a field nothing looked at. It asked for help, was told everything was
 * fine, and had to ask again, which is exactly what a person watched happen.
 *
 * The output is bounded where it is stored rather than here: the record already carries at most twenty thousand
 * characters, and re-bounding it in two places would be two places to get it wrong.
 */
export function receiptForModel(blocks: readonly MessageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool-activity") {
      const command = block.args.command;
      if (typeof command === "string" && command.trim() !== "") parts.push(`$ ${command.trim()}`);
      // Optional on the block type, so it is checked rather than assumed; the receipt still carries the command.
      if (block.result !== undefined && block.result.trim() !== "") parts.push(block.result);
    } else if (block.type === "evidence") {
      parts.push(block.summary);
    } else if (block.type === "text") {
      parts.push(block.content);
    }
  }
  return parts.join("\n").trim();
}

/**
 * One budget figure an approved payload asked for, clamped to what this host allows.
 *
 * `undefined` — a payload written before the budget travelled with the card — answers with the host's own limit,
 * and so does anything that is not a positive number. The ceiling is `COMMAND_LIMITS`, because the payload is stored
 * with the conversation: a guardrail may narrow, and nothing may widen.
 */
function narrowedTo(value: unknown, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return ceiling;
  return Math.min(Math.floor(value), ceiling);
}

export async function runApprovedCommand(input: {
  payload: string;
  expectedDigest: string;
  approvalId: string;
  /**
   * The folders this node owns, checked again here rather than trusted from when the card was drawn.
   *
   * The same check the guarded path runs, which is what makes `confirm` a policy about *asking* rather than a
   * different kind of gate: an approved operation is still an operation this node may perform.
   */
  resources: OwnedResources;
  /** Injected so the whole decision path can be tested without spawning anything. */
  run?: (request: {
    command: string;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }) => Promise<CommandOutcome>;
  now?: () => Instant;
}): Promise<
  | { ok: true; blocks: MessageBlock[]; outcome: CommandOutcome; description: string }
  | { ok: false; code: string; message: string }
> {
  let parsed: { command?: unknown; cwd?: unknown; timeoutMs?: unknown; maxOutputBytes?: unknown };
  try {
    parsed = JSON.parse(input.payload) as typeof parsed;
  } catch {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload is not readable" };
  }

  const command = typeof parsed.command === "string" ? parsed.command : "";
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
  if (command === "" || cwd === "") {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload carries no command" };
  }

  // The binding: what is about to run must hash to what the user was shown.
  if (commandDigest(command, cwd) !== input.expectedDigest) {
    return {
      ok: false,
      code: "APPROVAL_FORGED",
      message: "the operation changed after it was displayed; the decision does not cover what would run",
    };
  }

  const preflight = preflightCommand({ command, cwd, resources: input.resources });
  if (!preflight.ok || preflight.envelope.kind !== "command") {
    return {
      ok: false,
      code: preflight.ok ? "COMMAND_REFUSED" : preflight.code,
      message: preflight.ok ? "refused" : preflight.message,
    };
  }
  const resolvedCwd = preflight.envelope.cwd;
  /*
   * The budget the carded envelope carried, if any, and never more than this node's own limits.
   *
   * A guardrail may narrow what an approved command is allowed: a shorter deadline, a smaller output ceiling. The
   * card travels with the envelope it displayed, so the narrowing arrives here with it instead of being lost
   * between the question and the answer. It is clamped rather than trusted — the payload is stored with the
   * conversation, and the host's own limits are the ceiling whatever it says.
   */
  const budget = {
    timeoutMs: narrowedTo(parsed.timeoutMs, COMMAND_LIMITS.timeoutMs),
    maxOutputBytes: narrowedTo(parsed.maxOutputBytes, COMMAND_LIMITS.maxOutputBytes),
  };

  const at = input.now ?? (() => new Date().toISOString() as Instant);
  const startedAt = at();
  const outcome = await (
    input.run ?? ((request) => runCommand({ command: request.command, cwd: request.cwd }, request))
  )({ command, cwd: resolvedCwd, ...budget });
  const description = describeCommandOutcome(command, outcome);
  const succeeded = outcome.exitCode === 0 && !outcome.timedOut;

  const blocks: MessageBlock[] = [
    {
      type: "tool-activity",
      toolCallId: `run-${input.approvalId}`,
      name: "run_command",
      label: `Chạy lệnh trong ${resolvedCwd}`,
      status: succeeded ? "done" : "failed",
      // The approval id travels with the receipt so the interface can mark the card it answered as
      // decided, including after a reload.
      args: { command, cwd: resolvedCwd, approvalId: input.approvalId, decision: "granted" },
      result: commandOutput(outcome),
      path: resolvedCwd,
      startedAt,
      endedAt: at(),
    },
    {
      type: "evidence",
      kind: "exit-status",
      summary: outcome.timedOut
        ? `Lệnh bị dừng sau ${outcome.durationMs} ms vì vượt thời gian cho phép.`
        : `Lệnh thoát với mã ${outcome.exitCode ?? "không rõ"} sau ${outcome.durationMs} ms.`,
      // Non-zero is not "unverified": it is a result, and it contradicts success.
      verdict: succeeded ? "verified" : "contradicted",
      ref: input.approvalId,
    },
  ];

  return { ok: true, blocks, outcome, description };
}
