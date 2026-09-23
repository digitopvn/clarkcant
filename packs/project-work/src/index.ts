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

export const CAPABILITIES = [READ_FILE_QUESTION, CONTROLLED_CODE_TASK];

/**
 * @status-ref pack.project-work
 * TODO(P2): the tool implementations behind these descriptors. The capability
 * descriptors, their effect classification and their schemas are real and are what
 * the policy layer and the UI consume; the functions that actually read a file or
 * apply a patch are supplied by the worker host at run time.
 */
export * from "./worktree.ts";

export const EXECUTION_STATUS = "descriptors-real-implementations-supplied-by-worker";
