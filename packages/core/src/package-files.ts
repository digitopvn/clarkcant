import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

import type { DirectoryEntry } from "@clarkcant/contracts";

/**
 * Reading a file out of a package the node can see on disk.
 *
 * A widget that runs in its own frame is loaded by URL, so the frame has to fetch the widget's own files from
 * somewhere. This is that somewhere: the one path by which a package's bytes become a response.
 *
 * Two rules, and both are the kind that are obvious until they are not:
 *
 * **A path is resolved, then checked to be inside the package.** A server that serves whatever a path resolves to
 * hands out the machine — `../../` is the ordinary way a local developer tool becomes a way to read files — so the
 * check is on the resolved absolute path, not on the string that arrived.
 *
 * **Only a package the node can actually read.** A git or npm entry names bytes nobody here has; serving those
 * would mean the node acting as a proxy for whatever that URL returns, which is a different and much larger thing
 * than serving a widget.
 *
 * **Containment is checked on canonical paths, not lexical ones.** `resolve()` plus `startsWith()` blocks `../`
 * but is blind to a symlink: a file `leak.txt -> ../secret.txt` placed inside the package root resolves
 * lexically to a path inside the root while pointing at bytes outside it. Both the root and the candidate are
 * run through `realpathSync` before the containment check, and the file that is actually opened is the
 * canonical path the check approved — not the original candidate — so a symlink cannot pass a check performed
 * on one path and then be read through a different one. A residual TOCTOU window remains between the
 * `realpathSync` call and the `openSync` immediately after it: if the filesystem is mutated by a concurrent
 * process in that narrow window, the check and the read could in principle disagree. That is a property of any
 * check-then-open on a POSIX filesystem without O_BENEATH/openat2-style kernel support, which Node does not
 * expose; `O_NOFOLLOW` on the open call at least refuses a symlink swapped in at the last instant.
 */

export type PackageFileOutcome =
  | { ok: true; bytes: Buffer; contentType: string }
  | {
      ok: false;
      code: "NOT_A_LOCAL_PACKAGE" | "FILE_OUTSIDE_PACKAGE" | "FILE_NOT_FOUND";
      message: string;
    };

/**
 * What to call each kind of file when serving it.
 *
 * A closed map rather than a lookup on whatever the filesystem says: the frame is sandboxed, and the one thing a
 * wrong content type could still do is get a browser to treat a widget's data as something executable.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The content type for a path, or `application/octet-stream` for anything this host does not name. */
export function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot === -1 ? "" : lower.slice(dot);
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function readPackageFile(input: {
  entry: Pick<DirectoryEntry, "source">;
  relativePath: string;
}): PackageFileOutcome {
  if (input.entry.source.kind !== "local") {
    return {
      ok: false,
      code: "NOT_A_LOCAL_PACKAGE",
      message: "this node can only serve a package whose bytes it already has, and this entry names another source",
    };
  }

  const lexicalRoot = resolve(input.entry.source.path);
  const lexicalCandidate = resolve(join(lexicalRoot, normalize(input.relativePath)));
  if (lexicalCandidate !== lexicalRoot && !lexicalCandidate.startsWith(lexicalRoot + sep)) {
    // The cheap lexical check first: `../../` never needs a syscall to refuse.
    return { ok: false, code: "FILE_OUTSIDE_PACKAGE", message: "that path is outside the package" };
  }

  let root: string;
  let candidate: string;
  try {
    // Canonicalise both sides with `realpath` so a symlink is resolved by the platform, not by string
    // arithmetic. A root or candidate that cannot be resolved (missing, dangling symlink, permission
    // denied) is reported as not-found — there is nothing this node can prove exists at that path.
    root = realpathSync(lexicalRoot);
    candidate = realpathSync(lexicalCandidate);
  } catch {
    return { ok: false, code: "FILE_NOT_FOUND", message: "there is no such file in this package" };
  }

  if (candidate !== root && !candidate.startsWith(root + sep)) {
    // The canonical check: a symlink inside the lexically-approved path whose target resolves outside
    // the canonical root is refused here, after following it, which the lexical check above cannot see.
    return { ok: false, code: "FILE_OUTSIDE_PACKAGE", message: "that path is outside the package" };
  }

  // The file that is opened is the canonical path the check just approved, opened with O_NOFOLLOW so a
  // symlink swapped into that exact name between the check and this call is refused rather than followed.
  let fd: number;
  try {
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, code: "FILE_NOT_FOUND", message: "there is no such file in this package" };
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return { ok: false, code: "FILE_NOT_FOUND", message: "there is no such file in this package" };
    }
    return { ok: true, bytes: readFileSync(fd), contentType: contentTypeFor(candidate) };
  } catch {
    return { ok: false, code: "FILE_NOT_FOUND", message: "there is no such file in this package" };
  } finally {
    closeSync(fd);
  }
}
