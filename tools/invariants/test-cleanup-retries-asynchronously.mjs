/**
 * Test cleanup that asks for retries gets them.
 *
 * On Windows, `rmSync(path, { recursive: true, force: true, maxRetries })` cannot be relied on to wait out a directory
 * that an antivirus, an indexer or a child process that just exited holds for a moment, which is exactly what the
 * retries are written for:
 *
 * - On Node 22, and on Node 24 before 24.21, it reports the held directory as `EBUSY` or `EPERM` at once: the retries
 *   never run.
 * - From Node 24.21 (nodejs/node#64698) the retries run, but each wait sleeps the main thread. The event loop stands
 *   still for the whole budget, seconds of it, so nothing the test process would do meanwhile happens: no timer fires,
 *   no child's exit is handled, and a handle the test itself holds is not let go.
 *
 * `fs.promises.rm` with the same options retries on every supported version without blocking. Test code removes such
 * a directory with `removeTestDirectory()` from `tools/test-cleanup.ts` (or awaits `rm` from `node:fs/promises`) instead.
 *
 * How the check reads a file:
 *
 * - Comments and the text of string literals are blanked first, so a call named in a comment or a string is not a call,
 *   and a `(` in a string does not unbalance the call around it. Code inside a template literal's `${...}` is still read.
 * - A call is read whole by balancing parentheses, so an options object that wraps across lines is still seen. An
 *   optional call (`fs.rmSync?.(...)`) and bracket access with a literal key (`fs["rmSync"](...)`) count as calls.
 * - `rmSync` reached under another name is seen when the name is given in the file: `rmSync as name` in an import,
 *   `{ rmSync: name }` in a destructuring, or `const name = rmSync` (also `fs.rmSync`, `require("node:fs").rmSync` or
 *   `fs["rmSync"]`). Options passed as a variable are not seen.
 * - A call that is meant to show the failing form carries `invariant-allow: sync-rm-retries` in a comment on its line or
 *   the line above. The marker in a string literal does not count.
 *
 * Known limits, since the check reads text and does not parse:
 *
 * - A regular expression literal is read as code, so one holding a quote can blank what follows on its line; none does
 *   today.
 * - JSX text is read as code. A quote right after a letter or digit (`<p>Don't</p>`) is taken as an apostrophe, never
 *   valid code there, so it hides nothing. A quote in JSX text after a space or a tag (`<p>It is 'odd</p>`,
 *   `<p>"Quoted</p>`) still opens a string, and blanks what follows on its line.
 *
 * It covers test code: specs and the helpers beside them in `test/` and `e2e/` folders, plus the test tooling CI runs on
 * every OS (`TEST_TOOLING`).
 */
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

const TEST_ROOTS = ["apps", "packages", "packs", "tools", "examples"];
const EXTENSION = String.raw`\.(?:[cm]?[jt]s|[jt]sx)$`;
const SOURCE = new RegExp(EXTENSION);
const SPEC = new RegExp(String.raw`\.(?:spec|test)${EXTENSION}`);
/** Test tooling outside `test/` folders that CI runs, Windows included. */
const TEST_TOOLING = new Set(["tools/smoke-widget-tooling.mjs"]);
const ALLOW = "invariant-allow: sync-rm-retries";

/** Whether a repo-relative path is test code. */
export function isTestPath(path) {
  return TEST_TOOLING.has(path) || /(?:^|\/)(?:test|e2e)\//.test(path) || SPEC.test(path);
}

/**
 * `source` read two ways, each the same length with newlines kept, so every index and line still points at the same
 * place: `code` has comments and string-literal text replaced by spaces, and `comments` keeps only the comments.
 * Template literals are followed into their `${...}` expressions.
 */
function scan(source) {
  const out = source.split("");
  const comments = source.replace(/[^\n]/g, " ").split("");
  const blank = (index) => {
    if (out[index] !== "\n") out[index] = " ";
  };
  const blankComment = (index) => {
    comments[index] = source[index];
    blank(index);
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
      while (index < source.length && source[index] !== "\n") blankComment(index++);
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (index < stop) blankComment(index++);
    } else if ((character === '"' || character === "'") && /[\w$]/.test(source[index - 1] ?? "")) {
      // A quote right after a name or a number cannot open a string in code; it is an apostrophe in JSX text.
      index += 1;
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
  return { code: out.join(""), comments: comments.join("") };
}

/** `source` with comments and string-literal text replaced by spaces, newlines kept. */
export function blankCommentsAndStrings(source) {
  return scan(source).code;
}

/**
 * `code` with each bracket access by a literal key, `["rmSync"]`, written as `.rmSync` padded to the same length, so the
 * rest of the check reads it as member access. `code` has the key blanked, so `source` names it.
 */
function bracketAccessAsMember(code, source) {
  const out = code.split("");
  for (const match of source.matchAll(/\[(\s*)(["'`])rmSync\2\s*\]/g)) {
    const quote = match.index + 1 + match[1].length;
    // Only where the brackets and quotes are code: not inside a comment or a string.
    if (code[match.index] !== "[" || code[quote] !== match[2] || code[quote + 7] !== match[2]) continue;
    const replacement = ".rmSync".padEnd(match[0].length, " ");
    for (let offset = 0; offset < match[0].length; offset += 1) {
      if (out[match.index + offset] !== "\n") out[match.index + offset] = replacement[offset];
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
  const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\s*(?:\([^()]*\))?\s*\.\s*)*rmSync\b(?!\s*(?:\?\.\s*)?\()/g;
  for (const pattern of [/\brmSync\s+as\s+([A-Za-z_$][\w$]*)/g, /\brmSync\s*:\s*([A-Za-z_$][\w$]*)/g, assigned]) {
    for (const match of code.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

const escapeName = (name) => name.replace(/\$/g, "\\$");

/** The 1-based line of each `rmSync(...)` call in `source` that passes `maxRetries`. */
export function retryingRmSyncLines(source) {
  const scanned = scan(source);
  const code = bracketAccessAsMember(scanned.code, source);
  const commentLines = scanned.comments.split("\n");
  const names = rmSyncNames(code).map(escapeName).join("|");
  const lines = [];
  for (const match of code.matchAll(new RegExp(`(?<![\\w$])(?:${names})\\s*(?:\\?\\.\\s*)?\\(`, "g"))) {
    // A declaration of the name (`function rmSync(`) is not a call; neither is the import or alias itself.
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, match.index - 12), match.index))) continue;
    const open = match.index + match[0].length - 1;
    if (!/\bmaxRetries\b/.test(callText(code, open))) continue;
    const line = code.slice(0, match.index).split("\n").length;
    if (commentLines[line - 1]?.includes(ALLOW) || commentLines[line - 2]?.includes(ALLOW)) continue;
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
        `${path}:${String(line)} calls rmSync with maxRetries, which on Windows fails at once or blocks the event loop while it retries; await removeTestDirectory() from tools/test-cleanup.ts`,
      );
    }
  }
  c.notes.push(`${files.length} test file(s) checked for synchronous removal that asks for retries`);
}
