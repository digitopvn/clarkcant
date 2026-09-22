import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import { startPatternMatcher } from "./pattern-matcher.ts";
import type { ToolDefinition } from "./types.ts";

/**
 * The filesystem boundary an approved project root describes.
 *
 * A path escape is refused here, where the act happens, and never by a policy decision: whether a
 * worker may read `/etc/passwd` is not a matter of mode or consent, it is the host's capability
 * boundary. `decideExecution` is deliberately not involved, and this module does not import it.
 *
 * Four properties make the check worth trusting rather than decorative:
 *
 * 1. **Both sides are canonical.** A root and a candidate are put through `fs.realpath` before they are
 *    compared, so `..` and a symlink are resolved by the platform rather than by string arithmetic.
 *    Comparing the strings the user typed would accept `/root/link/../../etc` whenever the lexical form
 *    happened to land inside. `realpath` does not detect a bind mount: a mount over the approved path is
 *    caught below only when a *different* directory is mounted there, not when the approved directory is
 *    mounted over itself.
 * 2. **The candidate is walked the way the kernel walks it.** Each component is resolved before the next
 *    one is joined, so `..` after a symlink climbs out of the symlink's *target* rather than out of its
 *    name — the case a lexical `path.resolve` gets wrong in the permissive direction.
 * 3. **A root has an identity.** Approval records the `{ dev, ino }` the kernel gave the directory, and
 *    every resolution re-compares it. A symlink or a mount standing at the approved path changes what
 *    `realpath` answers; a rename followed by a directory created at the same name leaves the canonical
 *    path identical and only the inode different. Both are refused, because nothing under either is the
 *    directory that was approved.
 * 4. **The file that is read is the file that was checked.** Containment is decided on a path and the
 *    kernel opens whatever stands there when the call is made, so every read opens with `O_NOFOLLOW` and
 *    `fstat`s the descriptor it got: a descriptor that is not the file the path resolved to is refused
 *    rather than read.
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

/**
 * A root as it was approved: the directory, and the identity the kernel gave it at that moment.
 *
 * `dev` and `ino` are what `stat` reports for the directory itself rather than for its name, which is what
 * makes an in-place replacement detectable: `mv root root-away && mkdir root` (or a rename followed by a
 * recreate) leaves the name where it was while the directory behind it is a different one, and comparing
 * paths cannot tell the two apart.
 */
export interface ApprovedRoot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/** The roots a session may touch, canonicalised and identified, plus the ones refused and why. */
export interface CanonicalRoots {
  /** The approved directories, in approval order, canonical. */
  readonly roots: readonly string[];
  /** The same roots with the identity captured at approval, which every resolution re-checks. */
  readonly approved: readonly ApprovedRoot[];
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
  /**
   * Milliseconds one grep's matching may spend before its thread is terminated.
   *
   * A JavaScript regular expression is not a function of its input's length: `^(a+)+$` against a long line of
   * `a`s backtracks for longer than the process lives, and a synchronous `RegExp.test` cannot be interrupted by
   * a timer. The match runs in a thread this process can kill, and this is the clock that kills it.
   */
  maxGrepMatchMs: 5_000,
  /**
   * Milliseconds one find's name matching may spend before its thread is terminated.
   *
   * The same clock as a grep's, on the same kind of unbounded expression: `*?` repeated eleven times is eleven
   * `.*.` in a row once the glob is translated, and a name that does not end in the letter the pattern ends
   * with makes the engine try every way of splitting it. Tighter than a grep's because the work is smaller —
   * the names one traversal collected, not every line of every file under it.
   */
  maxFindMatchMs: 1_000,
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
  // `..` and the separator after it, not any name that merely begins with two dots: a directory called
  // `..dots` is inside the root, and a boundary that refuses more than it must gets routed around.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Canonicalise the approved roots.
 *
 * A root that cannot be canonicalised is not used and is reported by name: silently dropping one would
 * leave a session confined to something other than what was approved, and silently keeping an
 * unusable one would refuse every path for a reason nobody could find.
 */
export async function canonicalRoots(roots: readonly string[]): Promise<CanonicalRoots> {
  const approved: ApprovedRoot[] = [];
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
    // The identity is captured here, at the moment of approval, because this is the only moment at which
    // "the directory that was approved" is still unambiguously the directory at this path.
    // Deduplicated after canonicalisation, so `/root` and `/root/` and a symlink to `/root` are one root.
    if (!approved.some((entry) => entry.path === here)) {
      approved.push({ path: here, dev: info.dev, ino: info.ino });
    }
  }

  return { roots: approved.map((entry) => entry.path), approved, refused };
}

/**
 * Walk a path the way the platform resolves it, so that containment is checked on the real target.
 *
 * Once a component is genuinely absent, the walk stops resolving and the remaining segments are joined to the
 * canonical path reached so far: a path that names a file nobody created yet is still a legal path *inside*
 * the root, and the caller gets a truthful "not found" instead of a containment refusal. A `..` after such a
 * component is refused, because the platform would refuse it too — the missing component has to exist to be
 * climbed out of.
 *
 * A component `stat` cannot follow is looked at with `lstat` before it is called absent. A symlink whose
 * target does not exist is not a missing file: the platform would resolve the rest of the path against a
 * target that is not there, so those segments cannot be joined to this path and admitted as if they were
 * inside the root. The path is refused instead.
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
      const link = await lstat(candidate).catch(() => undefined);
      if (link?.isSymbolicLink() === true) {
        return {
          ok: false,
          reason: `"${candidate}" is a symlink whose target does not resolve, so the rest of this path is not a known path inside an approved root`,
        };
      }
      missing = segment;
      current = candidate;
      continue;
    }
    // Together: refuses a path that walks *through* a file, which the platform refuses as well.
    if (index < segments.length - 1 && !info.isDirectory()) {
      return { ok: false, reason: `"${candidate}" is not a directory, so nothing can be under it` };
    }
    // The component's canonical target, so a symlink is followed and the next segment is joined to
    // where it actually points rather than to its name. A canonicalisation that fails here is refused
    // rather than skipped: falling back to the un-canonicalised `candidate` would admit a path whose target
    // the platform would not confirm, which is the one answer this walk exists to never give.
    try {
      current = await realpath(candidate);
    } catch (cause) {
      return {
        ok: false,
        reason: `"${candidate}" could not be canonicalised (${describeCause(cause)}), so whether it is inside an approved root cannot be decided`,
      };
    }
  }

  return { ok: true, path: current };
}

/**
 * Resolve a candidate against the approved roots.
 *
 * `roots` are approved, as `canonicalRoots` produced them: canonical paths with the identity each had when it
 * was approved. A relative path is taken against the first approved root and never against the process
 * working directory: a working directory is a convenience the platform hands a process, not a boundary, and a
 * boundary that moved with `process.cwd()` would be no boundary at all.
 */
export async function resolveInsideRoots(
  roots: readonly ApprovedRoot[],
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
   * Two different things can stand in an approved path's place, and only the first is visible as a path: a
   * symlink or a mount changes what `realpath` answers, while a rename followed by a directory created at the
   * same name leaves the canonical path identical and only the inode different. Both are refused, because
   * nothing under either is the directory that was approved. This runs first rather than only when a candidate
   * matches, because the failure it catches is the root's, not the candidate's.
   */
  for (const root of roots) {
    let now: string;
    try {
      now = await realpath(root.path);
    } catch (cause) {
      return {
        ok: false,
        reason: `approved root "${root.path}" can no longer be resolved: ${describeCause(cause)}`,
      };
    }
    if (now !== root.path) {
      return {
        ok: false,
        reason: `approved root "${root.path}" now resolves to "${now}", so it is no longer the directory that was approved`,
      };
    }
    const info = await stat(root.path).catch(() => undefined);
    if (info === undefined) {
      return {
        ok: false,
        reason: `approved root "${root.path}" is no longer there, so no path under it can be admitted`,
      };
    }
    if (info.dev !== root.dev || info.ino !== root.ino) {
      return {
        ok: false,
        // No inode number in the message: the refusal is read by a model, and which directory stands there
        // is the whole of what it needs to know. The numbers stay in the approval record, where a human
        // debugging an outage can reach them.
        reason: `approved root "${root.path}" is a different directory than the one that was approved (its inode changed since approval), so no path under it can be admitted`,
      };
    }
  }

  const root = isAbsolute(asked) ? parse(asked).root : "";
  const relativeToRoot = root === "" ? asked : asked.slice(root.length);
  const walked = await walkPath(root === "" ? first.path : root, relativeToRoot.split(sep));
  if (!walked.ok) return walked;

  if (!roots.some((approved) => isWithin(approved.path, walked.path))) {
    return {
      ok: false,
      reason: `"${walked.path}" is outside every approved root (${roots.map((entry) => entry.path).join(", ")})`,
    };
  }

  return walked;
}

/** A file opened after its identity was verified, or why it was not opened. */
type VerifiedOpen =
  | { readonly ok: true; readonly handle: FileHandle; readonly size: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Open a file for reading, then check that the descriptor holds the file the path resolved to.
 *
 * `resolveInsideRoots` decides containment on a path, and the kernel opens whatever stands at that path when
 * the syscall is made, so a directory an attacker can write to is a window between the two. Two things close
 * it: `O_NOFOLLOW`, so a symlink planted at the resolved path is refused instead of followed, and an `fstat`
 * of the descriptor compared with a fresh canonicalisation of the same path, so a file swapped in after the
 * check is refused rather than read.
 */
async function openVerified(input: {
  roots: readonly ApprovedRoot[];
  path: string;
}): Promise<VerifiedOpen> {
  let handle: FileHandle;
  try {
    handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    const why =
      code === "ELOOP"
        ? "something put a symlink there after the path was checked, and a symlink is not followed"
        : describeCause(cause);
    return { ok: false, reason: `"${input.path}" could not be opened for reading: ${why}` };
  }

  const refuse = async (reason: string): Promise<VerifiedOpen> => {
    await handle.close().catch(() => undefined);
    return { ok: false, reason };
  };

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return await refuse(`"${input.path}" is not a regular file`);
    const checked = await resolveInsideRoots(input.roots, input.path);
    if (!checked.ok) return await refuse(`"${input.path}" was refused after it was opened: ${checked.reason}`);
    const atPath = await stat(checked.path).catch(() => undefined);
    if (atPath === undefined || atPath.dev !== opened.dev || atPath.ino !== opened.ino) {
      return await refuse(
        `"${input.path}" is not the file that was checked: something else stands at that path now`,
      );
    }
    return { ok: true, handle, size: opened.size };
  } catch (cause) {
    return await refuse(`"${input.path}" could not be verified after opening: ${describeCause(cause)}`);
  }
}

/** A tool result that carries text only, which is what every scoped tool answers with. */
function text(value: string): { text: string } {
  return { text: value };
}

/** The refusal every tool answers with, so a denial reads as a decision rather than as a crash. */
function refused(reason: string): { text: string } {
  return text(`refused: ${reason}`);
}

/** A pattern that could not be compiled, answered the same way wherever it was noticed. */
function invalidPattern(reason: string): { text: string } {
  return text(`invalid pattern: ${reason}`);
}

/**
 * Cut a body so that the header and the body together stay inside the per-tool output bound.
 *
 * The cut is labelled, because a file that looks whole and is not is what the bound exists to prevent. It is
 * also made between characters rather than between bytes: a byte cut can land inside a multi-byte character,
 * and the replacement character the decoder leaves behind re-encodes to three bytes, which puts an answer that
 * was cut to fit back over the bound it was cut for.
 */
function boundedBody(body: string, header: string): string {
  const room = SCOPED_FS_LIMITS.maxOutputBytes - Buffer.byteLength(header) - 1;
  if (Buffer.byteLength(body) <= room) return body;
  const note = `\n… truncated: the output bound of ${SCOPED_FS_LIMITS.maxOutputBytes} byte was reached`;
  const limit = Math.max(0, room - Buffer.byteLength(note));
  const kept: string[] = [];
  let bytes = 0;
  // Iterating a string visits whole code points, so the cut can only fall between characters.
  for (const character of body) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    kept.push(character);
    bytes += size;
  }
  return `${kept.join("")}${note}`;
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

/** Read at most `cap` bytes from an open handle, so a large file is never loaded to be trimmed afterwards. */
async function readBounded(
  handle: FileHandle,
  cap: number,
): Promise<{ bytes: Uint8Array; bytesRead: number }> {
  const buffer = new Uint8Array(cap);
  let bytesRead = 0;
  while (bytesRead < cap) {
    const { bytesRead: read } = await handle.read(buffer, bytesRead, cap - bytesRead, bytesRead);
    if (read <= 0) break;
    bytesRead += read;
  }
  return { bytes: buffer.subarray(0, bytesRead), bytesRead };
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
  roots: readonly ApprovedRoot[];
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
function readTool(roots: readonly ApprovedRoot[]): ToolDefinition {
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

      const opened = await openVerified({ roots, path: resolved.path });
      if (!opened.ok) return refused(opened.reason);
      try {
        /*
         * The output bound is the bound, for this tool as much as for a listing.
         *
         * `maxFileBytes` says how much of a file may be read; the answer is a header, a newline and the bytes,
         * so a read allowed to return `maxFileBytes` would return about four times `maxOutputBytes` of tool text
         * and spend a turn's context on one call. The smaller of the two bounds decides, and the header already
         * says which bytes were shown.
         */
        const requested = boundedNumber(
          params,
          "maxBytes",
          SCOPED_FS_LIMITS.maxFileBytes,
          SCOPED_FS_LIMITS.maxFileBytes,
        );
        const cap = Math.min(requested, SCOPED_FS_LIMITS.maxOutputBytes);
        const { bytes, bytesRead } = await readBounded(opened.handle, cap);
        const header =
          opened.size > bytesRead
            ? `${resolved.path} (${opened.size} byte; the first ${bytesRead} are shown)`
            : `${resolved.path} (${opened.size} byte)`;
        return text(`${header}\n${boundedBody(new TextDecoder().decode(bytes), header)}`);
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    },
  };
}

/** The grep tool: a regular expression over the files under one approved path. */
function grepTool(roots: readonly ApprovedRoot[]): ToolDefinition {
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
      /*
       * The pattern is checked here as well as in the matching thread, so an invalid one is reported even when
       * nothing is searched at all, and so the answer does not depend on there being a file to match against.
       * Compiling is not what can hang; matching is, and that only happens in the thread.
       */
      try {
        new RegExp(pattern);
      } catch (cause) {
        return invalidPattern(describeCause(cause));
      }

      const asked = textParam(params, "path") ?? roots[0]?.path ?? "";
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
      const searchNotes: string[] = [];
      let matched = 0;
      let cutAtMatches = false;
      const matcher = startPatternMatcher({
        kind: "regex",
        pattern,
        budgetMs: SCOPED_FS_LIMITS.maxGrepMatchMs,
      });
      try {
        for (const file of walked.files) {
          if (matched >= maxMatches) {
            cutAtMatches = true;
            break;
          }
          const opened = await openVerified({ roots, path: file.path });
          if (!opened.ok) {
            searchNotes.push(`${file.label}: not searched (${opened.reason})`);
            continue;
          }
          let fileLines: string[];
          try {
            if (opened.size > SCOPED_FS_LIMITS.maxFileBytes) {
              searchNotes.push(
                `${file.label}: larger than the ${SCOPED_FS_LIMITS.maxFileBytes} byte read bound, so it was not searched`,
              );
              continue;
            }
            const { bytes } = await readBounded(opened.handle, SCOPED_FS_LIMITS.maxFileBytes);
            fileLines = new TextDecoder().decode(bytes).split("\n");
          } finally {
            await opened.handle.close().catch(() => undefined);
          }

          const outcome = await matcher.match(fileLines);
          if (!outcome.ok) {
            if (outcome.kind === "invalid-pattern") return invalidPattern(outcome.reason);
            /*
             * A pattern that outran its budget ends the whole search rather than this file: the matches found so
             * far are a prefix of an answer nobody can trust, and handing them over would read as a complete one.
             */
            return refused(`${outcome.reason} (while matching "${file.label}")`);
          }
          for (const index of outcome.matches) {
            if (matched >= maxMatches) {
              cutAtMatches = true;
              break;
            }
            matched += 1;
            lines.push(`${file.label}:${index + 1}: ${(fileLines[index] ?? "").trim()}`);
          }
        }
      } finally {
        await matcher.dispose();
      }

      const notes = [
        ...walked.notes,
        ...searchNotes,
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
function findTool(roots: readonly ApprovedRoot[]): ToolDefinition {
  return {
    name: "clarkcant_find",
    label: "Find files inside the approved project roots",
    description:
      "Lists files under a path inside the approved project roots whose name matches a glob (`*` and `?`) or, when " +
      "the pattern has neither, contains it as a substring. Symlinks that leave the roots are not followed, and a " +
      "glob that cannot finish matching inside its wall-clock budget is refused rather than left to run.",
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
      const asked = textParam(params, "path") ?? roots[0]?.path ?? "";
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

      const names = walked.files.map((file) => file.label.split("/").pop() ?? "");
      let matched: readonly TraversedFile[];
      if (pattern === undefined) {
        matched = walked.files;
      } else if (!isGlobPattern(pattern)) {
        /*
         * A pattern with no wildcard is a substring, and `String.prototype.includes` has no backtracking to
         * run away with: its cost is its input's length and nothing else. Only a glob needs a thread, because
         * only a glob is translated into an expression whose match time is not bounded by the name it is
         * tested against.
         */
        matched = walked.files.filter((_file, index) => (names[index] ?? "").includes(pattern));
      } else {
        const matcher = startPatternMatcher({
          kind: "glob",
          pattern,
          budgetMs: SCOPED_FS_LIMITS.maxFindMatchMs,
        });
        try {
          const outcome = await matcher.match(names);
          if (!outcome.ok) {
            if (outcome.kind === "invalid-pattern") return invalidPattern(outcome.reason);
            // The matches found so far are a prefix of an answer nobody can trust, so a glob that outran its
            // clock ends the whole listing rather than being reported as the complete one.
            return refused(`${outcome.reason} (while matching the name "${pattern}")`);
          }
          matched = outcome.matches.flatMap((index) => {
            const file = walked.files[index];
            return file === undefined ? [] : [file];
          });
        } finally {
          await matcher.dispose();
        }
      }
      const matching = matched.map((file) => file.label).sort((left, right) => left.localeCompare(right));
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

/** Whether a pattern is a glob rather than a substring: only `*` and `?` are wildcards in this glob. */
function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** The ls tool: one directory, its entries, bounded. */
function lsTool(roots: readonly ApprovedRoot[]): ToolDefinition {
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
      const asked = textParam(params, "path") ?? roots[0]?.path ?? "";
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
 * `roots` are approved — `canonicalRoots` produced them, so each carries the identity the kernel gave the
 * directory when it was approved — because every call re-checks that identity, and an unapproved root is
 * refused by name rather than quietly accepted.
 */
export function createScopedFsTools(input: { roots: readonly ApprovedRoot[] }): ToolDefinition[] {
  const roots = [...input.roots];
  return [readTool(roots), grepTool(roots), findTool(roots), lsTool(roots)];
}
