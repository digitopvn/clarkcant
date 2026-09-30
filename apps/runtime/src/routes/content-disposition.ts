/**
 * A `Content-Disposition` header for a file name nobody on this node chose.
 *
 * A header value is Latin-1 by the letter of HTTP and ASCII in practice: Node's `writeHead` throws on any character
 * outside it, and a thrown header is a response that never goes out — a Vietnamese file name used to leave Open and
 * Save As waiting for good. RFC 6266 has the answer every browser reads: an ASCII `filename` for an old reader, and a
 * `filename*` carrying the real name as percent-encoded UTF-8 (RFC 8187), which a current reader prefers.
 *
 * The name is untrusted text either way, so quotes, backslashes and control characters never reach the header: a
 * header that could be broken out of would be a response-splitting bug, not a formatting problem. The characters that
 * reverse how text reads go too (`stripBidiControls`): `hoa-don\u202Egpj.exe` reads as `hoa-donexe.jpg`.
 */

import { stripBidiControls } from "@clarkcant/contracts";

const NAME_MAX_CHARS = 120;

/**
 * The name cut to `NAME_MAX_CHARS` code points with its last extension kept.
 *
 * The extension is what the OS opens a saved file with, and the node chose it (`artifactFileName`): a plain cut from
 * the end would drop it and leave whatever the widget put before it, so `a….bat.txt` would be saved as `a….bat`.
 */
function clipKeepingExtension(name: string): string {
  const chars = [...name];
  if (chars.length <= NAME_MAX_CHARS) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  if (extension === "" || !/^\.[\p{L}\p{N}_-]{1,16}$/u.test(extension)) return chars.slice(0, NAME_MAX_CHARS).join("");
  const stem = [...name.slice(0, dot)].slice(0, NAME_MAX_CHARS - [...extension].length).join("");
  return `${stem}${extension}`;
}

/** Characters RFC 8187 lets through unencoded (`attr-char`); everything else is percent-encoded. */
function encodeExtended(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9!#$&+.^_`|~-]/u.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** The name as printable ASCII: accents dropped where they come off a letter, anything else replaced by `_`. */
function asciiFallback(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .replaceAll(/[^\x20-\x7e]/gu, "_")
    // `%` too: an old reader percent-decodes this form as well, and would read `%2e` as a different name.
    .replaceAll(/["\\%]/gu, "_")
    .trim();
  return folded === "" ? "file" : folded;
}

export function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  // Control characters and the quoting characters go first, before either form is built from the name.
  const filtered = [...stripBidiControls(filename)]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && char !== '"' && char !== "\\";
    })
    .join("")
    .trim();
  // By code point, so a name is never cut through the middle of a character.
  const cleaned = clipKeepingExtension(filtered).trim();
  const name = cleaned === "" ? "file" : cleaned;
  const fallback = asciiFallback(name);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeExtended(name)}`;
}
