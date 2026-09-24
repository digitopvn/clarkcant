/**
 * Reading a terminal's byte stream: where each command starts and ends, and what it printed as plain text.
 *
 * Kept apart from the process registry because none of it needs a process: it is two pure functions over strings,
 * and the cases that break them — a marker split across two reads, a progress bar that rewrites its own line — are
 * cases a test can state exactly.
 */

/**
 * One event read out of the stream.
 *
 * `mark` is a shell-integration marker (OSC 133): `A` a prompt is about to be drawn, `C` a command is about to run
 * (its payload is the command line, when the shell told us), `D` it finished (its payload is the exit status).
 * `text` is everything else, in order.
 */
export type TerminalStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "mark"; code: string; payload: string };

const MARK_PREFIX = "\u001b]133;";
/** Longer than any real marker. A carry that grows past this was never a marker and is released as text. */
const MAX_CARRY = 4_096;

/**
 * A scanner that remembers a marker cut in half by a read boundary.
 *
 * A PTY hands over whatever the kernel buffered, so `\e]133;D;0\a` can arrive as `\e]13` and `3;D;0\a`. Treating
 * the halves as text would lose the command's end and print the fragment into its output; holding the tail until
 * the next read is the only reading that is right for every split.
 */
export function createMarkScanner(): { push(data: string): TerminalStreamEvent[] } {
  let carry = "";
  return {
    push(data: string): TerminalStreamEvent[] {
      let input = carry + data;
      carry = "";
      const events: TerminalStreamEvent[] = [];
      const text = (value: string): void => {
        if (value === "") return;
        const last = events[events.length - 1];
        if (last?.kind === "text") last.text += value;
        else events.push({ kind: "text", text: value });
      };
      for (;;) {
        const start = input.indexOf(MARK_PREFIX);
        if (start === -1) {
          // A tail that could still become a marker is held; everything before it is text now.
          const held = partialPrefixLength(input);
          text(input.slice(0, input.length - held));
          carry = input.slice(input.length - held);
          break;
        }
        text(input.slice(0, start));
        const body = input.slice(start + MARK_PREFIX.length);
        const bell = body.indexOf("\u0007");
        const st = body.indexOf("\u001b\\");
        const end = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st);
        if (end === -1) {
          if (input.length - start > MAX_CARRY) {
            text(input.slice(start));
          } else {
            carry = input.slice(start);
          }
          break;
        }
        const content = body.slice(0, end);
        const separator = content.indexOf(";");
        events.push({
          kind: "mark",
          code: separator === -1 ? content : content.slice(0, separator),
          payload: separator === -1 ? "" : content.slice(separator + 1),
        });
        input = body.slice(end + (end === bell ? 1 : 2));
      }
      return events;
    },
  };
}

function partialPrefixLength(input: string): number {
  for (let length = Math.min(MARK_PREFIX.length - 1, input.length); length > 0; length -= 1) {
    if (MARK_PREFIX.startsWith(input.slice(input.length - length))) return length;
  }
  return 0;
}

const ESC = "\u001b";
const BEL = "\u0007";
/** OSC: window titles, hyperlinks, shell-integration markers. */
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "gu");
/** CSI: colours, cursor movement, erase. */
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
/** Character-set selection. */
const CHARSET = new RegExp(`${ESC}[()][0-9A-Za-z]`, "gu");
/** The remaining two-byte escapes. */
const SHORT_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_=>]`, "gu");

/**
 * Remove C0 control characters and DEL, except the ones in `keep`.
 *
 * A code-point loop rather than a regular expression, as elsewhere in the runtime: the intent is a range check.
 */
export function stripControlCharacters(text: string, keep = ""): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !keep.includes(character)) continue;
    out += character;
  }
  return out;
}

/**
 * What a person would read if the output were printed on paper.
 *
 * Colours, cursor moves and window titles are removed; a carriage return overwrites the line it returns to, so a
 * progress bar leaves its last state rather than every frame; a backspace removes the character before it. This is
 * the form a command's output is sent back to the conversation in, where escape codes are noise to a model and to a
 * reader alike.
 */
export function plainTerminalText(raw: string): string {
  const stripped = raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(SHORT_ESCAPE, "")
    .replace(/\r\n/gu, "\n");
  const lines = stripped.split("\n").map((line) => {
    let current = "";
    for (const segment of line.split("\r")) {
      // A carriage return goes back to the column zero and writes over what was there.
      current = segment.length >= current.length ? segment : segment + current.slice(segment.length);
    }
    let out = "";
    for (const char of current) {
      if (char === "\b") out = out.slice(0, -1);
      else if (char === "\t" || char >= " ") out += char;
    }
    return out.replace(/\s+$/u, "");
  });
  return lines.join("\n");
}

/** Keep a string's tail within a byte budget, and say whether anything was cut. */
export function keepTail(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(value.length - maxChars), truncated: true };
}
