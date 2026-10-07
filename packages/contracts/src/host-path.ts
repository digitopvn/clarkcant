import { z } from "zod";

/**
 * A path on one machine, in the only form a plan may name one: absolute and already normalized.
 *
 * A plan is shown to a person and bound to their consent, so the path it names has to be the path that is used. A
 * relative path (`.`, `../../etc`) or a home shorthand (`~/Documents`) resolves to something different depending on
 * where it is read, and a `..` or `.` segment inside an absolute path hides where it really points. Both are refused
 * rather than resolved here: resolving needs the machine, and this is a contract.
 *
 * Two styles, told apart by how the path starts, each with exactly one separator:
 *
 * - POSIX: starts with `/`, separated by `/`. A `\` is refused: on POSIX it is an ordinary filename character, so
 *   `/srv/data\x` is a file next to `/srv/data`, not inside it, and accepting it would let a reader of the plan see a
 *   folder that is not the one reached.
 * - Windows: a drive letter, a colon and `\` (`C:\Users\an`), separated by `\`. A `/` is refused, so `c:/x` — which on
 *   a POSIX machine is a relative path — is never taken for an absolute one.
 *
 * The path says nothing about which machine; a caller pairs it with a node id. A Windows-style path names a folder only
 * on a Windows node: on any other node it is not absolute, and whoever enforces the reach refuses it there.
 *
 * Containment is textual. It does not follow symbolic links, junctions or mounts — a contract cannot see the disk — so
 * whoever enforces a reach resolves links on the node before comparing, and refuses a path that resolves outside what
 * was consented to.
 */
export function absoluteHostPathProblem(value: string): string | undefined {
  if (value.includes("\0")) return "must not contain a NUL character";
  if (/^\s|\s$/.test(value)) return "must not start or end with whitespace";
  const windows = /^[A-Za-z]:/.test(value);
  if (windows) {
    if (!/^[A-Za-z]:\\/.test(value)) return "must be absolute: a Windows path is a drive letter, a colon and \\";
    if (value.includes("/")) return "must use only \\ as the separator in a Windows path";
  } else {
    if (!value.startsWith("/")) return "must be absolute (/… or C:\\…), not relative or ~";
    if (value.startsWith("//")) return "must be a local path, not a network share";
    if (value.includes("\\")) return "must use only / as the separator in a POSIX path; \\ is a filename character there";
  }
  const segments = value.slice(windows ? 3 : 1).split(windows ? "\\" : "/");
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

/**
 * The segments of an absolute host path, for comparing one path against another: the root (`C:` upper-cased for a
 * Windows path, `` for a POSIX one), then each non-empty segment split on that style's one separator.
 */
export function hostPathSegments(value: string): string[] {
  const windows = /^[A-Za-z]:\\/.test(value);
  const root = windows ? value.slice(0, 2).toUpperCase() : "";
  return [root, ...value.slice(windows ? 3 : 1).split(windows ? "\\" : "/").filter((segment) => segment !== "")];
}

/**
 * Whether `inner` is `outer` or a path inside it. Segment by segment, so `/a/bc` is not inside `/a/b`. Textual only:
 * both paths must already satisfy `absoluteHostPathProblem`, and links are the enforcer's to resolve first.
 */
export function hostPathWithin(inner: string, outer: string): boolean {
  if (absoluteHostPathProblem(inner) !== undefined || absoluteHostPathProblem(outer) !== undefined) return false;
  const a = hostPathSegments(inner);
  const b = hostPathSegments(outer);
  return b.length <= a.length && b.every((segment, index) => segment === a[index]);
}
