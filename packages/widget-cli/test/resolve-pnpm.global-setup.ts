import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Resolve the pnpm that `clark widget pack` runs, once, before any test worker starts.
 *
 * `pack` runs `pnpm pack` inside the package being packed, and every test packs a package scaffolded under the
 * temporary directory — outside this repository, so no `packageManager` field pins the version. Corepack answers that
 * with its last known good pnpm, and on a machine that has never resolved one (every fresh CI runner) it first asks
 * the registry for the latest release and downloads it. That happened inside whichever test packed first: on the
 * Windows runner the first pack took 32.8s against a 20s budget while the identical second pack took 430ms, and
 * which test paid depended on worker scheduling, so it failed only some of the time.
 *
 * Resolving it here moves that one-time cost out of every test's timeout and keeps parallel workers from each
 * downloading the same release. It spawns pnpm the way `pnpmPack` does, from the same kind of directory, so it warms
 * the same resolution. A failure is reported rather than thrown: the tests that pack then fail with the CLI's own
 * explanation, which is the more useful message.
 */
export default function resolvePnpm(): void {
  const options = { cwd: tmpdir(), encoding: "utf8" as const, windowsHide: true, timeout: 180_000 };
  const result =
    process.platform === "win32"
      ? spawnSync("pnpm --version", { ...options, shell: true })
      : spawnSync("pnpm", ["--version"], options);
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr || result.stdout).trim();
    process.stderr.write(`could not resolve pnpm before the tests that pack an npm archive: ${reason}\n`);
  }
}
