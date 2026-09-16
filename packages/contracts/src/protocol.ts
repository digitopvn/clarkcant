import { z } from "zod";

import { semverSchema } from "./primitives.ts";

/**
 * Wire and message versioning.
 *
 * Versions are plain integers so that negotiation is a range comparison rather
 * than a semver puzzle. Two nodes whose windows do not overlap still exchange
 * read/status traffic; they simply may not start new effects, which is what
 * T11 (peer schema/version unsupported) asserts.
 */

export const APP_HOST_API = { min: 1, max: 1 } as const;
export const NODELINK_PROTOCOL = { min: 1, max: 2 } as const;
export const WIDGET_SDK_VERSION = { min: 1, max: 1 } as const;

export const appHostApiSchema = z.int().min(APP_HOST_API.min).max(APP_HOST_API.max);
export const nodeLinkVersionSchema = z.int().min(NODELINK_PROTOCOL.min).max(NODELINK_PROTOCOL.max);
export const widgetSdkVersionSchema = z.int().min(WIDGET_SDK_VERSION.min).max(WIDGET_SDK_VERSION.max);

export const protocolRangeSchema = z
  .strictObject({
    name: z.enum(["agent.nodelink", "agent.apphost", "agent.widgetsdk"]),
    min: z.int().nonnegative(),
    max: z.int().nonnegative(),
  })
  .refine((range) => range.min <= range.max, {
    error: "protocol range min must not exceed max",
    path: ["min"],
  });
export type ProtocolRange = z.infer<typeof protocolRangeSchema>;

export const versionHandshakeSchema = z.strictObject({
  /** Which contract family this handshake covers. */
  protocol: protocolRangeSchema,
  /** Application release, for diagnostics only — never used for negotiation. */
  appVersion: semverSchema,
  /** Host API generation the peer can satisfy. */
  hostApi: protocolRangeSchema,
  /** Capability schema generations the peer accepts, keyed by capability family. */
  capabilityGenerations: z.record(z.string().min(1).max(120), protocolRangeSchema),
});
export type VersionHandshake = z.infer<typeof versionHandshakeSchema>;

export const negotiationResultSchema = z.strictObject({
  /**
   * `full` — new delegations and effects may start.
   * `read-only` — status/history may be exchanged, new effects may not start.
   * `incompatible` — nothing may be exchanged.
   */
  mode: z.enum(["full", "read-only", "incompatible"]),
  agreed: z
    .strictObject({
      nodeLinkVersion: z.int().nonnegative().optional(),
      hostApiVersion: z.int().nonnegative().optional(),
      capabilityGenerations: z.record(z.string(), z.int().nonnegative()).optional(),
    })
    .optional(),
  /** Human-readable reasons for a degraded outcome, surfaced in the UI. */
  reasons: z.array(z.string().min(1).max(300)).max(16),
});
export type NegotiationResult = z.infer<typeof negotiationResultSchema>;

function intersect(
  a: ProtocolRange,
  b: ProtocolRange,
): { min: number; max: number } | undefined {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min <= max ? { min, max } : undefined;
}

/**
 * Negotiate a usable version window between two peers.
 *
 * A peer that cannot overlap on the NodeLink protocol itself is `incompatible`.
 * A peer that overlaps on the protocol but not on some capability family keeps
 * working in `read-only` mode: existing tasks stay observable, new effects on
 * the unsupported family do not start. Silently downgrading a schema is never
 * an option (`distributed-runtime.md` §11).
 */
export function negotiateVersions(
  local: VersionHandshake,
  remote: VersionHandshake,
): NegotiationResult {
  const reasons: string[] = [];

  if (local.protocol.name !== remote.protocol.name) {
    return {
      mode: "incompatible",
      reasons: [`protocol mismatch: ${local.protocol.name} vs ${remote.protocol.name}`],
    };
  }

  const protocolOverlap = intersect(local.protocol, remote.protocol);
  if (!protocolOverlap) {
    return {
      mode: "incompatible",
      reasons: [
        `no ${local.protocol.name} overlap: local ${local.protocol.min}-${local.protocol.max}, remote ${remote.protocol.min}-${remote.protocol.max}`,
      ],
    };
  }

  const hostApiOverlap = intersect(local.hostApi, remote.hostApi);
  if (!hostApiOverlap) {
    reasons.push(
      `host API has no overlap: local ${local.hostApi.min}-${local.hostApi.max}, remote ${remote.hostApi.min}-${remote.hostApi.max}`,
    );
  }

  /** Highest version both sides accept wins, so newest shared schema is used. */
  const capabilityGenerations: Record<string, number> = {};
  for (const [family, localRange] of Object.entries(local.capabilityGenerations)) {
    const remoteRange = remote.capabilityGenerations[family];
    if (!remoteRange) {
      reasons.push(`remote does not implement capability family ${family}`);
      continue;
    }
    const overlap = intersect(localRange, remoteRange);
    if (!overlap) {
      reasons.push(
        `capability family ${family} has no overlap: local ${localRange.min}-${localRange.max}, remote ${remoteRange.min}-${remoteRange.max}`,
      );
      continue;
    }
    capabilityGenerations[family] = overlap.max;
  }

  if (!hostApiOverlap || reasons.length > 0) {
    return {
      mode: "read-only",
      agreed: Object.keys(capabilityGenerations).length > 0 ? { capabilityGenerations } : {},
      reasons,
    };
  }

  return {
    mode: "full",
    agreed: {
      nodeLinkVersion: protocolOverlap.max,
      hostApiVersion: hostApiOverlap.max,
      capabilityGenerations,
    },
    reasons: [],
  };
}

/**
 * Local handshake describing what this build speaks. Derived from the constants
 * above so the declared window and the validating schema cannot drift apart.
 */
export function localHandshake(
  appVersion: string,
  capabilityGenerations: Record<string, ProtocolRange> = {},
): VersionHandshake {
  return versionHandshakeSchema.parse({
    protocol: { name: "agent.nodelink", ...NODELINK_PROTOCOL },
    appVersion,
    hostApi: { name: "agent.apphost", ...APP_HOST_API },
    capabilityGenerations,
  });
}
