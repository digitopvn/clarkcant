import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chooseShell, createTerminalRegistry, type TerminalRegistry } from "../src/terminal-sessions.ts";

/**
 * The terminal registry against a real shell in a real pseudo-terminal.
 *
 * Deliberately not a fake PTY: what these assert — a command's start and end seen through the shell's own prompt
 * hooks, its exit code, a prefilled line landing on the prompt — is the behaviour of bash, and a fake would only
 * prove the fake. bash with a throwaway HOME, so no personal rc file changes what the prompt prints.
 */
let dir: string;
let registry: TerminalRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-terminal-"));
  registry = createTerminalRegistry({
    dataDir: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, SHELL: "/bin/bash" },
    platform: "linux",
  });
});

afterEach(async () => {
  await stopAndWait(registry);
  // A killed shell's children can still be letting go of the directory for a moment on macOS.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Kill every shell and wait until each has exited, so nothing is still writing into the directory being removed. */
async function stopAndWait(target: TerminalRegistry): Promise<void> {
  target.stopAll();
  const deadline = Date.now() + 5_000;
  while (target.list().some((info) => info.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Whether a process is still running. A zombie nobody has reaped yet has already exited. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

async function openShell(): Promise<string> {
  const availability = await registry.availability();
  // Named, not skipped: node-pty is an optional dependency, and a node without it is a missing condition to report.
  expect(availability, "node-pty must load for the terminal to exist on this platform").toEqual({ ok: true });
  const opened = await registry.open({ cwd: dir, title: "test" });
  if (!opened.ok) throw new Error(opened.reason);
  expect(await registry.ready(opened.info.terminalId)).toBe(true);
  return opened.info.terminalId;
}

describe.skipIf(process.platform === "win32")("a terminal on this node", () => {
  it("runs a command and reports its output and exit code from the shell's own marks", async () => {
    const id = await openShell();
    expect(registry.get(id)?.integration).toBe("osc133");

    const failed = await registry.run(id, "echo hello; false", { waitMs: 10_000 });
    expect(failed.status).toBe("finished");
    if (failed.status !== "finished") return;
    expect(failed.record.command).toBe("echo hello; false");
    expect(failed.record.exitCode).toBe(1);
    expect(failed.record.output).toContain("hello");

    const ok = await registry.run(id, "printf 'a\\rb\\n'", { waitMs: 10_000 });
    expect(ok.status === "finished" && ok.record.exitCode).toBe(0);
    expect(ok.status === "finished" && ok.record.output).toBe("b");
  }, 30_000);

  it("refuses a second command while one is running, and records the first when it ends", async () => {
    const id = await openShell();
    const slow = await registry.run(id, "sleep 1; echo done", { waitMs: 100 });
    expect(slow.status).toBe("running");
    const busy = await registry.run(id, "echo other", { waitMs: 100 });
    expect(busy.status).toBe("busy");
    expect(registry.prefill(id, "echo later").ok).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const last = registry.commands(id).at(-1);
    expect(last?.command).toBe("sleep 1; echo done");
    expect(last?.exitCode).toBe(0);
    expect(last?.output).toBe("done");
    expect(registry.get(id)?.running).toBeNull();
  }, 30_000);

  it("records a command the person typed themselves", async () => {
    const id = await openShell();
    const events: string[] = [];
    registry.subscribe(id, (event) => {
      if (event.type === "command") events.push(event.phase);
    });
    registry.write(id, "ls /nonexistent-clarkcant\r");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const last = registry.commands(id).at(-1);
    expect(last?.command).toBe("ls /nonexistent-clarkcant");
    expect(last?.exitCode).not.toBe(0);
    expect(events).toEqual(["started", "finished"]);
  }, 30_000);

  it("puts a prefilled line on the prompt without running it", async () => {
    const id = await openShell();
    const before = registry.commands(id).length;
    expect(registry.prefill(id, "echo not-yet\nrm -rf /")).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // A newline in a prefill would be an Enter; it is flattened, so nothing ran.
    expect(registry.commands(id).length).toBe(before);
    expect(registry.replay(id)).toContain("echo not-yet rm -rf /");
  }, 30_000);

  it("never types over a line the person is typing, and replaces its own prefill instead of appending", async () => {
    const id = await openShell();
    expect(registry.prefill(id, "echo first")).toEqual({ ok: true });
    expect(registry.prefill(id, "echo second")).toEqual({ ok: true });
    const ran = await registry.run(id, "echo third", { waitMs: 10_000 });
    expect(ran.status === "finished" && ran.record.command).toBe("echo third");

    registry.write(id, "echo half");
    expect(registry.prefill(id, "echo agent").ok).toBe(false);
    expect(await registry.run(id, "echo agent", { waitMs: 1_000 })).toEqual({ status: "typing" });
    // Once the person sends their line, the prompt is theirs again to share.
    registry.write(id, "\r");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(registry.commands(id).at(-1)?.command).toBe("echo half");
    const after = await registry.run(id, "echo agent", { waitMs: 10_000 });
    expect(after.status === "finished" && after.record.output).toBe("agent");
  }, 30_000);

  it("does not take a marker printed by a command for the shell's own", async () => {
    const id = await openShell();
    // The command prints a finished-with-0 marker and a new prompt marker while it is still running.
    const result = await registry.run(id, "printf '\\033]133;D;0\\007\\033]133;A\\007'; sleep 1; false", { waitMs: 10_000 });
    expect(result.status).toBe("finished");
    if (result.status !== "finished") return;
    expect(result.record.exitCode).toBe(1);
  }, 30_000);

  it("follows the directory the shell is in, so a command is judged where it runs", async () => {
    const id = await openShell();
    mkdirSync(join(dir, "sub"));
    await registry.run(id, "cd sub", { waitMs: 10_000 });
    expect(registry.get(id)?.cwd).toBe(join(realpathSync(dir), "sub"));
  }, 30_000);

  it("strips control characters from what it types", async () => {
    const id = await openShell();
    const result = await registry.run(id, "echo a\tb\u0015", { waitMs: 10_000 });
    expect(result.status === "finished" && result.record.output).toBe("ab");
  }, 30_000);

  it("closes the jobs a person left running in the background, not just the shell", async () => {
    const id = await openShell();
    const started = await registry.run(id, "sleep 60 & echo $!", { waitMs: 10_000 });
    const pid = Number.parseInt(started.status === "finished" ? started.record.output.trim().split("\n").at(-1) ?? "" : "", 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(alive(pid)).toBe(true);
    await stopAndWait(registry);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it.skipIf(process.platform !== "linux")("kills a job that ignores the hangup too", async () => {
    const id = await openShell();
    const started = await registry.run(id, "nohup sleep 60 >/dev/null 2>&1 & echo $!", { waitMs: 10_000 });
    const pid = Number.parseInt(started.status === "finished" ? started.record.output.trim().split("\n").at(-1) ?? "" : "", 10);
    expect(alive(pid)).toBe(true);
    await stopAndWait(registry);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("finds its shell integration when the node was started with a relative data directory", async () => {
    // The shell starts in the terminal's directory, so a relative rc path would be looked up from there and missed.
    const relativeRegistry = createTerminalRegistry({
      dataDir: relative(process.cwd(), dir),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, SHELL: "/bin/bash" },
      platform: "linux",
    });
    try {
      // A directory at a different depth from the node's own, so a path relative to one is wrong from the other.
      const nested = join(dir, "a", "b", "c", "d", "e", "f");
      mkdirSync(nested, { recursive: true });
      const opened = await relativeRegistry.open({ cwd: relative(process.cwd(), nested) });
      if (!opened.ok) throw new Error(opened.reason);
      expect(opened.info.cwd).toBe(nested);
      await relativeRegistry.ready(opened.info.terminalId);
      const result = await relativeRegistry.run(opened.info.terminalId, "true", { waitMs: 10_000 });
      expect(result.status === "finished" && result.record.exitCode).toBe(0);
    } finally {
      await stopAndWait(relativeRegistry);
    }
  }, 30_000);

  it("gives the drive to one attachment at a time", async () => {
    const id = await openShell();
    expect(registry.claimDriver(id, "a")).toBe(true);
    expect(registry.get(id)?.driver).toBe("a");
    registry.claimDriver(id, "b");
    expect(registry.get(id)?.driver).toBe("b");
    registry.releaseDriver(id, "a");
    expect(registry.get(id)?.driver).toBe("b");
    registry.releaseDriver(id, "b");
    expect(registry.get(id)?.driver).toBeNull();
  }, 30_000);

  it("reports the shell as exited after it is closed", async () => {
    const id = await openShell();
    const exits: (number | null)[] = [];
    registry.subscribe(id, (event) => {
      if (event.type === "exit") exits.push(event.exitCode);
    });
    expect(registry.kill(id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(registry.get(id)?.status).toBe("exited");
    expect(exits).toHaveLength(1);
    expect(await registry.run(id, "echo x")).toEqual({ status: "gone" });
  }, 30_000);
});

describe("when the pseudo-terminal cannot load", () => {
  it("says why instead of opening something that is not a terminal", async () => {
    const unavailable = createTerminalRegistry({
      dataDir: dir,
      loadPty: async () => ({ ok: false, reason: "không có node-pty" }),
    });
    expect(await unavailable.availability()).toEqual({ ok: false, reason: "không có node-pty" });
    const opened = await unavailable.open({ cwd: dir });
    expect(opened.ok).toBe(false);
  });
});

describe("choosing a shell", () => {
  it("uses the person's shell, and bash when none is set", () => {
    expect(chooseShell({ SHELL: "/usr/bin/zsh" }, "linux")).toEqual({ file: "/usr/bin/zsh", kind: "zsh" });
    expect(chooseShell({}, "darwin")).toEqual({ file: "/bin/bash", kind: "bash" });
    expect(chooseShell({ SHELL: "/usr/bin/fish" }, "linux").kind).toBe("other");
  });
});
