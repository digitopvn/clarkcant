import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { shellLaunchArgs } from "../src/launch-args.mjs";

/**
 * The shape of the shell's command line.
 *
 * Electron on Windows exits `-1`, silently, when an argument follows a URL-shaped one and no `--` came first. The
 * failure cannot be seen from Linux or macOS, so the shape is pinned here where every platform runs it.
 */

const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//i;

describe("the desktop shell's launch arguments", () => {
  const args = shellLaunchArgs("/repo/apps/desktop", [
    "--dev",
    "--renderer-url",
    "http://127.0.0.1:5173/?gateway=http%3A%2F%2F127.0.0.1%3A8765",
    "--node-url",
    "http://127.0.0.1:8765",
    "--data-dir",
    "/repo/.data",
  ]);

  it("puts the app path first and `--` straight after it", () => {
    expect(args.slice(0, 2)).toEqual(["/repo/apps/desktop", "--"]);
  });

  it("has `--` before the first URL-shaped argument", () => {
    const firstUrl = args.findIndex((arg) => URL_SHAPED.test(arg));
    expect(firstUrl).toBeGreaterThan(0);
    expect(args.indexOf("--")).toBeLessThan(firstUrl);
  });

  it("leaves every flag where the shell's by-name lookup still finds its value", () => {
    // `main.mjs` reads `process.argv.slice(2)` with `indexOf`, which the separator does not disturb.
    const argv = args.slice(1);
    const value = (flag: string): string | undefined => {
      const index = argv.indexOf(flag);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    expect(value("--renderer-url")).toBe("http://127.0.0.1:5173/?gateway=http%3A%2F%2F127.0.0.1%3A8765");
    expect(value("--node-url")).toBe("http://127.0.0.1:8765");
    expect(value("--data-dir")).toBe("/repo/.data");
    expect(argv.includes("--dev")).toBe(true);
  });

  it("is what `pnpm dev:desktop` launches the shell with", () => {
    // The launcher starts three processes at import, so it is read rather than run.
    const launcher = readFileSync(join(import.meta.dirname, "../../../tools/dev-desktop.mjs"), "utf8");
    expect(launcher).toContain('from "../apps/desktop/src/launch-args.mjs"');
    expect(launcher).toMatch(/shellLaunchArgs\(join\(ROOT, "apps\/desktop"\)/);
  });
});
