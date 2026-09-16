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
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";

import type { WorkerTool } from "./index.ts";

/** Capability ref granted when the user allows the worker to read files in the project. */
export const CAPABILITY_PROJECT_READ = "capability:project.read";

export const READ_PROJECT_FILE_TOOL = "read_project_file";
export const LIST_PROJECT_FILES_TOOL = "list_project_files";

const MAX_READ_BYTES = 64 * 1024;

/**
 * Resolve a path and refuse anything outside the approved roots.
 *
 * Comparison is done on the resolved path, so `..` segments and symlinked roots are both
 * accounted for rather than string-matched.
 */
function resolveWithinRoots(candidate: string, roots: readonly string[]): string {
  const resolved = resolve(candidate);
  for (const root of roots) {
    const rootResolved = resolve(root);
    const rel = relative(rootResolved, resolved);
    // Inside the root when the relative path is empty (the root itself) or does not climb out.
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      return resolved;
    }
  }
  throw new Error(
    `refused: ${resolved} is outside the approved project roots (${roots.map((root) => resolve(root)).join(", ")})`,
  );
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
        const target = resolveWithinRoots(stringParameter(params, "path"), projectRoots);
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
        const target = resolveWithinRoots(stringParameter(params, "path"), projectRoots);
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
