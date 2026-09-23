/**
 * Worker tools.
 *
 * These are the tools a worker may register, each declaring the capability that gates it and
 * the evidence a successful call produces.
 *
 * `read_project_file` also closes the containment gap recorded in `@clarkcant/pi-adapter`'s
 * `prompt`: the SDK resolves its own paths, so root containment has to be applied by wrapping
 * the operation rather than by inspecting the model's arguments afterwards. A worker that
 * refuses to read outside its approved roots is that wrapper.
 *
 * Containment is delegated to `@clarkcant/pi-adapter`'s `scoped-fs` primitive rather than
 * reimplemented here: that module canonicalises both the root and the candidate with
 * `fs.realpath` and walks the path component by component, so a symlink inside an approved
 * root cannot resolve to a target outside it. A lexical `path.relative` comparison, which this
 * module used before, cannot see through a symlink and would admit that escape.
 */

import { readFile } from "node:fs/promises";

import { canonicalRoots, resolveInsideRoots, type ApprovedRoot } from "@clarkcant/pi-adapter";

import type { WorkerTool } from "./index.ts";

/** Capability ref granted when the user allows the worker to read files in the project. */
export const CAPABILITY_PROJECT_READ = "capability:project.read";

export const READ_PROJECT_FILE_TOOL = "read_project_file";
export const LIST_PROJECT_FILES_TOOL = "list_project_files";

const MAX_READ_BYTES = 64 * 1024;

/**
 * Canonicalise `projectRoots` once per worker run and cache the result.
 *
 * `canonicalRoots` is async (it calls `fs.realpath`/`fs.stat`), so the roots cannot be resolved
 * at tool-construction time; every tool built by `createFileTools` shares one lazily-resolved
 * promise instead of re-canonicalising the same roots on every call. A root that cannot be
 * approved is refused by name, the same as the project-session lane.
 */
function approvedRootsOf(projectRoots: readonly string[]): () => Promise<readonly ApprovedRoot[]> {
  let cached: Promise<readonly ApprovedRoot[]> | undefined;
  return async () => {
    cached ??= canonicalRoots(projectRoots).then((result) => {
      if (result.refused.length > 0) {
        throw new Error(
          `refused: ${result.refused.map((entry) => `${entry.root} (${entry.reason})`).join("; ")}`,
        );
      }
      if (result.approved.length === 0) {
        throw new Error("refused: no approved project root is in force, so no path can be allowed");
      }
      return result.approved;
    });
    return cached;
  };
}

/** Resolve a candidate against the approved roots, or throw the refusal as an `Error`. */
async function resolveWithinRoots(
  candidate: string,
  getRoots: () => Promise<readonly ApprovedRoot[]>,
): Promise<string> {
  const roots = await getRoots();
  const resolved = await resolveInsideRoots(roots, candidate);
  if (!resolved.ok) throw new Error(`refused: ${resolved.reason}`);
  return resolved.path;
}

function stringParameter(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`parameter "${name}" must be a non-empty string`);
  }
  return value;
}

/**
 * The file tools, bound to the roots the brief approved.
 *
 * Built per run rather than module-level, because the roots are part of the brief and a shared
 * module-level tool would carry one run's roots into another's.
 */
export function createFileTools(projectRoots: readonly string[]): WorkerTool[] {
  const getRoots = approvedRootsOf(projectRoots);
  return [
    {
      name: READ_PROJECT_FILE_TOOL,
      label: "Read project file",
      description: "Read a text file from inside the approved project roots.",
      capabilityRef: CAPABILITY_PROJECT_READ,
      // The file's contents at a known version: the kind of evidence that can be re-checked.
      proves: "file-version",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to read, inside an approved root." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(params: Record<string, unknown>) {
        const target = await resolveWithinRoots(stringParameter(params, "path"), getRoots);
        const contents = await readFile(target, "utf8");
        // Bounded so one large file cannot consume the run's whole context. The truncation is
        // stated in the output rather than applied silently.
        const exceeded = contents.length > MAX_READ_BYTES;
        const body = exceeded ? contents.slice(0, MAX_READ_BYTES) : contents;
        const note = exceeded
          ? ` [truncated to ${MAX_READ_BYTES} of ${contents.length} characters]`
          : "";
        return { text: `read ${target} (${contents.length} characters)${note}\n${body}` };
      },
    },
    {
      name: LIST_PROJECT_FILES_TOOL,
      label: "List project files",
      description: "List the file names in one directory inside the approved project roots.",
      capabilityRef: CAPABILITY_PROJECT_READ,
      proves: "file-version",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list, inside an approved root." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(params: Record<string, unknown>) {
        const target = await resolveWithinRoots(stringParameter(params, "path"), getRoots);
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(target, { withFileTypes: true });
        const names = entries.map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`);
        return { text: `${target} contains ${names.length} entries\n${names.join("\n")}` };
      },
    },
  ];
}

/** Every tool this worker can offer, before the brief narrows the set. */
export function allWorkerTools(projectRoots: readonly string[]): WorkerTool[] {
  return createFileTools(projectRoots);
}
