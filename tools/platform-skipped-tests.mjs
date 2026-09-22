/**
 * Which titles in a spec file a platform condition keeps from running.
 *
 * The status registry's first rule is that an `implemented` entry names a test that exercises it. A test inside
 * `describe.skipIf(!POSIX)` is named, exists, and never runs on a runner where the condition does not hold, so a
 * check that only looks for the title accepts evidence that cannot execute. This module answers the question that
 * check needs: for one spec file, which test titles sit under a platform-conditional skip.
 *
 * It reads the TypeScript AST rather than matching text, because the property being asked about is nesting, and a
 * matcher that quietly fails to nest looks exactly like a repository with nothing wrong — the one outcome this
 * module must never produce. A file it cannot parse therefore throws instead of reporting an empty map. The
 * condition is resolved rather than pattern-matched on the call: `!POSIX` counts only because `POSIX` is bound in
 * the same file to `process.platform`, and an opt-in gate such as `describe.skipIf(!LIVE)` on an environment
 * variable is deliberately not this module's subject.
 *
 * This lives outside check-invariants.mjs so the nesting can be tested on its own.
 */
import ts from "typescript";

/** A property access that reads the platform this runner is on. */
const PLATFORM_PROPERTY = /^process\.(?:platform|arch)$/;

/** The vitest modifier that turns a declaration off (or on) for a condition. */
const CONDITIONAL_METHODS = new Set(["skipIf", "runIf"]);

/** A test or suite declaration: `it`, `test`, `describe`, or a dotted variant such as `it.each`. */
const DECLARATION = /^(?:describe|it|test)(?:\.[A-Za-z]+)*$/;

/**
 * Every node under `node`, `node` included.
 *
 * @param {import("typescript").Node} node
 * @param {(child: import("typescript").Node) => void} visit
 */
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Whether an expression reads the platform, directly or through a name bound to it earlier in the file.
 *
 * @param {import("typescript").Node} node
 * @param {Set<string>} platformNames
 */
function readsPlatform(node, platformNames) {
  let found = false;
  walk(node, (child) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(child) && PLATFORM_PROPERTY.test(child.getText())) found = true;
    else if (ts.isIdentifier(child) && platformNames.has(child.text)) found = true;
  });
  return found;
}

/**
 * The names in this file whose value derives from the platform, in declaration order so a chain such as
 * `const POSIX = process.platform !== "win32"` is resolved before it is read.
 *
 * @param {import("typescript").SourceFile} file
 */
function platformBoundNames(file) {
  const names = new Set();
  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    if (!ts.isIdentifier(node.name)) return;
    if (readsPlatform(node.initializer, names)) names.add(node.name.text);
  });
  return names;
}

/**
 * The condition of a `describe.skipIf(...)` / `it.runIf(...)` call, or `undefined` when the call is something else.
 *
 * @param {import("typescript").CallExpression} call
 * @returns {import("typescript").Expression | undefined}
 */
function conditionOf(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (!CONDITIONAL_METHODS.has(callee.name.text)) return undefined;
  if (!/^(?:describe|it|test)\b/.test(callee.expression.getText())) return undefined;
  return call.arguments[0];
}

/**
 * The titles a platform condition skips, mapped to the condition that skips them.
 *
 * A title declared more than once is reported only when every declaration of it is skipped: one declaration that
 * runs on this platform is enough for the title to be evidence.
 *
 * @param {string} sourceText the contents of one spec file
 * @returns {Map<string, string>} title to the condition's own text
 * @throws when the file cannot be parsed, rather than reporting that nothing is skipped: "nothing is skipped" is
 * what a clean repository looks like, so an unreadable file must not be able to produce it
 */
export function platformSkippedTestTitles(sourceText) {
  const file = ts.createSourceFile("spec.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const broken = file.parseDiagnostics?.[0];
  if (broken !== undefined) {
    throw new Error(`not parseable as TypeScript: ${ts.flattenDiagnosticMessageText(broken.messageText, " ")}`);
  }
  const platformNames = platformBoundNames(file);

  /** @type {Map<import("typescript").CallExpression, string>} */
  const skips = new Map();
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const condition = conditionOf(node);
    if (condition === undefined || !readsPlatform(condition, platformNames)) return;
    /*
     * The skip applies to the call that follows the modifier — `describe.skipIf(...)("title", fn)` — so the suite
     * or test that actually wraps the title is the outer call. Both are recorded: the modifier's own call keeps the
     * suite's title, and the outer one is the ancestor every declaration inside it has.
     */
    const conditionText = condition.getText();
    skips.set(node, conditionText);
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) skips.set(node.parent, conditionText);
  });

  /** @type {Map<string, {declarations: number, skipped: number, condition: string}>} */
  const seen = new Map();
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!DECLARATION.test(node.expression.getText()) && !skips.has(node.expression)) return;
    const title = node.arguments[0];
    if (title === undefined || !(ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) return;
    let condition;
    // The declaration itself is included: `it.skipIf(...)("title", fn)` carries its own skip, and so does the suite
    // a `describe.skipIf(...)(...)` call declares.
    for (let ancestor = node; ancestor !== undefined; ancestor = ancestor.parent) {
      condition = skips.get(ancestor);
      if (condition !== undefined) break;
    }
    const record = seen.get(title.text) ?? { declarations: 0, skipped: 0, condition: "" };
    record.declarations += 1;
    if (condition !== undefined) {
      record.skipped += 1;
      record.condition = condition;
    }
    seen.set(title.text, record);
  });

  const skipped = new Map();
  for (const [title, record] of seen) {
    if (record.declarations > 0 && record.skipped === record.declarations) skipped.set(title, record.condition);
  }
  return skipped;
}
