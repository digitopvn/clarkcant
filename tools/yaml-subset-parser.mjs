/**
 * A deliberately narrow YAML reader for this repository's GitHub workflow files.
 *
 * The merge-gate invariant must expand the job names of `.github/workflows/ci.yml` offline, and the repository has
 * no YAML dependency. Rather than add one, this reads exactly the shapes the workflows use: block mappings, block
 * sequences (including sequences of mappings), single-line flow sequences of scalars, `|`/`>` block scalars, and
 * plain, single-quoted and double-quoted single-line scalars, the empty flow mapping `{}`, with `#` comments.
 *
 * Anything else — anchors, aliases, tags, flow mappings, multi-line plain or quoted scalars, tabs for indentation,
 * duplicate keys — throws with a line number instead of being read approximately. A check built on this reader must
 * fail when the workflow outgrows it, never pass by having misread it.
 *
 * Plain scalars are typed the way YAML 1.2's core schema types them (`true`, `false`, `null`, `~`, numbers), because
 * GitHub does: an unquoted `node: 22.10` becomes the number 22.1 and is shown that way in a job name.
 */

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u;

export class YamlSubsetError extends Error {
  /** @param {string} message @param {number} line one-based line number */
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = "YamlSubsetError";
    this.line = line;
  }
}

/** Remove a trailing ` # comment` from a plain value, which YAML only recognises after whitespace. */
function stripPlainComment(text) {
  const match = /(^|\s)#/u.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
}

/** A plain scalar typed by the core schema. */
function plainScalar(text) {
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (NUMBER.test(text)) return Number(text);
  return text;
}

/**
 * Read one scalar that starts at the beginning of `text`. Returns the value and whatever follows it.
 *
 * @param {string} text
 * @param {number} line
 * @returns {{value: unknown, rest: string}}
 */
function readScalarPrefix(text, line) {
  if (text.startsWith("'")) {
    let out = "";
    let index = 1;
    for (;;) {
      if (index >= text.length) throw new YamlSubsetError("unterminated single-quoted scalar (multi-line scalars are not supported)", line);
      const char = text[index];
      if (char === "'") {
        if (text[index + 1] === "'") { out += "'"; index += 2; continue; }
        return { value: out, rest: text.slice(index + 1) };
      }
      out += char;
      index += 1;
    }
  }
  if (text.startsWith('"')) {
    const escapes = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", "0": "\0" };
    let out = "";
    let index = 1;
    for (;;) {
      if (index >= text.length) throw new YamlSubsetError("unterminated double-quoted scalar (multi-line scalars are not supported)", line);
      const char = text[index];
      if (char === '"') return { value: out, rest: text.slice(index + 1) };
      if (char === "\\") {
        const next = text[index + 1];
        if (!(next in escapes)) throw new YamlSubsetError(`unsupported escape \\${next ?? ""} in a double-quoted scalar`, line);
        out += escapes[next];
        index += 2;
        continue;
      }
      out += char;
      index += 1;
    }
  }
  return { value: undefined, rest: text };
}

/** A complete scalar value: quoted, or plain with an optional trailing comment. */
function scalar(text, line) {
  const trimmed = text.trim();
  // `{}` is how a workflow writes "no permissions"; any other flow mapping is refused below.
  if (stripPlainComment(trimmed) === "{}") return {};
  if (/^[&*!{]/u.test(trimmed)) {
    throw new YamlSubsetError(`unsupported YAML construct "${trimmed.slice(0, 20)}" (anchors, aliases, tags and flow mappings are not read)`, line);
  }
  const quoted = readScalarPrefix(trimmed, line);
  if (quoted.value !== undefined) {
    if (stripPlainComment(quoted.rest) !== "") throw new YamlSubsetError("unexpected text after a quoted scalar", line);
    return quoted.value;
  }
  return plainScalar(stripPlainComment(trimmed));
}

/** A single-line flow sequence of scalars, `[a, "b", 'c']`. */
function flowSequence(text, line) {
  const body = stripPlainComment(text);
  if (!body.endsWith("]")) throw new YamlSubsetError("flow sequences must close on the same line", line);
  const inner = body.slice(1, -1).trim();
  if (inner === "") return [];
  const items = [];
  let rest = inner;
  while (rest !== "") {
    if (/^[[{]/u.test(rest)) throw new YamlSubsetError("nested flow collections are not supported", line);
    const quoted = readScalarPrefix(rest, line);
    let value;
    if (quoted.value !== undefined) {
      value = quoted.value;
      rest = quoted.rest.trim();
    } else {
      const comma = rest.indexOf(",");
      const raw = (comma === -1 ? rest : rest.slice(0, comma)).trim();
      value = plainScalar(raw);
      rest = comma === -1 ? "" : rest.slice(comma);
    }
    items.push(value);
    if (rest === "") break;
    if (!rest.startsWith(",")) throw new YamlSubsetError("expected `,` between flow sequence items", line);
    rest = rest.slice(1).trim();
  }
  return items;
}

/**
 * Split `key: value` (or `key:`) into its parts, or return null when the text is not a mapping entry.
 *
 * @returns {{key: string, rest: string} | null}
 */
function mappingEntry(text, line) {
  if (text.startsWith("'") || text.startsWith('"')) {
    const quoted = readScalarPrefix(text, line);
    const after = quoted.rest;
    if (!/^\s*:(\s|$)/u.test(after)) return null;
    return { key: String(quoted.value), rest: after.replace(/^\s*:/u, "") };
  }
  const match = /^([^\s#][^#]*?)\s*:(?:\s+|$)(.*)$/u.exec(text);
  if (!match) return null;
  if (/^[&*!{[?|>]/u.test(match[1])) throw new YamlSubsetError(`unsupported mapping key "${match[1]}"`, line);
  return { key: match[1], rest: match[2] };
}

/**
 * Parse `text` into plain JavaScript values.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseYamlSubset(text) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  let cursor = 0;

  const skippable = (raw) => /^\s*(?:#.*)?$/u.test(raw) || raw === "---";

  /** The next significant line, without consuming it. */
  function peek() {
    while (cursor < lines.length && skippable(lines[cursor])) cursor += 1;
    if (cursor >= lines.length) return null;
    const raw = lines[cursor];
    const leading = /^[ \t]*/u.exec(raw)[0];
    if (leading.includes("\t")) throw new YamlSubsetError("tabs are not allowed for indentation", cursor + 1);
    return { indent: leading.length, text: raw.slice(leading.length).trimEnd(), line: cursor + 1 };
  }

  const isSequenceItem = (content) => content === "-" || content.startsWith("- ");

  /** A block collection whose entries sit at exactly `indent`. */
  function parseBlock(indent) {
    const next = peek();
    return next && isSequenceItem(next.text) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent) {
    const result = {};
    for (;;) {
      const next = peek();
      if (!next || next.indent < indent) return result;
      if (next.indent > indent) throw new YamlSubsetError("unexpected indentation", next.line);
      if (isSequenceItem(next.text)) return result;
      const entry = mappingEntry(next.text, next.line);
      if (!entry) throw new YamlSubsetError(`expected a "key: value" entry, got "${next.text.slice(0, 40)}"`, next.line);
      if (Object.hasOwn(result, entry.key)) throw new YamlSubsetError(`duplicate key "${entry.key}"`, next.line);
      cursor += 1;
      result[entry.key] = parseValue(entry.rest, indent, next.line, true);
    }
  }

  function parseSequence(indent) {
    const result = [];
    for (;;) {
      const next = peek();
      if (!next || next.indent < indent) return result;
      if (next.indent > indent) throw new YamlSubsetError("unexpected indentation", next.line);
      if (!isSequenceItem(next.text)) return result;
      const afterDash = next.text.slice(1);
      const item = afterDash.trimStart();
      const column = indent + 1 + (afterDash.length - item.length);
      if (item !== "" && !item.startsWith("[") && !item.startsWith("|") && !item.startsWith(">")
        && mappingEntry(item, next.line)) {
        // `- key: value` opens a mapping whose entries line up with `key`. Blank the dash so the mapping reads it.
        lines[cursor] = `${" ".repeat(column)}${item}`;
        result.push(parseMapping(column));
      } else {
        cursor += 1;
        result.push(parseValue(item, indent, next.line, false));
      }
    }
  }

  /** A block scalar body: every following line indented past `parentIndent`, or blank. */
  function blockScalar(header, parentIndent, line) {
    const match = /^([|>])([-+]?)\s*(?:#.*)?$/u.exec(header);
    if (!match) throw new YamlSubsetError(`unsupported block scalar header "${header}"`, line);
    const body = [];
    let contentIndent = null;
    while (cursor < lines.length) {
      const raw = lines[cursor];
      if (/^\s*$/u.test(raw)) { body.push(""); cursor += 1; continue; }
      const indent = /^ */u.exec(raw)[0].length;
      if (indent <= parentIndent) break;
      contentIndent ??= indent;
      if (indent < contentIndent) throw new YamlSubsetError("block scalar line is indented less than its first line", cursor + 1);
      body.push(raw.slice(contentIndent));
      cursor += 1;
    }
    while (body.length > 0 && body.at(-1) === "") body.pop();
    const joined = match[1] === "|" ? body.join("\n") : body.join(" ").replace(/ {2,}/gu, " ");
    return match[2] === "-" ? joined : `${joined}\n`;
  }

  /**
   * The value after `key:` or `- `. An empty value opens a nested block on the following lines; a mapping's value
   * may be a sequence written at the mapping's own indentation, as YAML allows.
   */
  function parseValue(rest, parentIndent, line, inMapping) {
    const text = rest.trim();
    if (text === "" || /^#/u.test(text)) {
      const next = peek();
      if (!next) return null;
      if (next.indent > parentIndent) return parseBlock(next.indent);
      if (inMapping && next.indent === parentIndent && isSequenceItem(next.text)) return parseSequence(parentIndent);
      return null;
    }
    if (text.startsWith("|") || text.startsWith(">")) return blockScalar(text, parentIndent, line);
    const value = text.startsWith("[") ? flowSequence(text, line) : scalar(text, line);
    const next = peek();
    if (next && next.indent > parentIndent) {
      throw new YamlSubsetError("a scalar continues on the next line (multi-line scalars are not supported)", next.line);
    }
    return value;
  }

  const first = peek();
  if (!first) return null;
  if (first.indent !== 0) throw new YamlSubsetError("the document must start at column 0", first.line);
  const document = parseBlock(0);
  const trailing = peek();
  if (trailing) throw new YamlSubsetError(`unexpected content "${trailing.text.slice(0, 40)}"`, trailing.line);
  return document;
}
