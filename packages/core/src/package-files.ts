import { readFileSync, statSync } from "node:fs";
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

  const root = resolve(input.entry.source.path);
  const candidate = resolve(join(root, normalize(input.relativePath)));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    // Checked on the resolved path: `normalize` alone would let a symlink or a drive-relative form through, and the
    // string that arrived is not the thing being opened.
    return { ok: false, code: "FILE_OUTSIDE_PACKAGE", message: "that path is outside the package" };
  }

  try {
    if (!statSync(candidate).isFile()) throw new Error("not a file");
    return { ok: true, bytes: readFileSync(candidate), contentType: contentTypeFor(candidate) };
  } catch {
    // A directory, a missing file and an unreadable one are one answer here, because they are one answer to the
    // frame: there is nothing at that path. Which of the three it was is not the frame's business.
    return { ok: false, code: "FILE_NOT_FOUND", message: "there is no such file in this package" };
  }
}
