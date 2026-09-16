import { z } from "zod";

import { instantSchema, sequenceSchema, type Instant } from "./primitives.ts";
import { grantSchema } from "./grants.ts";

/**
 * NodeLink — the peer protocol between independent installations.
 *
 * Delivery is at-least-once with durable deduplication, never exactly-once for
 * external effects. That single decision shapes everything below: the sender
 * records intent before transmitting, the receiver records the inbox entry and
 * the accepted task in one transaction before acknowledging, and a resent
 * envelope returns the outcome that was already known rather than starting
 * anything new.
 *
 * `senderNodeId` is carried for diagnostics and correlation. It is not identity.
 * Identity comes from the authenticated transport, which is why the receiver
 * validates the claimed sender against the verified channel instead of trusting
 * the field.
 */

export const peerMessageKindSchema = z.enum([
  "handshake",
  "invite.claim",
  "pair.confirm",
  "revoke",
  "delegate",
  "accepted",
  "status",
  "input.request",
  "input.response",
  "approval.request",
  "approval.response",
  "cancel.request",
  "result",
  "artifact.offer",
  "artifact.accept",
  "heartbeat",
]);
export type PeerMessageKind = z.infer<typeof peerMessageKindSchema>;

export const peerEnvelopeSchema = z.strictObject({
  protocol: z.literal("agent.nodelink"),
  version: z.int().positive(),
  messageId: z.string().min(1).max(128),
  /** Groups all messages belonging to one logical exchange. */
  correlationId: z.string().min(1).max(128),
  /**
   * Claimed sender. Verified against the authenticated channel; a mismatch is
   * rejected rather than reconciled.
   */
  senderNodeId: z.string().min(1).max(128),
  recipientNodeId: z.string().min(1).max(128),
  kind: peerMessageKindSchema,
  delegationId: z.string().min(1).max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  /**
   * Revision the sender believed it was acting on. A receiver holding a newer
   * revision refuses rather than applying a stale instruction.
   */
  expectedTaskRevision: z.int().nonnegative().optional(),
  runId: z.string().min(1).max(128).optional(),
  /** Fencing token: an executor whose epoch is behind must not act. */
  executionEpoch: z.int().nonnegative().optional(),
  /** Monotonic per sender stream. Used for dedup and gap detection. */
  sourceSequence: sequenceSchema,
  sentAt: instantSchema,
  /** Mandatory per-kind runtime validation. Never passed through unvalidated. */
  payload: z.record(z.string(), z.unknown()),
});
export type PeerEnvelope = z.infer<typeof peerEnvelopeSchema>;

/** Which payload fields each kind must carry. */
const REQUIRED_PAYLOAD_KEYS: Record<PeerMessageKind, readonly string[]> = {
  handshake: ["handshake"],
  "invite.claim": ["inviteId", "deviceIdentity"],
  "pair.confirm": ["grant", "fingerprint"],
  revoke: ["grantId", "reason"],
  delegate: ["grant", "taskBrief", "dataClass"],
  accepted: ["acceptedAt"],
  status: ["taskState", "taskRevision"],
  "input.request": ["requestId", "prompt", "expiresAt"],
  "input.response": ["requestId", "response"],
  "approval.request": ["requestId", "operationDigest", "operationDescription", "expiresAt"],
  "approval.response": ["requestId", "decision"],
  "cancel.request": ["reason"],
  result: ["outcome", "evidence"],
  "artifact.offer": ["artifact", "digest", "sizeBytes", "classification"],
  "artifact.accept": ["artifactOfferMessageId", "decision"],
  heartbeat: [],
};

export const peerValidationIssueSchema = z.strictObject({
  code: z.enum([
    "MISSING_FIELD",
    "UNSUPPORTED_KIND",
    "VERSION_UNSUPPORTED",
    "SENDER_MISMATCH",
    "SEQUENCE_REGRESSION",
    "DELEGATION_UNKNOWN",
    "REVISION_STALE",
    "GRANT_INVALID",
  ]),
  message: z.string().min(1).max(500),
  field: z.string().min(1).max(160).optional(),
});
export type PeerValidationIssue = z.infer<typeof peerValidationIssueSchema>;

export type PeerValidation =
  | { valid: true; envelope: PeerEnvelope }
  | { valid: false; issues: PeerValidationIssue[] };

/**
 * Validate an inbound envelope.
 *
 * `authenticatedSenderNodeId` is required rather than optional, because accepting
 * an envelope without comparing it to the verified channel identity is the exact
 * mistake acceptance test T08 covers.
 */
export function validatePeerEnvelope(
  raw: unknown,
  context: {
    authenticatedSenderNodeId: string;
    supportedVersions: { min: number; max: number };
    lastSeenSequence: number | undefined;
    knownDelegationIds: ReadonlySet<string>;
    currentTaskRevision?: number;
  },
): PeerValidation {
  const parsed = peerEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.slice(0, 16).map((issue) => ({
        code: "MISSING_FIELD" as const,
        message: issue.message,
        ...(issue.path.length > 0 ? { field: issue.path.join(".") } : {}),
      })),
    };
  }

  const envelope = parsed.data;
  const issues: PeerValidationIssue[] = [];

  if (
    envelope.version < context.supportedVersions.min ||
    envelope.version > context.supportedVersions.max
  ) {
    issues.push({
      code: "VERSION_UNSUPPORTED",
      message: `envelope version ${envelope.version} is outside the supported window ${context.supportedVersions.min}-${context.supportedVersions.max}`,
      field: "version",
    });
  }

  if (envelope.senderNodeId !== context.authenticatedSenderNodeId) {
    issues.push({
      code: "SENDER_MISMATCH",
      message: `envelope claims sender ${envelope.senderNodeId} but the authenticated channel belongs to ${context.authenticatedSenderNodeId}`,
      field: "senderNodeId",
    });
  }

  const required = REQUIRED_PAYLOAD_KEYS[envelope.kind];
  for (const key of required) {
    if (!(key in envelope.payload)) {
      issues.push({
        code: "MISSING_FIELD",
        message: `${envelope.kind} requires payload.${key}`,
        field: `payload.${key}`,
      });
    }
  }

  if (
    context.lastSeenSequence !== undefined &&
    envelope.sourceSequence <= context.lastSeenSequence
  ) {
    // Not an error: at-least-once delivery means replays are expected. The
    // caller deduplicates on (senderNodeId, sourceSequence, messageId).
    issues.push({
      code: "SEQUENCE_REGRESSION",
      message: `sourceSequence ${envelope.sourceSequence} is not greater than the last seen ${context.lastSeenSequence}`,
      field: "sourceSequence",
    });
  }

  if (envelope.kind === "delegate") {
    if (
      !envelope.delegationId ||
      !context.knownDelegationIds.has(envelope.delegationId)
    ) {
      issues.push({
        code: "DELEGATION_UNKNOWN",
        message: `delegate references delegation ${String(envelope.delegationId)} which has not been established`,
        field: "delegationId",
      });
    }
    const grantResult = grantSchema.safeParse(envelope.payload.grant);
    if (!grantResult.success) {
      issues.push({
        code: "GRANT_INVALID",
        message: "delegate payload carries a grant that does not match the grant schema",
        field: "payload.grant",
      });
    }
  }

  if (
    envelope.expectedTaskRevision !== undefined &&
    context.currentTaskRevision !== undefined &&
    envelope.expectedTaskRevision !== context.currentTaskRevision
  ) {
    issues.push({
      code: "REVISION_STALE",
      message: `envelope targets task revision ${envelope.expectedTaskRevision} but the current revision is ${context.currentTaskRevision}`,
      field: "expectedTaskRevision",
    });
  }

  return issues.length === 0 ? { valid: true, envelope } : { valid: false, issues };
}

/**
 * Stable dedup key for an inbound envelope.
 *
 * Sequence plus sender is the primary key; `messageId` is included so that a
 * sender which reuses a sequence after a reset still produces a distinct key and
 * cannot make a new instruction look like a replay.
 */
export function dedupKey(envelope: PeerEnvelope): string {
  return `${envelope.senderNodeId}:${envelope.sourceSequence}:${envelope.messageId}`;
}

export type InboxDecision =
  | { action: "process"; key: string }
  | { action: "duplicate"; key: string; previousMessageId: string }
  | { action: "gap-detected"; key: string; expected: number; received: number };

/**
 * Decide what to do with an inbound envelope.
 *
 * A duplicate is not an error and is answered with the previously recorded
 * outcome, which is what makes "retry a delegation whose acknowledgement was
 * lost" safe (acceptance test T02). A sequence gap is reported rather than
 * silently filled, because silently accepting a gap hides real loss.
 */
export function decideInboxAction(
  envelope: PeerEnvelope,
  inbox: { keys: ReadonlyMap<string, string>; lastSequence: number | undefined },
): InboxDecision {
  const key = dedupKey(envelope);
  const previous = inbox.keys.get(key);
  if (previous !== undefined) {
    return { action: "duplicate", key, previousMessageId: previous };
  }
  if (inbox.lastSequence === undefined || envelope.sourceSequence === inbox.lastSequence + 1) {
    return { action: "process", key };
  }
  if (envelope.sourceSequence > inbox.lastSequence) {
    return {
      action: "gap-detected",
      key,
      expected: inbox.lastSequence + 1,
      received: envelope.sourceSequence,
    };
  }
  // Older than last seen but not a known key: replay of something already
  // superseded. Treated as a duplicate of an unknown origin.
  return { action: "duplicate", key, previousMessageId: "unknown" };
}

/* ------------------------------------------------------------------ *
 * Pairing
 * ------------------------------------------------------------------ */

/**
 * A single-use pairing invitation.
 *
 * The invite is an introduction, not a credential. It carries an expiry and a
 * single-use flag, and claiming it opens no resource access on its own — trust
 * and grants are established by a separate, explicit confirmation.
 */
export const pairInviteSchema = z.strictObject({
  inviteId: z.string().min(1).max(128),
  /** Node that created the invite and will be the receiver of the offer. */
  issuerNodeId: z.string().min(1).max(128),
  /** Endpoint the peer should reach, as declared by the issuer. */
  endpoint: z.string().min(1).max(500),
  /**
   * Fingerprint of the issuer's device key. Displayed to the user so a DNS name
   * is never the thing being trusted.
   */
  fingerprint: z.string().min(16).max(400),
  createdAt: instantSchema,
  expiresAt: instantSchema,
  claimedAt: instantSchema.optional(),
});
export type PairInvite = z.infer<typeof pairInviteSchema>;

export type InviteClaimResult =
  | { ok: true; invite: PairInvite }
  | { ok: false; code: "INVITE_EXPIRED" | "INVITE_ALREADY_CLAIMED" | "INVITE_UNKNOWN"; message: string };

export function claimInvite(invite: PairInvite, at: Instant): InviteClaimResult {
  if (invite.claimedAt) {
    return {
      ok: false,
      code: "INVITE_ALREADY_CLAIMED",
      message: `invite was already claimed at ${invite.claimedAt}; replay is refused`,
    };
  }
  if (new Date(at).getTime() >= new Date(invite.expiresAt).getTime()) {
    return {
      ok: false,
      code: "INVITE_EXPIRED",
      message: `invite expired at ${invite.expiresAt}`,
    };
  }
  return { ok: true, invite: { ...invite, claimedAt: at } };
}

/**
 * Deployment mismatch guard.
 *
 * The classic failure this prevents: a headless server is configured with a
 * loopback redirect that can only ever resolve on the operator's laptop, so the
 * OAuth callback silently never arrives (acceptance test T33).
 */
export function checkRedirectReachable(input: {
  redirectUri: string;
  ownerNodeKind: "desktop" | "headless-server";
}): { ok: boolean; message: string } {
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(input.redirectUri);
  if (isLoopback && input.ownerNodeKind === "headless-server") {
    return {
      ok: false,
      message:
        "a loopback redirect cannot be completed on a headless server: the browser runs on the user's machine, not on the server. Use a registered HTTPS callback for the server node, or complete the flow on the desktop node that owns the credential.",
    };
  }
  return { ok: true, message: "redirect target is consistent with the owning node" };
}

/* ------------------------------------------------------------------ *
 * Blob transfer
 * ------------------------------------------------------------------ */

/**
 * An artifact offer.
 *
 * Transfer is a request, not an implication. The receiver checks scope, digest,
 * size and classification before accepting, so a peer cannot push data by
 * declaring it small (acceptance test T10).
 */
export const artifactOfferSchema = z.strictObject({
  artifactId: z.string().min(1).max(128),
  /** Digest is verified after transfer, not merely advertised. */
  digest: z.string().min(1).max(120),
  sizeBytes: z.int().nonnegative(),
  mimeType: z.string().min(1).max(200),
  classification: z.enum(["public", "internal", "confidential", "secret"]),
  /** Node-qualified origin, so lineage survives the copy. */
  originNodeId: z.string().min(1).max(128),
  /** Resource the artifact was derived from, when applicable. */
  derivedFromResourceId: z.string().min(1).max(200).optional(),
});
export type ArtifactOffer = z.infer<typeof artifactOfferSchema>;

export type TransferDecision =
  | { accepted: true }
  | { accepted: false; reason: string };

export function checkArtifactAcceptance(
  offer: ArtifactOffer,
  policy: {
    allowedClassifications: readonly ("public" | "internal" | "confidential" | "secret")[];
    maxBytes: number;
    allowedMimePrefixes: readonly string[];
  },
): TransferDecision {
  if (!policy.allowedClassifications.includes(offer.classification)) {
    return {
      accepted: false,
      reason: `grant does not permit data class ${offer.classification}`,
    };
  }
  if (offer.sizeBytes > policy.maxBytes) {
    return {
      accepted: false,
      reason: `artifact is ${offer.sizeBytes} bytes which exceeds the ${policy.maxBytes} byte budget`,
    };
  }
  const mimeAllowed = policy.allowedMimePrefixes.some((prefix) =>
    offer.mimeType.startsWith(prefix),
  );
  if (!allowedMime(offer.mimeType) || !mimeAllowed) {
    return { accepted: false, reason: `mime type ${offer.mimeType} is not permitted` };
  }
  return { accepted: true };
}

/**
 * Executable and markup MIME types are refused outright. An artifact named as a
 * document that is actually a program is the cheapest possible attack on a
 * transfer channel.
 */
function allowedMime(mimeType: string): boolean {
  const banned = [
    "application/x-executable",
    "application/x-sharedlib",
    "application/x-mach-binary",
    "application/x-msdownload",
    "application/x-sh",
    "application/x-httpd-php",
    "text/html",
    "image/svg+xml",
  ];
  return !banned.includes(mimeType);
}
