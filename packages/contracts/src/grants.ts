import { z } from "zod";

import { effectCategorySchema, instantSchema, type EffectCategory } from "./primitives.ts";

/**
 * Authority model.
 *
 * The rule the whole protocol rests on: the identity of a caller comes from the
 * authenticated transport, never from a field inside the payload. `Principal`
 * is therefore built by the gateway after authentication, and no command schema
 * accepts a caller-supplied principal.
 */

export const principalKindSchema = z.enum([
  "user",
  "client",
  "peer-node",
  "pack",
  "conductor",
  "worker",
]);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

export const principalSchema = z.strictObject({
  principalId: z.string().min(1).max(128),
  kind: principalKindSchema,
  /** Node whose policy evaluates this principal. */
  nodeId: z.string().min(1).max(128),
  /** For `peer-node` principals: verified peer identity plus delegated origin. */
  peer: z
    .strictObject({
      senderNodeId: z.string().min(1).max(128),
      delegatedOriginUserId: z.string().min(1).max(128).optional(),
      delegationId: z.string().min(1).max(128).optional(),
      delegationDepth: z.int().nonnegative().max(8),
    })
    .optional(),
  /** For `pack` principals: the package generation that granted the identity. */
  packageGeneration: z.string().min(1).max(200).optional(),
});
export type Principal = z.infer<typeof principalSchema>;

/**
 * Capability identifiers use the form `namespace.name@major`.
 *
 * The major version is part of the identity so that a peer cannot satisfy a
 * request by silently substituting a semantically different implementation
 * (`distributed-runtime.md` §11: negotiate or become unavailable).
 */
export const capabilityRefSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+@\d+$/, {
    error: "must look like namespace.name@1",
  });
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;

export function capabilityRef(namespaceDotName: string, major: number): CapabilityRef {
  return capabilityRefSchema.parse(`${namespaceDotName}@${major}`);
}

export function splitCapabilityRef(ref: CapabilityRef): { name: string; major: number } {
  const at = ref.lastIndexOf("@");
  return {
    name: ref.slice(0, at),
    major: Number.parseInt(ref.slice(at + 1), 10),
  };
}

/**
 * Readiness is a product of four independent booleans, not one status string.
 *
 * `installed` (bytes on disk), `loaded` (facet initialised), `authenticated`
 * (a usable credential exists for the bound account) and `healthy` (a probe
 * succeeded) fail independently. Collapsing them into one flag is precisely the
 * bug behind "cài package xong" being read as "integration dùng được".
 */
export const capabilityReadinessSchema = z.strictObject({
  installed: z.boolean(),
  loaded: z.boolean(),
  authenticated: z.boolean(),
  authorized: z.boolean(),
  healthy: z.boolean(),
  /** Set when the capability cannot be used and say why, for the UI. */
  blockedReason: z.string().min(1).max(500).optional(),
  lastProbeAt: instantSchema.optional(),
});
export type CapabilityReadiness = z.infer<typeof capabilityReadinessSchema>;

export function isUsable(readiness: CapabilityReadiness): boolean {
  return (
    readiness.installed &&
    readiness.loaded &&
    readiness.authenticated &&
    readiness.authorized &&
    readiness.healthy
  );
}

export const capabilityDescriptorSchema = z.strictObject({
  ref: capabilityRefSchema,
  /** Package that provides this capability, if any. */
  providedBy: z
    .strictObject({
      packageId: z.string().min(1).max(160),
      version: z.string().min(1).max(80),
      digest: z.string().min(1).max(120),
      generation: z.string().min(1).max(200),
    })
    .optional(),
  /** Node that must execute the capability. Resources do not travel implicitly. */
  executionNodeId: z.string().min(1).max(128),
  summary: z.string().min(1).max(400),
  /** Input/output JSON Schema, loaded lazily rather than dumped into context. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  resourceKinds: z.array(z.string().min(1).max(80)).max(32),
  effectCategory: effectCategorySchema,
  supportsCancellation: z.boolean(),
  /** Opaque connection reference required before use, if any. */
  requiresConnection: z.boolean(),
  readiness: capabilityReadinessSchema,
  /** Coarse UI affordances the conductor may offer, e.g. "opens-preview". */
  uiAffordances: z.array(z.string().min(1).max(80)).max(32),
});
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;

/**
 * A scoped grant. The receiver intersects this with its own policy; a sender
 * can only ever narrow, never widen, what the receiver permits.
 */
export const grantSchema = z.strictObject({
  grantId: z.string().min(1).max(128),
  ownerPrincipalId: z.string().min(1).max(128),
  senderNodeId: z.string().min(1).max(128),
  receiverNodeId: z.string().min(1).max(128),
  capabilityRefs: z.array(capabilityRefSchema).max(256),
  /** Resources the grant may touch. Empty means no resource access. */
  resources: z
    .array(
      z.strictObject({
        nodeId: z.string().min(1).max(128),
        resourceId: z.string().min(1).max(200),
        kind: z.string().min(1).max(80),
        /** `read` is a subset of `write`; `write` is a subset of `admin`. */
        access: z.enum(["read", "write", "admin"]),
      }),
    )
    .max(128),
  /** Data classes the sender may include in a delegation payload. */
  allowedDataClasses: z.array(z.enum(["public", "internal", "confidential", "secret"])).max(8),
  expiresAt: instantSchema,
  budget: z
    .strictObject({
      maxRuns: z.int().nonnegative().optional(),
      maxWallClockMs: z.int().nonnegative().optional(),
      maxTokens: z.int().nonnegative().optional(),
      maxArtifactBytes: z.int().nonnegative().optional(),
    })
    .optional(),
  /** How many further hops a delegated task may take. `0` forbids re-delegation. */
  maxDelegationDepth: z.int().nonnegative().max(8),
  revokedAt: instantSchema.optional(),
});
export type Grant = z.infer<typeof grantSchema>;

const ACCESS_RANK: Record<"read" | "write" | "admin", number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * Intersect two grants.
 *
 * This is the only sanctioned way to derive an effective grant, and it exists to
 * make accidental privilege escalation impossible: every field picks the
 * narrower of the two sides. Delegation depth and budgets take the minimum,
 * expiry takes the earlier instant, revocation wins outright, and resources are
 * matched by (node, resourceId, kind) with the lower access level winning.
 */
export function intersectGrants(a: Grant, b: Grant): Grant {
  if (a.senderNodeId !== b.senderNodeId || a.receiverNodeId !== b.receiverNodeId) {
    throw new Error("cannot intersect grants that do not describe the same node pair");
  }

  const capabilityRefs = a.capabilityRefs.filter((ref) => b.capabilityRefs.includes(ref));

  const resources: Grant["resources"] = [];
  for (const left of a.resources) {
    const right = b.resources.find(
      (candidate) =>
        candidate.nodeId === left.nodeId &&
        candidate.resourceId === left.resourceId &&
        candidate.kind === left.kind,
    );
    if (!right) continue;
    const access = ACCESS_RANK[left.access] <= ACCESS_RANK[right.access] ? left.access : right.access;
    resources.push({ ...left, access });
  }

  const allowedDataClasses = a.allowedDataClasses.filter((cls) =>
    b.allowedDataClasses.includes(cls),
  );

  const expiresAt =
    new Date(a.expiresAt).getTime() <= new Date(b.expiresAt).getTime() ? a.expiresAt : b.expiresAt;

  const budget = intersectBudgets(a.budget, b.budget);

  const revokedAt =
    a.revokedAt && b.revokedAt
      ? new Date(a.revokedAt).getTime() <= new Date(b.revokedAt).getTime()
        ? a.revokedAt
        : b.revokedAt
      : (a.revokedAt ?? b.revokedAt);

  return grantSchema.parse({
    grantId: a.grantId,
    ownerPrincipalId: a.ownerPrincipalId,
    senderNodeId: a.senderNodeId,
    receiverNodeId: a.receiverNodeId,
    capabilityRefs,
    resources,
    allowedDataClasses,
    expiresAt,
    ...(budget === undefined ? {} : { budget }),
    maxDelegationDepth: Math.min(a.maxDelegationDepth, b.maxDelegationDepth),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  });
}

type GrantBudget = NonNullable<Grant["budget"]>;

function intersectBudgets(a?: GrantBudget, b?: GrantBudget): GrantBudget | undefined {
  if (!a) return b;
  if (!b) return a;
  const min = (left?: number, right?: number): number | undefined => {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.min(left, right);
  };
  const budget: GrantBudget = {};
  const maxRuns = min(a.maxRuns, b.maxRuns);
  const maxWallClockMs = min(a.maxWallClockMs, b.maxWallClockMs);
  const maxTokens = min(a.maxTokens, b.maxTokens);
  const maxArtifactBytes = min(a.maxArtifactBytes, b.maxArtifactBytes);
  if (maxRuns !== undefined) budget.maxRuns = maxRuns;
  if (maxWallClockMs !== undefined) budget.maxWallClockMs = maxWallClockMs;
  if (maxTokens !== undefined) budget.maxTokens = maxTokens;
  if (maxArtifactBytes !== undefined) budget.maxArtifactBytes = maxArtifactBytes;
  return budget;
}

export type GrantCheck =
  | { allowed: true; grant: Grant }
  | { allowed: false; code: "GRANT_EXPIRED" | "GRANT_REVOKED" | "GRANT_SCOPE_VIOLATION"; message: string };

/**
 * Check whether a grant covers one invocation.
 *
 * Every dimension is checked, including data class, because a grant that allows
 * a capability but forbids the payload's data class must not execute it.
 */
export function checkGrant(
  grant: Grant,
  request: {
    capabilityRef: CapabilityRef;
    at: string;
    resource?: { nodeId: string; resourceId: string; kind: string; access: "read" | "write" | "admin" };
    dataClass?: "public" | "internal" | "confidential" | "secret";
    delegationDepth?: number;
  },
): GrantCheck {
  if (grant.revokedAt) {
    return { allowed: false, code: "GRANT_REVOKED", message: `grant revoked at ${grant.revokedAt}` };
  }
  if (new Date(request.at).getTime() >= new Date(grant.expiresAt).getTime()) {
    return { allowed: false, code: "GRANT_EXPIRED", message: `grant expired at ${grant.expiresAt}` };
  }
  if (!grant.capabilityRefs.includes(request.capabilityRef)) {
    return {
      allowed: false,
      code: "GRANT_SCOPE_VIOLATION",
      message: `grant does not include capability ${request.capabilityRef}`,
    };
  }
  if (request.resource) {
    const entry = grant.resources.find(
      (candidate) =>
        candidate.nodeId === request.resource?.nodeId &&
        candidate.resourceId === request.resource?.resourceId &&
        candidate.kind === request.resource?.kind,
    );
    if (!entry) {
      return {
        allowed: false,
        code: "GRANT_SCOPE_VIOLATION",
        message: "grant does not include the requested resource",
      };
    }
    if (ACCESS_RANK[entry.access] < ACCESS_RANK[request.resource.access]) {
      return {
        allowed: false,
        code: "GRANT_SCOPE_VIOLATION",
        message: `grant allows ${entry.access} but ${request.resource.access} was requested`,
      };
    }
  }
  if (request.dataClass && !grant.allowedDataClasses.includes(request.dataClass)) {
    return {
      allowed: false,
      code: "GRANT_SCOPE_VIOLATION",
      message: `grant does not permit data class ${request.dataClass}`,
    };
  }
  if (request.delegationDepth !== undefined && request.delegationDepth > grant.maxDelegationDepth) {
    return {
      allowed: false,
      code: "GRANT_SCOPE_VIOLATION",
      message: `delegation depth ${request.delegationDepth} exceeds grant maximum ${grant.maxDelegationDepth}`,
    };
  }
  return { allowed: true, grant };
}

/** Effects that always require fresh, explicit human approval. */
const ALWAYS_APPROVED_CATEGORIES: ReadonlySet<EffectCategory> = new Set<EffectCategory>([
  "destructive",
  "financial",
  "communication",
]);

export function requiresApproval(
  category: EffectCategory,
  policy: { autoApproveReads: boolean },
): boolean {
  if (category === "read") return !policy.autoApproveReads;
  return ALWAYS_APPROVED_CATEGORIES.has(category);
}
