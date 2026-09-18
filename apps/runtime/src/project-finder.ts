import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import { disambiguate } from "@clarkcant/core";
import { type Instant, redactSecrets } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import { isWithinRoot, looksLikePath } from "./path-roots.ts";
import {
  type Database,
  type ProjectKind,
  type ProjectRecord,
  findProjectByPath,
  getProject,
  listProjects,
  pruneProjects,
  searchProjects,
  touchProjectUse,
  upsertProject,
} from "@clarkcant/storage";

import {
  type DecideDeps,
  decideProject,
} from "./jev-decider.ts";

/**
 * The workspace finder.
 *
 * The interface has one screen, so "add a new skill for the agentkit project" has to find the
 * directory itself. This is the layer that does it: a bounded scan of the home directory, an index of
 * metadata only, a ranked candidate list, and one question when two directories could both be meant.
 *
 * Three properties are deliberate and are what make a scan of a home directory defensible:
 *
 * 1. **Metadata only.** Names, markers, a modification time and a git remote. No file is opened
 *    except `.git/config`, which is where the remote is, and no contents are stored.
 * 2. **Bounded and interruptible.** Depth, entry count and an abort signal, with a yield between
 *    roots, so a scan cannot hold the event loop for the length of a turn.
 * 3. **Nothing leaves the node except a name.** The selector is offered a short name, a path
 *    relative to the root, and the markers — never an absolute path and never a file.
 */

/* ------------------------------------------------------------------ *
 * Scanner
 * ------------------------------------------------------------------ */

/** Directories that are never part of a project a user would name. */
export const SYSTEM_IGNORES: readonly string[] = [
  "Library",
  "Applications",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "Pods",
  "DerivedData",
  ".venv",
  "venv",
  "__pycache__",
  "test-results",
  "playwright-report",
];

const CODE_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "docker-compose.yml",
  "tsconfig.json",
  "src",
];

const DOC_MARKERS = [".obsidian", "docs", "README.md", "README", "CLAUDE.md", "AGENTS.md", "notes"];

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".tiff", ".svg"];
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ".mp4", ".mov", ".mkv", ".mp3", ".wav", ".m4a"];

export interface ScanOptions {
  roots: readonly string[];
  /** Additional ignored directory names, from the user's own preferences. */
  ignore?: readonly string[];
  maxDepth?: number;
  /** Total entries examined before the scan stops early. Bounds a pathological tree. */
  maxEntries?: number;
  signal?: AbortSignal;
  /** Called between roots so a caller can yield to the event loop. */
  yieldBetweenRoots?: () => Promise<void>;
}

export interface ScannedProject {
  path: string;
  name: string;
  kind: ProjectKind;
  markers: string[];
  mtime: number;
  gitRemote?: string;
}

export interface ScanOutcome {
  projects: ScannedProject[];
  visited: number;
  truncated: boolean;
  stoppedEarly: boolean;
  durationMs: number;
}

function isIgnored(name: string, ignores: ReadonlySet<string>): boolean {
  // Every dot-directory, so `.ssh`, `.aws`, `.config` and friends are never entered.
  if (name.startsWith(".") && name !== ".obsidian") return true;
  if (ignores.has(name)) return true;
  if (name.endsWith(".app") || name.endsWith(".photoslibrary") || name.endsWith(".framework")) return true;
  // Cloud placeholders that are not downloaded are directories with no content until touched.
  if (name.endsWith(".icloud")) return true;
  return false;
}

function markersOf(entries: { name: string; isDirectory: () => boolean }[]): string[] {
  const names = new Set(entries.map((entry) => entry.name));
  const markers: string[] = [];
  for (const marker of [...CODE_MARKERS, ...DOC_MARKERS]) {
    if (names.has(marker)) markers.push(marker);
  }
  return markers;
}

/** Which kind of thing a directory is, from its markers and the shape of its contents. */
export function kindFrom(input: { markers: readonly string[]; extensionCounts: ReadonlyMap<string, number> }): ProjectKind {
  const markers = new Set(input.markers);
  if (CODE_MARKERS.some((marker) => markers.has(marker))) return "code";
  if (DOC_MARKERS.some((marker) => markers.has(marker))) return "docs";
  let media = 0;
  for (const [extension, count] of input.extensionCounts) {
    if (MEDIA_EXTENSIONS.includes(extension)) media += count;
  }
  if (media >= 3) return "media";
  return "generic";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** The origin remote, read from `.git/config`. The one file this scanner opens, and only for its URL. */
export function readGitRemote(path: string): string | undefined {
  try {
    const config = readFileSync(join(path, ".git", "config"), "utf8");
    const remoteSection = /\[remote "origin"\]([^[]*)/.exec(config);
    const url = remoteSection === null ? undefined : /\n\s*url\s*=\s*(\S+)/.exec(remoteSection[1] ?? "");
    return url?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Walk the approved roots.
 *
 * A directory with a project marker is recorded and **not** descended into: the projects inside a
 * repository are its packages, and offering them as candidates is how a finder ends up proposing
 * `packages/core` instead of the repository the user named.
 */
export async function scanProjects(options: ScanOptions): Promise<ScanOutcome> {
  const startedAt = Date.now();
  const maxDepth = options.maxDepth ?? 5;
  const maxEntries = options.maxEntries ?? 20_000;
  const ignores = new Set([...SYSTEM_IGNORES, ...(options.ignore ?? [])]);
  const projects: ScannedProject[] = [];
  let visited = 0;
  let truncated = false;
  let stoppedEarly = false;

  const walk = (path: string, depth: number): void => {
    if (visited >= maxEntries) {
      truncated = true;
      return;
    }
    if (options.signal?.aborted === true) {
      stoppedEarly = true;
      return;
    }

    let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped rather than failing the scan: a permission error deep in
      // a home directory must not stop the whole index from refreshing.
      return;
    }
    visited += entries.length;

    const markers = markersOf(entries);
    const extensionCounts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const extension = extensionOf(entry.name);
      if (extension === "") continue;
      extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
    }

    const hasMarker = markers.length > 0;
    const kind = kindFrom({ markers, extensionCounts });
    const isRootItself = options.roots.some((root) => resolve(root) === resolve(path));

    // A directory is a candidate when something marks it as one, or when it holds enough media to be
    // a folder a user would name. An unmarked, unremarkable directory is not indexed: a home
    // directory has hundreds, and offering them is noise rather than help.
    if (!isRootItself && (hasMarker || (kind === "media" && extensionCounts.size > 0))) {
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        // An unreadable directory is still indexed with a zero mtime, which makes the next refresh
        // re-examine it rather than treating it as unchanged.
        mtime = 0;
      }
      const remote = markers.includes(".git") ? readGitRemote(path) : undefined;
      projects.push({
        path,
        name: basename(path),
        kind,
        markers,
        mtime,
        ...(remote === undefined ? {} : { gitRemote: remote }),
      });
      return;
    }

    if (depth >= maxDepth) return;
    for (const entry of entries) {
      // `isSymbolicLink` first: a symlink out of the approved root would let the scan index a tree the
      // user never approved, which is the escape this refuses.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() !== true) continue;
      if (isIgnored(entry.name, ignores)) continue;
      walk(join(path, entry.name), depth + 1);
      if (visited >= maxEntries || stoppedEarly) return;
    }
  };

  for (const root of options.roots) {
    if (options.signal?.aborted === true) {
      stoppedEarly = true;
      break;
    }
    walk(root, 0);
    // Yielding between roots is what keeps a scan from blocking a turn in the same process.
    if (options.yieldBetweenRoots !== undefined) await options.yieldBetweenRoots();
    if (visited >= maxEntries) break;
  }

  return { projects, visited, truncated, stoppedEarly, durationMs: Date.now() - startedAt };
}

/* ------------------------------------------------------------------ *
 * The finder
 * ------------------------------------------------------------------ */

export interface ProjectFinderDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** Approved roots. Defaults to the home directory, which is the user's own decision. */
  roots: () => readonly string[];
  /** Extra ignored directory names, from `workspace.ignore`. */
  ignore: () => readonly string[];
  /** For a path relative to a root, which is all that travels. */
  home: () => string;
  /** The selector, when one is configured. Absent means the ranking decides. */
  decider?: DecideDeps;
}

export interface ProjectCandidate {
  id: string;
  name: string;
  /** Relative to the approved root, so no absolute home path is ever put in a prompt. */
  relPath: string;
  kind: ProjectKind;
  markers: string[];
  lastUsedAt: string | undefined;
  score: number | undefined;
  how: "alias" | "search" | "recent";
}

export interface RefreshOutcome {
  scanned: number;
  kept: number;
  removed: number;
  truncated: boolean;
  stoppedEarly: boolean;
  durationMs: number;
}

/** Refresh the index. Incremental by directory mtime unless `full` is set. */
export async function refreshProjectIndex(
  deps: ProjectFinderDeps,
  options: { full?: boolean; signal?: AbortSignal } = {},
): Promise<RefreshOutcome> {
  const roots = deps.roots();
  const known = new Map(listProjects(deps.db, deps.nodeId, 10_000).map((project) => [project.path, project]));

  const scan = await scanProjects({
    roots,
    ignore: deps.ignore(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // Between roots, not between entries: yielding per entry would make the scan an order of
    // magnitude slower for the same responsiveness.
    yieldBetweenRoots: async () => {
      await new Promise((done) => setImmediate(done));
    },
  });

  const at = deps.now();
  let kept = 0;
  for (const project of scan.projects) {
    const existing = known.get(project.path);
    // Incremental: a directory whose mtime has not moved is already indexed, and re-writing it would
    // churn the search index for nothing. A name or marker change moves the directory's mtime.
    if (options.full !== true && existing !== undefined && existing.mtime === project.mtime) {
      kept += 1;
      continue;
    }
    upsertProject(deps.db, {
      projectId: existing?.projectId ?? deps.newId("prj"),
      nodeId: deps.nodeId,
      path: project.path,
      name: project.name,
      aliases: existing?.aliases ?? [],
      gitRemote: project.gitRemote,
      markers: project.markers,
      kind: project.kind,
      mtime: project.mtime,
      lastUsedAt: existing?.lastUsedAt,
      indexedAt: at,
    });
    kept += 1;
  }

  // Only a scan that actually finished is allowed to prune: a bounded or interrupted scan did not
  // see every directory, and removing what it did not see would delete the index on every miss. Both
  // halves of that have to be checked — an abort before the first walk reports `truncated: false`
  // having scanned nothing, and pruning on that empties the per-node index, taking the aliases and
  // last-use times a rescan cannot reconstruct.
  const removed =
    (options.full === true || !scan.truncated) && !scan.stoppedEarly
      ? pruneProjects(deps.db, deps.nodeId, scan.projects.map((project) => project.path))
      : 0;

  return {
    scanned: scan.projects.length,
    kept,
    removed,
    truncated: scan.truncated,
    stoppedEarly: scan.stoppedEarly,
    durationMs: scan.durationMs,
  };
}

/**
 * Candidates for a query, from the cache.
 *
 * Cache first, always. A miss triggers a refresh by the caller rather than a scan inside the read
 * path, so a search never waits on a filesystem walk.
 */
export function findProjectCandidates(
  deps: ProjectFinderDeps,
  input: { query: string; kind?: ProjectKind; limit?: number },
): { candidates: ProjectCandidate[]; source: "cache" | "empty" } {
  const limit = input.limit ?? 8;
  const matches = searchProjects(deps.db, deps.nodeId, input.query, limit * 2);

  // Recent use is a signal even when the query does not match the name: "the project I was in" is a
  // real request, and the plan ranks recent-use above a fuzzy name match.
  // Recent use is a different signal from a match, and it is labelled as one. Calling it a search hit
  // made an unmatched query indistinguishable from a matched one, and the caller then opened whatever
  // directory had been used last — "the project I was in" and "a project that does not exist" looked
  // the same, and the second one silently opened the wrong directory.
  const recent =
    matches.length === 0
      ? listProjects(deps.db, deps.nodeId, limit)
          .filter((project) => project.lastUsedAt !== undefined)
          .map((project) => ({ project, score: undefined, how: "recent" as const }))
      : [];

  const combined = [...matches, ...recent]
    .filter((match) => input.kind === undefined || match.project.kind === input.kind)
    .map((match) => toCandidate(deps, match.project, match.score, match.how));

  const deduped = new Map(combined.map((candidate) => [candidate.id, candidate]));
  const ranked = rankProjectCandidates([...deduped.values()]).slice(0, limit);
  return { candidates: ranked, source: ranked.length === 0 ? "empty" : "cache" };
}

function toCandidate(
  deps: ProjectFinderDeps,
  project: ProjectRecord,
  score: number | undefined,
  // The declaration's own union, so a signal added to the type cannot be silently left out here —
  // which is how `recent` came to be reported as a search hit in the first place.
  how: ProjectCandidate["how"],
): ProjectCandidate {
  return {
    id: project.projectId,
    name: project.name,
    relPath: relativePaths(deps, project.path),
    kind: project.kind,
    markers: project.markers,
    lastUsedAt: project.lastUsedAt,
    score,
    how,
  };
}

/**
 * The path as it travels: relative to the approved root that contains it.
 *
 * Relative to the root rather than to the home directory, because a workspace is not always inside
 * home — this repository lives on another volume, and a home-relative path escaped as
 * `../../Volumes/…`, which is both useless to read and a description of the machine's layout. The
 * plan's rule is `relPath-from-root`, and the reason is that the selector and the model see this
 * string: a relative path from an approved root says where something is without saying where the
 * user's home is.
 */
function relativePaths(deps: ProjectFinderDeps, path: string): string {
  const roots = deps.roots().map((root) => resolve(root));
  const containing = roots.find((root) => isWithinRoot(root, path));
  const relativeToRoot = relative(containing ?? deps.home(), path);
  // Forward slashes, always.
  //
  // This value is read by a person and by the model — it is what a question offers as a choice and what
  // the transcript shows as "the directory in use" — so it is a name for a location rather than a path
  // for this machine. `path.relative` answers with the platform's separator, which made the same project
  // read as `.data/e2e/x` on one machine and `.data\e2e\x` on another; the branch was found by a browser
  // test that types one and looks for the other.
  return relativeToRoot === "" ? "." : relativeToRoot.split(sep).join("/");
}

/** Exact alias, then recent use, then kind, then the search score, then the shorter name. */
export function rankProjectCandidates(candidates: readonly ProjectCandidate[]): ProjectCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.how !== right.how) {
      if (left.how === "alias") return -1;
      if (right.how === "alias") return 1;
    }
    const leftUsed = left.lastUsedAt ?? "";
    const rightUsed = right.lastUsedAt ?? "";
    if (leftUsed !== rightUsed) return leftUsed < rightUsed ? 1 : -1;
    if (left.kind !== right.kind && left.kind === "code") return -1;
    if (left.kind !== right.kind && right.kind === "code") return 1;
    if (left.score !== undefined && right.score !== undefined && left.score !== right.score) {
      return left.score - right.score;
    }
    return left.name.length - right.name.length;
  });
}

export type ProjectVerification =
  | { ok: true; project: ProjectRecord }
  | { ok: false; code: "PROJECT_UNKNOWN" | "PATH_MISSING" | "OUTSIDE_APPROVED_ROOTS" | "LEASED"; message: string };

/**
 * Re-check a project before a session is started in it.
 *
 * The index can be stale, the directory can have been moved, and a root can have been removed from
 * the approved list since the scan. Starting a session in a path outside the approved roots is the
 * failure this refuses.
 */
export function verifyProject(deps: ProjectFinderDeps, projectId: string): ProjectVerification {
  const project = getProject(deps.db, projectId);
  if (project === undefined || project.nodeId !== deps.nodeId) {
    return { ok: false, code: "PROJECT_UNKNOWN", message: "that project is not indexed on this node" };
  }

  const roots = deps.roots();
  if (!roots.some((root) => isWithinRoot(root, project.path))) {
    return {
      ok: false,
      code: "OUTSIDE_APPROVED_ROOTS",
      message: "that directory is no longer inside an approved root",
    };
  }

  try {
    if (!statSync(project.path).isDirectory()) {
      return { ok: false, code: "PATH_MISSING", message: "that directory is no longer a directory" };
    }
  } catch {
    return { ok: false, code: "PATH_MISSING", message: "that directory is no longer on disk" };
  }

  const live = deps.db
    .prepare(
      "SELECT lease_id FROM leases WHERE released_at IS NULL AND expires_at > ? AND resource_id = ? LIMIT 1",
    )
    .get(deps.now(), project.path) as { lease_id: string } | undefined;
  if (live !== undefined) {
    return {
      ok: false,
      code: "LEASED",
      message: "another writer holds a lease on that directory; wait for it to finish",
    };
  }

  return { ok: true, project };
}

/** How a directory was chosen. `path` means the user gave it, not that it was searched for. */
export type ProjectResolutionMode = "jev" | "rank" | "alias" | "path";

export type ProjectResolution =
  | { status: "resolved"; project: ProjectRecord; relPath: string; mode: ProjectResolutionMode; candidates: number }
  | { status: "clarify"; question: string; options: string[] }
  | { status: "ask-for-directory"; question: string }
  | { status: "rejected"; code: string; message: string };

/**
 * A path the user typed, if their words contain one.
 *
 * The answer to "which directory?" is a path, and a finder that treats it as a search query asks the
 * question again — which is exactly the loop this closes. `~/…` and absolute paths are recognised,
 * quoted or bare; a path containing a space has to be quoted, and that is a rule the user can see
 * rather than one that silently truncates their answer. Trailing punctuation is dropped, because a
 * path rarely ends a sentence without a full stop after it.
 */
export function pathFromIntent(intent: string): string | undefined {
  const quoted = /"([^"]+)"|'([^']+)'/.exec(intent);
  const candidates: string[] = [];
  const quotedValue = quoted?.[1] ?? quoted?.[2];
  if (quotedValue !== undefined) candidates.push(quotedValue);
  // Every spelling of a path a person might type: a home-relative one, a Windows drive letter, a UNC
  // share, and a rooted path. The first version of this matched only the slash forms, so on Windows a
  // typed `D:\...` was treated as a search query and the finder asked the question again — the loop
  // this function exists to close.
  for (const match of intent.match(/(?:^|\s)(~[\\/][^\s]*|[A-Za-z]:[\\/][^\s]*|\\\\[^\s]*|\/[^\s]*)/g) ?? []) {
    candidates.push(match.trim());
  }
  for (const raw of candidates) {
    const trimmed = raw.replace(/[.,;:]+$/, "");
    if (looksLikePath(trimmed)) return trimmed;
  }
  return undefined;
}

/**
 * A tilde at the front of a path, expanded the way the platform would.
 *
 * Both separators are accepted, because the tilde form is typed by hand and `~\` is what a Windows
 * shell offers to complete.
 */
function expandHome(raw: string, home: string): string {
  if (!raw.startsWith("~")) return raw;
  const rest = raw.slice(1);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("\\")) return raw;
  return join(home, rest.replace(/^[\\/]/, ""));
}

/**
 * Index one directory the user named.
 *
 * A named directory is indexed even when it carries no marker, because the user saying "this one" is
 * the signal — the scanner's marker rule exists to keep a home directory from offering hundreds of
 * unremarkable folders, not to tell a user their own folder is not a folder. Everything still has to
 * be inside an approved root: a path is not a way to reach outside what the user approved.
 */
export function indexDirectoryPath(
  deps: ProjectFinderDeps,
  raw: string,
): { ok: true; projectId: string } | { ok: false; code: string; message: string } {
  const path = resolve(expandHome(raw, deps.home()));
  const roots = deps.roots().map((root) => resolve(root));
  if (!roots.some((root) => isWithinRoot(root, path))) {
    return {
      ok: false,
      code: "OUTSIDE_APPROVED_ROOTS",
      message: "that directory is not inside a root this node is allowed to use",
    };
  }

  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, code: "PATH_MISSING", message: "there is no directory at that path" };
  }
  if (!stats.isDirectory()) {
    return { ok: false, code: "NOT_A_DIRECTORY", message: "that path is not a directory" };
  }

  const existing = findProjectByPath(deps.db, deps.nodeId, path);
  if (existing !== undefined) return { ok: true, projectId: existing.projectId };

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return { ok: false, code: "PATH_UNREADABLE", message: "that directory could not be read" };
  }
  const markers = markersOf(entries);
  const extensionCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const extension = extensionOf(entry.name);
    if (extension === "") continue;
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
  }

  const projectId = deps.newId("prj");
  upsertProject(deps.db, {
    projectId,
    nodeId: deps.nodeId,
    path,
    name: basename(path),
    aliases: [],
    gitRemote: markers.includes(".git") ? readGitRemote(path) : undefined,
    markers,
    kind: kindFrom({ markers, extensionCounts }),
    mtime: stats.mtimeMs,
    lastUsedAt: undefined,
    indexedAt: deps.now(),
  });
  return { ok: true, projectId };
}

/**
 * Resolve what the user meant to a directory.
 *
 * The order is the plan's: candidates from the cache, a refresh on a miss, then one candidate
 * resolves itself, several go to the selector, and anything the selector will not decide becomes a
 * single clarifying question. A directory is never invented, and a path is never guessed.
 */
export async function resolveProject(
  deps: ProjectFinderDeps,
  input: { intent: string; kind?: ProjectKind },
): Promise<ProjectResolution> {
  // The path is read from the user's own words, *before* redaction, and everything that travels keeps
  // using the redacted form below. Two reasons, and the first one was a live defect: the redactor
  // replaces an absolute path with a placeholder — a home path is exactly what it is built to remove —
  // so extracting after it meant a typed directory never resolved and the user was asked for it again,
  // forever. The second is that this is the answer to a question the node asked: it is used locally to
  // open a directory, never sent to a provider, and Phase 11 requires the selector's state to carry no
  // absolute home path at all.
  const typedPath = pathFromIntent(input.intent.slice(0, 500));
  const usableIntent = redactSecrets(input.intent).slice(0, 300);

  // A path is checked first, and deliberately: searching on the words of a path returns whatever else
  // happens to share them, and then the user is asked for the directory they just gave.
  if (typedPath !== undefined) {
    const indexed = indexDirectoryPath(deps, typedPath);
    if (!indexed.ok) return { status: "rejected", code: indexed.code, message: indexed.message };
    const verified = verifyProject(deps, indexed.projectId);
    if (!verified.ok) return { status: "rejected", code: verified.code, message: verified.message };
    return {
      status: "resolved",
      project: verified.project,
      relPath: relativePaths(deps, verified.project.path),
      mode: "path",
      candidates: 1,
    };
  }

  let { candidates } = findProjectCandidates(deps, { query: usableIntent, ...(input.kind === undefined ? {} : { kind: input.kind }) });

  // A miss on a cold index is a scan, not a failure. The scan is awaited here because the caller is
  // about to answer the user; the *background* refresh on mount is the one that must not block.
  if (candidates.length === 0) {
    await refreshProjectIndex(deps, { full: false });
    candidates = findProjectCandidates(deps, { query: usableIntent, ...(input.kind === undefined ? {} : { kind: input.kind }) }).candidates;
  }

  if (candidates.length === 0) {
    return {
      status: "ask-for-directory",
      question:
        "Tui không tìm thấy thư mục nào khớp. Bạn cho tui đường dẫn thư mục cần dùng được không?",
    };
  }

  const pick = (id: string, mode: ProjectResolutionMode): ProjectResolution => {
    const verified = verifyProject(deps, id);
    if (!verified.ok) return { status: "rejected", code: verified.code, message: verified.message };
    return {
      status: "resolved",
      project: verified.project,
      relPath: relativePaths(deps, verified.project.path),
      mode,
      candidates: candidates.length,
    };
  };

  /** The question asked instead of opening the directory used last. */
  const offerRecent = (candidate: { relPath: string }): ProjectResolution => ({
    status: "clarify",
    question: `Tui không tìm thấy thư mục nào khớp. Có phải bạn muốn dùng ${candidate.relPath} (thư mục dùng gần đây nhất) không?`,
    options: [candidate.relPath],
  });

  /**
   * Resolve a candidate, unless it is only the directory used last.
   *
   * A recent candidate is a proposal and not a match, so it is never opened silently — asking for a
   * project that does not exist must not open whatever was used before it. The single-candidate path
   * has always refused it; the decider path did not, so a selector choosing from a list could do exactly
   * what the rule forbids. Found by the browser test that types a name nothing matches and expects a
   * question rather than a session.
   */
  const resolve = (candidate: { how: string; id: string; relPath: string }, mode: ProjectResolutionMode): ProjectResolution =>
    candidate.how === "recent" ? offerRecent(candidate) : pick(candidate.id, mode);

  const single = candidates[0];
  if (candidates.length === 1 && single !== undefined) {
    return resolve(single, single.how === "alias" ? "alias" : "rank");
  }

  if (deps.decider !== undefined) {
    const decision = await decideProject(deps.decider, {
      intent: usableIntent,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        relPath: candidate.relPath,
        kind: candidate.kind,
        markers: candidate.markers,
      })),
      verify: (id) => verifyProject(deps, id).ok,
    });
    if (decision.status === "selected") {
      const chosen = candidates.find((candidate) => candidate.id === decision.id);
      return chosen === undefined ? pick(decision.id, "jev") : resolve(chosen, "jev");
    }
    if (decision.status === "none" || decision.status === "fallback") {
      const asked = disambiguate(candidates.map((candidate) => ({ id: candidate.id, label: candidate.relPath })));
      if (asked.resolved) {
        const chosen = candidates.find((candidate) => candidate.id === asked.id);
        return chosen === undefined ? pick(asked.id, "rank") : resolve(chosen, "rank");
      }
      return { status: "clarify", question: asked.question, options: asked.options };
    }
  }

  // One question, never a guess: two directories with similar names is exactly the case the plan
  // names, and answering with the wrong repository is worse than asking.
  const asked = disambiguate(candidates.map((candidate) => ({ id: candidate.id, label: candidate.relPath })));
  if (asked.resolved) {
    const chosen = candidates.find((candidate) => candidate.id === asked.id);
    return chosen === undefined ? pick(asked.id, "rank") : resolve(chosen, "rank");
  }
  return { status: "clarify", question: asked.question, options: asked.options };
}

/** Record a use, which is what makes recent-use a real signal on the next question. */
export function markProjectUsed(deps: ProjectFinderDeps, projectId: string): boolean {
  return touchProjectUse(deps.db, projectId, deps.now());
}

/** A short context block for the initial prompt: what was chosen, and how to change it. */
export function projectContext(project: ProjectRecord): string {
  const markers = project.markers.slice(0, 6).join(", ");
  return (
    `Thư mục đã chọn: ${project.name} (${project.kind}${markers === "" ? "" : `, dấu hiệu: ${markers}`}). ` +
    "Nếu không phải, nói \"không phải, dùng dự án X\"."
  );
}

export function findProjectById(deps: ProjectFinderDeps, projectId: string): ProjectRecord | undefined {
  return getProject(deps.db, projectId);
}

export function findProjectAtPath(deps: ProjectFinderDeps, path: string): ProjectRecord | undefined {
  return findProjectByPath(deps.db, deps.nodeId, path);
}

/**
 * `find_project`, as the Session Manager exposes it to the main model.
 *
 * The tool returns names and relative paths, never absolute ones: the model is choosing a directory
 * to work in, and a home path in a prompt is a path in a log.
 */
export function createFindProjectTool(deps: ProjectFinderDeps): ToolDefinition {
  return {
    name: "find_project",
    label: "Find a project directory",
    description:
      "Find a project or folder on this machine by name, alias or topic. Returns names and paths " +
      "relative to the home directory. Use it when the user names a project without giving a path.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What the user called the project, in their words." },
        kind: { type: "string", description: "Restrict to one kind.", enum: ["code", "docs", "media", "generic"] },
      },
    },
    promptSnippet: "find_project — locate a project directory on this machine",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const query = typeof params.query === "string" ? params.query : "";
      if (query.trim() === "") return { text: "No query was given." };
      const kind =
        params.kind === "code" || params.kind === "docs" || params.kind === "media" || params.kind === "generic"
          ? params.kind
          : undefined;
      const { candidates } = findProjectCandidates(deps, { query, ...(kind === undefined ? {} : { kind }) });
      if (candidates.length === 0) {
        return {
          text: `No indexed directory matches "${query}". The index holds ${listProjects(deps.db, deps.nodeId).length} directories.`,
        };
      }
      const lines = candidates.map(
        (candidate) => `- ${candidate.name} (${candidate.kind}) at ~/${candidate.relPath}`,
      );
      return { text: `${candidates.length} match(es):\n${lines.join("\n")}` };
    },
  };
}

export { homedir };
