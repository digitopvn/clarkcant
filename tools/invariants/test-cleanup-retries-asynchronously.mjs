/**
 * Test cleanup that asks for retries gets them.
 *
 * Under Node 24 on Windows, `rmSync(path, { recursive: true, force: true, maxRetries })` reports a locked file as `EPERM`
 * at once: the retries never run. `fs.promises.rm` with the same options does retry. A spec that cleans up with a
 * retrying `rmSync` therefore fails on Windows as soon as an antivirus, an indexer or a child process that just exited
 * holds a file for a moment, which is exactly what the retries were written for. Test code removes such a directory with
 * `removeTestDirectory()` from `tools/test-cleanup.ts` (or awaits `rm` from `node:fs/promises`) instead.
 *
 * The check reads each `rmSync(` call by balancing parentheses, so an options object that wraps across lines is still
 * read whole. It covers test code only: specs and the helpers beside them in `test/` and `e2e/` folders.
 */
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

const TEST_ROOTS = ["apps", "packages", "packs", "tools", "examples"];
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;

/** Whether a repo-relative path is test code. */
export function isTestPath(path) {
  return /(?:^|\/)(?:test|e2e)\//.test(path) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path);
}

/** The text of the call whose `(` is at `open`, by balancing parentheses. */
function callText(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
}

/** The 1-based line of each `rmSync(...)` call in `source` that passes `maxRetries`. */
export function retryingRmSyncLines(source) {
  const lines = [];
  for (const match of source.matchAll(/\brmSync\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    if (!/\bmaxRetries\b/.test(callText(source, open))) continue;
    lines.push(source.slice(0, match.index).split("\n").length);
  }
  return lines;
}

export default function run(ctx) {
  const { repoRoot, check, walk, relative } = ctx;
  const c = check("test-cleanup-retries-asynchronously");
  const files = TEST_ROOTS.flatMap((root) => walk(join(repoRoot, root), (path) => SOURCE.test(path)))
    .map((path) => relative(path))
    .filter(isTestPath);
  for (const path of files) {
    for (const line of retryingRmSyncLines(readFileSync(join(repoRoot, path), "utf8"))) {
      c.failures.push(
        `${path}:${String(line)} calls rmSync with maxRetries, which never retries on Windows; await removeTestDirectory() from tools/test-cleanup.ts`,
      );
    }
  }
  c.notes.push(`${files.length} test file(s) checked for synchronous removal that asks for retries`);
}
