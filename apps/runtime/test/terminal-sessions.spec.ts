import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

afterEach(() => {
  registry.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

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
      relativeRegistry.stopAll();
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
