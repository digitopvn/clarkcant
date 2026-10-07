/**
 * Test cleanup that asks for retries gets them.
 *
 * On Windows, `rmSync(path, { recursive: true, force: true, maxRetries })` reports a held directory as `EPERM` or
 * `EBUSY` at once: the retries never run (measured on Node 22 and 24). `fs.promises.rm` with the same options does retry.
 * A spec that cleans up with a retrying `rmSync` therefore fails on Windows as soon as an antivirus, an indexer or a
 * child process that just exited holds a file for a moment, which is exactly what the retries were written for. Test
 * code removes such a directory with `removeTestDirectory()` from `tools/test-cleanup.ts` (or awaits `rm` from
 * `node:fs/promises`) instead.
 *
 * How the check reads a file:
 *
 * - Comments and the text of string literals are blanked first, so a call named in a comment or a string is not a call,
 *   and a `(` in a string does not unbalance the call around it. Code inside a template literal's `${...}` is still read.
 *   A regular expression literal is read as code, so one holding a quote can blank what follows; none does today.
 * - A call is read whole by balancing parentheses, so an options object that wraps across lines is still seen.
 * - `rmSync` reached under another name is seen when the name is given in the file: `rmSync as name` in an import,
 *   `{ rmSync: name }` in a destructuring, or `const name = rmSync`. Options passed as a variable are not seen.
 * - A call that is meant to show the failing form carries `invariant-allow: sync-rm-retries` in a comment on its line or
 *   the line above.
 *
 * It covers test code: specs and the helpers beside them in `test/` and `e2e/` folders, plus the test tooling CI runs on
 * every OS (`TEST_TOOLING`).
 */
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

const TEST_ROOTS = ["apps", "packages", "packs", "tools", "examples"];
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
/** Test tooling outside `test/` folders that CI runs, Windows included. */
const TEST_TOOLING = new Set(["tools/smoke-widget-tooling.mjs"]);
const ALLOW = "invariant-allow: sync-rm-retries";

/** Whether a repo-relative path is test code. */
export function isTestPath(path) {
  return TEST_TOOLING.has(path) || /(?:^|\/)(?:test|e2e)\//.test(path) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * `source` with comments and string-literal text replaced by spaces, newlines kept, so every index and line still
 * points at the same place. Template literals are followed into their `${...}` expressions.
 */
export function blankCommentsAndStrings(source) {
  const out = source.split("");
  const blank = (index) => {
    if (out[index] !== "\n") out[index] = " ";
  };
  /** What encloses the current position: a template literal, or a `${` expression with its own brace depth. */
  const stack = [];
  let index = 0;
  const inTemplateText = () => stack.length > 0 && stack[stack.length - 1].kind === "template";
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (inTemplateText()) {
      if (character === "\\") {
        blank(index);
        if (index + 1 < source.length) blank(index + 1);
        index += 2;
      } else if (character === "`") {
        stack.pop();
        index += 1;
      } else if (character === "$" && next === "{") {
        stack.push({ kind: "expression", depth: 0 });
        index += 2;
      } else {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") blank(index++);
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (index < stop) blank(index++);
    } else if (character === '"' || character === "'") {
      index += 1;
      while (index < source.length && source[index] !== character && source[index] !== "\n") {
        if (source[index] === "\\") blank(index++);
        if (index < source.length) blank(index++);
      }
      index += 1;
    } else if (character === "`") {
      stack.push({ kind: "template" });
      index += 1;
    } else {
      const top = stack[stack.length - 1];
      if (top?.kind === "expression") {
        if (character === "{") top.depth += 1;
        else if (character === "}") {
          if (top.depth === 0) stack.pop();
          else top.depth -= 1;
        }
      }
      index += 1;
    }
  }
  return out.join("");
}

/** The text of the call whose `(` is at `open`, by balancing parentheses. */
function callText(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return code.slice(open);
}

/** The names `rmSync` goes by in `code`: its own, and any alias the file gives it. */
function rmSyncNames(code) {
  const names = new Set(["rmSync"]);
  for (const pattern of [/\brmSync\s+as\s+([A-Za-z_$][\w$]*)/g, /\brmSync\s*:\s*([A-Za-z_$][\w$]*)/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)?rmSync\b(?!\s*\()/g]) {
    for (const match of code.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

const escapeName = (name) => name.replace(/\$/g, "\\$");

/** The 1-based line of each `rmSync(...)` call in `source` that passes `maxRetries`. */
export function retryingRmSyncLines(source) {
  const code = blankCommentsAndStrings(source);
  const sourceLines = source.split("\n");
  const names = rmSyncNames(code).map(escapeName).join("|");
  const lines = [];
  for (const match of code.matchAll(new RegExp(`(?<![\\w$])(?:${names})\\s*\\(`, "g"))) {
    // A declaration of the name (`function rmSync(`) is not a call; neither is the import or alias itself.
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, match.index - 12), match.index))) continue;
    const open = match.index + match[0].length - 1;
    if (!/\bmaxRetries\b/.test(callText(code, open))) continue;
    const line = code.slice(0, match.index).split("\n").length;
    if (sourceLines[line - 1]?.includes(ALLOW) || sourceLines[line - 2]?.includes(ALLOW)) continue;
    lines.push(line);
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
