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

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalRoots, resolveInsideRoots, type ApprovedRoot } from "@clarkcant/pi-adapter";

import type { WorkerTool } from "./index.ts";

/**
 * Capability refs granted to this worker, matching the refs `packs/project-work` declares
 * (`project.file.read@1`, `project.code.change@1`) — the tool's `capabilityRef` is checked against
 * `WorkerBriefEnvelope.allowedCapabilityRefs` in `index.ts`'s `runWorker`, so a tool whose ref does
 * not match the pack's own descriptor is never registered even when the pack's capability was
 * granted. These constants exist so the two sides cannot drift silently.
 */
export const CAPABILITY_PROJECT_READ = "project.file.read@1";
export const CAPABILITY_PROJECT_CODE_CHANGE = "project.code.change@1";

export const READ_PROJECT_FILE_TOOL = "read_project_file";
export const LIST_PROJECT_FILES_TOOL = "list_project_files";
export const WRITE_PROJECT_FILE_TOOL = "write_project_file";

const MAX_READ_BYTES = 64 * 1024;
/** A single call cannot write more than this many characters, so one call cannot flood the run's evidence. */
const MAX_WRITE_CHARS = 64 * 1024;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

function stringParameter(
  params: Record<string, unknown>,
  name: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = params[name];
  if (typeof value !== "string" || (value.length === 0 && !options.allowEmpty)) {
    throw new Error(`parameter "${name}" must be a ${options.allowEmpty ? "" : "non-empty "}string`);
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

/**
 * The code-change tool, bound to the roots the brief approved.
 *
 * `project.code.change@1`'s `effectCategory` is `local-write` (`packs/project-work/src/index.ts`),
 * which is exactly the category the runtime's execution policy gates before a task carrying this
 * capability is ever dispatched — `apps/runtime/src/task-dispatch.ts`'s `runOne` reads the
 * capability's `effectCategory` from the registry and runs `decideExecution` before the worker that
 * calls this tool is even started, and (under Guarded, the default) an ungranted approval stops the
 * dispatch before a worker process exists at all. This tool cannot repeat that decision — it runs in
 * a separate process with no database connection — so what it owns is the part only the process that
 * touches the filesystem can own: containment to the approved roots, and evidence that names exactly
 * what changed, so the dispatcher's `file-diff` evidence is not merely "the tool returned success".
 */
export function createCodeChangeTools(projectRoots: readonly string[]): WorkerTool[] {
  const getRoots = approvedRootsOf(projectRoots);
  return [
    {
      name: WRITE_PROJECT_FILE_TOOL,
      label: "Write project file",
      description:
        "Overwrite a text file inside an approved project root with new contents. Creates the file " +
        "(and any missing parent directories inside the root) if it does not already exist.",
      capabilityRef: CAPABILITY_PROJECT_CODE_CHANGE,
      // A before/after digest pair over a confined path: re-checkable by reading the file back, which
      // is exactly what `read-after-write` evidence promises.
      proves: "read-after-write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write, inside an approved root." },
          contents: { type: "string", description: "The file's new, complete contents." },
        },
        required: ["path", "contents"],
        additionalProperties: false,
      },
      async execute(params: Record<string, unknown>) {
        const contents = stringParameter(params, "contents", { allowEmpty: true });
        if (contents.length > MAX_WRITE_CHARS) {
          throw new Error(`refused: contents exceed the ${MAX_WRITE_CHARS}-character limit for one write`);
        }
        const target = await resolveWithinRoots(stringParameter(params, "path"), getRoots);
        const before = await readFile(target, "utf8").then(
          (text) => ({ existed: true, digest: sha256(text) }),
          () => ({ existed: false, digest: undefined as string | undefined }),
        );
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents, "utf8");
        const after = sha256(contents);
        const verb = before.existed ? "overwrote" : "created";
        return {
          text:
            `${verb} ${target} (${contents.length} characters)\n` +
            `before: ${before.digest ?? "absent"}\n` +
            `after: ${after}`,
        };
      },
    },
  ];
}

/** Every tool this worker can offer, before the brief narrows the set. */
export function allWorkerTools(projectRoots: readonly string[]): WorkerTool[] {
  return [...createFileTools(projectRoots), ...createCodeChangeTools(projectRoots)];
}
