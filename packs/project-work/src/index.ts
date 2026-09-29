import type { CapabilityDescriptor } from "@clarkcant/contracts";

/**
 * Project work pack.
 *
 * The vertical slice the P2 gate is built on: answer a question about a file, then
 * make a controlled change in a fixture workspace and prove it with evidence. It is
 * deliberately the smallest pack that exercises the whole path — capability
 * discovery, policy, a worker run, evidence, and a result surface.
 */

const NODE = "node_placeholder" as CapabilityDescriptor["executionNodeId"];

function descriptor(
  input: Omit<CapabilityDescriptor, "executionNodeId" | "readiness"> & {
    nodeId?: CapabilityDescriptor["executionNodeId"];
  },
): CapabilityDescriptor {
  return {
    ...input,
    executionNodeId: input.nodeId ?? NODE,
    readiness: {
      installed: true,
      loaded: true,
      authenticated: true,
      authorized: true,
      healthy: true,
    },
  };
}

/**
 * A read-only question about a project file.
 *
 * Read-only and closed-world, so it needs no approval. Everything that writes does.
 */
export const READ_FILE_QUESTION = descriptor({
  ref: "project.file.read@1" as CapabilityDescriptor["ref"],
  summary: "Answer a question about a file inside an approved project root",
  resourceKinds: ["workspace", "folder", "file"],
  effectCategory: "read",
  supportsCancellation: true,
  requiresConnection: false,
  uiAffordances: ["shows-evidence", "shows-file-diff"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string", maxLength: 2000 },
      rootResourceId: { type: "string" },
    },
    required: ["question", "rootResourceId"],
  },
});

/**
 * A controlled code change in a fixture workspace.
 *
 * Carries `local-write`, so the host requires an approval bound to the operation
 * digest. The pack cannot approve its own effect: `requestedCapabilities` is a
 * request, and the approval comes from a user principal.
 */
export const CONTROLLED_CODE_TASK = descriptor({
  ref: "project.code.change@1" as CapabilityDescriptor["ref"],
  summary: "Apply a bounded code change inside an approved workspace and report a diff",
  resourceKinds: ["workspace", "git-worktree", "file"],
  effectCategory: "local-write",
  supportsCancellation: true,
  requiresConnection: false,
  uiAffordances: ["shows-file-diff", "shows-evidence", "offers-follow-up"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      instruction: { type: "string", maxLength: 4000 },
      rootResourceId: { type: "string" },
      expectedFiles: { type: "array", items: { type: "string" } },
    },
    required: ["instruction", "rootResourceId"],
  },
});

/**
 * One command a worker runs inside the task's own folders.
 *
 * Declared so a worker can be granted it, never run by the worker itself: the worker hands the command to the host,
 * which runs the same preflight, policy, judgment layer, secret injection and audit a command from the conversation
 * goes through. Its effect category is the least a command can be; the host classifies each command it is handed and
 * decides on that, so `git push` is judged as the external write it is.
 */
export const RUN_PROJECT_COMMAND = descriptor({
  ref: "project.command.run@1" as CapabilityDescriptor["ref"],
  summary: "Run one command inside the task's own folder, through the host's command path",
  resourceKinds: ["workspace", "git-worktree", "folder"],
  effectCategory: "local-write",
  supportsCancellation: true,
  requiresConnection: false,
  uiAffordances: ["shows-evidence"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string", maxLength: 4000 },
      cwd: { type: "string" },
    },
    required: ["command"],
  },
});

export const CAPABILITIES = [READ_FILE_QUESTION, CONTROLLED_CODE_TASK, RUN_PROJECT_COMMAND];

/**
 * What a worker is given when a task is dispatched for one of this pack's capabilities.
 *
 * A code change that cannot read the code it changes, or run its tests, is not a code change; so granting it grants
 * the two it cannot work without. A read-only question is given reading and nothing else. The host still decides
 * every write and every command on its own; this only says which tools the worker is offered.
 */
export function workerCapabilitiesFor(ref: string): readonly string[] {
  switch (ref) {
    case CONTROLLED_CODE_TASK.ref:
      return [CONTROLLED_CODE_TASK.ref, READ_FILE_QUESTION.ref, RUN_PROJECT_COMMAND.ref];
    default:
      return [ref];
  }
}

/**
 * @status-ref pack.project-work
 *
 * The capability descriptors, their effect classification and their schemas are real and are what
 * the policy layer and the UI consume. The functions that actually read a file or apply a patch are
 * supplied by the worker host at run time — `apps/worker/src/tools.ts`'s `read_project_file` /
 * `list_project_files` / `write_project_file`, registered under exactly these refs and gated by the
 * execution policy at dispatch time in `apps/runtime/src/task-dispatch.ts` — rather than by this
 * package, which only declares what a worker is allowed to be granted.
 */
export * from "./managed-worktree.ts";
export * from "./worktree.ts";

export const EXECUTION_STATUS = "descriptors-real-implementations-supplied-by-worker";
