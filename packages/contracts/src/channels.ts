import { z } from "zod";

import { type IngressMode, ingressModeSchema } from "./ingress-mode.ts";
import { type Instant, connectionIdSchema, instantSchema } from "./primitives.ts";

/**
 * External messaging channels: Clark on Telegram, Discord, WhatsApp and whatever comes next, as one Clark.
 *
 * A channel is another surface into the same conversation, not another agent. A provider's delivery is verified,
 * deduplicated and recorded by the one durable intake every external source uses (`signals.ts`); what it means for a
 * conversation is decided after that, by the host, from these provider-neutral records. Nothing here names a provider's
 * own fields: a provider's ids appear only as opaque strings in the mapping records below, never in `MessageRecord`,
 * and the model never sees them or any credential.
 *
 * Versioned (`CHANNEL_CONTRACT_VERSION`): a record written now says `version: 1`.
 */

export const CHANNEL_CONTRACT_VERSION = 1;

/** The ingress vocabulary every external source shares (`ingress-mode.ts`), named for channels. */
export const channelIngressModeSchema = ingressModeSchema;
export type ChannelIngressMode = IngressMode;

/** A provider's name as the host registers its adapter: `telegram`, `discord`, `fake`. Never shown as a concept. */
export const channelProviderSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "a channel provider is lower-case letters, digits and dashes");
export type ChannelProvider = z.infer<typeof channelProviderSchema>;

/** An id a provider gave something — a chat, a thread, a message, an account. Opaque to everything but its adapter. */
const externalIdSchema = z.string().min(1).max(200);

/**
 * What one provider can do, answered by its adapter instead of assumed.
 *
 * Only `text` is required; everything else absent means unsupported, so a renderer degrades rather than guessing.
 */
export const channelCapabilitiesSchema = z.strictObject({
  text: z.boolean(),
  richText: z.boolean().optional(),
  images: z.boolean().optional(),
  files: z.boolean().optional(),
  audio: z.boolean().optional(),
  voice: z.boolean().optional(),
  replies: z.boolean().optional(),
  threads: z.boolean().optional(),
  reactions: z.boolean().optional(),
  edit: z.boolean().optional(),
  delete: z.boolean().optional(),
  typing: z.boolean().optional(),
  buttons: z.boolean().optional(),
  selects: z.boolean().optional(),
  forms: z.boolean().optional(),
  deliveryReceipts: z.boolean().optional(),
  readReceipts: z.boolean().optional(),
  /** Longest text one message may carry; a longer reply is split by the host. */
  maxTextLength: z.int().min(1).max(1_000_000).optional(),
});
export type ChannelCapabilities = z.infer<typeof channelCapabilitiesSchema>;

/** Most characters one message's text may carry in this contract, either way: kept well inside what one signal may carry. */
export const CHANNEL_TEXT_MAX = 12_000;

/** What a message says, provider-neutral. Attachments and rich blocks are later versions of this record. */
export const channelContentSchema = z.strictObject({
  text: z.string().min(1).max(CHANNEL_TEXT_MAX),
  format: z.enum(["plain", "markdown"]),
});
export type ChannelContent = z.infer<typeof channelContentSchema>;

/** Who wrote a message on the provider. `isBot` is the provider's own claim, read as provenance only. */
export const channelActorSchema = z.strictObject({
  externalActorId: externalIdSchema,
  displayName: z.string().min(1).max(200).optional(),
  isBot: z.boolean().optional(),
});
export type ChannelActor = z.infer<typeof channelActorSchema>;

/** A chat, channel or group: `direct` is one person and Clark, `group` is anything with more people in it. */
export const channelSpaceSchema = z.strictObject({
  externalSpaceId: externalIdSchema,
  kind: z.enum(["direct", "group"]),
});
export type ChannelSpace = z.infer<typeof channelSpaceSchema>;

/**
 * One thing that happened on a channel, as an adapter normalized it.
 *
 * `eventId` is what makes a redelivery the same event: it is the dedupe key the intake records the event under. A
 * message Clark itself sent comes back on many providers; the adapter marks it `selfAuthored` when the provider says
 * so, and the host also recognizes it by the connection's own accounts and by the messages it recorded sending.
 */
export const channelMessageEventSchema = z.strictObject({
  version: z.literal(CHANNEL_CONTRACT_VERSION),
  kind: z.literal("message"),
  eventId: z.string().min(1).max(300),
  occurredAt: instantSchema,
  space: channelSpaceSchema,
  externalThreadId: externalIdSchema.optional(),
  externalMessageId: externalIdSchema,
  actor: channelActorSchema,
  content: channelContentSchema,
  /** The provider message this one answers, when the provider says. */
  replyToExternalMessageId: externalIdSchema.optional(),
  /** Whether the message names Clark (an @mention of the connection's account), as the adapter read it. */
  mentionsClark: z.boolean(),
  selfAuthored: z.boolean().optional(),
});
export const channelEventSchema = z.discriminatedUnion("kind", [channelMessageEventSchema]);
export type ChannelEvent = z.infer<typeof channelEventSchema>;

/**
 * Where on a channel something is sent: a connection, a space in it, optionally a thread and the message answered.
 * The host resolves it from a binding or a recorded reply route; the model never writes one.
 */
export const channelAddressSchema = z.strictObject({
  connectionRef: connectionIdSchema,
  externalSpaceId: externalIdSchema,
  externalThreadId: externalIdSchema.optional(),
  replyToExternalMessageId: externalIdSchema.optional(),
});
export type ChannelAddress = z.infer<typeof channelAddressSchema>;

/**
 * Where a turn a channel started answers: recorded when the turn starts, so the reply goes back there with no
 * provider reasoning in the turn at all.
 */
export const channelReplyRouteSchema = z.strictObject({
  version: z.literal(CHANNEL_CONTRACT_VERSION),
  bindingId: z.string().min(1).max(128),
  address: channelAddressSchema,
  /** The Clark message the turn answers, and who wrote it. */
  inboundMessageId: z.string().min(1).max(128),
  actorPrincipalId: z.string().min(1).max(128),
});
export type ChannelReplyRoute = z.infer<typeof channelReplyRouteSchema>;

/* ------------------------------------------------------------------ *
 * Connections, identities and bindings
 * ------------------------------------------------------------------ */

export const externalConnectionStateSchema = z.enum(["connected", "degraded", "revoked"]);
export type ExternalConnectionState = z.infer<typeof externalConnectionStateSchema>;

/**
 * One account Clark speaks as on a provider: a bot, a business number. Owned by a principal; its credentials stay in
 * the host's secret store under the names it lists, never in this record.
 */
export const externalConnectionSchema = z.strictObject({
  version: z.literal(CHANNEL_CONTRACT_VERSION),
  connectionRef: connectionIdSchema,
  provider: channelProviderSchema,
  /** The provider's id for the account Clark speaks as. */
  providerAccountId: externalIdSchema,
  principalId: z.string().min(1).max(128),
  ingressMode: channelIngressModeSchema,
  state: externalConnectionStateSchema,
  /** The provider actor ids that are Clark itself: a message from one of them never starts anything. */
  selfActorIds: z.array(externalIdSchema).max(16),
  /** The secret a delivery is verified with, by name; absent when the transport authenticates itself. */
  verifySecretName: z.string().min(1).max(120).optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ExternalConnection = z.infer<typeof externalConnectionSchema>;

/** A provider account mapped to a Clark principal. The owner's own account maps to the owner. */
export const externalIdentitySchema = z.strictObject({
  connectionRef: connectionIdSchema,
  externalActorId: externalIdSchema,
  principalId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(200).optional(),
  linkedAt: instantSchema,
});
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;

/**
 * Who in a bound space Clark engages with. Not a deny list: a message from outside the audience is still kept as
 * context, it just does not start a turn.
 */
export const channelAudiencePolicySchema = z.discriminatedUnion("kind", [
  /** Anyone who can write in the space. A direct space has exactly one such person. */
  z.strictObject({ kind: z.literal("space") }),
  z.strictObject({ kind: z.literal("principals"), principalIds: z.array(z.string().min(1).max(128)).min(1).max(64) }),
]);
export type ChannelAudiencePolicy = z.infer<typeof channelAudiencePolicySchema>;

/**
 * When a message in a bound space becomes a Clark turn, and how much traffic is held.
 *
 * Every activation is a plain switch read the same way each time; the defaults answer a direct message, a mention, a
 * reply to Clark and a thread Clark is already in, and keep everything else as bounded context.
 */
export const channelAttentionPolicySchema = z.strictObject({
  direct: z.boolean().default(true),
  mention: z.boolean().default(true),
  replyToClark: z.boolean().default(true),
  participatingThread: z.boolean().default(true),
  /** A standing instruction to answer every message in this space. */
  everyMessage: z.boolean().default(false),
  /** Messages in one thread this close together become one turn. */
  burstWindowMs: z.int().min(0).max(60_000).default(1_500),
  /** The most turn-starting messages one thread holds while it waits; older ones beyond it are dropped, and said so. */
  maxQueuedPerThread: z.int().min(1).max(100).default(20),
  /** The most context-only messages kept per binding; older ones are removed. */
  contextJournalLimit: z.int().min(0).max(200).default(30),
});
export type ChannelAttentionPolicy = z.infer<typeof channelAttentionPolicySchema>;
export const DEFAULT_CHANNEL_ATTENTION_POLICY: ChannelAttentionPolicy = channelAttentionPolicySchema.parse({});

/**
 * One space (or thread) on a connection, joined to a Clark conversation.
 *
 * It answers who sent a message, from where, which conversation it belongs to, what standing authority exists
 * (`grantRefs`), and where Clark replies. A space with no binding starts nothing.
 */
export const channelBindingSchema = z.strictObject({
  version: z.literal(CHANNEL_CONTRACT_VERSION),
  bindingId: z.string().min(1).max(128),
  connectionRef: connectionIdSchema,
  provider: channelProviderSchema,
  providerAccountId: externalIdSchema,
  externalSpaceId: externalIdSchema,
  /** Bound to one thread only; absent binds the whole space. */
  externalThreadId: externalIdSchema.optional(),
  spaceKind: z.enum(["direct", "group"]),
  conversationId: z.string().min(1).max(128),
  audiencePolicy: channelAudiencePolicySchema,
  attentionPolicy: channelAttentionPolicySchema,
  /** Standing grants that apply to work asked for here, by id. */
  grantRefs: z.array(z.string().min(1).max(128)).max(16),
  state: z.enum(["active", "paused"]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ChannelBinding = z.infer<typeof channelBindingSchema>;

/* ------------------------------------------------------------------ *
 * Links and receipts
 * ------------------------------------------------------------------ */

/** A Clark message and the provider message it is, in either direction. */
export const externalMessageLinkSchema = z.strictObject({
  connectionRef: connectionIdSchema,
  provider: channelProviderSchema,
  externalSpaceId: externalIdSchema,
  externalThreadId: externalIdSchema.optional(),
  externalMessageId: externalIdSchema,
  conversationId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  direction: z.enum(["inbound", "outbound"]),
  createdAt: instantSchema,
});
export type ExternalMessageLink = z.infer<typeof externalMessageLinkSchema>;

export const channelOperationSchema = z.enum(["send", "edit", "delete", "react"]);
export type ChannelOperation = z.infer<typeof channelOperationSchema>;

/**
 * What became of one outbound operation, under its idempotency key.
 *
 * - `pending`: recorded, not yet handed to the adapter.
 * - `sent`: the provider accepted it.
 * - `failed`: it was not sent, with why.
 * - `unknown`: handed off with no answer the node can trust. Never retried; the effect ledger asks the person.
 * - `held`: the policy asks before it is sent, so it was not.
 * - `refused`: the policy refuses it.
 */
export const channelDeliveryStateSchema = z.enum(["pending", "sent", "failed", "unknown", "held", "refused"]);
export type ChannelDeliveryState = z.infer<typeof channelDeliveryStateSchema>;

export const channelDeliveryReceiptSchema = z.strictObject({
  receiptId: z.string().min(1).max(128),
  connectionRef: connectionIdSchema,
  bindingId: z.string().min(1).max(128).optional(),
  operation: channelOperationSchema,
  idempotencyKey: z.string().min(1).max(300),
  state: channelDeliveryStateSchema,
  /** The effect-ledger row this operation was recorded under, once it was handed off. */
  effectId: z.string().min(1).max(128).optional(),
  conversationId: z.string().min(1).max(128),
  /** The Clark message being delivered. */
  messageId: z.string().min(1).max(128).optional(),
  externalMessageId: externalIdSchema.optional(),
  reason: z.string().min(1).max(1000).optional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ChannelDeliveryReceipt = z.infer<typeof channelDeliveryReceiptSchema>;

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

/** A delivery as it arrived, whatever the transport: its headers, and its bytes exactly as sent. */
export interface ChannelDelivery {
  via: ChannelIngressMode;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  rawBody: Uint8Array;
}

export type ChannelVerifyResult = { ok: true } | { ok: false; reason: string };

export interface ChannelNormalizeContext {
  connection: ExternalConnection;
  /** The node's clock, for a delivery that does not say when it happened. */
  now: () => Instant;
}

/**
 * How an outbound operation ended, as the adapter knows it. `not-sent` is a promise that nothing reached the provider;
 * anything the adapter cannot promise — a timeout, a dropped connection, an answer it could not read — is a throw, and
 * the host records it as unknown and never sends it again.
 */
export type ChannelSendOutcome =
  | { status: "sent"; externalMessageId: string; externalThreadId?: string }
  | { status: "not-sent"; reason: string };

export interface ChannelSendOptions {
  /** The same operation always carries the same key; an adapter whose provider deduplicates passes it on. */
  idempotencyKey: string;
}

/**
 * What a provider's adapter does, and all it does.
 *
 * A host-managed driver: it verifies and normalizes what arrives and carries out what the host decided to send. It
 * owns no scheduler, no dedupe store, no retry loop and no automation; durable intake, routing, policy, effects and
 * recovery are the host's. Optional operations are absent when the provider has no such thing.
 */
export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  readonly ingressModes: readonly ChannelIngressMode[];
  capabilities(): ChannelCapabilities;
  /** Whether a delivery came from the provider, checked before anything in it is read. */
  verify?(delivery: ChannelDelivery, secret: string | undefined): ChannelVerifyResult;
  normalize(delivery: ChannelDelivery, context: ChannelNormalizeContext): Promise<ChannelEvent[]>;
  send(address: ChannelAddress, content: ChannelContent, options: ChannelSendOptions): Promise<ChannelSendOutcome>;
  edit?(address: ChannelAddress, externalMessageId: string, content: ChannelContent, options: ChannelSendOptions): Promise<ChannelSendOutcome>;
  delete?(address: ChannelAddress, externalMessageId: string, options: ChannelSendOptions): Promise<ChannelSendOutcome>;
  react?(address: ChannelAddress, externalMessageId: string, reaction: string, options: ChannelSendOptions): Promise<ChannelSendOutcome>;
  typing?(address: ChannelAddress): Promise<void>;
}

/** The signal topic a channel message is recorded under in the shared intake. Persistent intents may match it. */
export const CHANNEL_MESSAGE_TOPIC = "channel.message.received";

/** The intake source id of one connection: dedupe in the shared intake is per source, so per connection. */
export function channelSourceId(connectionRef: string): string {
  return `channel:${connectionRef}`;
}
