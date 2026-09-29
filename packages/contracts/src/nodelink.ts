import { z } from "zod";

import { instantSchema, sequenceSchema, type Instant } from "./primitives.ts";
import { grantSchema } from "./grants.ts";
import { NOTICE_BODY_MAX, NOTICE_TITLE_MAX, noticeCategorySchema, noticeSeveritySchema } from "./inbox.ts";

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
  /**
   * Something that happened on the sender, for the receiver's standing requests to match. A fact, never a command: it
   * carries no grant and asks for nothing, and what it starts is decided by what the receiver's owner set up there.
   */
  "signal",
  /**
   * Something the sender's owner should hear about on this node too, for its inbox. Words and nothing more: a notice
   * carries no subject, no action and no instruction, and the receiver records it under the sender's name only when its
   * own owner decided to work with that node (a grant the receiver wrote to it, or an allowance for it). Sent only to a
   * node that advertised `notice` among its features.
   */
  "notice",
  /**
   * The sender gave up on messages it sequenced for the receiver, and says so in their place: the receiver's cursor moves
   * to this envelope's own sequence, and both owners are told what was lost. Sent only after the sender dead-lettered
   * every sequence it covers, and only to a node that advertised `skip` among its features.
   */
  "skip",
]);
export type PeerMessageKind = z.infer<typeof peerMessageKindSchema>;

/**
 * The payload of a `notice` envelope.
 *
 * `key` is the sender's own name for the event, so the same notice sent again — a retry, or a second envelope for the
 * same thing — is recorded once. Strict: a sender that adds a subject, an action or anything else is refused rather
 * than having it dropped silently, because what a person can do with a notice is decided by the host that shows it.
 */
export const peerNoticeSchema = z.strictObject({
  key: z.string().min(1).max(160),
  category: noticeCategorySchema,
  severity: noticeSeveritySchema,
  title: z.string().min(1).max(NOTICE_TITLE_MAX),
  body: z.string().max(NOTICE_BODY_MAX).optional(),
});
export type PeerNotice = z.infer<typeof peerNoticeSchema>;

/** The most given-up messages one `skip` envelope lists; a longer run is covered by consecutive skips. */
export const PEER_SKIP_LOST_MAX = 50;

/**
 * One message a `skip` gives up on: its sequence, its id, its kind and the task it concerned. A task id is an id and
 * nothing else, so it is held to an id's characters: the receiver shows it to its owner.
 */
export const peerSkipLostSchema = z.strictObject({
  sequence: sequenceSchema,
  messageId: z.string().min(1).max(128),
  kind: peerMessageKindSchema.exclude(["skip"]),
  taskId: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .optional(),
});
export type PeerSkipLost = z.infer<typeof peerSkipLostSchema>;

/**
 * The payload of a `skip` envelope.
 *
 * `through` is the envelope's own `sourceSequence`, never more: a skip covers only sequences its sender already issued,
 * so it cannot move the receiver's cursor over a message not yet sent. `lost` lists what the sender gave up on in that
 * range, in sequence order. Strict, like a notice: a skip that carries anything else is refused whole.
 */
export const peerSkipSchema = z.strictObject({
  through: sequenceSchema,
  lost: z.array(peerSkipLostSchema).min(1).max(PEER_SKIP_LOST_MAX),
});
export type PeerSkip = z.infer<typeof peerSkipSchema>;

/** Whether a skip lists each message once, in ascending sequence order, none past `through`. */
function skipListsInOrder(skip: PeerSkip): boolean {
  let previous = -1;
  for (const lost of skip.lost) {
    if (lost.sequence <= previous || lost.sequence > skip.through) return false;
    previous = lost.sequence;
  }
  return true;
}

/**
 * What a node says it takes beyond the envelopes every build understands, so a peer sends a newer kind only to a node
 * that reads it. A closed list: a value this build does not know is dropped, never stored, so a peer cannot write
 * arbitrary words into this node's peer row by advertising them.
 */
export const peerFeatureSchema = z.enum(["notice", "skip"]);
export type PeerFeature = z.infer<typeof peerFeatureSchema>;
/** Every feature this build takes, in the order it advertises them. */
export const PEER_FEATURES: readonly PeerFeature[] = peerFeatureSchema.options;
/** How many advertised values are looked at; the rest are ignored rather than parsed. */
export const PEER_FEATURES_MAX = 16;

/**
 * A peer's advertised features, as this build reads them: known values only, each once. `undefined` when the peer
 * advertised nothing readable, which is how a build from before features existed answers.
 */
export function readPeerFeatures(value: unknown): PeerFeature[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = new Set<PeerFeature>();
  for (const item of value.slice(0, PEER_FEATURES_MAX)) {
    const read = peerFeatureSchema.safeParse(item);
    if (read.success) known.add(read.data);
  }
  return [...known];
}

/** The longest name a peer may give itself here, in characters. */
export const PEER_LABEL_MAX = 64;

/**
 * A peer's words as text this node shows: control characters become a space, and format characters — bidi overrides,
 * zero-width joiners and spaces — are removed, so a peer cannot reorder or hide what a person reads next to them.
 */
export function peerTextAsData(text: string): string {
  return text.replace(/\p{Cc}+/gu, " ").replace(/\p{Cf}+/gu, "");
}

/**
 * The name a peer gives itself, treated as data: cleaned like any peer text, whitespace collapsed, at most
 * `PEER_LABEL_MAX` characters. `undefined` when nothing is left, so an empty name is never stored.
 */
export function readPeerLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = peerTextAsData(value).replace(/\s+/g, " ").trim();
  const bounded = [...cleaned].slice(0, PEER_LABEL_MAX).join("").trim();
  return bounded === "" ? undefined : bounded;
}

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
  signal: ["signal"],
  notice: ["notice"],
  skip: ["skip"],
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
    "SKIP_INVALID",
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

  if (envelope.kind === "skip" && "skip" in envelope.payload) {
    const skip = peerSkipSchema.safeParse(envelope.payload["skip"]);
    if (!skip.success) {
      issues.push({ code: "SKIP_INVALID", message: "skip payload is not a skip this node can read", field: "payload.skip" });
    } else if (skip.data.through !== envelope.sourceSequence) {
      // Never past its own slot: a skip reaching further would move the cursor over messages not yet sent.
      issues.push({
        code: "SKIP_INVALID",
        message: `skip covers through ${skip.data.through} but occupies sequence ${envelope.sourceSequence}`,
        field: "payload.skip.through",
      });
    } else if (!skipListsInOrder(skip.data)) {
      issues.push({
        code: "SKIP_INVALID",
        message: "skip lists a message outside its range, or out of sequence order",
        field: "payload.skip.lost",
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
  // A skip is the one envelope that closes a gap: it says the sequences before it were given up on, so it is processed
  // past the cursor rather than waiting for them.
  if (envelope.kind === "skip" && envelope.sourceSequence > inbox.lastSequence) {
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
