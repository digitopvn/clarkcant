/**
 * Which titles in a spec file a platform condition keeps from running.
 *
 * The status registry's first rule is that an `implemented` entry names a test that exercises it. A test inside
 * `describe.skipIf(!POSIX)` is named, exists, and never runs on a runner where the condition does not hold, so a
 * check that only looks for the title accepts evidence that cannot execute. This module answers the question that
 * check needs: for one spec file, which test titles sit under a platform-conditional skip.
 *
 * It scans the text and carries its own picture of nesting rather than loading a parser, because
 * `tools/check-invariants.mjs` runs before `pnpm install` in CI: nothing under `node_modules` is resolvable from
 * there, and a third-party parser would take the whole invariants step down with it — the step that is deliberately
 * kept runnable with no install at all. Nesting is the property being asked about, and a matcher that quietly fails
 * to nest looks exactly like a repository with nothing wrong, which is the one outcome this module must never
 * produce. It is therefore conservative in one direction only: a title is reported as running only when the scan can
 * show it sits outside every platform skip it can see, and a file it cannot scan throws instead of reporting an
 * empty map. The condition is resolved rather than pattern-matched on the call: `!POSIX` counts only because `POSIX`
 * is bound in the same file to `process.platform`, and an opt-in gate such as `describe.skipIf(!LIVE)` on an
 * environment variable is deliberately not this module's subject.
 *
 * This lives outside check-invariants.mjs so the nesting can be tested on its own.
 */

/**
 * One token of the scan. Comments and whitespace are dropped, and a string, template or regular expression is one
 * token so its contents can never be read as structure. `match` pairs an opening delimiter with its closing one.
 *
 * @typedef {object} Token
 * @property {"name" | "string" | "template" | "number" | "regex" | "punct"} kind
 * @property {string} text
 * @property {number} start
 * @property {number} end
 * @property {string} [value] a literal's own contents, escapes resolved
 * @property {number} [substitutions] how many `${...}` a template literal has
 * @property {number} [match]
 */

/** The `process` members that read the platform this runner is on. */
const PLATFORM_MEMBERS = new Set(["platform", "arch"]);

/** A test or suite declaration: `it`, `test`, `describe`, or a dotted variant such as `it.each`. */
const DECLARATION = /^(?:describe|it|test)(?:\.[A-Za-z]+)*$/;

/** A declaration whose condition is a runtime one: `describe.skipIf`, `it.runIf`, and the dotted variants. */
const MODIFIER = /^(?:describe|it|test)(?:\.[A-Za-z]+)*\.(?:skipIf|runIf)$/;

/** The names binding a value, which is how a platform read can reach a skip through a name. */
const DECLARATORS = new Set(["const", "let", "var"]);

/** A delimiter a `/` divides after rather than opening a regular expression. */
const DIVIDES_AFTER = new Set([")", "]", "}", "++", "--"]);

/** Keywords a `/` opens a regular expression after, even though a name precedes it. */
const REGEX_AFTER = new Set([
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
  "await",
]);

/** Punctuators, longest first so `=>` is not read as `=` followed by `>`. */
const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  "&&=",
  "||=",
  "??=",
  ">>>",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ";",
  ",",
  ".",
  ":",
  "?",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "&",
  "|",
  "^",
  "~",
  "@",
  "#",
];

/** The characters an escape sequence stands for, where it stands for anything. */
const ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };

/**
 * @param {string} reason
 * @returns {Error} the one error shape this module throws, so a caller can tell a scan that could not read the file
 * from a bug in the scan
 */
function parseError(reason) {
  return new Error(`not parseable as TypeScript: ${reason}`);
}

/**
 * Whether a `/` here opens a regular expression rather than dividing.
 *
 * This is the only place a token's kind depends on the token before it, and the scan needs it so a pattern such as
 * `/\)/` cannot contribute a delimiter.
 *
 * @param {Token | undefined} previous
 */
function opensRegex(previous) {
  if (previous === undefined) return true;
  if (previous.kind === "name") return REGEX_AFTER.has(previous.text);
  if (previous.kind === "punct") return !DIVIDES_AFTER.has(previous.text);
  return false;
}

/**
 * @param {string} source
 * @param {number} start index of the opening quote
 * @returns {number} the index just past the closing quote
 */
function endOfString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") break;
    if (ch === quote) return i + 1;
    i += 1;
  }
  throw parseError("unterminated string literal");
}

/**
 * @param {string} source
 * @param {number} start index of the opening slash
 * @returns {number} the index just past the pattern and its flags
 */
function endOfRegex(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") throw parseError("unterminated regular expression literal");
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i += 1;
      while (i < source.length && /[a-z]/iu.test(source[i])) i += 1;
      return i;
    }
    i += 1;
  }
  throw parseError("unterminated regular expression literal");
}

/**
 * @param {string} source
 * @param {number} start index of the first digit
 * @returns {number} the index just past the number, exponent included
 */
function endOfNumber(source, start) {
  let i = start;
  while (i < source.length && /[0-9A-Za-z_.]/u.test(source[i])) {
    if (source[i] === "." && source[i + 1] === ".") break;
    i += 1;
  }
  const sign = source[i];
  if ((source[i - 1] === "e" || source[i - 1] === "E") && (sign === "+" || sign === "-")) {
    i += 1;
    while (i < source.length && /[0-9]/u.test(source[i])) i += 1;
  }
  return i;
}

/**
 * A literal's contents, with the escapes a title could carry resolved: a registry entry writes the title as a person
 * reads it, not as the source spells it.
 *
 * @param {string} raw the literal's text, quotes included
 */
function literalValue(raw) {
  return raw
    .slice(1, -1)
    .replace(/\\(.)/gu, (_whole, next) => ESCAPES[next] ?? next);
}

/**
 * The source as a token stream.
 *
 * @param {string} source
 * @returns {Token[]}
 * @throws when the text cannot be scanned as a whole file: an unterminated literal, template or comment, or a
 * delimiter whose partner is missing. Reporting nothing as skipped is what a clean repository looks like, so an
 * unreadable file must not be able to produce it.
 */
function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  /** @type {{kind: string, index?: number}[]} */
  const open = [];
  /** @type {{start: number, value: string, substitutions: number}[]} */
  const substitutions = [];
  /** @type {{start: number, value: string, substitutions: number} | undefined} */
  let template;
  /** @type {Token | undefined} */
  let previous;
  let i = 0;

  /**
   * @param {Token["kind"]} kind
   * @param {number} start
   * @param {number} end
   * @param {Partial<Token>} [extra] the literal's own contents, where the token is one
   */
  const emit = (kind, start, end, extra) => {
    const token = { kind, text: source.slice(start, end), start, end, ...extra };
    tokens.push(token);
    previous = token;
    return token;
  };

  while (i < source.length) {
    const ch = source[i];

    /* Inside a template literal the only characters that matter are the ones that end it or start a substitution. */
    if (template !== undefined) {
      if (ch === "\\") {
        template.value += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        emit("template", template.start, i + 1, {
          value: template.value,
          substitutions: template.substitutions,
        });
        template = undefined;
        i += 1;
        continue;
      }
      if (ch === "$" && source[i + 1] === "{") {
        template.substitutions += 1;
        substitutions.push(template);
        template = undefined;
        open.push({ kind: "substitution" });
        i += 2;
        continue;
      }
      template.value += ch;
      i += 1;
      continue;
    }

    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const line = source.indexOf("\n", i);
      i = line === -1 ? source.length : line + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw parseError("unterminated block comment");
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfString(source, i);
      emit("string", i, end, { value: literalValue(source.slice(i, end)) });
      i = end;
      continue;
    }
    if (ch === "`") {
      template = { start: i, value: "", substitutions: 0 };
      i += 1;
      continue;
    }
    if (ch === "/" && opensRegex(previous)) {
      const end = endOfRegex(source, i);
      emit("regex", i, end);
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/u.test(ch)) {
      let end = i + 1;
      while (end < source.length && /[A-Za-z0-9_$]/u.test(source[end])) end += 1;
      emit("name", i, end);
      i = end;
      continue;
    }
    if (/[0-9]/u.test(ch)) {
      const end = endOfNumber(source, i);
      emit("number", i, end);
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      emit("punct", i, i + 1);
      open.push({ kind: ch, index: tokens.length - 1 });
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const frame = open.pop();
      const opener = { ")": "(", "]": "[", "}": "{" }[ch];
      if (frame === undefined) throw parseError(`unbalanced ${ch}`);
      if (frame.kind === "substitution") {
        if (ch !== "}") throw parseError(`unbalanced ${ch} inside a template substitution`);
        template = substitutions.pop();
        i += 1;
        continue;
      }
      if (frame.kind !== opener) throw parseError(`unbalanced ${ch}`);
      const closing = emit("punct", i, i + 1);
      closing.match = frame.index;
      tokens[frame.index].match = tokens.length - 1;
      i += 1;
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i));
    if (punctuator !== undefined) {
      emit("punct", i, i + punctuator.length);
      i += punctuator.length;
      continue;
    }
    /* An operator this list does not name is still a token: it must not be dropped, because the next `/` reads it. */
    emit("punct", i, i + 1);
    i += 1;
  }

  if (template !== undefined) throw parseError("unterminated template literal");
  if (open.length > 0) throw parseError(`unbalanced ${open[open.length - 1].kind}`);
  return tokens;
}

/**
 * Each group's parent group, for the ancestor walk that decides whether a title sits under a skip, plus the depth
 * each token sits at, which is how a declarator's initializer knows where it ends.
 *
 * @param {Token[]} tokens
 * @returns {{parents: Map<number, number>, depth: number[]}} opening token index to its enclosing group's index
 */
function groups(tokens) {
  /** @type {Map<number, number>} */
  const parents = new Map();
  /** @type {number[]} */
  const depth = [];
  /** @type {number[]} */
  const stack = [];
  tokens.forEach((token, index) => {
    depth.push(stack.length);
    if (token.kind !== "punct") return;
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      const enclosing = stack[stack.length - 1];
      if (enclosing !== undefined) parents.set(index, enclosing);
      stack.push(index);
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      stack.pop();
    }
  });
  return { parents, depth };
}

/**
 * The call whose argument list is the group opened at `index`, or `undefined` when the group is not a call's
 * arguments — a parenthesised expression, or a call through a computed member.
 *
 * `called` says the callee is itself a call, which is what tells the outer call of a modifier
 * (`describe.skipIf(!POSIX)("title", ...)`) from the modifier itself.
 *
 * @param {Token[]} tokens
 * @param {number} index
 * @returns {{text: string, called: boolean} | undefined}
 */
function calleeOf(tokens, index) {
  const previous = tokens[index - 1];
  if (previous === undefined) return undefined;
  if (previous.kind === "name") {
    let start = index - 1;
    while (
      start >= 2 &&
      tokens[start - 1].kind === "punct" &&
      tokens[start - 1].text === "." &&
      tokens[start - 2].kind === "name"
    ) {
      start -= 2;
    }
    const parts = tokens.slice(start, index).map((token) => token.text);
    return { text: parts.join(""), called: false };
  }
  if (previous.kind === "punct" && previous.text === ")" && previous.match !== undefined) {
    const inner = calleeOf(tokens, previous.match);
    if (inner === undefined) return undefined;
    return { text: inner.text, called: true };
  }
  return undefined;
}

/**
 * Whether a token range reads the platform, directly or through a name bound to it earlier in the file.
 *
 * @param {Token[]} tokens
 * @param {number} from
 * @param {number} to inclusive; less than `from` when the range is empty
 * @param {Set<string>} platformNames
 */
function readsPlatform(tokens, from, to, platformNames) {
  for (let i = from; i <= to; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== "name") continue;
    if (
      token.text === "process" &&
      tokens[i + 1]?.kind === "punct" &&
      tokens[i + 1]?.text === "." &&
      tokens[i + 2]?.kind === "name" &&
      PLATFORM_MEMBERS.has(tokens[i + 2].text)
    ) {
      return true;
    }
    if (platformNames.has(token.text)) return true;
  }
  return false;
}

/**
 * The names in this file whose value derives from the platform, in declaration order so a chain such as
 * `const WINDOWS = process.platform === "win32"; const POSIX = !WINDOWS;` is resolved before it is read.
 *
 * @param {Token[]} tokens
 * @param {number[]} depth
 */
function platformBoundNames(tokens, depth) {
  const names = new Set();
  tokens.forEach((token, index) => {
    if (token.kind !== "name" || !DECLARATORS.has(token.text)) return;
    const base = depth[index];
    for (let i = index + 1; i < tokens.length; ) {
      if (tokens[i].kind !== "name") return;
      const name = tokens[i].text;
      i += 1;
      if (tokens[i]?.text !== "=") {
        /* `let a, b = ...` and a destructuring pattern both land here: not a plain binding this scan follows. */
        if (tokens[i]?.text === ",") {
          i += 1;
          continue;
        }
        return;
      }
      const valueStart = i + 1;
      let end = valueStart;
      while (end < tokens.length && !(depth[end] === base && (tokens[end].text === "," || tokens[end].text === ";"))) {
        end += 1;
      }
      if (readsPlatform(tokens, valueStart, end - 1, names)) names.add(name);
      if (tokens[end]?.text !== ",") return;
      i = end + 1;
    }
  });
  return names;
}

/**
 * The titles a platform condition skips, mapped to the condition that skips them.
 *
 * A title declared more than once is reported only when every declaration of it is skipped: one declaration that
 * runs on this platform is enough for the title to be evidence.
 *
 * @param {string} sourceText the contents of one spec file
 * @returns {Map<string, string>} title to the condition's own text
 * @throws when the file cannot be scanned, rather than reporting that nothing is skipped: "nothing is skipped" is
 * what a clean repository looks like, so an unreadable file must not be able to produce it
 */
export function platformSkippedTestTitles(sourceText) {
  const tokens = tokenize(sourceText);
  const { parents, depth } = groups(tokens);
  const platformNames = platformBoundNames(tokens, depth);

  /*
   * The skip applies to the call that follows the modifier — `describe.skipIf(...)("title", fn)` — so the suite or
   * test that actually wraps the title is the outer call. Both of its groups are recorded: the modifier's own keeps
   * the condition, and the outer one is the ancestor every declaration inside it has.
   */
  /** @type {Map<number, string>} */
  const skips = new Map();
  tokens.forEach((token, index) => {
    if (token.kind !== "punct" || token.text !== "(" || token.match === undefined) return;
    const callee = calleeOf(tokens, index);
    if (callee === undefined || callee.called || !MODIFIER.test(callee.text)) return;
    const first = tokens[index + 1];
    const last = tokens[token.match - 1];
    if (first === undefined || last === undefined) return;
    if (!readsPlatform(tokens, index + 1, token.match - 1, platformNames)) return;
    const condition = sourceText.slice(first.start, last.end);
    skips.set(index, condition);
    const outer = tokens[token.match + 1];
    if (outer !== undefined && outer.kind === "punct" && outer.text === "(") skips.set(token.match + 1, condition);
  });

  /** @type {Map<string, {declarations: number, skipped: number, condition: string}>} */
  const seen = new Map();
  tokens.forEach((token, index) => {
    if (token.kind !== "punct" || token.text !== "(" || token.match === undefined) return;
    const callee = calleeOf(tokens, index);
    if (callee === undefined || !DECLARATION.test(callee.text)) return;
    const title = tokens[index + 1];
    if (title === undefined) return;
    const isLiteral = title.kind === "string" || (title.kind === "template" && title.substitutions === 0);
    const after = tokens[index + 2];
    if (!isLiteral || (after?.text !== "," && index + 2 !== token.match)) return;
    const text = title.kind === "string" ? literalValue(title.text) : title.text.slice(1, -1);

    /* The declaration is included: `it.skipIf(...)("title", fn)` carries its own skip, and so does the suite an
     * outer `describe.skipIf(...)(...)` call declares. */
    let condition;
    for (let group = index; group !== undefined && condition === undefined; group = parents.get(group)) {
      condition = skips.get(group);
    }
    const record = seen.get(text) ?? { declarations: 0, skipped: 0, condition: "" };
    record.declarations += 1;
    if (condition !== undefined) {
      record.skipped += 1;
      record.condition = condition;
    }
    seen.set(text, record);
  });

  const skipped = new Map();
  for (const [title, record] of seen) {
    if (record.declarations > 0 && record.skipped === record.declarations) skipped.set(title, record.condition);
  }
  return skipped;
}
