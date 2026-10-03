/**
 * Fitting display text to a host card's bounds.
 *
 * The conductor strict-parses every host card a tool hands back and leaves out one that fails its contract, so a value
 * a model wrote can cost the person the whole card by being one character too long. These shorten a value that is only
 * shown, never one that is sent back: an id, a command that runs or a name a secret is stored under is refused at the
 * tool instead, because a shortened copy of it would be a different value.
 *
 * Lengths are counted in UTF-16 units, the unit the card schemas count, and a value is cut between code points so a
 * character that takes two units is never split in half.
 */

/** `value` as it is when it fits `max`, otherwise its start and an ellipsis, `max` units in all. */
export function fitHead(value: string, max: number): string {
  return value.length <= max ? value : `${headWithin(value, max - 1)}…`;
}

/** `value` as it is when it fits `max`, otherwise an ellipsis and its end, `max` units in all. For a path, whose end names it. */
export function fitTail(value: string, max: number): string {
  return value.length <= max ? value : `…${tailWithin(value, max - 1)}`;
}

/** The longest start of `value` that fits `max` UTF-16 units, cut between code points. */
function headWithin(value: string, max: number): string {
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/** The longest end of `value` that fits `max` UTF-16 units, cut between code points like `headWithin`. */
function tailWithin(value: string, max: number): string {
  const chars = Array.from(value);
  let out = "";
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? "";
    if (out.length + char.length > max) break;
    out = char + out;
  }
  return out;
}
