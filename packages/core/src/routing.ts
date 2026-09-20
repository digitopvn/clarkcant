import type { CapabilityDescriptor, OperatingSystem } from "@clarkcant/contracts";

/**
 * Task-to-node routing.
 *
 * The rule the blueprint is emphatic about: placement is not "send it wherever
 * there is capacity". Locality, credentials, allowed operations, OS drivers and
 * active leases all constrain the answer, and "sửa ứng dụng trên máy này" must not
 * be forwarded to a VPS just because the network is fast.
 */

export interface RoutingCandidate {
  nodeId: string;
  /** Capabilities this node can actually run right now. */
  usableCapabilityRefs: readonly string[];
  /** Credential-bound capabilities, which cannot move without a re-auth. */
  connectionBoundCapabilityRefs: readonly string[];
  operatingSystem: OperatingSystem;
  /** Resource kinds present locally, e.g. `workspace`. */
  localResourceKinds: readonly string[];
  /** True when the node is currently reachable. */
  online: boolean;
  /** Resources already leased, so two writers are never chosen. */
  leasedResourceIds: readonly string[];
  activeRunCount: number;
  maxConcurrentRuns: number;
}

export interface RoutingRequest {
  requiredCapabilityRefs: readonly string[];
  /** Resources the task must be able to touch, by node. */
  requiredResources: readonly { nodeId: string; resourceId: string; kind: string }[];
  /** Capabilities whose credentials must not be copied to another node. */
  connectionBoundCapabilityRefs: readonly string[];
  /** When set, the task may not leave this node (user said "don't send this out"). */
  pinnedNodeId?: string;
}

export type RoutingDecision =
  | { ok: true; nodeId: string; rationale: string }
  | { ok: false; code: "NO_ELIGIBLE_NODE" | "RESOURCE_LOCALITY_CONFLICT"; message: string };

/**
 * Choose an execution node.
 *
 * Eligibility is computed first and preference only breaks ties. Doing it the
 * other way round — scoring everything and picking the highest — is how a task
 * ends up on a node that cannot satisfy its credentials.
 */
export function routeTask(request: RoutingRequest, candidates: readonly RoutingCandidate[]): RoutingDecision {
  const pool = request.pinnedNodeId
    ? candidates.filter((candidate) => candidate.nodeId === request.pinnedNodeId)
    : candidates;

  if (pool.length === 0) {
    return {
      ok: false,
      code: "NO_ELIGIBLE_NODE",
      message: request.pinnedNodeId
        ? `the task is pinned to node ${request.pinnedNodeId}, which is not a known node`
        : "no nodes are registered",
    };
  }

  const reasons: string[] = [];
  const eligible = pool.filter((candidate) => {
    if (!candidate.online) {
      reasons.push(`${candidate.nodeId}: offline`);
      return false;
    }
    const missing = request.requiredCapabilityRefs.filter(
      (ref) => !candidate.usableCapabilityRefs.includes(ref),
    );
    if (missing.length > 0) {
      reasons.push(`${candidate.nodeId}: missing usable ${missing.join(", ")}`);
      return false;
    }
    const boundButNotLocal = request.connectionBoundCapabilityRefs.filter(
      (ref) =>
        candidate.usableCapabilityRefs.includes(ref) === false ||
        !candidate.connectionBoundCapabilityRefs.includes(ref),
    );
    if (boundButNotLocal.length > 0) {
      reasons.push(
        `${candidate.nodeId}: credentials for ${boundButNotLocal.join(", ")} live on another node and are not copied`,
      );
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return {
      ok: false,
      code: "NO_ELIGIBLE_NODE",
      message: `no node can satisfy this task. ${reasons.join("; ")}`,
    };
  }

  // Resource locality is a hard constraint, not a preference: a file that only
  // exists on one node cannot be worked on from another without an explicit transfer.
  if (request.requiredResources.length > 0) {
    const resourceNodes = new Set(request.requiredResources.map((resource) => resource.nodeId));
    if (resourceNodes.size > 1) {
      return {
        ok: false,
        code: "RESOURCE_LOCALITY_CONFLICT",
        message: `the task references resources on multiple nodes (${[...resourceNodes].join(", ")}); split it or transfer the data explicitly`,
      };
    }
    const [resourceNode] = [...resourceNodes];
    const match = eligible.find((candidate) => candidate.nodeId === resourceNode);
    if (match) {
      const leased = request.requiredResources.find((resource) =>
        match.leasedResourceIds.includes(resource.resourceId),
      );
      if (leased) {
        return {
          ok: false,
          code: "RESOURCE_LOCALITY_CONFLICT",
          message: `resource ${leased.resourceId} is already leased on ${match.nodeId}; wait for the current writer to finish`,
        };
      }
      return {
        ok: true,
        nodeId: match.nodeId,
        rationale: `resource locality: ${request.requiredResources.map((r) => r.resourceId).join(", ")} exist on ${match.nodeId}`,
      };
    }
    return {
      ok: false,
      code: "RESOURCE_LOCALITY_CONFLICT",
      message: `the required resources live on ${String(resourceNode)}, which cannot run the task`,
    };
  }

  const withCapacity = eligible.filter(
    (candidate) => candidate.activeRunCount < candidate.maxConcurrentRuns,
  );
  const pool2 = withCapacity.length > 0 ? withCapacity : eligible;
  const chosen = pool2.reduce((best, candidate) =>
    candidate.activeRunCount < best.activeRunCount ? candidate : best,
  );

  return {
    ok: true,
    nodeId: chosen.nodeId,
    rationale:
      withCapacity.length > 0
        ? `node ${chosen.nodeId} can satisfy every required capability and has ${chosen.maxConcurrentRuns - chosen.activeRunCount} free worker slot(s)`
        : `node ${chosen.nodeId} can satisfy every required capability, though all nodes are at capacity`,
  };
}

/**
 * Whether a capability must stay where its credentials are.
 *
 * Connections are owned by one node and their tokens are not replicated, so any
 * capability backed by a connection is implicitly bound to that node.
 */
export function connectionBoundRefs(descriptors: readonly CapabilityDescriptor[]): string[] {
  return descriptors.filter((descriptor) => descriptor.requiresConnection).map((d) => d.ref);
}

/**
 * Ambiguity check before a write.
 *
 * If a request could mean two different projects, the blueprint requires exactly
 * one clarifying question rather than a guess followed by an apology
 * (acceptance test T19).
 */
export function disambiguate(
  candidates: readonly { id: string; label: string }[],
  /** A decider's answer, when one already chose. Honoured only if it names a candidate. */
  chosen?: string,
): { resolved: true; id: string } | { resolved: false; question: string; options: string[] } {
  if (chosen !== undefined) {
    const match = candidates.find((candidate) => candidate.id === chosen);
    if (match !== undefined) return { resolved: true, id: match.id };
  }
  if (candidates.length === 1) return { resolved: true, id: candidates[0]!.id };
  if (candidates.length === 0) {
    return {
      resolved: false,
      question: "Which project should this apply to? None is registered yet.",
      options: [],
    };
  }
  return {
    resolved: false,
    question: `Which one did you mean? ${candidates.length} projects match.`,
    options: candidates.slice(0, 5).map((candidate) => candidate.label),
  };
}
