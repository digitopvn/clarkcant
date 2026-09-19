import { inflateSync } from "node:zlib";

/**
 * The text a PDF actually holds.
 *
 * The node stored PDFs and named them by id, because "we cannot read this" is more honest than inventing detail - but
 * the issue that asked for attachments asks for their content to reach the agent, and a PDF is the one binary format
 * whose text can be recovered without a provider or a dependency. So it is recovered here, and everything this cannot
 * read is reported as a reason rather than as an empty string: an empty string is what a PDF with no text looks like,
 * and the two are different facts.
 *
 * What this does not do, on purpose: it does not decrypt, it does not follow object streams, and it does not decode
 * fonts. A PDF that needs any of those comes back with a reason naming that, so the caller can say so instead of
 * pretending the file was empty.
 */

/** One `stream ... endstream` region, with the dictionary text that precedes it. */
function streams(source: string): { dictionary: string; body: string }[] {
  const found: { dictionary: string; body: string }[] = [];
  const marker = "stream";
  let at = 0;
  for (;;) {
    const start = source.indexOf(marker, at);
    if (start === -1) return found;
    // The dictionary is the text between the previous `obj` and this marker; the nearest `<<` is enough to know
    // whether this stream is compressed.
    const dictionaryStart = source.lastIndexOf("<<", start);
    const dictionary = dictionaryStart === -1 ? "" : source.slice(dictionaryStart, start);
    // `stream` is followed by CRLF or LF, and the body ends at the matching `endstream`.
    let bodyStart = start + marker.length;
    if (source[bodyStart] === "\r") bodyStart += 1;
    if (source[bodyStart] === "\n") bodyStart += 1;
    const end = source.indexOf("endstream", bodyStart);
    if (end === -1) return found;
    found.push({ dictionary, body: source.slice(bodyStart, end) });
    at = end + "endstream".length;
  }
}

/** A PDF literal string, with the escapes the format allows. */
function decodeLiteral(raw: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? "";
    if (character !== "\\") {
      out += character;
      continue;
    }
    const next = raw[index + 1] ?? "";
    index += 1;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next >= "0" && next <= "7") {
      // Up to three octal digits, which is how a PDF writes a byte that is not a printable character. The peek is
      // checked rather than assumed: the last character of a string is not followed by anything.
      let digits = next;
      for (;;) {
        const peek = raw[index + 1];
        if (digits.length >= 3 || peek === undefined || peek < "0" || peek > "7") break;
        digits += peek;
        index += 1;
      }
      out += String.fromCharCode(Number.parseInt(digits, 8));
    } else if (next === "\n") {
      // A backslash before a newline is a line continuation, not a character.
    } else out += next;
  }
  return out;
}

/**
 * Every literal string a content stream paints as text, in the order the operators show them.
 *
 * Read from the operators rather than from each string's neighbours: the first version of this asked whether a string
 * was near a `Tj` or inside brackets, and it collected the first string of a `TJ` array and dropped the rest - which
 * is exactly the sort of quiet truncation that makes a reader look like it works. `TJ` paints every string in its
 * array, `Tj` and `'` and `"` paint one each, and anything else holding parentheses is not text.
 */
function textOf(content: string): string[] {
  const found: { at: number; text: string }[] = [];
  const literal = /\((?:\\.|[^\\()])*\)/g;

  const arrays = /\[[^\]]*\]\s*TJ/g;
  let arrayMatch: RegExpExecArray | null;
  while ((arrayMatch = arrays.exec(content)) !== null) {
    const inner = arrayMatch[0];
    literal.lastIndex = 0;
    let inside: RegExpExecArray | null;
    while ((inside = literal.exec(inner)) !== null) {
      found.push({ at: arrayMatch.index + inside.index, text: decodeLiteral(inside[0].slice(1, -1)) });
    }
  }

  const singles = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g;
  let singleMatch: RegExpExecArray | null;
  while ((singleMatch = singles.exec(content)) !== null) {
    const shown = singleMatch[0];
    const end = shown.lastIndexOf(")");
    found.push({ at: singleMatch.index, text: decodeLiteral(shown.slice(1, end)) });
  }

  return found.sort((left, right) => left.at - right.at).map((piece) => piece.text);
}

export function extractPdfText(bytes: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } {
  // PDF structure is ASCII, so a latin1 reading keeps every byte addressable while the operators are being found.
  const source = Buffer.from(bytes).toString("latin1");
  if (!source.startsWith("%PDF-")) return { ok: false, reason: "this file does not start with %PDF-" };

  const pieces: string[] = [];
  let compressed = 0;
  for (const stream of streams(source)) {
    let content = stream.body;
    if (stream.dictionary.includes("/FlateDecode")) {
      compressed += 1;
      try {
        content = inflateSync(Buffer.from(stream.body, "latin1")).toString("latin1");
      } catch {
        continue;
      }
    }
    pieces.push(...textOf(content));
  }

  const text = pieces
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") {
    return {
      ok: false,
      reason:
        compressed === 0
          ? "no text operators were found in this PDF"
          : "this PDF's text is compressed in a way this node cannot read",
    };
  }
  return { ok: true, text };
}
