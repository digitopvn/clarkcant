/**
 * Which regular expressions a package's JSON Schema may ask this node to run.
 *
 * A service lists an input schema for each tool, and the node checks every call against it on its main thread, where
 * `pattern` and `patternProperties` become JavaScript regular expressions. That engine backtracks, so a pattern such as
 * `^(a+)+$` can take exponential time on a short input and stall the whole node. A schema is therefore read before it is
 * used, and one whose patterns could backtrack without bound is refused.
 *
 * The check is deliberately conservative: it refuses some patterns that would in fact run quickly, and says which rule
 * each one broke so the package's author can write it another way. It refuses
 *
 *   - a repetition whose body can be matched more than one way from one repetition to the next, such as `(a+)+`,
 *     `(\w+\s?)*` or `(a?a)+` (a bounded repetition such as `(\d{1,3}\.?){4}` is allowed while its ways stay few);
 *   - a choice between options that can start with the same character, inside a repetition, such as `(a|ab)+`;
 *   - two unbounded repetitions in a row that can trade the same characters, such as `\d+\d+` or `.*.*`;
 *   - a backreference (`\1`, `\k<name>`), and a quantifier inside a lookahead or lookbehind;
 *   - a pattern longer than {@link MAX_PATTERN_LENGTH} characters, and one this reader cannot parse.
 *
 * What the rules miss is still bounded: a string checked against a pattern may be at most
 * {@link MAX_PATTERN_INPUT_LENGTH} characters, and a longer one is refused before any pattern runs.
 */

/** Longer than this, a pattern is refused outright. */
export const MAX_PATTERN_LENGTH = 512;
/** A value or key longer than this is refused rather than checked against a pattern. */
export const MAX_PATTERN_INPUT_LENGTH = 1000;
/** A schema or input nested deeper than this is refused rather than walked. */
const MAX_DEPTH = 64;
/** How many ways a bounded repetition may split one input before it counts as unbounded. */
const MAX_WAYS = 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Sets of UTF-16 code units, as sorted, disjoint, inclusive ranges. A pattern without the `u` flag matches code units.

type CharSet = readonly (readonly [number, number])[];

const MAX_UNIT = 0xffff;
const EMPTY: CharSet = [];

function union(a: CharSet, b: CharSet): CharSet {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const sorted = [...a, ...b].sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

function intersects(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as readonly [number, number];
    const y = b[j] as readonly [number, number];
    if (x[1] < y[0]) i += 1;
    else if (y[1] < x[0]) j += 1;
    else return true;
  }
  return false;
}

function complement(set: CharSet): CharSet {
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_UNIT) out.push([next, MAX_UNIT]);
  return out;
}

const unit = (code: number): CharSet => [[code, code]];
const of = (...chars: string[]): CharSet => chars.reduce<CharSet>((set, char) => union(set, unit(char.charCodeAt(0))), EMPTY);

const DIGIT: CharSet = [[0x30, 0x39]];
const WORD: CharSet = union(union(DIGIT, [[0x41, 0x5a], [0x61, 0x7a]]), of("_"));
const SPACE: CharSet = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const ANY_BUT_LINE_END: CharSet = complement(union(of("\n", "\r"), [[0x2028, 0x2029]]));

// ---------------------------------------------------------------------------------------------------------------------
// The pattern, read as the node's `new RegExp(pattern)` reads it: no flags, so no `u` and the web-compatibility syntax.

type Node =
  | { kind: "set"; set: CharSet }
  /** Matches without consuming: `^`, `$`, `\b`, `\B`, and a lookaround with no quantifier in it. */
  | { kind: "zero" }
  | { kind: "seq"; items: Node[] }
  | { kind: "alt"; options: Node[] }
  | { kind: "repeat"; body: Node; min: number; max: number };

/** A rule the pattern breaks, as the end of a sentence about the pattern. */
class Refusal extends Error {}

const REFUSE = {
  nested: "repeats something that can itself be matched more than one way, like (a+)+",
  alternation: "repeats a choice between options that can start with the same character, like (a|ab)+",
  adjacent: "has two repetitions in a row that can match the same characters, like \\d+\\d+",
  backreference: "refers back to an earlier group, like \\1",
  lookaround: "repeats inside a lookahead or lookbehind, like (?=a+)",
  unreadable: "is not one this node can read",
} as const;

const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/u;

function parsePattern(source: string): Node {
  let at = 0;

  const peek = (offset = 0): string | undefined => source[at + offset];
  const unreadable = (): never => {
    throw new Refusal(REFUSE.unreadable);
  };

  function hex(length: number): number | undefined {
    const digits = source.slice(at, at + length);
    if (digits.length !== length || !/^[0-9a-fA-F]+$/u.test(digits)) return undefined;
    at += length;
    return Number.parseInt(digits, 16);
  }

  /** After a backslash: a class of characters, one character, or (outside a class) an assertion. */
  function escape(inClass: boolean): CharSet | "zero" {
    const char = peek();
    if (char === undefined) return unreadable();
    at += 1;
    switch (char) {
      case "d":
        return DIGIT;
      case "D":
        return complement(DIGIT);
      case "w":
        return WORD;
      case "W":
        return complement(WORD);
      case "s":
        return SPACE;
      case "S":
        return complement(SPACE);
      case "b":
        return inClass ? unit(8) : "zero";
      case "B":
        return inClass ? of("B") : "zero";
      case "t":
        return of("\t");
      case "n":
        return of("\n");
      case "v":
        return of("\v");
      case "f":
        return of("\f");
      case "r":
        return of("\r");
      case "x":
        return unit(hex(2) ?? "x".charCodeAt(0));
      case "u":
        return unit(hex(4) ?? "u".charCodeAt(0));
      case "c": {
        const letter = peek();
        if (letter !== undefined && /[A-Za-z]/u.test(letter)) {
          at += 1;
          return unit(letter.charCodeAt(0) % 32);
        }
        // Read literally as a backslash and a `c`; either is what the next character can be.
        return of("\\", "c");
      }
      case "k":
        if (!inClass && peek() === "<") throw new Refusal(REFUSE.backreference);
        return of("k");
      default:
        // Outside a class, `\1`–`\9` is a backreference, or an octal escape when there are fewer groups: both refused.
        if (/[1-9]/u.test(char) && !inClass) throw new Refusal(REFUSE.backreference);
        // `\0` and, in a class, an octal escape: some code unit up to 0xff.
        if (/[0-9]/u.test(char)) return [[0, 0xff]];
        return of(char);
    }
  }

  function charClass(): CharSet {
    // `[` already read.
    let negated = false;
    if (peek() === "^") {
      negated = true;
      at += 1;
    }
    let set: CharSet = EMPTY;
    const member = (): CharSet | number => {
      const char = peek();
      if (char === undefined) return unreadable();
      at += 1;
      if (char !== "\\") return char.charCodeAt(0);
      const read = escape(true);
      if (read === "zero") return unreadable();
      return read.length === 1 && read[0]?.[0] === read[0]?.[1] ? (read[0]?.[0] ?? 0) : read;
    };
    for (;;) {
      if (peek() === undefined) return unreadable();
      if (peek() === "]") {
        at += 1;
        break;
      }
      const from = member();
      if (peek() === "-" && peek(1) !== "]" && peek(1) !== undefined) {
        at += 1;
        const to = member();
        if (typeof from === "number" && typeof to === "number") {
          if (from > to) return unreadable();
          set = union(set, [[from, to]]);
        } else {
          // `[\d-z]`: a class at either end makes the dash a character of its own.
          set = union(union(set, typeof from === "number" ? unit(from) : from), union(typeof to === "number" ? unit(to) : to, of("-")));
        }
        continue;
      }
      set = union(set, typeof from === "number" ? unit(from) : from);
    }
    return negated ? complement(set) : set;
  }

  function containsRepeat(node: Node): boolean {
    switch (node.kind) {
      case "repeat":
        return true;
      case "seq":
        return node.items.some(containsRepeat);
      case "alt":
        return node.options.some(containsRepeat);
      default:
        return false;
    }
  }

  function group(): Node {
    // `(` already read.
    let lookaround = false;
    if (peek() === "?") {
      const kind = source.slice(at + 1, at + 3);
      if (kind.startsWith(":")) at += 2;
      else if (kind.startsWith("=") || kind.startsWith("!")) {
        lookaround = true;
        at += 2;
      } else if (kind === "<=" || kind === "<!") {
        lookaround = true;
        at += 3;
      } else if (kind.startsWith("<")) {
        const close = source.indexOf(">", at);
        if (close < 0) return unreadable();
        at = close + 1;
      } else return unreadable();
    }
    const body = alternatives();
    if (peek() !== ")") return unreadable();
    at += 1;
    if (!lookaround) return body;
    if (containsRepeat(body)) throw new Refusal(REFUSE.lookaround);
    return { kind: "zero" };
  }

  function atom(): Node | undefined {
    const char = peek();
    if (char === undefined || char === "|" || char === ")") return undefined;
    at += 1;
    switch (char) {
      case "(":
        return group();
      case "[":
        return { kind: "set", set: charClass() };
      case ".":
        return { kind: "set", set: ANY_BUT_LINE_END };
      case "^":
      case "$":
        return { kind: "zero" };
      case "\\": {
        const read = escape(false);
        return read === "zero" ? { kind: "zero" } : { kind: "set", set: read };
      }
      case "*":
      case "+":
      case "?":
        return unreadable();
      case "{":
        // A `{` that does not start a quantifier is a character; one that does has nothing to repeat.
        if (QUANTIFIER.test(source.slice(at - 1))) return unreadable();
        return { kind: "set", set: of("{") };
      default:
        return { kind: "set", set: of(char) };
    }
  }

  function quantified(node: Node): Node {
    let min: number;
    let max: number;
    const char = peek();
    if (char === "*") [min, max] = [0, Infinity];
    else if (char === "+") [min, max] = [1, Infinity];
    else if (char === "?") [min, max] = [0, 1];
    else if (char === "{") {
      const match = QUANTIFIER.exec(source.slice(at));
      if (match === null) return node;
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
      if (max < min) return unreadable();
      at += match[0].length - 1;
    } else return node;
    at += 1;
    if (peek() === "?") at += 1;
    // A repeated repetition, `a**`, is a syntax error in JavaScript.
    if (peek() === "*" || peek() === "+" || peek() === "?") return unreadable();
    return { kind: "repeat", body: node, min, max };
  }

  function sequence(): Node {
    const items: Node[] = [];
    for (;;) {
      const next = atom();
      if (next === undefined) break;
      items.push(quantified(next));
    }
    return items.length === 1 ? (items[0] as Node) : { kind: "seq", items };
  }

  function alternatives(): Node {
    const options = [sequence()];
    while (peek() === "|") {
      at += 1;
      options.push(sequence());
    }
    return options.length === 1 ? (options[0] as Node) : { kind: "alt", options };
  }

  const tree = alternatives();
  if (at !== source.length) return unreadable();
  return tree;
}

// ---------------------------------------------------------------------------------------------------------------------
// What each part of a pattern can match, gathered bottom-up, with the rules checked on the way.

interface Shape {
  /** Whether it can match the empty string. */
  nullable: boolean;
  /** The characters a match can start with, and end with. */
  first: CharSet;
  last: CharSet;
  /** What a variable repetition can take or give back at the start, or at the end, of a match. */
  headVariable: CharSet;
  tailVariable: CharSet;
  /** The same, for an unbounded repetition only. */
  headUnbounded: CharSet;
  tailUnbounded: CharSet;
  minLength: number;
  maxLength: number;
  /** Whether it holds a choice between options that can start with the same character. */
  overlappingChoice: boolean;
}

const ZERO: Shape = {
  nullable: true,
  first: EMPTY,
  last: EMPTY,
  headVariable: EMPTY,
  tailVariable: EMPTY,
  headUnbounded: EMPTY,
  tailUnbounded: EMPTY,
  minLength: 0,
  maxLength: 0,
  overlappingChoice: false,
};

/** Two shapes one after the other. */
function followedBy(a: Shape, b: Shape): Shape {
  if (intersects(a.tailUnbounded, b.headUnbounded)) throw new Refusal(REFUSE.adjacent);
  return {
    nullable: a.nullable && b.nullable,
    first: a.nullable ? union(a.first, b.first) : a.first,
    last: b.nullable ? union(b.last, a.last) : b.last,
    headVariable: a.nullable ? union(a.headVariable, b.headVariable) : a.headVariable,
    tailVariable: b.nullable ? union(b.tailVariable, a.tailVariable) : b.tailVariable,
    headUnbounded: a.nullable ? union(a.headUnbounded, b.headUnbounded) : a.headUnbounded,
    tailUnbounded: b.nullable ? union(b.tailUnbounded, a.tailUnbounded) : b.tailUnbounded,
    minLength: a.minLength + b.minLength,
    maxLength: a.maxLength + b.maxLength,
    overlappingChoice: a.overlappingChoice || b.overlappingChoice,
  };
}

function times(count: number, length: number): number {
  return count === 0 || length === 0 ? 0 : count * length;
}

function shapeOf(node: Node): Shape {
  switch (node.kind) {
    case "zero":
      return ZERO;
    case "set":
      return { ...ZERO, nullable: false, first: node.set, last: node.set, minLength: 1, maxLength: 1 };
    case "seq":
      return node.items.map(shapeOf).reduce(followedBy, ZERO);
    case "alt": {
      const options = node.options.map(shapeOf);
      let overlapping = options.some((option) => option.overlappingChoice);
      for (let i = 0; i < options.length && !overlapping; i += 1) {
        for (let j = i + 1; j < options.length && !overlapping; j += 1) {
          overlapping = intersects((options[i] as Shape).first, (options[j] as Shape).first);
        }
      }
      return options.reduce(
        (acc, option) => ({
          nullable: acc.nullable || option.nullable,
          first: union(acc.first, option.first),
          last: union(acc.last, option.last),
          headVariable: union(acc.headVariable, option.headVariable),
          tailVariable: union(acc.tailVariable, option.tailVariable),
          headUnbounded: union(acc.headUnbounded, option.headUnbounded),
          tailUnbounded: union(acc.tailUnbounded, option.tailUnbounded),
          minLength: Math.min(acc.minLength, option.minLength),
          maxLength: Math.max(acc.maxLength, option.maxLength),
          overlappingChoice: overlapping,
        }),
        { ...ZERO, nullable: false, minLength: Infinity, overlappingChoice: overlapping },
      );
    }
    case "repeat": {
      const body = shapeOf(node.body);
      const { min, max } = node;
      if (max > 1) {
        // One repetition's end can trade characters with the next one's start, or one pass can go two ways.
        const trades = intersects(body.tailVariable, body.first) || intersects(body.headVariable, body.last);
        if (trades || body.overlappingChoice) {
          const span = body.maxLength - body.minLength + 2;
          if (max === Infinity || body.maxLength === Infinity || span ** max > MAX_WAYS) {
            throw new Refusal(trades ? REFUSE.nested : REFUSE.alternation);
          }
        }
      }
      const variable = min < max;
      const unbounded = variable && max === Infinity;
      return {
        nullable: min === 0 || body.nullable,
        first: body.first,
        last: body.last,
        headVariable: variable ? union(body.headVariable, body.first) : body.headVariable,
        tailVariable: variable ? union(body.tailVariable, body.last) : body.tailVariable,
        headUnbounded: unbounded ? union(body.headUnbounded, body.first) : body.headUnbounded,
        tailUnbounded: unbounded ? union(body.tailUnbounded, body.last) : body.tailUnbounded,
        minLength: times(min, body.minLength),
        maxLength: times(max, body.maxLength),
        overlappingChoice: body.overlappingChoice,
      };
    }
  }
}

/**
 * Why checking an input against this pattern could take unbounded time, as the end of a sentence about the pattern, or
 * undefined when it cannot.
 */
export function unsafePatternReason(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return `is longer than ${String(MAX_PATTERN_LENGTH)} characters`;
  try {
    shapeOf(parsePattern(pattern));
    return undefined;
  } catch (cause) {
    if (cause instanceof Refusal) return cause.message;
    // A stack overflow or anything else unexpected is not evidence the pattern is safe.
    return REFUSE.unreadable;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Every place in a JSON Schema a pattern can be.

/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
/** Keywords whose value is a list of schemas (`items` is one in the older drafts). */
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "items", "oneOf", "prefixItems"] as const;
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP_KEYWORDS = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface UnsafeSchemaPattern {
  /** Where in the schema, such as `properties.name.pattern`. */
  at: string;
  pattern: string;
  why: string;
}

function member(path: string, key: string): string {
  const shown = key.length > 40 ? `${key.slice(0, 40)}…` : key;
  const name = /^[A-Za-z_$][\w$]*$/u.test(shown) ? shown : JSON.stringify(shown);
  return path === "" ? name : /^[A-Za-z_$]/u.test(name) ? `${path}.${name}` : `${path}[${name}]`;
}

/**
 * The first pattern in a schema this node will not run, with where it is, or undefined when every one is safe.
 *
 * Walks every keyword whose value is a schema, including `$defs`, `patternProperties` (whose names are patterns too),
 * and `propertyNames`. Values that are data rather than schemas (`default`, `examples`, `const`, `enum`) are not walked.
 */
export function unsafeSchemaPattern(schema: unknown, path = "", depth = 0): UnsafeSchemaPattern | undefined {
  if (!isObject(schema)) return undefined;
  if (depth > MAX_DEPTH) return { at: path, pattern: "", why: `is nested more than ${String(MAX_DEPTH)} levels deep` };
  if (schema.pattern !== undefined) {
    const at = member(path, "pattern");
    // The validator turns whatever is there into a pattern, so text is the only thing it may be.
    if (typeof schema.pattern !== "string") return { at, pattern: String(schema.pattern), why: "is not text" };
    const why = unsafePatternReason(schema.pattern);
    if (why !== undefined) return { at, pattern: schema.pattern, why };
  }
  if (isObject(schema.patternProperties)) {
    for (const key of Object.keys(schema.patternProperties)) {
      const why = unsafePatternReason(key);
      if (why !== undefined) return { at: member(member(path, "patternProperties"), key), pattern: key, why };
    }
  }
  for (const keyword of SCHEMA_KEYWORDS) {
    const found = unsafeSchemaPattern(schema[keyword], member(path, keyword), depth + 1);
    if (found !== undefined) return found;
  }
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const list = schema[keyword];
    if (!Array.isArray(list)) continue;
    for (const [index, item] of list.entries()) {
      const found = unsafeSchemaPattern(item, `${member(path, keyword)}[${String(index)}]`, depth + 1);
      if (found !== undefined) return found;
    }
  }
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword];
    if (!isObject(map)) continue;
    for (const [key, item] of Object.entries(map)) {
      const found = unsafeSchemaPattern(item, member(member(path, keyword), key), depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** A refused pattern in words a person can act on. */
export function describeUnsafePattern(found: UnsafeSchemaPattern): string {
  if (found.pattern === "") return `the schema ${found.why}`;
  const shown = found.pattern.length > 60 ? `${found.pattern.slice(0, 60)}…` : found.pattern;
  return `the pattern ${JSON.stringify(shown)} at ${found.at} ${found.why}, so checking an input against it could stall this node`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The input side: no value or key that a pattern will be run on may be longer than the bound.

/** The schemas that apply to one value, following `$ref` into the root's definitions and the combining keywords. */
function applicable(schema: unknown, root: Json, seen: Set<unknown> = new Set()): Json[] {
  if (!isObject(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const found: Json[] = [schema];
  if (typeof schema.$ref === "string") {
    const [, where, name] = /^#\/(\$defs|definitions)\/(.+)$/u.exec(schema.$ref) ?? [];
    const defs = where === undefined ? undefined : root[where];
    const target = name === undefined || !isObject(defs) ? undefined : defs[name.replace(/~1/gu, "/").replace(/~0/gu, "~")];
    found.push(...applicable(schema.$ref === "#" ? root : target, root, seen));
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const list = schema[keyword];
    if (Array.isArray(list)) for (const item of list) found.push(...applicable(item, root, seen));
  }
  for (const keyword of ["not", "if", "then", "else"] as const) found.push(...applicable(schema[keyword], root, seen));
  return found;
}

function overlong(schema: unknown, root: Json, value: unknown, path: string, depth: number): string | undefined {
  const schemas = applicable(schema, root);
  if (schemas.length === 0) return undefined;
  if (depth > MAX_DEPTH) return path;
  if (typeof value === "string") {
    return value.length > MAX_PATTERN_INPUT_LENGTH && schemas.some((each) => each.pattern !== undefined) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const at = `${path}[${String(index)}]`;
      for (const each of schemas) {
        const positional = Array.isArray(each.prefixItems) ? each.prefixItems : Array.isArray(each.items) ? each.items : undefined;
        const children = [
          positional?.[index],
          Array.isArray(each.items) ? undefined : each.items,
          each.additionalItems,
          each.contains,
          each.unevaluatedItems,
        ];
        for (const child of children) {
          const found = overlong(child, root, item, at, depth + 1);
          if (found !== undefined) return found;
        }
      }
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const at = member(path, key);
    for (const each of schemas) {
      const patterned = isObject(each.patternProperties) ? Object.values(each.patternProperties) : [];
      if (key.length > MAX_PATTERN_INPUT_LENGTH && patterned.length > 0) return `${at} (its name)`;
      const named = overlong(each.propertyNames, root, key, `${at} (its name)`, depth + 1);
      if (named !== undefined) return named;
      const own = isObject(each.properties) && Object.hasOwn(each.properties, key) ? each.properties[key] : undefined;
      for (const child of [own, ...patterned, each.additionalProperties, each.unevaluatedProperties]) {
        const found = overlong(child, root, item, at, depth + 1);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/**
 * Where an input holds a value or key longer than {@link MAX_PATTERN_INPUT_LENGTH} that the schema would check against
 * a pattern, or undefined when there is none. Only such values are bounded: a long note a schema does not pattern-check
 * is not refused.
 */
export function overlongPatternInput(schema: Json, input: unknown): string | undefined {
  return overlong(schema, schema, input, "", 0);
}
