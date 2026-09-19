import { z } from "zod";

/**
 * Error taxonomy.
 *
 * Codes are grouped by the boundary that produced them so that a client can
 * decide whether to retry, ask the user, or stop. `UNKNOWN_EFFECT` in particular
 * must never be presented as a plain failure: it means the outcome is genuinely
 * undetermined and a human or a reconciliation pass has to look.
 */
export const errorCodeSchema = z.enum([
  // Request shaping
  "INVALID_SCHEMA",
  "UNSUPPORTED_VERSION",
  "MALFORMED_ID",
  "PAYLOAD_TOO_LARGE",

  // Identity and authority
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "GRANT_EXPIRED",
  "GRANT_REVOKED",
  "GRANT_SCOPE_VIOLATION",
  "TRANSITIVE_TRUST_DENIED",
  "PRINCIPAL_MISMATCH",

  // Protocol
  "PROTOCOL_INCOMPATIBLE",
  "DUPLICATE_COMMAND",
  "OUT_OF_ORDER_EVENT",
  "REPLAY_REJECTED",

  // Resources and concurrency
  "RESOURCE_NOT_FOUND",
  "RESOURCE_VERSION_MISMATCH",
  "WRONG_NODE_FOR_RESOURCE",
  "LEASE_HELD",
  "STALE_LEASE_EPOCH",
  "BUDGET_EXCEEDED",
  "QUOTA_EXCEEDED",

  // Capability and install
  "CAPABILITY_MISSING",
  "CAPABILITY_NOT_READY",
  "CAPABILITY_NOT_AUTHENTICATED",
  "INSTALL_CONSENT_STALE",
  "INSTALL_DIGEST_MISMATCH",
  "INSTALL_UNSUPPORTED_PLATFORM",
  "INSTALL_STAGING_FAILED",
  "INSTALL_ACTIVATION_FAILED",

  // Effects
  "EFFECT_UNKNOWN",
  "EFFECT_ALREADY_CONFIRMED",
  "EFFECT_PRECONDITION_FAILED",

  // Approval and consent
  "APPROVAL_REQUIRED",
  "APPROVAL_EXPIRED",
  "APPROVAL_FORGED",

  // Automation
  "TARGET_STALE",
  "OBSERVATION_EXPIRED",
  "TARGET_CHANGED",
  "DRIVER_UNAVAILABLE",
  "PERMISSION_DENIED_BY_OS",

  // Widgets
  "WIDGET_UNKNOWN_DEFINITION",
  "WIDGET_PROPS_INVALID",
  "WIDGET_ACTION_UNKNOWN",
  "WIDGET_ISOLATION_VIOLATION",

  // Preferences
  "PREFERENCE_UNKNOWN",
  "PREFERENCE_INVALID",

  // Voice and media
  "MEDIA_FOCUS_CONFLICT",
  "VOICE_TRANSPORT_UNAVAILABLE",

  // Generic
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Whether the caller may safely re-issue the same logical request.
 *
 * `never` is deliberately attached to every effect-bearing code. Re-sending a
 * request whose external effect may already have landed is how duplicate writes
 * appear, so the protocol refuses to label that case retryable.
 */
export const retryabilitySchema = z.enum(["never", "after-backoff", "after-user-action", "immediate"]);
export type Retryability = z.infer<typeof retryabilitySchema>;

const RETRYABILITY: Record<ErrorCode, Retryability> = {
  INVALID_SCHEMA: "never",
  UNSUPPORTED_VERSION: "never",
  MALFORMED_ID: "never",
  PAYLOAD_TOO_LARGE: "never",

  UNAUTHENTICATED: "after-user-action",
  UNAUTHORIZED: "never",
  GRANT_EXPIRED: "after-user-action",
  GRANT_REVOKED: "never",
  GRANT_SCOPE_VIOLATION: "never",
  TRANSITIVE_TRUST_DENIED: "never",
  PRINCIPAL_MISMATCH: "never",

  PROTOCOL_INCOMPATIBLE: "never",
  DUPLICATE_COMMAND: "immediate",
  OUT_OF_ORDER_EVENT: "immediate",
  REPLAY_REJECTED: "never",

  RESOURCE_NOT_FOUND: "never",
  RESOURCE_VERSION_MISMATCH: "after-user-action",
  WRONG_NODE_FOR_RESOURCE: "never",
  LEASE_HELD: "after-backoff",
  STALE_LEASE_EPOCH: "never",
  BUDGET_EXCEEDED: "after-user-action",
  QUOTA_EXCEEDED: "after-user-action",

  CAPABILITY_MISSING: "after-user-action",
  CAPABILITY_NOT_READY: "after-backoff",
  CAPABILITY_NOT_AUTHENTICATED: "after-user-action",
  INSTALL_CONSENT_STALE: "after-user-action",
  INSTALL_DIGEST_MISMATCH: "after-user-action",
  INSTALL_UNSUPPORTED_PLATFORM: "never",
  INSTALL_STAGING_FAILED: "after-backoff",
  INSTALL_ACTIVATION_FAILED: "after-user-action",

  EFFECT_UNKNOWN: "never",
  EFFECT_ALREADY_CONFIRMED: "never",
  EFFECT_PRECONDITION_FAILED: "never",

  APPROVAL_REQUIRED: "after-user-action",
  APPROVAL_EXPIRED: "after-user-action",
  APPROVAL_FORGED: "never",

  TARGET_STALE: "immediate",
  OBSERVATION_EXPIRED: "immediate",
  TARGET_CHANGED: "immediate",
  DRIVER_UNAVAILABLE: "after-user-action",
  PERMISSION_DENIED_BY_OS: "after-user-action",

  WIDGET_UNKNOWN_DEFINITION: "never",
  WIDGET_PROPS_INVALID: "never",
  WIDGET_ACTION_UNKNOWN: "never",
  WIDGET_ISOLATION_VIOLATION: "never",

  // A key nothing reads: re-sending it would refuse again, so the caller has to change the key.
  PREFERENCE_UNKNOWN: "never",
  // The shape, not the request, was wrong: a corrected value may be sent unchanged otherwise.
  PREFERENCE_INVALID: "after-user-action",

  MEDIA_FOCUS_CONFLICT: "after-user-action",
  VOICE_TRANSPORT_UNAVAILABLE: "after-user-action",

  NOT_IMPLEMENTED: "never",
  INTERNAL_ERROR: "after-backoff",
};

export function retryabilityOf(code: ErrorCode): Retryability {
  return RETRYABILITY[code];
}

export const contractErrorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1).max(2000),
  /** Which layer refused, for operator diagnosis. */
  origin: z.enum([
    "transport",
    "gateway",
    "policy",
    "storage",
    "scheduler",
    "executor",
    "driver",
    "widget-host",
    "peer",
    "adapter",
  ]),
  retryability: retryabilitySchema.optional(),
  /** Structured detail. Never contains credential material. */
  detail: z.record(z.string(), z.unknown()).optional(),
  /** Set when the error concerns a specific resource, for UI targeting. */
  relatedResource: z
    .strictObject({ nodeId: z.string(), resourceId: z.string(), kind: z.string() })
    .optional(),
});

export type ContractError = z.infer<typeof contractErrorSchema>;

/** Build a contract error, deriving retryability from the code by default. */
export function contractError(
  code: ErrorCode,
  origin: ContractError["origin"],
  message: string,
  detail?: Record<string, unknown>,
): ContractError {
  return {
    code,
    origin,
    message,
    retryability: retryabilityOf(code),
    ...(detail === undefined ? {} : { detail }),
  };
}

export class ContractViolation extends Error {
  readonly contract: ContractError;

  constructor(contract: ContractError) {
    super(`${contract.code}: ${contract.message}`);
    this.name = "ContractViolation";
    this.contract = contract;
  }
}

export function raise(
  code: ErrorCode,
  origin: ContractError["origin"],
  message: string,
  detail?: Record<string, unknown>,
): never {
  throw new ContractViolation(contractError(code, origin, message, detail));
}
