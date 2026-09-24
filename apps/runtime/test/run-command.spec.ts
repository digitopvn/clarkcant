import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  COMMAND_LIMITS,
  commandDigest,
  runApprovedCommand,
  listRunningCommands,
  runCommand,
  receiptForModel,
  stopCommand,
} from "../src/run-command.ts";
import { ownedResources } from "../src/preflight.ts";

/**
 * Running a command, and the two things that make it safe to offer.
 *
 * The command itself is the easy part. What is asserted here is the gate: that a command can only be
 * proposed for a directory the user approved, and that what runs is what was approved — the digest is
 * recomputed from the payload at execution time and a mismatch is refused rather than executed.
 */


describe("an approved command is still checked against what this node owns", () => {
  it("refuses an operation whose folder this node does not own", async () => {
    /*
     * Asking a person is a policy about whether to ask, not a different kind of gate: the same containment the
     * guarded path runs is run here, at the moment of the decision rather than when the card was drawn.
     *
     * The folder has to **exist** for the refusal to be about ownership: a path that is merely absent is refused as
     * unknown, which is a different answer and not the one this test is about. A path spelled for one platform is
     * absent on the other — which is how this passed on a developer's machine and failed on Linux — so it is created.
     */
    const outside = mkdtempSync(join(tmpdir(), "clarkcant-outside-"));
    try {
      const payload = JSON.stringify({ command: "git status", cwd: outside });
      const refused = await runApprovedCommand({
        payload,
        expectedDigest: commandDigest("git status", outside),
        approvalId: "appr_1",
        resources: ownedResources([process.cwd()]),
      });

      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("OUTSIDE_OWNED_RESOURCES");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses an empty command and one long enough to be a script", async () => {
    const owned = ownedResources([process.cwd()]);
    const empty = await runApprovedCommand({
      payload: JSON.stringify({ command: "   ", cwd: process.cwd() }),
      expectedDigest: commandDigest("   ", process.cwd()),
      approvalId: "appr_1",
      resources: owned,
    });
    expect(empty.ok).toBe(false);

    const long = "x".repeat(COMMAND_LIMITS.maxCommandLength + 1);
    const tooLong = await runApprovedCommand({
      payload: JSON.stringify({ command: long, cwd: process.cwd() }),
      expectedDigest: commandDigest(long, process.cwd()),
      approvalId: "appr_1",
      resources: owned,
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe("COMMAND_TOO_LONG");
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
  // A real directory, because the preflight checks that the folder exists as well as that this node owns it: an
  // approved command that would run nowhere is refused before anything is spawned.
  const workdir = mkdtempSync(join(tmpdir(), "clarkcant-approved-"));
  const payload = JSON.stringify({ command: "git clone repo", cwd: workdir });
  const digest = commandDigest("git clone repo", workdir);
  const owned = ownedResources([workdir]);
  afterAll(() => rmSync(workdir, { recursive: true, force: true }));

  it("runs it and returns the receipt the transcript keeps", async () => {
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      approvalId: "appr_1",
      resources: owned,
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
    // The output is in the result and nowhere else. It used to be in the result *and* in a text block of its own,
    // which the interface drew as a second copy of the same output under a receipt that already showed it.
    expect(result.blocks.filter((block) => block.type === "text")).toHaveLength(0);
    // And the verdict on its own, because the output has a place of its own now.
    expect(result.description).toContain("thoát với mã 0");
    expect(result.description).not.toContain("Cloning into");
  });

  it("runs the narrowed budget the card carried, and never more than this host allows", async () => {
    /*
     * An asking mode consults the judgment layer before it draws a card, and what that layer narrowed — a shorter
     * deadline, a smaller output ceiling — travels with the card. It has to reach the run as well as the card: a
     * permission that is narrowed on screen and not at the point of the effect is not a narrowing at all.
     */
    const seen: { timeoutMs: number; maxOutputBytes: number }[] = [];
    const run = async (request: {
      command: string;
      cwd: string;
      timeoutMs: number;
      maxOutputBytes: number;
    }) => {
      seen.push({ timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes });
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };

    const narrowed = JSON.stringify({
      command: "git clone repo",
      cwd: workdir,
      timeoutMs: 30_000,
      maxOutputBytes: 2_000,
    });
    const ran = await runApprovedCommand({
      payload: narrowed,
      expectedDigest: digest,
      approvalId: "appr_1",
      resources: owned,
      run,
    });
    expect(ran.ok).toBe(true);
    expect(seen).toEqual([{ timeoutMs: 30_000, maxOutputBytes: 2_000 }]);

    // A payload is stored with the conversation, so it is clamped rather than trusted: the host's own limits are
    // the ceiling whatever it asks for.
    const wider = JSON.stringify({
      command: "git clone repo",
      cwd: workdir,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 10_000_000,
    });
    await runApprovedCommand({
      payload: wider,
      expectedDigest: digest,
      approvalId: "appr_2",
      resources: owned,
      run,
    });
    expect(seen[1]).toEqual({
      timeoutMs: COMMAND_LIMITS.timeoutMs,
      maxOutputBytes: COMMAND_LIMITS.maxOutputBytes,
    });
  });

  it("leaves the output out when the command printed nothing", async () => {
    const result = await runApprovedCommand({
      payload,
      expectedDigest: digest,
      approvalId: "appr_1",
      resources: owned,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Silence is stated rather than shown as an empty block, which would look like output that failed to arrive,
    // and there is still no second copy of it anywhere.
    const activity = result.blocks[0];
    expect(activity?.type === "tool-activity" ? activity.result : undefined).toBe("Không có output.");
    expect(result.blocks.some((block) => block.type === "text")).toBe(false);
  });

  it("refuses an operation whose payload changed after it was displayed", async () => {
    // The approval covers what the user read. Swapping the command afterwards — the classic
    // display-then-execute gap — has to fail here, and nothing may run.
    let ran = false;
    const result = await runApprovedCommand({
      payload: JSON.stringify({ command: "git clone something-else", cwd: workdir }),
      expectedDigest: digest,
      approvalId: "appr_1",
      resources: owned,
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
      resources: owned,
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
      resources: owned,
      run: async () => ({ exitCode: 128, stdout: "", stderr: "Permission denied (publickey)", durationMs: 30, timedOut: false }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blocks[0]).toMatchObject({ type: "tool-activity", status: "failed" });
    expect(result.blocks[1]).toMatchObject({ type: "evidence", verdict: "contradicted" });
    // What it printed is in the result, and the verdict says which command failed and how.
    const activity = result.blocks[0];
    expect(activity?.type === "tool-activity" ? activity.result : undefined).toContain("Permission denied");
    expect(result.description).toContain("thoát với mã 128");
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

  it("does not hand the command the node's own keys", async () => {
    process.env["TYPESAFE_API_KEY"] = "node-provider-key-for-test";
    process.env["GH_TOKEN"] = "loaded-from-dotenv-for-test";
    try {
      const outcome = await runCommand({
        command: `node -e "process.stdout.write(JSON.stringify([process.env.TYPESAFE_API_KEY ?? null, process.env.GH_TOKEN ?? null, typeof process.env.PATH]))"`,
        cwd: process.cwd(),
      });
      expect(JSON.parse(outcome.stdout)).toEqual([null, null, "string"]);
    } finally {
      delete process.env["TYPESAFE_API_KEY"];
      delete process.env["GH_TOKEN"];
    }
  });

  it("stops one running command by its work id and reports it as stopped, not timed out", async () => {
    const running = runCommand({ command: `node -e "setTimeout(() => {}, 30000)"`, cwd: process.cwd() });
    let workId: string | undefined;
    for (let attempt = 0; attempt < 50 && workId === undefined; attempt += 1) {
      workId = listRunningCommands()[0]?.workId;
      if (workId === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(workId).toBeDefined();

    expect(stopCommand(workId as string)).toBe(true);
    const outcome = await running;

    expect(outcome.stopped).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.durationMs).toBeLessThan(10_000);
    expect(listRunningCommands()).toEqual([]);
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

describe("the receipt a model is given", () => {
  it("carries the command's output, not only its verdict", () => {
    // Covered here because the bug was invisible in the transcript: the receipt block showed the output to a reader
    // while the text the model received held only "the command exited with code 0", so the model asked for help, was
    // told all was well, and asked again.
    const receipt = receiptForModel([
      {
        type: "tool-activity",
        toolCallId: "run-x",
        name: "run_command",
        label: "Chay lenh trong D:/proj",
        status: "done",
        args: { command: "git log -20 --oneline", cwd: "D:/proj", approvalId: "x", decision: "granted" },
        result: "a1b2c3 lan dau\nd4e5f6 lan sau",
        startedAt: "2026-09-19T02:00:00.000Z" as never,
        endedAt: "2026-09-19T02:00:01.000Z" as never,
      },
      {
        type: "evidence",
        kind: "exit-status",
        summary: "Lenh thoat voi ma 0 sau 12 ms.",
        verdict: "verified",
        ref: "x",
      },
    ]);

    expect(receipt).toContain("git log -20 --oneline");
    expect(receipt).toContain("a1b2c3 lan dau");
    expect(receipt).toContain("Lenh thoat voi ma 0");
  });
});

