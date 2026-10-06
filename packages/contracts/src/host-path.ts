import { z } from "zod";

/**
 * A path on one machine, in the only form a plan may name one: absolute and already normalized.
 *
 * A plan is shown to a person and bound to their consent, so the path it names has to be the path that is used. A
 * relative path (`.`, `../../etc`) or a home shorthand (`~/Documents`) resolves to something different depending on
 * where it is read, and a `..` or `.` segment inside an absolute path hides where it really points. Both are refused
 * rather than resolved here: resolving needs the machine, and this is a contract.
 *
 * POSIX (`/home/a`) and Windows (`C:\Users\a`, `C:/Users/a`) absolute forms are both accepted, because a plan may name
 * a folder on any of the platforms ClarkCant runs on. The path says nothing about which machine; a caller pairs it with
 * a node id.
 */
export function absoluteHostPathProblem(value: string): string | undefined {
  if (value.includes("\0")) return "must not contain a NUL character";
  if (/^\s|\s$/.test(value)) return "must not start or end with whitespace";
  const windows = /^[A-Za-z]:[\\/]/.test(value);
  if (!windows && !value.startsWith("/")) return "must be absolute (/… or C:\\…), not relative or ~";
  if (value.startsWith("//") || value.startsWith("\\\\")) return "must be a local path, not a network share";
  const segments = value.slice(windows ? 3 : 1).split(/[\\/]/);
  if (segments.some((segment) => segment === "." || segment === "..")) return "must be normalized: no . or .. segments";
  if (segments.length > 1 && segments.some((segment) => segment === "")) return "must be normalized: no empty segments";
  return undefined;
}

export const absoluteHostPathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => absoluteHostPathProblem(value) === undefined, {
    error: (issue) => `path ${JSON.stringify(issue.input)} ${absoluteHostPathProblem(String(issue.input)) ?? "is invalid"}`,
  });

/** The segments of a normalized absolute path, for comparing one path against another. */
export function hostPathSegments(value: string): string[] {
  const windows = /^[A-Za-z]:[\\/]/.test(value);
  const root = windows ? value.slice(0, 2).toUpperCase() : "";
  return [root, ...value.slice(windows ? 3 : 1).split(/[\\/]/).filter((segment) => segment !== "")];
}

/** Whether `inner` is `outer` or a path inside it. Segment by segment, so `/a/bc` is not inside `/a/b`. */
export function hostPathWithin(inner: string, outer: string): boolean {
  const a = hostPathSegments(inner);
  const b = hostPathSegments(outer);
  return b.length <= a.length && b.every((segment, index) => segment === a[index]);
}
