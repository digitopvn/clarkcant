import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import type { Instant, MessageBlock } from "@clarkcant/contracts";

import { isWithinRoot } from "./path-roots.ts";

/**
 * Running one command, in a directory the user approved.
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

export interface CommandGuardResult {
  ok: boolean;
  code?: "EMPTY_COMMAND" | "COMMAND_TOO_LONG" | "OUTSIDE_APPROVED_ROOTS" | "NO_PLACE_TO_RUN";
  message?: string;
  /** The resolved directory the command would run in. */
  cwd?: string;
  /** Why this directory is allowed, written for the card: the user is approving a place as well as a command. */
  because?: string;
}

/**
 * Where a command may run.
 *
 * Not an allowlist the operator maintains: the operator's decision was that the agent should be able to
 * work anywhere it can justify, provided it looks for the right place first and the choice is visible
 * before anything runs. So a directory qualifies when it is one the node already recognises as a place
 * work happens — a folder the user approved, a folder the finder indexed as a project, or the folder such
 * a project lives in (which is where a clone lands: beside the other repositories rather than inside one).
 *
 * The approval card still stands in front of the command, and it names the directory, so the person who
 * approves sees where it will run rather than trusting this function.
 */
export interface CommandPlacement {
  /** Folders the user approved explicitly. */
  approvedRoots: readonly string[];
  /** Folders the finder has indexed as projects on this node. */
  knownProjects: readonly string[];
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

/** Whether a command may be proposed at all, and where it would run. */
export function guardCommand(input: {
  command: unknown;
  cwd?: unknown;
  placement: CommandPlacement;
}): CommandGuardResult {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command === "") {
    return { ok: false, code: "EMPTY_COMMAND", message: "Cần một lệnh để chạy." };
  }
  if (command.length > COMMAND_LIMITS.maxCommandLength) {
    return {
      ok: false,
      code: "COMMAND_TOO_LONG",
      message: `Lệnh dài hơn ${COMMAND_LIMITS.maxCommandLength} ký tự. Hãy đưa nó vào một tệp để đọc trước khi duyệt.`,
    };
  }

  const { approvedRoots, knownProjects } = input.placement;
  // `dirname("")` is `.`, which would make this list look non-empty on a node that knows nothing — the
  // branch below would never fire and a command would be proposed for `.`. The parent is only considered
  // when there is a project to take the parent of.
  const firstProject = knownProjects[0];
  const candidates = [approvedRoots[0], firstProject, firstProject === undefined ? undefined : dirname(firstProject)].filter(
    (value): value is string => value !== undefined && value.trim() !== "",
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "NO_PLACE_TO_RUN",
      message:
        "Node này chưa biết thư mục nào để làm việc. Hãy để tui tìm dự án trước, hoặc nói rõ thư mục cần dùng.",
    };
  }

  const requested =
    typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd.trim() : (candidates[0] ?? "");

  for (const root of approvedRoots) {
    if (isWithinRoot(root, requested)) {
      return { ok: true, cwd: requested, because: `nằm trong thư mục bạn đã duyệt (${root})` };
    }
  }

  for (const project of knownProjects) {
    if (isWithinRoot(project, requested)) {
      return { ok: true, cwd: requested, because: `nằm trong dự án đã biết (${project})` };
    }
    // The folder the projects live in: where a clone lands, beside the repositories rather than inside
    // one of them. This is the case the request was about.
    const parent = dirname(project);
    if (parent !== "" && resolve(parent) === resolve(requested)) {
      return { ok: true, cwd: requested, because: `là thư mục chứa các dự án đã biết (${project})` };
    }
  }

  return {
    ok: false,
    code: "OUTSIDE_APPROVED_ROOTS",
    message:
      `Thư mục ${requested} không nằm trong thư mục đã duyệt hay dự án nào tui biết. ` +
      `Hãy tìm dự án trước (find_project) hoặc chọn một thư mục nằm cạnh các dự án hiện có.`,
  };
}

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
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

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
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
 * Written for a reader who has to decide whether it worked, so the exit code and the truncation are
 * stated before the output rather than after it — a wall of text with the verdict at the bottom is a
 * wall of text.
 */
export function describeCommandOutcome(command: string, outcome: CommandOutcome): string {
  const verdict = outcome.timedOut
    ? `hết thời gian sau ${outcome.durationMs} ms và bị dừng`
    : `thoát với mã ${outcome.exitCode ?? "không rõ"} sau ${outcome.durationMs} ms`;
  const parts = [`\`${command}\` ${verdict}.`];
  if (outcome.stdout.trim() !== "") parts.push(`stdout:\n${outcome.stdout.trimEnd()}`);
  if (outcome.stderr.trim() !== "") parts.push(`stderr:\n${outcome.stderr.trimEnd()}`);
  if (outcome.stdout.trim() === "" && outcome.stderr.trim() === "") parts.push("Không có output.");
  return parts.join("\n\n");
}

/**
 * Run an operation a user approved, having checked it is still the operation they approved.
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
export async function runApprovedCommand(input: {
  payload: string;
  expectedDigest: string;
  placement: CommandPlacement;
  approvalId: string;
  /** Injected so the whole decision path can be tested without spawning anything. */
  run?: (request: { command: string; cwd: string }) => Promise<CommandOutcome>;
  now?: () => Instant;
}): Promise<
  | { ok: true; blocks: MessageBlock[]; outcome: CommandOutcome; description: string }
  | { ok: false; code: string; message: string }
> {
  let parsed: { command?: unknown; cwd?: unknown };
  try {
    parsed = JSON.parse(input.payload) as { command?: unknown; cwd?: unknown };
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

  const guard = guardCommand({ command, cwd, placement: input.placement });
  if (!guard.ok || guard.cwd === undefined) {
    return { ok: false, code: guard.code ?? "OUTSIDE_APPROVED_ROOTS", message: guard.message ?? "refused" };
  }

  const at = input.now ?? (() => new Date().toISOString() as Instant);
  const startedAt = at();
  const outcome = await (input.run ?? ((request) => runCommand(request)))({ command, cwd: guard.cwd });
  const description = describeCommandOutcome(command, outcome);
  const succeeded = outcome.exitCode === 0 && !outcome.timedOut;

  const blocks: MessageBlock[] = [
    {
      type: "tool-activity",
      toolCallId: `run-${input.approvalId}`,
      name: "run_command",
      label: `Chạy lệnh trong ${guard.cwd}`,
      status: succeeded ? "done" : "failed",
      // The approval id travels with the receipt so the interface can mark the card it answered as
      // decided, including after a reload.
      args: { command, cwd: guard.cwd, approvalId: input.approvalId, decision: "granted" },
      result: description,
      path: guard.cwd,
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
