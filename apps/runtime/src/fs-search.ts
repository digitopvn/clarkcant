import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";

/**
 * Searching the machine, read-only.
 *
 * The node's own history search answers "what did we say about this". This answers "where is this on
 * the machine", which is a different question and the one an agent without it cannot answer at all:
 * before this, a request to find a file was answered by searching a database of conversations, and the
 * honest result was nothing.
 *
 * Three properties are load-bearing, and all three are about not becoming a liability:
 *
 *   - **Nothing is indexed.** A walk happens when it is asked for and its results are not kept, so
 *     there is no growing copy of somebody's disk to protect, and nothing to keep up to date. The cost
 *     is speed, which is paid only by the search that is running.
 *   - **It is bounded, and it says how.** A scan that walks a whole disk takes as long as it takes, so
 *     there is a ceiling on files, on time and on results — and the ceiling that was hit is reported
 *     rather than presented as "no more matches".
 *   - **It reads, never writes.** No path here opens a file for writing, and the approval that governs
 *     a write is a separate decision made elsewhere. Searching the whole machine does not imply
 *     permission to change any of it.
 */

/** Directories never descended into. Names, because that is what the walk sees. */
const SKIPPED_DIRECTORIES = new Set([
  // Source-control and dependency trees: enormous, repetitive, and nobody's file is in one.
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".gradle",
  ".m2",
  ".nuget",
  ".cargo",
  // Build output: a copy of something the search will find at its source.
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "coverage",
  // Operating system and application state: not the user's files, and slow to walk.
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
  "AppData",
  "$Recycle.Bin",
  "System Volume Information",
  "Recovery",
  "PerfLogs",
  "Library",
  "Applications",
  ".Trash",
  "proc",
  "sys",
  "dev",
  "run",
  "snap",
  "_cacache",
]);

/** Extensions never read for content: binary, compressed, or too large to be prose. */
const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib", ".class", ".jar", ".wasm",
  ".zip", ".gz", ".tar", ".7z", ".rar", ".bz2", ".xz", ".zst",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svgz", ".tif", ".tiff",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".db", ".sqlite", ".sqlite3", ".mdb", ".iso", ".img", ".vhd", ".vhdx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pyc", ".pyo", ".lock", ".map",
]);

/** The largest file whose contents are read. Beyond this it is data, not text to search. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export interface FileSearchRequest {
  /** What to look for. Matched case-insensitively in file names and in file contents. */
  query: string;
  /** Only look at names. Used when the question is "where is the file called X". */
  namesOnly?: boolean;
  /** Most results to return. */
  limit?: number;
  /** Most files to open before stopping. */
  maxFiles?: number;
  /** Wall-clock budget in milliseconds. */
  budgetMs?: number;
}

export interface FileSearchHit {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Whether the query matched the file's name or a line inside it. */
  match: "name" | "content";
  /** The matching line, trimmed, when the match was inside the file. */
  snippet?: string;
  lineNumber?: number;
}

export interface FileSearchOutcome {
  hits: FileSearchHit[];
  /** What was actually looked at, so a thin result is not read as an empty machine. */
  scanned: { files: number; directories: number };
  /** Where the walk started. */
  roots: string[];
  /** Directory names not descended into, reported so the limits of the answer are visible. */
  skipped: string[];
  /** True when a ceiling stopped the walk before the disk was exhausted. */
  truncated: boolean;
  /** Which ceiling, so the caller can say why the answer is partial. */
  stoppedBecause?: "results" | "files" | "budget";
}

export interface FileSearchOptions {
  /** Where to start. Injected so a test can search a tree it made. */
  roots: readonly string[];
  /** How the tree is read, so the walk can be exercised without touching a real disk. */
  list?: (directory: string) => Promise<{ name: string; directory: boolean }[]>;
  readText?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ size: number; modifiedAt: string }>;
  now?: () => number;
}

/**
 * The roots a whole-machine search starts from.
 *
 * Windows has no portable API for "list the drives", and the alternatives are worse than the obvious
 * one: shelling out to `wmic` depends on a tool Microsoft has deprecated, and PowerShell is a second
 * interpreter to launch before a search can begin. Probing the letters costs 26 cheap calls to the
 * filesystem and depends on nothing.
 *
 * On everything else, the root is the root.
 */
export function machineRoots(): string[] {
  if (process.platform !== "win32") return [sep];
  const drives: string[] = [];
  for (let letter = "A".charCodeAt(0); letter <= "Z".charCodeAt(0); letter += 1) {
    const root = `${String.fromCharCode(letter)}:\\`;
    try {
      if (existsSync(root)) drives.push(root);
    } catch {
      // A letter with no readable media is not an error: it is a drive that is not there.
    }
  }
  return drives;
}

/** Whether a file's contents are worth reading, by extension and size. */
function isTextual(name: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_CONTENT_BYTES) return false;
  return !BINARY_EXTENSIONS.has(extname(name).toLowerCase());
}

/** The line a match is on, for a reader who wants to see it rather than open the file. */
function lineFor(content: string, index: number): { snippet: string; lineNumber: number } {
  const before = content.slice(0, index);
  const lineNumber = before.split("\n").length;
  const start = before.lastIndexOf("\n") + 1;
  const end = content.indexOf("\n", index);
  return {
    snippet: content.slice(start, end === -1 ? Math.min(content.length, index + 200) : end).trim().slice(0, 300),
    lineNumber,
  };
}

export async function searchFileSystem(
  request: FileSearchRequest,
  options: FileSearchOptions,
): Promise<FileSearchOutcome> {
  const query = request.query.trim();
  // The operator's decision: a search that hides results is worse than one that takes a moment. The ceilings
  // are still reported when they are hit (see `stoppedBecause`), because a partial answer the caller knows is
  // partial is useful and one that looks complete is not.
  const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
  const maxFiles = Math.max(1, Math.min(request.maxFiles ?? 200_000, 1_000_000));
  const budgetMs = Math.max(50, Math.min(request.budgetMs ?? 20_000, 120_000));
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const outcome: FileSearchOutcome = {
    hits: [],
    scanned: { files: 0, directories: 0 },
    roots: [...options.roots],
    // Sorted with an explicit comparator so the list is stable across locales: it is reported to the
    // caller, and a list that reorders itself by machine is a list nobody can diff.
    skipped: [...SKIPPED_DIRECTORIES].sort((left, right) => left.localeCompare(right)),
    truncated: false,
  };
  if (query === "") return outcome;

  const list =
    options.list ??
    (async (directory: string) => {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        // A symlinked directory is reported as a file: following links turns a bounded walk into one
        // that can loop for ever through a link that points at its own parent.
        directory: entry.isDirectory() && !entry.isSymbolicLink(),
      }));
    });
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const stat =
    options.stat ??
    (async (path: string) => {
      const info = await lstat(path);
      return { size: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() };
    });

  const needle = query.toLowerCase();
  const queue: string[] = [...options.roots];

  /**
   * Which ceiling has been reached, if any.
   *
   * Asked before every file rather than once per directory, which was the first version of this and was
   * wrong in a way the tests caught: a directory holding a thousand matching files returned all of them,
   * because the only check happened on the way in.
   */
  const ceiling = (): FileSearchOutcome["stoppedBecause"] | undefined => {
    if (outcome.hits.length >= limit) return "results";
    if (outcome.scanned.files >= maxFiles) return "files";
    if (now() - startedAt > budgetMs) return "budget";
    return undefined;
  };

  while (queue.length > 0) {
    const stopped = ceiling();
    if (stopped !== undefined) {
      outcome.truncated = true;
      outcome.stoppedBecause = stopped;
      break;
    }

    const directory = queue.shift();
    if (directory === undefined) break;
    outcome.scanned.directories += 1;

    let entries: { name: string; directory: boolean }[];
    try {
      entries = await list(directory);
    } catch {
      // An unreadable directory is ordinary on a real machine — permissions, a disconnected drive, a
      // file that vanished between listing and reading. It is not a reason to fail the search.
      continue;
    }

    for (const entry of entries) {
      const stoppedInside = ceiling();
      if (stoppedInside !== undefined) {
        outcome.truncated = true;
        outcome.stoppedBecause = stoppedInside;
        break;
      }

      const path = join(directory, entry.name);
      if (entry.directory) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) queue.push(path);
        continue;
      }
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;

      outcome.scanned.files += 1;
      let info: { size: number; modifiedAt: string };
      try {
        info = await stat(path);
      } catch {
        continue;
      }

      if (entry.name.toLowerCase().includes(needle)) {
        outcome.hits.push({
          path,
          name: entry.name,
          sizeBytes: info.size,
          modifiedAt: info.modifiedAt,
          match: "name",
        });
        continue;
      }

      if (request.namesOnly === true || !isTextual(entry.name, info.size)) continue;
      try {
        const content = await readText(path);
        const index = content.toLowerCase().indexOf(needle);
        if (index === -1) continue;
        const { snippet, lineNumber } = lineFor(content, index);
        outcome.hits.push({
          path,
          name: entry.name,
          sizeBytes: info.size,
          modifiedAt: info.modifiedAt,
          match: "content",
          snippet,
          lineNumber,
        });
      } catch {
        // A file that cannot be read as text is not a match, and not a failure.
      }
    }
  }

  return outcome;
}

/**
 * What a search says, in words a reader can act on.
 *
 * Written for two audiences at once: the model, which needs the paths, and the person reading the
 * transcript afterwards, who needs to know what was and was not looked at.
 */
export function describeSearch(outcome: FileSearchOutcome, query: string): string {
  if (outcome.hits.length === 0) {
    const why = outcome.truncated
      ? `Đã dừng vì ${describeStop(outcome.stoppedBecause)} trước khi quét hết máy`
      : `Đã quét ${outcome.scanned.files} tệp trong ${outcome.scanned.directories} thư mục trên ${outcome.roots.join(", ")}`;
    return `Không tìm thấy "${query}". ${why}.`;
  }

  const lines = outcome.hits.map((hit) => {
    const where = hit.match === "content" ? ` [dòng ${hit.lineNumber ?? 1}: ${hit.snippet ?? ""}]` : "";
    return `- ${hit.path}${where}`;
  });
  const tail = outcome.truncated
    ? `Đã dừng vì ${describeStop(outcome.stoppedBecause)}; còn nữa.`
    : `Đã quét ${outcome.scanned.files} tệp trong ${outcome.scanned.directories} thư mục.`;
  return `${outcome.hits.length} kết quả cho "${query}":\n${lines.join("\n")}\n${tail}`;
}

function describeStop(reason: FileSearchOutcome["stoppedBecause"]): string {
  switch (reason) {
    case "results":
      return "đã đủ số kết quả";
    case "files":
      return "đã chạm trần số tệp";
    case "budget":
      return "hết thời gian cho phép";
    default:
      return "một giới hạn";
  }
}
