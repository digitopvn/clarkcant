import { describe, expect, it } from "vitest";

import {
  COMMAND_LIMITS,
  commandDigest,
  guardCommand,
  runApprovedCommand,
  runCommand,
} from "../src/run-command.ts";

/**
 * Running a command, and the two things that make it safe to offer.
 *
 * The command itself is the easy part. What is asserted here is the gate: that a command can only be
 * proposed for a directory the user approved, and that what runs is what was approved — the digest is
 * recomputed from the payload at execution time and a mismatch is refused rather than executed.
 */


describe("whether a command may be proposed at all", () => {
  it("runs where it was asked, because there is no folder allowlist", () => {
    // The operator's decision, made after the gate refused the tree this product itself runs from: the
    // agent's runtime carries the instruction out, permission belongs to the host, and the control that
    // actually has a person behind it is the approval card.
    expect(guardCommand({ command: "git clone repo", cwd: "D:/somewhere/else" })).toMatchObject({
      ok: true,
      cwd: "D:/somewhere/else",
    });
    // And the card says so in words, because that is what the person approving reads.
    expect(guardCommand({ command: "git status" }).because).toContain("không giới hạn thư mục");
  });

  it("still refuses an empty command and an over-long one", () => {
    expect(guardCommand({ command: "   " }).code).toBe("EMPTY_COMMAND");
    expect(guardCommand({ command: "x".repeat(COMMAND_LIMITS.maxCommandLength + 1) }).code).toBe(
      "COMMAND_TOO_LONG",
    );
  });
});

describe("the digest a decision is bound to", () => {
  it("covers the command and the directory", () => {
    expect(commandDigest("git status", "D:/work")).toBe(commandDigest("git status", "D:/work"));
    // The same command somewhere else is a different operation: approving one must not approve the other.
    expect(commandDigest("git status", "D:/work")).not.toBe(commandDigest("git status", "D:/www/digitop"));
    expect(commandDigest("git status", "D:/work")).not.toBe(commandDigest("git clone x", "D:/work"));
  });
});

describe("running an approved operation", () => {
  const payload = JSON.stringify({ command: "git clone repo", cwd: "D:/work/orchestrate" });
  const digest = commandDigest("git clone repo", "D:/work/orchestrate");

  it("runs it and returns the receipt the transcript keeps", async () => {
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      approvalId: "appr_1",
      run: async () => ({ exitCode: 0, stdout: "Cloning into 'orchestrate'...\n", stderr: "", durationMs: 12, timedOut: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [activity, evidence] = result.blocks;
    expect(activity).toMatchObject({ type: "tool-activity", status: "done", name: "run_command" });
    expect(String(activity?.type === "tool-activity" ? activity.result : "")).toContain("Cloning into");
    // The approval id is in the receipt so the interface can mark the card it answered as decided.
    expect(activity?.type === "tool-activity" ? activity.args.approvalId : undefined).toBe("appr_1");
    expect(evidence).toMatchObject({ type: "evidence", kind: "exit-status", verdict: "verified" });
    // And what the command printed. The receipt said "exit 0" and nothing else, which is what the agent reported
    // twice as "the log never reached me" - the person could not read their own output either.
    const printed = result.blocks.find((block) => block.type === "text");
    expect(printed?.type === "text" ? printed.content : undefined).toContain("Cloning into");
  });

  it("leaves the output out when the command printed nothing", async () => {
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      approvalId: "appr_1",
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A command that prints nothing adds no block: an empty block would look like output that failed to arrive.
    expect(result.blocks.some((block) => block.type === "text")).toBe(false);
  });

  it("refuses an operation whose payload changed after it was displayed", async () => {
    // The approval covers what the user read. Swapping the command afterwards — the classic
    // display-then-execute gap — has to fail here, and nothing may run.
    let ran = false;
    const result = await runApprovedCommand({
      payload: JSON.stringify({ command: "git clone something-else", cwd: "D:/work/orchestrate" }),
      expectedDigest: digest,
      approvalId: "appr_1",
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("APPROVAL_FORGED");
    expect(ran).toBe(false);
  });

  it("refuses an operation whose directory changed after it was displayed", async () => {
    // What protects this now that the folder restriction is gone: what runs must hash to what the person
    // approved. Swapping the directory afterwards makes it a different operation, and it is refused before
    // anything is spawned.
    let ran = false;
    const result = await runApprovedCommand({
      payload: JSON.stringify({ command: "git clone repo", cwd: "D:/somewhere/else" }),
      expectedDigest: digest,
      approvalId: "appr_1",
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("APPROVAL_FORGED");
    expect(ran).toBe(false);
  });

  it("reports a failing command as a contradicted result rather than as success", async () => {
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      approvalId: "appr_2",
      run: async () => ({ exitCode: 128, stdout: "", stderr: "Permission denied (publickey)", durationMs: 30, timedOut: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks[0]).toMatchObject({ type: "tool-activity", status: "failed" });
    expect(result.blocks[1]).toMatchObject({ type: "evidence", verdict: "contradicted" });
    expect(result.description).toContain("Permission denied");
  });
});

describe("running a real command", () => {
  it("reports the exit code and the output", async () => {
    const outcome = await runCommand({
      command: `node -e "process.stdout.write('xin chào')"`,
      cwd: process.cwd(),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("xin chào");
    expect(outcome.timedOut).toBe(false);
  });

  it("kills a command that overruns its deadline instead of holding the turn open", async () => {
    const outcome = await runCommand(
      { command: `node -e "setTimeout(() => {}, 5000)"`, cwd: process.cwd() },
      { timeoutMs: 300 },
    );
    expect(outcome.timedOut).toBe(true);
    expect(outcome.durationMs).toBeLessThan(4_000);
  });

  it("caps the output and says that it did", async () => {
    const outcome = await runCommand(
      { command: `node -e "process.stdout.write('x'.repeat(5000))"`, cwd: process.cwd() },
      { maxOutputBytes: 200 },
    );
    expect(outcome.stdout.length).toBeLessThan(400);
    expect(outcome.stdout).toContain("đã cắt bớt");
  });
});
