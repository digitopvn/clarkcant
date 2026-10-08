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
 * - The file is parsed by the TypeScript parser, as TypeScript, TSX or JavaScript with JSX by its extension, so
 *   comments, strings, template text, regular expression literals and JSX text are never read as code, and code inside
 *   a template literal's `${...}` is.
 * - A call is a call expression, so an options object that wraps across lines is still seen. An optional call
 *   (`fs.rmSync?.(...)`), a call through parentheses (`(await import("node:fs")).rmSync(...)`) and bracket access with
 *   a literal key (`fs["rmSync"](...)`) count as calls, as do `fs.rmSync.call(...)` and `fs.rmSync.apply(...)`. The
 *   call asks for retries when `maxRetries` is named among its arguments.
 * - `rmSync` reached under another name is seen when the name is given in the file: `rmSync as name` in an import,
 *   `{ rmSync: name }` in a destructuring, or `const name = rmSync` or `name = rmSync` (also `fs.rmSync`,
 *   `require("node:fs").rmSync`, `fs["rmSync"]` or another such name). Names are matched by spelling, not by scope.
 *   Options passed as a variable are not seen.
 * - A call that is meant to show the failing form carries `invariant-allow: sync-rm-retries` in a comment on its line or
 *   the line above. The marker in a string literal, a template or JSX text does not count.
 *
 * The parser comes from the `typescript` dev dependency. CI runs the invariants once before it installs dependencies,
 * for changes that need no install, and again after it. With no `node_modules` at all the check reports itself
 * skipped; any other failure to load the parser fails it. A file that does not parse is named in a note, since what
 * follows the error may not be read as written.
 *
 * It covers test code: specs and the helpers beside them in `test/` and `e2e/` folders, plus the test tooling CI runs on
 * every OS (`TEST_TOOLING`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

/** The TypeScript compiler API, and why it could not be loaded when it could not. */
const { ts, loadError } = await import("typescript").then(
  (module) => ({ ts: module.default, loadError: undefined }),
  (error) => ({ ts: undefined, loadError: error }),
);

/**
 * What the check does when the parser could not be loaded from `repoRoot`: skip only when dependencies are not installed
 * at all, which is when `typescript` itself is missing and there is no `node_modules`; fail on anything else.
 */
export function parserUnavailable(error, repoRoot) {
  const missing = error?.code === "ERR_MODULE_NOT_FOUND" && /'typescript'/.test(String(error.message));
  if (missing && !existsSync(join(repoRoot, "node_modules"))) {
    return { skip: "dependencies are not installed, so the TypeScript parser is not there; CI runs this check again after install" };
  }
  return { fail: `the TypeScript parser could not be loaded: ${String(error?.message ?? error)}` };
}

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
 * `source` parsed as the language its path names. A path is optional: a snippet is read as TSX, which accepts JSX and
 * every TypeScript form but the `<Type>value` assertion.
 */
function parse(source, path = "snippet.tsx") {
  if (!ts) throw new Error(`the TypeScript parser could not be loaded: ${String(loadError?.message ?? loadError)}`);
  const { ScriptKind } = ts;
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const kind = { ".ts": ScriptKind.TS, ".mts": ScriptKind.TS, ".cts": ScriptKind.TS, ".tsx": ScriptKind.TSX, ".jsx": ScriptKind.JSX }[extension];
  return ts.createSourceFile(
    path,
    source,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    kind ?? (/^\.[cm]?js$/.test(extension) ? ScriptKind.JS : ScriptKind.TSX),
  );
}

/**
 * The comments of a parsed file: the same length as its text with newlines kept, so every index and line still points
 * at the same place, and everything but comment text replaced by spaces. A comment is what is not whitespace in a
 * token's leading trivia; JSX text has no trivia, so text in JSX that reads like a comment is not one.
 */
function commentsOfFile(file) {
  const source = file.text;
  const comments = source.replace(/[^\n]/g, " ").split("");
  const visit = (node) => {
    const children = node.getChildren(file);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const start = node.getStart(file);
    for (let index = node.pos; index < start; index += 1) {
      const character = source[index];
      if (character !== " " && character !== "\n" && character !== "\r" && !/\s/.test(character)) comments[index] = character;
    }
  };
  visit(file);
  return comments.join("");
}

/**
 * The comments of `source`, as `commentsOfFile` gives them, which is where the check looks for the marker. `path` names
 * the language, as in the check; without it the source is read as TSX.
 */
export function commentsOf(source, path) {
  return commentsOfFile(parse(source, path));
}

/** `node` without the parentheses, non-null assertions and type assertions around it. */
function unwrap(node) {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** The node that names `rmSync` when `node` reads it (`rmSync` or a name it goes by, `x.rmSync`, `x["rmSync"]`). */
function rmSyncReference(node, names) {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return names.has(inner.text) ? inner : undefined;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === "rmSync" ? inner.name : undefined;
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)) {
    return inner.argumentExpression.text === "rmSync" ? inner.argumentExpression : undefined;
  }
  return undefined;
}

/** The text of a property name, or undefined for a computed one. */
const propertyText = (name) => (name && !ts.isComputedPropertyName(name) ? name.text : undefined);

/** The names `rmSync` goes by in `file`: its own, and any the file gives it, in the order the file gives them. */
function rmSyncNames(file) {
  const names = new Set(["rmSync"]);
  const visit = (node) => {
    if (ts.isImportSpecifier(node) && propertyText(node.propertyName ?? node.name) === "rmSync") {
      names.add(node.name.text);
    } else if (ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) {
        if (ts.isIdentifier(element.name) && propertyText(element.propertyName ?? element.name) === "rmSync") names.add(element.name.text);
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (rmSyncReference(node.initializer, names)) names.add(node.name.text);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      rmSyncReference(node.right, names)
    ) {
      names.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Whether `node` names `maxRetries`: as a name, a property or a quoted property key. */
function namesMaxRetries(node) {
  if (ts.isIdentifier(node)) return node.text === "maxRetries";
  if (ts.isPropertyAssignment(node) && propertyText(node.name) === "maxRetries") return true;
  return ts.forEachChild(node, namesMaxRetries) ?? false;
}

/**
 * The 1-based line of each `rmSync(...)` call in `source` that passes `maxRetries`. `path` names the language, as in
 * the check; without it the source is read as TSX.
 */
export function retryingRmSyncLines(source, path) {
  return inspect(source, path).lines;
}

/** The callee of a call, seen through `.call(...)` and `.apply(...)`. */
function callee(call) {
  const target = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(target) && (target.name.text === "call" || target.name.text === "apply")) return target.expression;
  return call.expression;
}

/**
 * The lines `retryingRmSyncLines` reports, and the first syntax error of a file it had to parse, as
 * `{ line, message }`: error recovery may read what follows the error differently from how it was written.
 */
function inspect(source, path) {
  // Both names are spelled out in any call the check finds, so a file without them needs no parse.
  if (!source.includes("rmSync") || !source.includes("maxRetries")) return { lines: [] };
  const file = parse(source, path);
  // Not in the typings, but set on every file the parser returns.
  const [error] = file.parseDiagnostics ?? [];
  const parseError = error && {
    line: file.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
    message: ts.flattenDiagnosticMessageText(error.messageText, " "),
  };
  const names = rmSyncNames(file);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.some(namesMaxRetries)) {
      const reference = rmSyncReference(callee(node), names);
      if (reference) found.push(file.getLineAndCharacterOfPosition(reference.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const commentLines = found.length > 0 && source.includes(ALLOW) ? commentsOfFile(file).split("\n") : [];
  const lines = found
    .filter((line) => !commentLines[line - 1]?.includes(ALLOW) && !commentLines[line - 2]?.includes(ALLOW))
    .sort((a, b) => a - b);
  return { lines, parseError };
}

/** The repo-relative paths of the files the check reads. */
export function checkedFiles({ repoRoot, walk, relative }) {
  return TEST_ROOTS.flatMap((root) => walk(join(repoRoot, root), (path) => SOURCE.test(path)))
    .map((path) => relative(path))
    .filter(isTestPath);
}

export default function run(ctx) {
  const c = ctx.check("test-cleanup-retries-asynchronously");
  if (!ts) {
    const { skip, fail } = parserUnavailable(loadError, ctx.repoRoot);
    if (skip) {
      c.skipped = true;
      c.notes.push(skip);
    } else c.failures.push(fail);
    return;
  }
  const files = checkedFiles(ctx);
  for (const path of files) {
    const { lines, parseError } = inspect(readFileSync(join(ctx.repoRoot, path), "utf8"), path);
    if (parseError) {
      c.notes.push(
        `warning: ${path}:${String(parseError.line)} does not parse (${parseError.message}), so a call after it may be missed`,
      );
    }
    for (const line of lines) {
      c.failures.push(
        `${path}:${String(line)} calls rmSync with maxRetries, which on Windows fails at once or blocks the event loop while it retries; await removeTestDirectory() from tools/test-cleanup.ts`,
      );
    }
  }
  c.notes.push(`${files.length} test file(s) checked for synchronous removal that asks for retries`);
}

