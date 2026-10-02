import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isMainModule } from "../src/cli.ts";

/**
 * The `clark` bin, started the way a package script starts it: through the shim the package manager installed.
 *
 * This exists because the shim once ran nothing. `src/cli.ts` had no shebang, so pnpm wrote a shim that handed the
 * `.ts` file to the operating system instead of to Node, and `clark widget test …` exited 0 having checked nothing.
 * Behind that sat a second no-op: started through the shim, argv[1] is the path inside the consumer's dependency
 * folder while `import.meta.url` is the resolved file, so the main-module guard never matched. Calling `runCli`
 * directly, as the other specs do, cannot see either failure — only running the installed bin can.
 */

const CONSUMER = fileURLToPath(new URL("../../../examples/reference-apps/", import.meta.url));
const BIN_DIR = join(CONSUMER, ["node", "modules"].join("_"), ".bin");
const SHIM = join(BIN_DIR, process.platform === "win32" ? "clark.cmd" : "clark");

function clark(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  // A `.cmd` shim can only be started through the shell on Windows, so there the line is built here, quoted; the
  // arguments are this spec's own literals and temp paths.
  const options = { cwd: CONSUMER, encoding: "utf8", windowsHide: true } as const;
  const result =
    process.platform === "win32"
      ? spawnSync([SHIM, ...args].map((part) => `"${part}"`).join(" "), { ...options, shell: true })
      : spawnSync(SHIM, args, options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the installed clark bin", () => {
  it("is installed as a shim the package manager generated", () => {
    expect(existsSync(SHIM), `${SHIM} is missing; run pnpm install`).toBe(true);
  });

  it("prints the usage for --help and exits 0", () => {
    const { status, stdout } = clark(["--help"]);

    // A checkout installed before the shebang still has the old shim; `pnpm install --force` rewrites it.
    expect(stdout, "the shim printed nothing; reinstall with pnpm install --force").toContain(
      "clark widget <command> [dir]",
    );
    expect(stdout).toContain("clark widget test [dir]");
    expect(status).toBe(0);
  }, 60_000);

  it("runs a real check and reports its counts", () => {
    const { status, stdout } = clark(["widget", "test", "text-editor"]);

    expect(stdout).toMatch(/[1-9]\d* passed, 0 failed/);
    expect(status).toBe(0);
  }, 60_000);

  it("exits non-zero when the command fails", () => {
    const missing = mkdtempSync(join(tmpdir(), "clark-bin-"));
    try {
      const { status, stdout } = clark(["widget", "test", join(missing, "absent")]);

      expect(stdout).toContain("0 passed, 1 failed");
      expect(status).toBe(1);
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the main-module guard", () => {
  const self = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const selfUrl = pathToFileURL(self).href;

  it("matches the module's own file", () => {
    expect(isMainModule(self, selfUrl)).toBe(true);
  });

  it("does not match when there is no entry, or another one", () => {
    expect(isMainModule(undefined, selfUrl)).toBe(false);
    expect(isMainModule(fileURLToPath(import.meta.url), selfUrl)).toBe(false);
    expect(isMainModule(join(tmpdir(), "clark-no-such-entry.ts"), selfUrl)).toBe(false);
  });

  it.runIf(process.platform === "win32")("ignores the case of a Windows path", () => {
    expect(isMainModule(self.toUpperCase(), selfUrl)).toBe(true);
    expect(isMainModule(self.toLowerCase(), selfUrl)).toBe(true);
  });
});
