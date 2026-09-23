import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { WIDGET_COMMANDS, positional, runCli } from "../src/cli.ts";

/**
 * The help text, checked against the commands the CLI actually accepts.
 *
 * This test exists because the two drifted. `dev` was implemented while the help said it was not, and `publish` was
 * implemented while the help did not mention it at all — the shape a hand-written help block beside a chain of `if`s
 * invites. The fix was to make one list authoritative for both, and this is what keeps it that way: the help is
 * asserted against the list, so a command added without a line in the help fails here rather than being discovered
 * by a user reading a lie.
 */

async function captureUsage(args: readonly string[]): Promise<{ code: number; text: string }> {
  const written: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  try {
    const code = await runCli(args);
    return { code, text: written.join("") };
  } finally {
    stdout.mockRestore();
  }
}

describe("the CLI help", () => {
  it("names every command the CLI accepts", async () => {
    const { text } = await captureUsage(["widget"]);

    for (const command of WIDGET_COMMANDS) {
      expect(text, `${command.name} is missing from the help`).toContain(command.name);
    }
  });

  it("prints the whole usage line for each command, not just its name", async () => {
    // A help that named `dev` without saying what it does or which flags it takes would pass the check above and
    // still leave the reader guessing, which is half of the bug this replaced.
    const { text } = await captureUsage(["widget"]);

    for (const command of WIDGET_COMMANDS) {
      expect(text, `${command.name}'s usage line is missing`).toContain(command.usage);
    }
  });

  it("describes dev as the dev host it is, and never as unimplemented", async () => {
    const { text } = await captureUsage(["widget"]);

    expect(text).toContain("dev host");
    expect(text).toContain("--port");
    // The exact sentence that was wrong, asserted as absent so it cannot come back.
    expect(text.toLowerCase()).not.toContain("is not implemented");
  });

  it("refuses a command it does not have, rather than pretending to know it", async () => {
    const { code, text } = await captureUsage(["widget", "become-a-toast"]);

    expect(code).toBe(2);
    expect(text).toContain("clark widget");
    expect(text.toLowerCase()).not.toContain("become-a-toast");
  });

  it("shows the help when no command is given at all", async () => {
    const { code, text } = await captureUsage(["widget"]);

    expect(code).toBe(2);
    for (const command of WIDGET_COMMANDS) expect(text).toContain(command.name);
  });
});

describe("the argument a command works on", () => {
  it("reads a flag's value as the flag's, not as the directory", () => {
    /*
     * The bug this pins: `dev --port 4000` named `4000`, so the directory handed to `readPackage` was one nobody
     * had written. Every value-taking flag is here, because the failure was in the reading rather than in `--port`.
     */
    expect(positional(["--port", "4000"])).toBeUndefined();
    expect(positional(["--builtin", "canvas.table@1"])).toBeUndefined();
    expect(positional(["--template", "form"])).toBeUndefined();
    expect(positional(["--frames", "/tmp/frames"])).toBeUndefined();
  });

  it("still reads a directory where a person would put it", () => {
    expect(positional(["pkg", "--port", "4000"])).toBe("pkg");
    expect(positional(["--port", "4000", "pkg"])).toBe("pkg");
    // The value of one flag is not the name of a directory, even when another flag follows it.
    expect(positional(["--builtin", "canvas.table@1", "--port", "4000"])).toBeUndefined();
  });

  it("copes with a flag that was given no value", () => {
    expect(positional(["--port"])).toBeUndefined();
    expect(positional(["pkg", "--port"])).toBe("pkg");
  });

  it("scaffolds into the working directory when a flag comes first", async () => {
    // The end-to-end form of the bug, through the real command rather than through the helper: `init --template
    // form` used to scaffold into a directory called `form`, nowhere near where the person was standing.
    const previous = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "clark-cli-dir-"));
    try {
      process.chdir(root);
      const { code } = await captureUsage(["widget", "init", "--template", "form"]);

      expect(code).toBe(0);
      expect(existsSync(join(root, "clarkcant.json"))).toBe(true);
      // Asserted as absent so the old reading cannot come back unnoticed.
      expect(existsSync(join(root, "form"))).toBe(false);
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
