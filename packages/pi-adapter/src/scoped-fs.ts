import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import type { ToolDefinition } from "./types.ts";

/**
 * The filesystem boundary an approved project root describes.
 *
 * A path escape is refused here, where the act happens, and never by a policy decision: whether a
 * worker may read `/etc/passwd` is not a matter of mode or consent, it is the host's capability
 * boundary. `decideExecution` is deliberately not involved, and this module does not import it.
 *
 * Three properties make the check worth trusting rather than decorative:
 *
 * 1. **Both sides are canonical.** A root and a candidate are put through `fs.realpath` before they are
 *    compared, so `..`, a symlink and a bind mount are all resolved by the platform rather than by string
 *    arithmetic. Comparing the strings the user typed would accept `/root/link/../../etc` whenever the
 *    lexical form happened to land inside.
 * 2. **The candidate is walked the way the kernel walks it.** Each component is resolved before the next
 *    one is joined, so `..` after a symlink climbs out of the symlink's *target* rather than out of its
 *    name — the case a lexical `path.resolve` gets wrong in the permissive direction.
 * 3. **A root has an identity.** If the approved path no longer canonicalises to itself, something else
 *    now stands in its place, and nothing under it is the directory that was approved.
 *
 * The four tools below are ClarkCant's own `read`/`grep`/`find`/`ls`. They exist because the SDK's
 * built-in ones resolve paths themselves: a project worker runs with those left out of its allowlist
 * and only these registered, so every filesystem call this package makes goes through
 * `resolveInsideRoots` first. No raw `fs` primitive is handed to a tool or an extension.
 */

/** A root that could not be approved, and why. Refusing a root is reported, never silent. */
export interface RefusedRoot {
  readonly root: string;
  readonly reason: string;
}

/** The roots a session may touch, canonicalised, plus the ones that were refused and why. */
export interface CanonicalRoots {
  readonly roots: readonly string[];
  readonly refused: readonly RefusedRoot[];
}

/** A candidate path, either admitted and canonical or refused with a readable reason. */
export type InsideRoots = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The bounds every scoped tool respects.
 *
 * A tool that can return an unbounded answer is a tool that can spend a turn's whole context on one
 * call. Each bound is reported when it is reached, because a truncated listing that looks complete is
 * the failure this exists to prevent.
 */
export const SCOPED_FS_LIMITS = {
  /** Bytes of one file a read hands over before the rest is left behind. */
  maxFileBytes: 262_144,
  /** Bytes of one tool's output. */
  maxOutputBytes: 65_536,
  /** Matches one grep returns. */
  maxMatches: 100,
  /** Directory entries one traversal visits. */
  maxEntries: 2_000,
  /** Results one find returns. */
  maxResults: 200,
  /** Directory levels below the start of a traversal. */
  maxDepth: 8,
} as const;

/** The names of the four tools, which are the whole filesystem surface of a confined session. */
export const SCOPED_FS_TOOL_NAMES = [
  "clarkcant_read",
  "clarkcant_grep",
  "clarkcant_find",
  "clarkcant_ls",
] as const;

/** One root's reason for being unusable, as a sentence a caller can put in a message. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether `candidate` is `root` itself or below it, by the platform's own separator rules. */
function isWithin(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Canonicalise the approved roots.
 *
 * A root that cannot be canonicalised is not used and is reported by name: silently dropping one would
 * leave a session confined to something other than what was approved, and silently keeping an
 * unusable one would refuse every path for a reason nobody could find.
 */
export async function canonicalRoots(roots: readonly string[]): Promise<CanonicalRoots> {
  const canonical: string[] = [];
  const refused: RefusedRoot[] = [];

  for (const root of roots) {
    if (!isAbsolute(root)) {
      refused.push({ root, reason: "it is not an absolute path" });
      continue;
    }
    let here: string;
    try {
      here = await realpath(root);
    } catch (cause) {
      refused.push({ root, reason: `it cannot be resolved: ${describeCause(cause)}` });
      continue;
    }
    const info = await stat(here).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      refused.push({ root, reason: `it is not a directory (${here})` });
      continue;
    }
    // Deduplicated after canonicalisation, so `/root` and `/root/` and a symlink to `/root` are one root.
    if (!canonical.includes(here)) canonical.push(here);
  }

  return { roots: canonical, refused };
}

/**
 * Walk a path the way the platform resolves it, so that containment is checked on the real target.
 *
 * Once a component does not exist, the walk stops resolving and the remaining segments are joined
 * lexically: a path that names a file nobody created yet is still a legal path *inside* the root, and
 * the caller gets a truthful "not found" instead of a containment refusal. A `..` after such a
 * component is refused, because the platform would refuse it too — the missing component has to exist
 * to be climbed out of.
 */
async function walkPath(base: string, segments: readonly string[]): Promise<InsideRoots> {
  let current = base;
  let missing: string | undefined;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (segment === "" || segment === ".") continue;

    if (segment === "..") {
      if (missing !== undefined) {
        return {
          ok: false,
          reason: `"${missing}" does not exist, so the ".." after it names nothing (the platform refuses this path too)`,
        };
      }
      current = dirname(current);
      continue;
    }

    if (missing !== undefined) {
      current = join(current, segment);
      continue;
    }

    const candidate = join(current, segment);
    const info = await stat(candidate).catch(() => undefined);
    if (info === undefined) {
      missing = segment;
      current = candidate;
      continue;
    }
    // Together: refuses a path that walks *through* a file, which the platform refuses as well.
    if (index < segments.length - 1 && !info.isDirectory()) {
      return { ok: false, reason: `"${candidate}" is not a directory, so nothing can be under it` };
    }
    // The component's canonical target, so a symlink is followed and the next segment is joined to
    // where it actually points rather than to its name.
    current = await realpath(candidate).catch(() => candidate);
  }

  return { ok: true, path: current };
}

/**
 * Resolve a candidate against the approved roots.
 *
 * `roots` are canonical, as `canonicalRoots` produced them. A relative path is taken against the first
 * approved root and never against the process working directory: a working directory is a convenience
 * the platform hands a process, not a boundary, and a boundary that moved with `process.cwd()` would be
 * no boundary at all.
 */
export async function resolveInsideRoots(
  roots: readonly string[],
  path: string,
): Promise<InsideRoots> {
  const first = roots[0];
  if (first === undefined) {
    return { ok: false, reason: "no approved root is in force, so no path can be allowed" };
  }

  const asked = path.trim();
  if (asked === "") return { ok: false, reason: "no path was given" };

  /*
   * Root identity, checked for every approved root before anything is admitted.
   *
   * A root that no longer canonicalises to itself has been replaced — by a symlink, another mount, or
   * a caller that never canonicalised — so a path under the approved string would be a path in some
   * other directory. This runs first rather than only when a candidate matches, because the failure it
   * catches is the root's, not the candidate's.
   */
  for (const root of roots) {
    let now: string;
    try {
      now = await realpath(root);
    } catch (cause) {
      return {
        ok: false,
        reason: `approved root "${root}" can no longer be resolved: ${describeCause(cause)}`,
      };
    }
    if (now !== root) {
      return {
        ok: false,
        reason: `approved root "${root}" now resolves to "${now}", so it is no longer the directory that was approved`,
      };
    }
  }

  const root = isAbsolute(asked) ? parse(asked).root : "";
  const relativeToRoot = root === "" ? asked : asked.slice(root.length);
  const walked = await walkPath(root === "" ? first : root, relativeToRoot.split(sep));
  if (!walked.ok) return walked;

  if (!roots.some((approved) => isWithin(approved, walked.path))) {
    return {
      ok: false,
      reason: `"${walked.path}" is outside every approved root (${roots.join(", ")})`,
    };
  }

  return walked;
}

/** A tool result that carries text only, which is what every scoped tool answers with. */
function text(value: string): { text: string } {
  return { text: value };
}

/** The refusal every tool answers with, so a denial reads as a decision rather than as a crash. */
function refused(reason: string): { text: string } {
  return text(`refused: ${reason}`);
}

/** One string parameter, trimmed, with an empty value treated as absent. */
function textParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

/** One numeric parameter, clamped to a stated bound so a caller cannot raise it. */
function boundedNumber(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
  limit: number,
): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), limit);
}

/** Read at most `cap` bytes, so a large file cannot be loaded to be trimmed afterwards. */
async function readBounded(
  path: string,
  cap: number,
): Promise<{ bytes: Uint8Array; bytesRead: number }> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(cap);
    let bytesRead = 0;
    while (bytesRead < cap) {
      const { bytesRead: read } = await handle.read(buffer, bytesRead, cap - bytesRead, bytesRead);
      if (read <= 0) break;
      bytesRead += read;
    }
    return { bytes: buffer.subarray(0, bytesRead), bytesRead };
  } finally {
    await handle.close();
  }
}

/** One candidate a traversal considered: where it is now, and what the caller should call it. */
interface TraversedFile {
  readonly path: string;
  readonly label: string;
}

interface Traversal {
  readonly files: readonly TraversedFile[];
  /** True when a bound stopped the walk before the tree was exhausted. */
  readonly truncated: string | undefined;
  /** What was left out and why, for a symlink that leaves the roots or a directory symlink. */
  readonly notes: readonly string[];
}

/**
 * Walk a directory, following no symlink out of the approved roots and staying inside every bound.
 *
 * A symlink that resolves inside the roots is followed for a file and *not* descended into for a
 * directory: descending into it would let a two-link loop make the walk run forever, and the bounds
 * would then be reporting a loop rather than a large tree.
 */
async function traverse(input: {
  roots: readonly string[];
  start: string;
  maxDepth: number;
  maxEntries: number;
}): Promise<Traversal> {
  const files: TraversedFile[] = [];
  const notes: string[] = [];
  let truncated: string | undefined;
  let visited = 0;

  const queue: { directory: string; depth: number }[] = [{ directory: input.start, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (visited >= input.maxEntries) {
        truncated = `the ${input.maxEntries} entry bound was reached`;
        break;
      }
      const path = join(current.directory, entry.name);
      const label = relative(input.start, path).split(sep).join("/");

      if (entry.isSymbolicLink()) {
        visited += 1;
        const resolved = await resolveInsideRoots(input.roots, path);
        if (!resolved.ok) {
          notes.push(`${label}: a symlink that leaves the approved roots was not followed`);
          continue;
        }
        const target = await stat(path).catch(() => undefined);
        if (target?.isDirectory() === true) {
          notes.push(`${label}: a directory symlink was not descended into`);
          continue;
        }
        if (target?.isFile() === true) files.push({ path: resolved.path, label });
        continue;
      }

      visited += 1;
      if (entry.isDirectory()) {
        if (current.depth + 1 > input.maxDepth) {
          truncated ??= `the depth bound of ${input.maxDepth} was reached`;
          continue;
        }
        queue.push({ directory: path, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile()) files.push({ path, label });
    }
    if (truncated !== undefined) break;
  }

  return { files, truncated, notes };
}

/** Join output lines, respecting the byte bound and saying when it cut the answer short. */
function joinBounded(lines: readonly string[], header: string): string {
  const kept: string[] = [];
  let bytes = 0;
  let cut = false;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > SCOPED_FS_LIMITS.maxOutputBytes) {
      cut = true;
      break;
    }
    kept.push(line);
    bytes += size;
  }
  return [
    header,
    ...kept,
    ...(cut ? [`… truncated: the output bound of ${SCOPED_FS_LIMITS.maxOutputBytes} byte was reached`] : []),
  ].join("\n");
}

/** The read tool: one file, its bytes, bounded and labelled. */
function readTool(roots: readonly string[]): ToolDefinition {
  return {
    name: "clarkcant_read",
    label: "Read a file inside the approved project roots",
    description:
      "Reads one text file. The path must be inside an approved project root; a relative path is taken against the " +
      "first approved root. A path outside the roots, a `..` escape or a symlink that leaves them is refused.",
    promptSnippet: "clarkcant_read: read a file inside the approved project roots",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "File to read, inside an approved project root." },
        maxBytes: {
          type: "number",
          description: `How many bytes to return, at most ${SCOPED_FS_LIMITS.maxFileBytes}.`,
        },
      },
    },
    execute: async (params) => {
      const asked = textParam(params, "path");
      if (asked === undefined) return refused("no path was given");
      const resolved = await resolveInsideRoots(roots, asked);
      if (!resolved.ok) return refused(resolved.reason);

      const info = await stat(resolved.path).catch(() => undefined);
      if (info === undefined) return text(`not found: "${resolved.path}" is not there`);
      if (!info.isFile()) return text(`not a file: "${resolved.path}" is not a regular file`);

      const cap = boundedNumber(params, "maxBytes", SCOPED_FS_LIMITS.maxFileBytes, SCOPED_FS_LIMITS.maxFileBytes);
      const { bytes, bytesRead } = await readBounded(resolved.path, cap);
      const body = new TextDecoder().decode(bytes);
      const header =
        info.size > bytesRead
          ? `${resolved.path} (${info.size} byte; the first ${bytesRead} are shown)`
          : `${resolved.path} (${info.size} byte)`;
      return text(`${header}\n${body}`);
    },
  };
}

/** The grep tool: a regular expression over the files under one approved path. */
function grepTool(roots: readonly string[]): ToolDefinition {
  return {
    name: "clarkcant_grep",
    label: "Search inside the approved project roots",
    description:
      "Searches files under a path inside the approved project roots with a JavaScript regular expression and returns " +
      "matching lines as `path:line: text`. Symlinks that leave the roots are not followed, and the answer is cut at " +
      "stated bounds rather than left unbounded.",
    promptSnippet: "clarkcant_grep: search for a pattern inside the approved project roots",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression to match against each line." },
        path: { type: "string", description: "File or directory to search, inside an approved root." },
        maxMatches: { type: "number", description: `Matches to return, at most ${SCOPED_FS_LIMITS.maxMatches}.` },
        maxDepth: { type: "number", description: `Directory depth to search, at most ${SCOPED_FS_LIMITS.maxDepth}.` },
      },
    },
    execute: async (params) => {
      const pattern = textParam(params, "pattern");
      if (pattern === undefined) return refused("no pattern was given");
      let expression: RegExp;
      try {
        expression = new RegExp(pattern);
      } catch (cause) {
        return text(`invalid pattern: ${describeCause(cause)}`);
      }

      const asked = textParam(params, "path") ?? roots[0] ?? "";
      const resolved = await resolveInsideRoots(roots, asked);
      if (!resolved.ok) return refused(resolved.reason);
      const info = await stat(resolved.path).catch(() => undefined);
      if (info === undefined) return text(`not found: "${resolved.path}" is not there`);

      const maxMatches = boundedNumber(params, "maxMatches", SCOPED_FS_LIMITS.maxMatches, SCOPED_FS_LIMITS.maxMatches);
      const maxDepth = boundedNumber(params, "maxDepth", SCOPED_FS_LIMITS.maxDepth, SCOPED_FS_LIMITS.maxDepth);
      const start = info.isDirectory() ? resolved.path : dirname(resolved.path);
      const single = info.isFile() ? [{ path: resolved.path, label: resolved.path }] : undefined;
      const walked =
        single === undefined
          ? await traverse({ roots, start, maxDepth, maxEntries: SCOPED_FS_LIMITS.maxEntries })
          : { files: single, truncated: undefined, notes: [] };

      const lines: string[] = [];
      let matched = 0;
      let cutAtMatches = false;
      for (const file of walked.files) {
        if (matched >= maxMatches) {
          cutAtMatches = true;
          break;
        }
        const size = (await stat(file.path).catch(() => undefined))?.size ?? 0;
        if (size > SCOPED_FS_LIMITS.maxFileBytes) continue;
        const body = await readFile(file.path, "utf8").catch(() => undefined);
        if (body === undefined) continue;
        const fileLines = body.split("\n");
        for (let index = 0; index < fileLines.length; index += 1) {
          const line = fileLines[index] ?? "";
          if (!expression.test(line)) continue;
          if (matched >= maxMatches) {
            cutAtMatches = true;
            break;
          }
          matched += 1;
          lines.push(`${file.label}:${index + 1}: ${line.trim()}`);
        }
      }

      const notes = [
        ...walked.notes,
        ...(cutAtMatches ? [`only the first ${maxMatches} matches are shown`] : []),
        ...(walked.truncated === undefined ? [] : [walked.truncated]),
      ];
      return text(
        joinBounded(
          [...lines, ...notes.map((note) => `… ${note}`)],
          `${walked.files.length} file considered under ${resolved.path}`,
        ),
      );
    },
  };
}

/** The find tool: names under one approved path, matched by a glob or a substring. */
function findTool(roots: readonly string[]): ToolDefinition {
  return {
    name: "clarkcant_find",
    label: "Find files inside the approved project roots",
    description:
      "Lists files under a path inside the approved project roots whose name matches a glob (`*` and `?`) or, when " +
      "the pattern has neither, contains it as a substring. Symlinks that leave the roots are not followed.",
    promptSnippet: "clarkcant_find: list files inside the approved project roots",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: { type: "string", description: "Glob or substring matched against each file name." },
        path: { type: "string", description: "Directory to search, inside an approved root." },
        maxResults: { type: "number", description: `Files to return, at most ${SCOPED_FS_LIMITS.maxResults}.` },
        maxDepth: { type: "number", description: `Directory depth to search, at most ${SCOPED_FS_LIMITS.maxDepth}.` },
      },
    },
    execute: async (params) => {
      const asked = textParam(params, "path") ?? roots[0] ?? "";
      const resolved = await resolveInsideRoots(roots, asked);
      if (!resolved.ok) return refused(resolved.reason);
      const info = await stat(resolved.path).catch(() => undefined);
      if (info === undefined) return text(`not found: "${resolved.path}" is not there`);

      const pattern = textParam(params, "pattern");
      const maxResults = boundedNumber(params, "maxResults", SCOPED_FS_LIMITS.maxResults, SCOPED_FS_LIMITS.maxResults);
      const maxDepth = boundedNumber(params, "maxDepth", SCOPED_FS_LIMITS.maxDepth, SCOPED_FS_LIMITS.maxDepth);
      const single = info.isFile() ? [{ path: resolved.path, label: resolved.path }] : undefined;
      const walked =
        single === undefined
          ? await traverse({ roots, start: resolved.path, maxDepth, maxEntries: SCOPED_FS_LIMITS.maxEntries })
          : { files: single, truncated: undefined, notes: [] };

      const matching = walked.files
        .filter((file) => matchesName(file.label.split("/").pop() ?? "", pattern))
        .map((file) => file.label)
        .sort((left, right) => left.localeCompare(right));
      const shown = matching.slice(0, maxResults);
      const notes = [
        ...walked.notes,
        ...(matching.length > shown.length ? [`only the first ${maxResults} of ${matching.length} matches are shown`] : []),
        ...(walked.truncated === undefined ? [] : [walked.truncated]),
      ];
      return text(
        joinBounded(
          [...shown, ...notes.map((note) => `… ${note}`)],
          `${matching.length} file under ${resolved.path}`,
        ),
      );
    },
  };
}

/** Whether a file name matches a glob, or contains the pattern when it is not a glob. */
function matchesName(name: string, pattern: string | undefined): boolean {
  if (pattern === undefined) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return name.includes(pattern);
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${source}$`).test(name);
}

/** The ls tool: one directory, its entries, bounded. */
function lsTool(roots: readonly string[]): ToolDefinition {
  return {
    name: "clarkcant_ls",
    label: "List a directory inside the approved project roots",
    description:
      "Lists one directory's entries with the kind of each entry. A symlink is shown with the canonical path it " +
      "resolves to, or as unreachable when it leaves the approved roots.",
    promptSnippet: "clarkcant_ls: list a directory inside the approved project roots",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Directory to list, inside an approved root. Defaults to the first root." },
        maxEntries: { type: "number", description: `Entries to return, at most ${SCOPED_FS_LIMITS.maxEntries}.` },
      },
    },
    execute: async (params) => {
      const asked = textParam(params, "path") ?? roots[0] ?? "";
      const resolved = await resolveInsideRoots(roots, asked);
      if (!resolved.ok) return refused(resolved.reason);
      const info = await stat(resolved.path).catch(() => undefined);
      if (info === undefined) return text(`not found: "${resolved.path}" is not there`);
      if (!info.isDirectory()) return text(`not a directory: "${resolved.path}" is not a directory`);

      const maxEntries = boundedNumber(params, "maxEntries", SCOPED_FS_LIMITS.maxEntries, SCOPED_FS_LIMITS.maxEntries);
      const entries = (await readdir(resolved.path, { withFileTypes: true }).catch(() => [])).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      const shown = entries.slice(0, maxEntries);
      const lines: string[] = [];
      for (const entry of shown) {
        const path = join(resolved.path, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await resolveInsideRoots(roots, path);
          lines.push(`${entry.name} -> ${target.ok ? target.path : "outside the approved roots"}`);
          continue;
        }
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/`);
          continue;
        }
        const size = (await stat(path).catch(() => undefined))?.size;
        lines.push(size === undefined ? entry.name : `${entry.name} (${size} byte)`);
      }
      const notes =
        entries.length > shown.length ? [`only the first ${maxEntries} of ${entries.length} entries are shown`] : [];
      return text(
        joinBounded(
          [...lines, ...notes.map((note) => `… ${note}`)],
          `${entries.length} entry in ${resolved.path}`,
        ),
      );
    },
  };
}

/**
 * The four tools a confined project worker runs with, bound to one canonical root set.
 *
 * `roots` must be canonical — `canonicalRoots` produced them — because every call re-checks that each
 * root still canonicalises to itself, and an un-canonical root is refused by name rather than quietly
 * accepted.
 */
export function createScopedFsTools(input: { roots: readonly string[] }): ToolDefinition[] {
  const roots = [...input.roots];
  return [readTool(roots), grepTool(roots), findTool(roots), lsTool(roots)];
}
