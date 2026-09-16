import {
  type CapabilityDescriptor,
  type CapabilityReadiness,
  type CapabilityRef,
  type Instant,
  capabilityDescriptorSchema,
  capabilityRefSchema,
  isUsable,
} from "@clarkcant/contracts";

import { type Database, allRows, oneRow, parseJson, toJson } from "@clarkcant/storage";

/**
 * Capability registry.
 *
 * A capability is anything the system can invoke: an API adapter, an MCP tool, a
 * Pi skill, a native driver, or a UI facet. The registry exists mainly to keep two
 * facts separate that are usually conflated:
 *
 * - what is installed (bytes on disk)
 * - what is actually usable (loaded, authenticated, authorized, healthy)
 *
 * "Cài package xong" and "integration dùng được" are different states, and every
 * consumer here asks for the second.
 */

export interface RegistryDeps {
  db: Database;
  nodeId: string;
}

export function registerCapability(deps: RegistryDeps, descriptor: CapabilityDescriptor): CapabilityDescriptor {
  const parsed = capabilityDescriptorSchema.parse(descriptor);
  upsert(deps, parsed);
  return parsed;
}

function upsert(deps: RegistryDeps, descriptor: CapabilityDescriptor): void {
  deps.db
    .prepare(
      `INSERT INTO capabilities
         (capability_ref, execution_node_id, package_generation, readiness, effect_category, summary, document, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(capability_ref, execution_node_id) DO UPDATE SET
         package_generation = excluded.package_generation,
         readiness = excluded.readiness,
         effect_category = excluded.effect_category,
         summary = excluded.summary,
         document = excluded.document,
         updated_at = excluded.updated_at`,
    )
    .run(
      descriptor.ref,
      descriptor.executionNodeId,
      descriptor.providedBy?.generation ?? null,
      toJson(descriptor.readiness),
      descriptor.effectCategory,
      descriptor.summary,
      toJson(descriptor),
      new Date().toISOString(),
    );
}

export function getCapability(
  deps: RegistryDeps,
  ref: CapabilityRef,
  executionNodeId?: string,
): CapabilityDescriptor | undefined {
  const row = executionNodeId
    ? oneRow<{ document: string }>(
        deps.db,
        "SELECT document FROM capabilities WHERE capability_ref = ? AND execution_node_id = ?",
        ref,
        executionNodeId,
      )
    : oneRow<{ document: string }>(
        deps.db,
        "SELECT document FROM capabilities WHERE capability_ref = ? ORDER BY execution_node_id LIMIT 1",
        ref,
      );
  return row === undefined ? undefined : parseJson<CapabilityDescriptor>(row.document, "capabilities.document");
}

/**
 * Capability summaries for the conductor.
 *
 * Deliberately summary-only: dumping every tool's full schema into every model
 * turn is both expensive and a prompt-injection surface, and the blueprint
 * requires schemas to be loaded lazily once a capability is actually chosen.
 */
export interface CapabilitySummary {
  ref: CapabilityRef;
  summary: string;
  executionNodeId: string;
  usable: boolean;
  blockedReason: string | undefined;
  effectCategory: CapabilityDescriptor["effectCategory"];
}

export function listCapabilitySummaries(
  deps: RegistryDeps,
  options: { usableOnly?: boolean; limit?: number } = {},
): CapabilitySummary[] {
  const rows = allRows<{ capability_ref: string; execution_node_id: string; readiness: string; summary: string; document: string }>(
    deps.db,
    "SELECT capability_ref, execution_node_id, readiness, summary, document FROM capabilities ORDER BY capability_ref LIMIT ?",
    options.limit ?? 200,
  );

  const summaries = rows.map((row) => {
    const readiness = parseJson<CapabilityReadiness>(row.readiness, "capabilities.readiness");
    const descriptor = parseJson<CapabilityDescriptor>(row.document, "capabilities.document");
    return {
      ref: capabilityRefSchema.parse(row.capability_ref),
      summary: row.summary,
      executionNodeId: row.execution_node_id,
      usable: isUsable(readiness),
      blockedReason: readiness.blockedReason,
      effectCategory: descriptor.effectCategory,
    };
  });

  return options.usableOnly ? summaries.filter((summary) => summary.usable) : summaries;
}

/** Load the full schema for one capability, once it has been chosen. */
export function loadCapabilitySchema(
  deps: RegistryDeps,
  ref: CapabilityRef,
  executionNodeId?: string,
): { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; effectCategory: string } | undefined {
  const descriptor = getCapability(deps, ref, executionNodeId);
  if (!descriptor) return undefined;
  return {
    inputSchema: descriptor.inputSchema ?? { type: "object", properties: {} },
    outputSchema: descriptor.outputSchema ?? { type: "object", properties: {} },
    effectCategory: descriptor.effectCategory,
  };
}

/**
 * Readiness transitions are monotonic in one respect: once a probe fails, the
 * capability stops being reported as usable immediately, even if the failure came
 * from a background check. Showing a stale "connected" is worse than showing
 * degraded.
 */
export function updateReadiness(
  deps: RegistryDeps,
  input: {
    ref: CapabilityRef;
    executionNodeId: string;
    change: Partial<CapabilityReadiness>;
    at: Instant;
  },
): CapabilityDescriptor {
  const existing = getCapability(deps, input.ref, input.executionNodeId);
  if (!existing) {
    throw new Error(`capability ${input.ref} is not registered on ${input.executionNodeId}`);
  }
  const readiness: CapabilityReadiness = {
    ...existing.readiness,
    ...input.change,
    lastProbeAt: input.change.lastProbeAt ?? input.at,
  };
  // A newly failed probe clears healthy rather than leaving a stale pass behind.
  if (input.change.healthy === false && input.change.blockedReason === undefined) {
    readiness.blockedReason = "the most recent readiness probe failed";
  }
  const next: CapabilityDescriptor = { ...existing, readiness };
  upsert(deps, next);
  return next;
}

/**
 * Resolve which node should actually run a capability.
 *
 * Placement is not "pick the node with spare CPU". Credentials, resources, OS
 * drivers, connected accounts and locality all narrow the answer, and a capability
 * that exists on the wrong node is not a valid answer to the user's request.
 */
export function resolveExecutionNode(
  deps: RegistryDeps,
  input: { ref: CapabilityRef; requiresConnection?: boolean; preferNodeIds?: readonly string[] },
): { nodeId: string; rationale: string } | { nodeId: undefined; reason: string } {
  const rows = allRows<{ execution_node_id: string; readiness: string; document: string }>(
    deps.db,
    "SELECT execution_node_id, readiness, document FROM capabilities WHERE capability_ref = ?",
    input.ref,
  );

  if (rows.length === 0) {
    return { nodeId: undefined, reason: `no installation provides ${input.ref}` };
  }

  const candidates = rows
    .map((row) => ({
      nodeId: row.execution_node_id,
      readiness: parseJson<CapabilityReadiness>(row.readiness, "capabilities.readiness"),
      descriptor: parseJson<CapabilityDescriptor>(row.document, "capabilities.document"),
    }))
    .filter((candidate) => isUsable(candidate.readiness));

  if (candidates.length === 0) {
    const reasons = rows
      .map((row) => {
        const readiness = parseJson<CapabilityReadiness>(row.readiness, "capabilities.readiness");
        return `${row.execution_node_id}: ${readiness.blockedReason ?? "not usable"}`;
      })
      .join("; ");
    return { nodeId: undefined, reason: reasons };
  }

  // Credentials do not travel, so a capability that needs a connection must run
  // where the connection lives.
  const withConnection = input.requiresConnection
    ? candidates.filter((candidate) => candidate.descriptor.requiresConnection)
    : candidates;

  const pool = withConnection.length > 0 ? withConnection : candidates;

  if (input.preferNodeIds && input.preferNodeIds.length > 0) {
    const preferred = pool.find((candidate) => input.preferNodeIds?.includes(candidate.nodeId));
    if (preferred) {
      return {
        nodeId: preferred.nodeId,
        rationale: `preferred node ${preferred.nodeId} has a usable ${input.ref}`,
      };
    }
  }

  const chosen = pool[0]!;
  return {
    nodeId: chosen.nodeId,
    rationale: `node ${chosen.nodeId} has a usable ${input.ref}; no locality preference applied`,
  };
}

/**
 * Whether a capability can be invoked without first going through a setup flow.
 *
 * Returned as a discriminated result rather than a boolean because the UI needs to
 * say *which* prerequisite is missing, and "not ready" alone would push the user
 * into a guess (acceptance test T29).
 */
export function invocationPreflight(
  deps: RegistryDeps,
  ref: CapabilityRef,
): { ready: true } | { ready: false; code: "CAPABILITY_MISSING" | "CAPABILITY_NOT_READY" | "CAPABILITY_NOT_AUTHENTICATED"; message: string } {
  const descriptor = getCapability(deps, ref);
  if (!descriptor) {
    return {
      ready: false,
      code: "CAPABILITY_MISSING",
      message: `capability ${ref} is not registered; it may need to be installed`,
    };
  }
  const { readiness } = descriptor;
  if (!readiness.installed || !readiness.loaded) {
    return {
      ready: false,
      code: "CAPABILITY_NOT_READY",
      message: readiness.blockedReason ?? `${ref} is not loaded yet`,
    };
  }
  if (!readiness.authenticated) {
    return {
      ready: false,
      code: "CAPABILITY_NOT_AUTHENTICATED",
      message: `${ref} needs a connection before it can run`,
    };
  }
  if (!readiness.authorized || !readiness.healthy) {
    return {
      ready: false,
      code: "CAPABILITY_NOT_READY",
      message: readiness.blockedReason ?? `${ref} failed its last readiness probe`,
    };
  }
  return { ready: true };
}
