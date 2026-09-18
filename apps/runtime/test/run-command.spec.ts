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

const ROOTS = ["D:/www/digitop", "D:/work"] as const;
/** A node that has approved two folders and indexed one project inside the first of them. */
const PLACEMENT = { approvedRoots: ROOTS, knownProjects: ["D:/www/digitop/clarkcant"] } as const;

describe("whether a command may be proposed at all", () => {
  it("accepts a command in an approved root, and defaults to the first place it knows", () => {
    expect(guardCommand({ command: "git status", cwd: "D:/www/digitop/clarkcant", placement: PLACEMENT })).toMatchObject({
      ok: true,
      cwd: "D:/www/digitop/clarkcant",
    });
    expect(guardCommand({ command: "git status", placement: PLACEMENT })).toMatchObject({ ok: true, cwd: ROOTS[0] });
  });

  it("accepts the folder the projects live in, because that is where a clone lands", () => {
    // The operator's decision: the agent may work where it can justify, not only in a folder they approved
    // beforehand. A project folder is the evidence, and the folder it sits in is where a clone goes.
    const placement = { approvedRoots: [] as string[], knownProjects: ["D:/www/digitop/clarkcant"] };
    const result = guardCommand({ command: "git clone repo", cwd: "D:/www/digitop", placement });
    expect(result.ok).toBe(true);
    // And it says why, because the card shows this to the person approving.
    expect(result.because).toContain("chứa các dự án");
    // A sibling that merely shares a prefix is not that folder.
    expect(guardCommand({ command: "x", cwd: "D:/www/digitop-other", placement }).ok).toBe(false);
  });

  it("accepts the folder the node itself runs in, even when the finder never reached it", () => {
    // What this fixes, and it was found in use rather than in review: the finder's scan stops at a file
    // ceiling, so the tree the app itself runs from was neither approved nor indexed, and every command in
    // the operator's own working directory was refused with "not a folder I know".
    const placement = {
      approvedRoots: [] as string[],
      knownProjects: [] as string[],
      nodeDirectory: "D:/www/digitop/clarkcant",
    };
    const result = guardCommand({ command: "git log -3", cwd: "D:/www/digitop/clarkcant/apps/runtime", placement });
    expect(result.ok).toBe(true);
    expect(result.because).toContain("node đang chạy");
  });

  it("accepts the folder beside the node, which is where a clone belongs", () => {
    const placement = {
      approvedRoots: [] as string[],
      knownProjects: [] as string[],
      nodeDirectory: "D:/www/digitop/clarkcant",
    };
    const result = guardCommand({ command: "git clone https://example.com/x.git", cwd: "D:/www/digitop", placement });
    expect(result.ok).toBe(true);
    expect(result.because).toContain("chứa nơi node đang chạy");
    // A sibling that merely shares a prefix is not that folder.
    expect(guardCommand({ command: "x", cwd: "D:/www/digitop-other", placement }).ok).toBe(false);
  });

  it("accepts a folder inside an indexed project", () => {
    const placement = { approvedRoots: [] as string[], knownProjects: ["D:/www/digitop/clarkcant"] };
    expect(guardCommand({ command: "npm test", cwd: "D:/www/digitop/clarkcant/packages/core", placement })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a directory that is neither approved nor known", () => {
    const result = guardCommand({ command: "rm -rf /", cwd: "D:/somewhere/else", placement: PLACEMENT });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("OUTSIDE_APPROVED_ROOTS");
    // The refusal tells the model what would make it possible, rather than only that it failed.
    expect(result.message).toContain("find_project");
  });

  it("refuses an empty command, an over-long one, and a node that knows no folder", () => {
    expect(guardCommand({ command: "   ", placement: PLACEMENT }).code).toBe("EMPTY_COMMAND");
    expect(
      guardCommand({ command: "x".repeat(COMMAND_LIMITS.maxCommandLength + 1), placement: PLACEMENT }).code,
    ).toBe("COMMAND_TOO_LONG");
    expect(
      guardCommand({ command: "ls", placement: { approvedRoots: [], knownProjects: [] } }).code,
    ).toBe("NO_PLACE_TO_RUN");
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
      placement: { approvedRoots: ROOTS, knownProjects: [] },
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
  });

  it("refuses an operation whose payload changed after it was displayed", async () => {
    // The approval covers what the user read. Swapping the command afterwards — the classic
    // display-then-execute gap — has to fail here, and nothing may run.
    let ran = false;
    const result = await runApprovedCommand({
      payload: JSON.stringify({ command: "git clone something-else", cwd: "D:/work/orchestrate" }),
      expectedDigest: digest,
      placement: { approvedRoots: ROOTS, knownProjects: [] },
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

  it("refuses an approved directory that is no longer inside an approved root", async () => {
    // The roots can change between the proposal and the decision; this is the moment that matters.
    let ran = false;
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      placement: { approvedRoots: ["D:/elsewhere"], knownProjects: [] },
      approvalId: "appr_1",
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    });

    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("reports a failing command as a contradicted result rather than as success", async () => {
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      placement: { approvedRoots: ROOTS, knownProjects: [] },
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
