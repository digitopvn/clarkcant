/*
 * How a value is shown, and the one instruction from Clark the widget acts on.
 *
 * A format changes how a number reads, never the number: a cell shown as 25% still holds 0.25, and exports as 0.25.
 * Formats are kept as a short list of ranges, the latest first in effect.
 */

import { isError } from "./formula.js";
import { inRange, parseRangeName, rangeName, sameRange } from "./sheet.js";

export const FORMAT_KINDS = Object.freeze(["percent", "number", "plain"]);
/** Formats kept at once; the oldest goes first. */
export const MAX_FORMATS = 32;

/** The format in effect at a cell: the latest range that holds it, or plain. */
export function formatAt(formats, row, column) {
  for (let index = formats.length - 1; index >= 0; index -= 1) {
    const entry = formats[index];
    if (entry === undefined) continue;
    const range = parseRangeName(entry.range);
    if (range !== undefined && inRange(range, row, column)) return entry.format;
  }
  return "plain";
}

/**
 * The list with this range set to this format, replacing an entry for the same range and keeping at most `MAX_FORMATS`,
 * and the entries that had to go to keep it there, oldest first, so the widget can say so.
 */
export function applyFormat(formats, range, format) {
  const name = rangeName(range);
  const kept = formats.filter((entry) => {
    const existing = parseRangeName(entry.range);
    return existing === undefined || !sameRange(existing, range);
  });
  // A plain entry is kept too: it is what undoes an older, larger range for these cells.
  const next = [...kept, { range: name, format }];
  const over = Math.max(0, next.length - MAX_FORMATS);
  return { formats: next.slice(over), dropped: next.slice(0, over) };
}

/** The list with this range set to this format; see `applyFormat`. */
export function withFormat(formats, range, format) {
  return applyFormat(formats, range, format).formats;
}

function trimZeros(text) {
  return text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

/** A number as general display: at most twelve significant digits, so 0.1 + 0.2 reads 0.3. */
export function generalNumber(value) {
  if (Object.is(value, -0)) return "0";
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

/** What a cell shows for its value under a format. */
export function displayValue(value, format) {
  if (value === null || value === undefined) return "";
  if (isError(value)) return value.error;
  if (typeof value !== "number") return String(value);
  switch (format) {
    case "percent":
      return `${trimZeros((value * 100).toFixed(2))}%`;
    case "number":
      return value.toFixed(2);
    default:
      return generalNumber(value);
  }
}

const DIRECTIVE = /^format: (percent|number|plain) ([A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?)$/u;

/**
 * Clark's reply, read as the one instruction it may carry, or a reason it was not one.
 *
 * The reply is untrusted text. It is applied only when, trimmed, it is exactly `format: <kind> <range>` with a kind from
 * the closed set and the very range that was selected when the person asked. Anything else — extra words, another range,
 * another kind — is refused and nothing changes.
 */
export function readFormatDirective(reply, selected) {
  const text = typeof reply === "string" ? reply.trim() : "";
  const match = DIRECTIVE.exec(text);
  if (match === null) return { ok: false, reason: "not-a-directive" };
  const range = parseRangeName(match[2] ?? "");
  if (range === undefined) return { ok: false, reason: "not-a-directive" };
  if (!sameRange(range, selected)) return { ok: false, reason: "other-range", range: rangeName(range) };
  return { ok: true, format: match[1], range };
}
