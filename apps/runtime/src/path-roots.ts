import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Whether a path is inside an approved root, by the platform's own rules.
 *
 * The check this replaces was `candidate.startsWith(root + "/")`. That is correct on a system whose
 * separator is a slash and silently wrong on one whose separator is a backslash: on Windows every path
 * inside every approved root failed the test, so a transcript could not be registered and a typed
 * directory could not be used — and both refusals read as policy decisions rather than as a bug. Ten
 * tests in the project finder and seven in the session store were failing on it.
 *
 * `path.relative` is the platform answering the question itself. Three cases, and the middle one is the
 * one the old check got wrong in both directions:
 *
 *   - an empty relative path means the candidate *is* the root;
 *   - a path that climbs out, or one that is absolute because it is on another Windows drive, means it
 *     is not inside;
 *   - anything else is inside, and `relative` has already resolved the separators and the `.` segments.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether the file system a platform usually runs on tells case apart: Windows (NTFS) and macOS (APFS by default) do
 * not, Linux does.
 */
export function caselessPaths(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * Whether a path is inside a root, with case compared the way `caseless` says rather than the way this host's
 * `path.relative` happens to: a lookup that only finds something — never a grant — uses it, so a path typed in another
 * case than its root still finds what is under that root where the file system cannot tell them apart, and Linux keeps
 * case. Grant checks keep `isWithinRoot`.
 *
 * Both sides are resolved first, so separators, `.` and `..` are already the platform's own; what is left is a
 * folder-by-folder prefix, so `/a/bc` is not inside `/a/b`.
 */
export function isWithinRootCased(root: string, candidate: string, caseless: boolean): boolean {
  const cased = (path: string): string => (caseless ? resolve(path).toLowerCase() : resolve(path));
  const resolvedRoot = cased(root);
  const resolvedCandidate = cased(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  return resolvedCandidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`);
}

/** Whether a value the user typed is a path at all, on this platform. */
export function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  // A tilde is the home directory on every platform this runs on; everything else is whatever the
  // platform considers absolute, which covers `C:\...` and `\\server\share` as well as `/...`.
  return trimmed.startsWith("~") || isAbsolute(trimmed);
}
