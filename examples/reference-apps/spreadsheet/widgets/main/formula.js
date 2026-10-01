/*
 * Formulas: a closed set, read by a parser and evaluated by walking what it built.
 *
 * Arithmetic (`+ - * / ^`, unary minus, parentheses), cell references (`B2`, `$B$2`), ranges as function arguments
 * (`B2:D9`) and five functions: SUM, AVERAGE, MIN, MAX, COUNT. Nothing else is recognised, and the text of a formula is
 * never handed to the JavaScript engine: no `eval`, no `Function`, no string-to-code path of any kind. A file someone
 * sent can hold formulas, and the most one can do here is compute a number or an error.
 *
 * Errors are values, as in other spreadsheets, and pass through whatever uses them:
 * `#DIV/0!` dividing by zero, `#VALUE!` arithmetic on text, `#REF!` a cell outside the sheet, `#NAME?` an unknown
 * function, `#PARSE!` a formula that cannot be read, `#NUM!` a result too large to hold, `#CIRC!` a cell that depends on
 * itself, and `#LIMIT!` a sheet whose formulas reach more cells than the widget will walk.
 */

import { MAX_COLUMNS, MAX_ROWS, cellName, classifyInput, columnIndex } from "./sheet.js";

export const ERRORS = Object.freeze({
  div0: "#DIV/0!",
  value: "#VALUE!",
  ref: "#REF!",
  name: "#NAME?",
  parse: "#PARSE!",
  num: "#NUM!",
  circ: "#CIRC!",
  limit: "#LIMIT!",
});

export const FUNCTIONS = Object.freeze(["SUM", "AVERAGE", "MIN", "MAX", "COUNT"]);

const MAX_FORMULA_CHARS = 1_000;
const MAX_DEPTH = 64;
const MAX_ARGUMENTS = 64;
/** Cells looked at while finding which formulas depend on which: beyond this the sheet is not evaluated. */
const DEPENDENCY_BUDGET = 2_000_000;
/** Cells read while evaluating every formula once. */
const EVALUATION_BUDGET = 5_000_000;

export function errorValue(code) {
  return { error: code };
}

export function isError(value) {
  return typeof value === "object" && value !== null && typeof value.error === "string";
}

/* ------------------------------------------------------------------ reading */

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    const rest = source.slice(index);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(rest);
    if (number !== null) {
      tokens.push({ type: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const reference = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![A-Za-z0-9_(])/u.exec(rest);
    if (reference !== null) {
      tokens.push({ type: "ref", column: columnIndex(reference[1] ?? ""), row: Number(reference[2]) - 1 });
      index += reference[0].length;
      continue;
    }
    const name = /^[A-Za-z][A-Za-z0-9_.]{0,31}/u.exec(rest);
    if (name !== null) {
      tokens.push({ type: "name", value: name[0].toUpperCase() });
      index += name[0].length;
      continue;
    }
    if ("+-*/^(),:".includes(char)) {
      tokens.push({ type: char });
      index += 1;
      continue;
    }
    return undefined;
  }
  tokens.push({ type: "end" });
  return tokens;
}

function failure() {
  return { type: "error", code: ERRORS.parse };
}

/**
 * The tree for a formula's text (without its leading `=`), or a node that evaluates to `#PARSE!`.
 */
export function parseFormula(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_FORMULA_CHARS) return failure();
  const tokens = tokenize(source);
  if (tokens === undefined) return failure();
  let position = 0;
  let depth = 0;
  const peek = () => tokens[position] ?? { type: "end" };
  const take = () => tokens[position++] ?? { type: "end" };
  const fail = () => {
    throw new SyntaxError("formula");
  };
  const deeper = () => {
    depth += 1;
    if (depth > MAX_DEPTH) fail();
  };

  const reference = (token) =>
    token.row >= MAX_ROWS || token.column < 0 || token.column >= MAX_COLUMNS || token.row < 0
      ? { type: "error", code: ERRORS.ref }
      : { type: "ref", row: token.row, column: token.column };

  const primary = () => {
    const token = take();
    switch (token.type) {
      case "number":
        return { type: "number", value: token.value };
      case "ref": {
        if (peek().type !== ":") return reference(token);
        take();
        const end = take();
        if (end.type !== "ref") fail();
        const a = reference(token);
        const b = reference(end);
        if (a.type === "error" || b.type === "error") return { type: "error", code: ERRORS.ref };
        return {
          type: "range",
          top: Math.min(a.row, b.row),
          left: Math.min(a.column, b.column),
          bottom: Math.max(a.row, b.row),
          right: Math.max(a.column, b.column),
        };
      }
      case "name": {
        if (take().type !== "(") fail();
        const args = [];
        if (peek().type === ")") fail();
        for (;;) {
          args.push(expression());
          if (args.length > MAX_ARGUMENTS) fail();
          const next = take();
          if (next.type === ")") break;
          if (next.type !== ",") fail();
        }
        return { type: "call", name: token.value, args };
      }
      case "(": {
        const inner = expression();
        if (take().type !== ")") fail();
        return { type: "group", inner };
      }
      default:
        return fail();
    }
  };

  const unary = () => {
    const token = peek();
    if (token.type === "-" || token.type === "+") {
      take();
      deeper();
      const operand = unary();
      depth -= 1;
      return token.type === "-" ? { type: "negate", operand } : { type: "plus", operand };
    }
    return primary();
  };

  const binary = (next, operators) => () => {
    deeper();
    let left = next();
    while (operators.includes(peek().type)) {
      const operator = take().type;
      left = { type: "binary", operator, left, right: next() };
    }
    depth -= 1;
    return left;
  };

  const power = binary(unary, ["^"]);
  const term = binary(power, ["*", "/"]);
  const expression = binary(term, ["+", "-"]);

  try {
    const tree = expression();
    if (peek().type !== "end") return failure();
    return tree;
  } catch {
    return failure();
  }
}

/** The cells and ranges a tree reads, for ordering the evaluation. */
export function references(tree) {
  const cells = [];
  const ranges = [];
  const visit = (node) => {
    switch (node.type) {
      case "ref":
        cells.push(node);
        break;
      case "range":
        ranges.push(node);
        break;
      case "negate":
      case "plus":
        visit(node.operand);
        break;
      case "group":
        visit(node.inner);
        break;
      case "binary":
        visit(node.left);
        visit(node.right);
        break;
      case "call":
        for (const arg of node.args) visit(arg);
        break;
      default:
        break;
    }
  };
  visit(tree);
  return { cells, ranges };
}

/* --------------------------------------------------------------- evaluating */

/**
 * Evaluate one tree. `read(row, column)` gives a cell's value: a number, text, `null` when empty, or an error.
 * `walkRange(range, visit)` visits the non-empty cells of a range and returns false when the budget ran out.
 */
function evaluateTree(tree, read, walkRange) {
  const arithmetic = (value) => {
    if (isError(value)) return value;
    if (value === null) return 0;
    if (typeof value === "number") return value;
    return errorValue(ERRORS.value);
  };
  const finite = (value) => (Number.isFinite(value) ? value : errorValue(ERRORS.num));

  const call = (node) => {
    if (!FUNCTIONS.includes(node.name)) return errorValue(ERRORS.name);
    const numbers = [];
    let firstError;
    const counting = node.name === "COUNT";
    const take = (value, fromCell) => {
      if (isError(value)) {
        if (firstError === undefined) firstError = value;
        return;
      }
      if (typeof value === "number") numbers.push(value);
      else if (value === null && !fromCell) numbers.push(0);
      else if (typeof value === "string" && !fromCell && !counting) firstError ??= errorValue(ERRORS.value);
    };
    for (const arg of node.args) {
      if (arg.type === "range") {
        const complete = walkRange(arg, (value) => take(value, true));
        if (!complete) return errorValue(ERRORS.limit);
      } else if (arg.type === "ref") {
        take(read(arg.row, arg.column), true);
      } else {
        take(evaluate(arg), false);
      }
    }
    if (counting) return numbers.length;
    if (firstError !== undefined) return firstError;
    switch (node.name) {
      case "SUM":
        return finite(numbers.reduce((sum, value) => sum + value, 0));
      case "AVERAGE":
        return numbers.length === 0 ? errorValue(ERRORS.div0) : finite(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
      case "MIN":
        return numbers.length === 0 ? 0 : numbers.reduce((least, value) => Math.min(least, value));
      case "MAX":
        return numbers.length === 0 ? 0 : numbers.reduce((most, value) => Math.max(most, value));
      default:
        return errorValue(ERRORS.name);
    }
  };

  const evaluate = (node) => {
    switch (node.type) {
      case "number":
        return node.value;
      case "error":
        return errorValue(node.code);
      case "ref": {
        const value = read(node.row, node.column);
        return value === null ? 0 : value;
      }
      case "range":
        // A range is a list of cells; only a function can take one.
        return errorValue(ERRORS.value);
      case "group":
        return evaluate(node.inner);
      case "plus":
        return arithmetic(evaluate(node.operand));
      case "negate": {
        const value = arithmetic(evaluate(node.operand));
        return isError(value) ? value : -value;
      }
      case "binary": {
        const left = arithmetic(evaluate(node.left));
        if (isError(left)) return left;
        const right = arithmetic(evaluate(node.right));
        if (isError(right)) return right;
        switch (node.operator) {
          case "+":
            return finite(left + right);
          case "-":
            return finite(left - right);
          case "*":
            return finite(left * right);
          case "/":
            return right === 0 ? errorValue(ERRORS.div0) : finite(left / right);
          case "^":
            return finite(left ** right);
          default:
            return errorValue(ERRORS.parse);
        }
      }
      case "call":
        return call(node);
      default:
        return errorValue(ERRORS.parse);
    }
  };

  return evaluate(tree);
}

/**
 * One formula against a fixed lookup, for tests and for previews.
 *
 * @param {string} source
 * @param {(row: number, column: number) => unknown} [lookup]
 */
export function evaluateFormula(source, lookup = () => null) {
  const tree = parseFormula(source);
  const walk = (range, visit) => {
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        const value = lookup(row, column);
        if (value !== null) visit(value);
      }
    }
    return true;
  };
  return evaluateTree(tree, lookup, walk);
}

/* --------------------------------------------------------------- the sheet */

const keyOf = (row, column) => row * MAX_COLUMNS + column;
const nameOfKey = (key) => cellName(Math.floor(key / MAX_COLUMNS), key % MAX_COLUMNS);

/**
 * Every cell's value, with the formulas evaluated in dependency order.
 *
 * The order comes from the formulas' references, not from recursion, so a long chain (`A2=A1+1`, `A3=A2+1`, …) cannot
 * exhaust the call stack. Cells left over once everything else is ordered sit on or behind a cycle; the cycles themselves
 * are found as strongly connected components and reported by cell name, and every cell that reads one shows `#CIRC!`.
 */
export function evaluateSheet(sheet, parsed = new Map()) {
  const inputs = new Map();
  const formulas = new Map();
  sheet.forEach((row, column, raw) => {
    const input = classifyInput(raw);
    const key = keyOf(row, column);
    if (input.kind === "formula") {
      let tree = parsed.get(input.source);
      if (tree === undefined) {
        tree = parseFormula(input.source);
        parsed.set(input.source, tree);
      }
      formulas.set(key, { tree, deps: new Set() });
    } else if (input.kind !== "empty") {
      inputs.set(key, input.value);
    }
  });

  const size = sheet.used();
  const values = new Map();
  const result = { values, cycles: [], limited: false, errors: 0 };
  const read = (row, column) => {
    if (row >= size.rows || column >= size.columns) return null;
    const key = keyOf(row, column);
    if (formulas.has(key)) return values.get(key) ?? null;
    return inputs.has(key) ? inputs.get(key) : null;
  };

  let evaluationSpent = 0;
  const walkRange = (range, visit) => {
    const bottom = Math.min(range.bottom, size.rows - 1);
    const right = Math.min(range.right, size.columns - 1);
    for (let row = range.top; row <= bottom; row += 1) {
      for (let column = range.left; column <= right; column += 1) {
        evaluationSpent += 1;
        if (evaluationSpent > EVALUATION_BUDGET) return false;
        const value = read(row, column);
        if (value !== null) visit(value);
      }
    }
    return true;
  };

  // Which formulas each formula reads, directly or through a range.
  const formulaKeys = [...formulas.keys()];
  let dependencySpent = 0;
  for (const formula of formulas.values()) {
    const { cells, ranges } = references(formula.tree);
    for (const cell of cells) {
      const target = keyOf(cell.row, cell.column);
      if (formulas.has(target)) formula.deps.add(target);
    }
    for (const range of ranges) {
      const bottom = Math.min(range.bottom, size.rows - 1);
      const right = Math.min(range.right, size.columns - 1);
      const area = Math.max(0, bottom - range.top + 1) * Math.max(0, right - range.left + 1);
      if (area <= formulaKeys.length) {
        dependencySpent += area;
        for (let row = range.top; row <= bottom; row += 1) {
          for (let column = range.left; column <= right; column += 1) {
            const target = keyOf(row, column);
            if (formulas.has(target)) formula.deps.add(target);
          }
        }
      } else {
        dependencySpent += formulaKeys.length;
        for (const target of formulaKeys) {
          const row = Math.floor(target / MAX_COLUMNS);
          const column = target % MAX_COLUMNS;
          if (row >= range.top && row <= bottom && column >= range.left && column <= right) formula.deps.add(target);
        }
      }
      if (dependencySpent > DEPENDENCY_BUDGET) break;
    }
    if (dependencySpent > DEPENDENCY_BUDGET) {
      result.limited = true;
      break;
    }
  }
  if (result.limited) {
    for (const key of formulaKeys) values.set(key, errorValue(ERRORS.limit));
    result.errors = formulaKeys.length;
    return finish(result, inputs);
  }

  // Kahn's ordering: a formula is evaluated once every formula it reads has been.
  const waiting = new Map();
  const dependents = new Map();
  for (const [key, formula] of formulas) {
    waiting.set(key, formula.deps.size);
    for (const dep of formula.deps) {
      const list = dependents.get(dep);
      if (list === undefined) dependents.set(dep, [key]);
      else list.push(key);
    }
  }
  const done = new Set();
  const queue = [];
  let head = 0;
  for (const [key, count] of waiting) if (count === 0) queue.push(key);

  const settle = (key) => {
    done.add(key);
    for (const next of dependents.get(key) ?? []) {
      if (done.has(next)) continue;
      const count = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, count);
      if (count === 0) queue.push(next);
    }
  };
  const drain = () => {
    while (head < queue.length) {
      const key = queue[head];
      head += 1;
      if (key === undefined || done.has(key)) continue;
      const formula = formulas.get(key);
      const value = evaluateTree(formula.tree, read, walkRange);
      values.set(key, evaluationSpent > EVALUATION_BUDGET ? errorValue(ERRORS.limit) : value);
      if (evaluationSpent > EVALUATION_BUDGET) result.limited = true;
      settle(key);
    }
  };
  drain();

  if (done.size < formulas.size) {
    const leftover = formulaKeys.filter((key) => !done.has(key));
    const members = cycleMembers(leftover, (key) => [...(formulas.get(key)?.deps ?? [])].filter((dep) => !done.has(dep)));
    result.cycles = [...members].sort((a, b) => a - b).map(nameOfKey);
    for (const key of members) values.set(key, errorValue(ERRORS.circ));
    for (const key of members) settle(key);
    drain();
    // Anything still waiting reads a cycle through a path the pass above could not order; it is part of the same fault.
    for (const key of formulaKeys) if (!done.has(key)) values.set(key, errorValue(ERRORS.circ));
  }

  result.errors = [...values.values()].filter(isError).length;
  return finish(result, inputs);
}

function finish(result, inputs) {
  for (const [key, value] of inputs) result.values.set(key, value);
  return {
    ...result,
    get: (row, column) => {
      const value = result.values.get(keyOf(row, column));
      return value === undefined ? null : value;
    },
  };
}

/**
 * The cells that sit on a cycle: members of a strongly connected component of more than one cell, or a cell that reads
 * itself. Tarjan's algorithm, written with an explicit stack so a long chain cannot overflow the call stack.
 */
function cycleMembers(nodes, edgesOf) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const members = new Set();
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [{ node: start, edges: edgesOf(start), next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      if (frame.next < frame.edges.length) {
        const target = frame.edges[frame.next];
        frame.next += 1;
        if (target === undefined) continue;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, edges: edgesOf(target), next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(target) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        const selfLoop = component.length === 1 && frame.edges.includes(frame.node);
        if (component.length > 1 || selfLoop) for (const member of component) members.add(member);
      }
    }
  }
  return members;
}
